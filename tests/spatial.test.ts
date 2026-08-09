/**
 * INSPIRE polygon ingest and spatial query tests.
 *
 * Two of these guard against defects in DuckDB's spatial extension rather than
 * in our own code, so they are deliberately explicit about what is being
 * checked:
 *
 *   1. ST_Read names the geometry column after the source GML element
 *      ("geometryProperty"), not "geom", and reports its type as
 *      GEOMETRY('EPSG:27700') rather than GEOMETRY.
 *   2. ST_Distance and ST_DWithin are wrong for polygon-to-polygon pairs —
 *      distance comes back as 0 and DWithin as true no matter how far apart
 *      the polygons are. Distance between boundaries is correct, which is what
 *      hmlr_find_adjacent_parcels relies on.
 *
 * If a future DuckDB release fixes (2), these tests keep passing — they assert
 * the correct answers, not the workaround.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "hmlr-mcp-spatial-"));
process.env.HMLR_DATA_DIR = dataDir;

/** Builds an OGR-style GML feature collection in British National Grid. */
function gml(features: Array<{ id: string; coords: string }>): string {
  const members = features
    .map(
      ({ id, coords }) => `<gml:featureMember><ogr:P fid="F${id}">
  <ogr:INSPIREID>${id}</ogr:INSPIREID>
  <ogr:geometryProperty><gml:Polygon srsName="EPSG:27700"><gml:outerBoundaryIs>
  <gml:LinearRing><gml:coordinates>${coords}</gml:coordinates></gml:LinearRing>
  </gml:outerBoundaryIs></gml:Polygon></ogr:geometryProperty>
</ogr:P></gml:featureMember>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="utf-8" ?>
<ogr:FeatureCollection xmlns:ogr="http://ogr.maptools.org/" xmlns:gml="http://www.opengis.net/gml">
${members}
</ogr:FeatureCollection>`;
}

// A 20x30m parcel, a 40x30m parcel sharing its eastern edge, and a 20x20m
// parcel 180m further east.
const PARCELS = gml([
  { id: "1001", coords: "451000,517000 451020,517000 451020,517030 451000,517030 451000,517000" },
  { id: "1002", coords: "451020,517000 451060,517000 451060,517030 451020,517030 451020,517000" },
  { id: "1003", coords: "451200,517000 451220,517000 451220,517020 451200,517020 451200,517000" },
]);

describe("INSPIRE spatial ingest", () => {
  let query: typeof import("../dist/services/cache.js").query;

  before(async () => {
    const { loadSpatial } = await import("../dist/services/ingest.js");
    const { DATASETS } = await import("../dist/constants.js");
    ({ query } = await import("../dist/services/cache.js"));

    const path = join(dataDir, "parcels.gml");
    writeFileSync(path, PARCELS);
    await loadSpatial(DATASETS.inspire!, [path], "Testshire");
  });

  it("finds the geometry column despite GDAL naming it after the GML element", async () => {
    const rows = await query<{ n: bigint | number }>("SELECT COUNT(*) AS n FROM inspire");
    assert.equal(Number(rows[0]!.n), 3);
  });

  it("computes parcel area in square metres from the projected geometry", async () => {
    const rows = await query<{ inspire_id: string; a: number }>(
      "SELECT inspire_id, area_sq_m AS a FROM inspire ORDER BY inspire_id",
    );
    const byId = Object.fromEntries(rows.map((r) => [r.inspire_id, r.a]));
    assert.equal(byId["1001"], 600); // 20m x 30m
    assert.equal(byId["1002"], 1200); // 40m x 30m
    assert.equal(byId["1003"], 400); // 20m x 20m
  });

  it("reprojects centroids from British National Grid to WGS84", async () => {
    const rows = await query<{ lat: number; lon: number }>(
      "SELECT centroid_lat AS lat, centroid_lon AS lon FROM inspire WHERE inspire_id = '1001'",
    );
    // Easting 451010, northing 517015 is in Middlesbrough.
    assert.ok(Math.abs(rows[0]!.lat - 54.5458) < 0.001, `lat was ${rows[0]!.lat}`);
    assert.ok(Math.abs(rows[0]!.lon - -1.2130) < 0.001, `lon was ${rows[0]!.lon}`);
  });

  it("tags each parcel with the local authority it was loaded for", async () => {
    const rows = await query<{ area: string }>("SELECT DISTINCT area FROM inspire");
    assert.deepEqual(rows.map((r) => r.area), ["Testshire"]);
  });
});

describe("parcel adjacency and distance", () => {
  let query: typeof import("../dist/services/cache.js").query;

  /** The expression hmlr_find_adjacent_parcels uses for separation. */
  const SEPARATION =
    "CASE WHEN ST_Intersects(n.geom, o.geom) THEN 0 " +
    "ELSE ST_Distance(ST_Boundary(n.geom), ST_Boundary(o.geom)) END";

  const from = (id: string): string =>
    `FROM inspire n, (SELECT geom FROM inspire WHERE inspire_id = '${id}') o
     WHERE n.inspire_id <> '${id}'`;

  before(async () => {
    ({ query } = await import("../dist/services/cache.js"));
    const { ensureSpatial } = await import("../dist/services/cache.js");
    await ensureSpatial();
  });

  it("reports zero distance to a parcel sharing a boundary", async () => {
    const rows = await query<{ d: number }>(
      `SELECT ${SEPARATION} AS d ${from("1001")} AND n.inspire_id = '1002'`,
    );
    assert.equal(rows[0]!.d, 0);
  });

  it("reports the true gap to a disjoint parcel, not zero", async () => {
    const rows = await query<{ d: number }>(
      `SELECT ${SEPARATION} AS d ${from("1001")} AND n.inspire_id = '1003'`,
    );
    // Eastern edge of 1001 is at 451020; western edge of 1003 at 451200.
    assert.equal(rows[0]!.d, 180);
  });

  it("excludes a parcel beyond the requested radius", async () => {
    const rows = await query<{ inspire_id: string }>(
      `SELECT n.inspire_id ${from("1001")} AND (${SEPARATION}) <= 50`,
    );
    assert.deepEqual(rows.map((r) => r.inspire_id), ["1002"]);
  });

  it("includes a parcel inside a wider radius", async () => {
    const rows = await query<{ inspire_id: string }>(
      `SELECT n.inspire_id ${from("1001")} AND (${SEPARATION}) <= 200 ORDER BY n.inspire_id`,
    );
    assert.deepEqual(rows.map((r) => r.inspire_id), ["1002", "1003"]);
  });

  it("matches only touching parcels when asked for adjacency alone", async () => {
    const rows = await query<{ inspire_id: string }>(
      `SELECT n.inspire_id ${from("1001")} AND ST_Intersects(n.geom, o.geom)`,
    );
    assert.deepEqual(rows.map((r) => r.inspire_id), ["1002"]);
  });

  after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(dataDir, { recursive: true, force: true });
  });
});
