/**
 * Group D — INSPIRE Index Polygons (title boundaries).
 *
 * Polygons are stored in British National Grid (EPSG:27700), so areas and
 * distances are computed in metres directly on the source geometry; WGS84
 * centroids are precomputed at ingest for joining to postcode coordinates.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { DATASETS, NOT_ADVICE_DISCLAIMER, OS_ATTRIBUTION } from "../constants.js";
import { limitField, responseFormatField } from "../schemas/common.js";
import { ensureSpatial, query, requireTable, sqlIdent, sqlLit } from "../services/cache.js";
import {
  guard,
  markdownTable,
  objectResponse,
  paginate,
  paginatedResponse,
  withAttribution,
} from "../services/format.js";
import { lookupPostcode } from "../services/postcodes.js";

const TABLE = sqlIdent(DATASETS.inspire!.table);

/** Converts a WGS84 coordinate to a British National Grid point expression. */
function bngPoint(longitude: number, latitude: number): string {
  return `ST_Transform(ST_Point(${longitude}, ${latitude}), 'EPSG:4326', 'EPSG:27700', always_xy := true)`;
}

/** Resolves a location argument to WGS84 coordinates. */
async function resolveLocation(input: {
  latitude?: number;
  longitude?: number;
  postcode?: string;
}): Promise<{ latitude: number; longitude: number; label: string }> {
  if (input.latitude !== undefined && input.longitude !== undefined) {
    return {
      latitude: input.latitude,
      longitude: input.longitude,
      label: `${input.latitude}, ${input.longitude}`,
    };
  }

  const info = await lookupPostcode(input.postcode!);
  if (!info || info.latitude === null || info.longitude === null) {
    throw new Error(
      `Could not resolve coordinates for postcode "${input.postcode}". ` +
        "Check the postcode, or pass latitude and longitude directly.",
    );
  }
  return { latitude: info.latitude, longitude: info.longitude, label: info.postcode };
}

const locationFields = {
  latitude: z.number().min(49).max(61).optional().describe("Latitude (WGS84)."),
  longitude: z.number().min(-9).max(2).optional().describe("Longitude (WGS84)."),
  postcode: z.string().min(5).max(10).optional().describe("Full postcode, used if coordinates are not given."),
};

const GetPolygonFields = {
  inspire_id: z.string().min(1).max(40).optional().describe("INSPIRE ID of the parcel."),
  ...locationFields,
  include_geometry: z
    .boolean()
    .default(false)
    .describe(
      "Include the full GeoJSON geometry. Off by default because parcel " +
        "outlines can run to thousands of coordinates.",
    ),
  response_format: responseFormatField,
} as const;

const GetPolygonSchema = z
  .object(GetPolygonFields)
  .strict()
  .superRefine((value, context) => {
    const hasCoords = value.latitude !== undefined && value.longitude !== undefined;
    if (!value.inspire_id && !hasCoords && !value.postcode) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide `inspire_id`, or a location as `postcode` or latitude+longitude.",
      });
    }
  });

const AdjacentFields = {
  inspire_id: z.string().min(1).max(40).optional().describe("INSPIRE ID of the parcel to start from."),
  ...locationFields,
  within_metres: z
    .number()
    .min(0)
    .max(500)
    .default(0)
    .describe("Include parcels within this distance. 0 (default) means touching only."),
  min_area_sq_m: z.number().min(0).optional().describe("Only return parcels at least this large."),
  check_ownership: z
    .boolean()
    .default(true)
    .describe("Cross-reference the ownership datasets to flag corporately-owned neighbours, when cached."),
  limit: limitField,
  response_format: responseFormatField,
} as const;

const AdjacentSchema = z
  .object(AdjacentFields)
  .strict()
  .superRefine((value, context) => {
    const hasCoords = value.latitude !== undefined && value.longitude !== undefined;
    if (!value.inspire_id && !hasCoords && !value.postcode) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide `inspire_id`, or a location as `postcode` or latitude+longitude.",
      });
    }
  });

const SearchParcelsFields = {
  ...locationFields,
  radius_metres: z.number().min(1).max(5000).optional().describe("Search radius around the location."),
  bbox: z
    .array(z.number())
    .length(4)
    .optional()
    .describe("Bounding box as [min_lon, min_lat, max_lon, max_lat] in WGS84."),
  min_area_sq_m: z.number().min(0).optional().describe("Minimum parcel area in square metres."),
  max_area_sq_m: z.number().min(0).optional().describe("Maximum parcel area in square metres."),
  limit: limitField,
  offset: z.number().int().min(0).default(0).describe("Rows to skip, for paging."),
  response_format: responseFormatField,
} as const;

const SearchParcelsSchema = z
  .object(SearchParcelsFields)
  .strict()
  .superRefine((value, context) => {
    const hasCoords = value.latitude !== undefined && value.longitude !== undefined;
    const hasCentre = hasCoords || Boolean(value.postcode);
    if (!value.bbox && !hasCentre) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide a `bbox`, or a centre (postcode or latitude+longitude) with `radius_metres`.",
      });
    }
    if (hasCentre && !value.bbox && value.radius_metres === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`radius_metres` is required when searching around a location.",
      });
    }
  });

type GetPolygonInput = z.infer<typeof GetPolygonSchema>;
type AdjacentInput = z.infer<typeof AdjacentSchema>;
type SearchParcelsInput = z.infer<typeof SearchParcelsSchema>;

interface ParcelRow {
  inspire_id: string | null;
  area: string | null;
  area_sq_m: number | null;
  centroid_lon: number | null;
  centroid_lat: number | null;
  distance_m?: number | null;
  geojson?: string | null;
}

function parcelTable(rows: ParcelRow[], includeDistance: boolean): string {
  const headers = ["INSPIRE ID", "Area (m²)", "Local authority", "Centroid"];
  if (includeDistance) headers.splice(2, 0, "Distance (m)");

  return markdownTable(
    headers,
    rows.map((row) => {
      const base: Array<string | number | null> = [
        row.inspire_id,
        row.area_sq_m === null ? null : Math.round(row.area_sq_m).toLocaleString("en-GB"),
        row.area,
        row.centroid_lat !== null && row.centroid_lon !== null
          ? `${row.centroid_lat.toFixed(5)}, ${row.centroid_lon.toFixed(5)}`
          : null,
      ];
      if (includeDistance) {
        base.splice(2, 0, row.distance_m === null || row.distance_m === undefined ? null : row.distance_m.toFixed(1));
      }
      return base;
    }),
  );
}

/** Locates the parcel to start from, by INSPIRE ID or by point-in-polygon. */
async function findAnchorParcel(input: {
  inspire_id?: string;
  latitude?: number;
  longitude?: number;
  postcode?: string;
}): Promise<{ inspire_id: string | null; label: string }> {
  if (input.inspire_id) {
    const rows = await query<{ inspire_id: string }>(
      `SELECT inspire_id FROM ${TABLE} WHERE inspire_id = ${sqlLit(input.inspire_id)} LIMIT 1`,
    );
    if (rows.length === 0) {
      throw new Error(
        `No cached parcel with INSPIRE ID "${input.inspire_id}". Confirm the local ` +
          "authority containing it has been downloaded (hmlr_data_status lists " +
          "cached areas).",
      );
    }
    return { inspire_id: input.inspire_id, label: input.inspire_id };
  }

  const location = await resolveLocation(input);
  const rows = await query<{ inspire_id: string | null }>(
    `SELECT inspire_id FROM ${TABLE}
     WHERE ST_Contains(geom, ${bngPoint(location.longitude, location.latitude)})
     LIMIT 1`,
  );

  if (rows.length === 0) {
    throw new Error(
      `No cached parcel contains ${location.label}. Either that local authority's ` +
        "INSPIRE data is not downloaded (run hmlr_download_dataset with " +
        'dataset="inspire" and the local authority name), or the point falls on ' +
        "unregistered land — roughly 12% of land in England and Wales is still " +
        "unregistered.",
    );
  }

  return { inspire_id: rows[0]!.inspire_id, label: location.label };
}

export function registerPolygonTools(server: McpServer): void {
  server.registerTool(
    "hmlr_get_title_polygon",
    {
      title: "Get a title boundary polygon",
      description: `Return the INSPIRE Index Polygon for a parcel — its boundary geometry as GeoJSON and its area in square metres — found either by INSPIRE ID or by a point that falls inside it.

Requires INSPIRE data for the relevant local authority to be cached (hmlr_download_dataset with dataset="inspire", area="<local authority>").

INSPIRE polygons show the extent of a registered title. They are indicative boundaries derived from Ordnance Survey mapping, not legally definitive ones.

Args:
  - inspire_id (string, optional): the parcel's INSPIRE ID.
  - postcode (string, optional) or latitude+longitude (numbers, optional): a point inside the parcel.
  - include_geometry (boolean, default false): return full GeoJSON. Off by default because outlines are large.
  - response_format ('markdown'|'json', default 'markdown')

Returns JSON with schema:
  {
    "found": boolean,
    "parcel": {
      "inspire_id": string|null, "area": string|null,
      "area_sq_m": number|null, "area_hectares": number|null, "area_acres": number|null,
      "centroid": {"latitude": number|null, "longitude": number|null},
      "geometry": <GeoJSON geometry>|null
    }|null
  }

Examples:
  - "How big is the plot at TS1 2AB?" -> postcode="TS1 2AB"
  - "Get the boundary for INSPIRE ID 12345" -> inspire_id="12345", include_geometry=true

Errors:
  - Explains which local authority to download when no cached parcel covers the point.
  - Notes that ~12% of land in England and Wales is unregistered and has no polygon.`,
      inputSchema: GetPolygonFields,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guard(async (input: GetPolygonInput) => {
      await requireTable(DATASETS.inspire!);
      await ensureSpatial();

      const predicate = input.inspire_id
        ? `inspire_id = ${sqlLit(input.inspire_id)}`
        : await (async () => {
            const location = await resolveLocation(input);
            return `ST_Contains(geom, ${bngPoint(location.longitude, location.latitude)})`;
          })();

      const geometryColumn = input.include_geometry
        ? `, ST_AsGeoJSON(ST_Transform(geom, 'EPSG:27700', 'EPSG:4326', always_xy := true)) AS geojson`
        : "";

      const rows = await query<ParcelRow>(
        `SELECT inspire_id, area, area_sq_m, centroid_lon, centroid_lat${geometryColumn}
         FROM ${TABLE} WHERE ${predicate} LIMIT 1`,
      );

      const row = rows[0];
      if (!row) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "No cached parcel matched. If you searched by location, the relevant " +
                "local authority's INSPIRE data may not be downloaded, or the point " +
                "may fall on unregistered land (around 12% of England and Wales).",
            },
          ],
          structuredContent: { found: false, parcel: null },
        };
      }

      const areaSqM = row.area_sq_m ?? null;
      const payload = {
        found: true,
        parcel: {
          inspire_id: row.inspire_id,
          area: row.area,
          area_sq_m: areaSqM,
          area_hectares: areaSqM === null ? null : areaSqM / 10_000,
          area_acres: areaSqM === null ? null : areaSqM / 4046.86,
          centroid: { latitude: row.centroid_lat, longitude: row.centroid_lon },
          geometry: row.geojson ? (JSON.parse(row.geojson) as unknown) : null,
        },
      };

      return objectResponse(payload, input.response_format, () =>
        withAttribution(
          [
            `# Parcel ${row.inspire_id ?? "(no INSPIRE ID)"}`,
            "",
            `- **Area**: ${areaSqM === null ? "—" : `${Math.round(areaSqM).toLocaleString("en-GB")} m²`}` +
              (areaSqM === null
                ? ""
                : ` (${(areaSqM / 10_000).toFixed(3)} ha, ${(areaSqM / 4046.86).toFixed(3)} acres)`),
            `- **Local authority**: ${row.area ?? "—"}`,
            `- **Centroid**: ${
              row.centroid_lat !== null && row.centroid_lon !== null
                ? `${row.centroid_lat.toFixed(6)}, ${row.centroid_lon.toFixed(6)}`
                : "—"
            }`,
            input.include_geometry ? "\n_GeoJSON geometry included in the structured output._" : null,
            "",
            "_INSPIRE polygons are indicative title extents derived from Ordnance " +
              "Survey mapping. They are not legally definitive boundaries._",
          ]
            .filter((line): line is string => line !== null)
            .join("\n"),
          `${OS_ATTRIBUTION} ${NOT_ADVICE_DISCLAIMER}`,
        ),
      );
    }),
  );

  server.registerTool(
    "hmlr_find_adjacent_parcels",
    {
      title: "Find neighbouring land parcels",
      description: `Find the parcels that share a boundary with a given parcel, or lie within a set distance of it — the land-assembly and ransom-strip tool.

When the ownership datasets are also cached, each neighbour is cross-referenced against CCOD/OCOD so corporately-owned adjoining land is flagged.

Requires INSPIRE data for the local authority (hmlr_download_dataset with dataset="inspire").

Args:
  - inspire_id (string, optional), or postcode / latitude+longitude to locate the starting parcel.
  - within_metres (0-500, default 0): 0 means directly touching; higher values include nearby parcels.
  - min_area_sq_m (number, optional): filter out small slivers.
  - check_ownership (boolean, default true): flag corporately-owned neighbours.
  - limit (1-200, default 25)
  - response_format ('markdown'|'json', default 'markdown')

Returns JSON with schema:
  {
    "origin": {"inspire_id": string|null, "label": string},
    "within_metres": number,
    "total": number, "count": number, "has_more": boolean,
    "items": [{
      "inspire_id": string|null, "area": string|null, "area_sq_m": number|null,
      "distance_m": number|null,
      "centroid": {"latitude": number|null, "longitude": number|null},
      "corporate_owner": {"title_number","proprietor","dataset"}|null
    }]
  }

Examples:
  - "What adjoins the plot at TS1 2AB?" -> postcode="TS1 2AB"
  - "Land within 50m owned by companies" -> postcode="TS1 2AB", within_metres=50

Errors:
  - Explains which local authority to download when the starting parcel is not cached.`,
      inputSchema: AdjacentFields,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guard(async (input: AdjacentInput) => {
      await requireTable(DATASETS.inspire!);
      await ensureSpatial();

      const anchor = await findAnchorParcel(input);
      const anchorPredicate =
        anchor.inspire_id !== null
          ? `inspire_id = ${sqlLit(anchor.inspire_id)}`
          : "FALSE";

      // DuckDB's spatial extension does not compute polygon-to-polygon
      // distance correctly: ST_Distance returns 0 for disjoint polygons and
      // ST_DWithin returns true regardless of the threshold, which would make
      // a "within 50m" search silently return every parcel in the cache.
      // Distance between the boundaries is correct, so derive it that way, and
      // treat touching or overlapping parcels as zero distance.
      const separation = `ST_Distance(ST_Boundary(n.geom), ST_Boundary(o.geom))`;
      const distanceExpression = `CASE WHEN ST_Intersects(n.geom, o.geom) THEN 0 ELSE ${separation} END`;

      const distanceClause =
        input.within_metres > 0
          ? `(ST_Intersects(n.geom, o.geom) OR ${separation} <= ${input.within_metres})`
          : `ST_Intersects(n.geom, o.geom)`;

      const areaClause =
        input.min_area_sq_m !== undefined ? `AND n.area_sq_m >= ${input.min_area_sq_m}` : "";

      const rows = await query<ParcelRow>(
        `WITH origin AS (SELECT geom FROM ${TABLE} WHERE ${anchorPredicate} LIMIT 1)
         SELECT n.inspire_id, n.area, n.area_sq_m, n.centroid_lon, n.centroid_lat,
                ${distanceExpression} AS distance_m
         FROM ${TABLE} n, origin o
         WHERE ${distanceClause}
           AND n.inspire_id IS DISTINCT FROM ${sqlLit(anchor.inspire_id ?? "")}
           ${areaClause}
         ORDER BY distance_m, n.area_sq_m DESC
         LIMIT ${Math.trunc(input.limit)}`,
      );

      // Cross-reference ownership only when a dataset is actually cached.
      const withOwnership = await Promise.all(
        rows.map(async (row) => {
          let corporateOwner: Record<string, unknown> | null = null;

          if (input.check_ownership && row.inspire_id) {
            for (const key of ["ccod", "ocod"] as const) {
              try {
                await requireTable(DATASETS[key]!);
              } catch {
                continue;
              }
              const owner = await query<{
                title_number: string;
                proprietor_1_name: string | null;
              }>(
                `SELECT "title_number", "proprietor_1_name"
                 FROM ${sqlIdent(DATASETS[key]!.table)}
                 WHERE upper(TRIM("title_number")) = ${sqlLit(row.inspire_id.toUpperCase())}
                 LIMIT 1`,
              ).catch(() => []);
              if (owner.length > 0) {
                corporateOwner = {
                  title_number: owner[0]!.title_number,
                  proprietor: owner[0]!.proprietor_1_name,
                  dataset: key,
                };
                break;
              }
            }
          }

          return {
            inspire_id: row.inspire_id,
            area: row.area,
            area_sq_m: row.area_sq_m,
            distance_m: row.distance_m ?? null,
            centroid: { latitude: row.centroid_lat, longitude: row.centroid_lon },
            corporate_owner: corporateOwner,
          };
        }),
      );

      const payload = {
        origin: { inspire_id: anchor.inspire_id, label: anchor.label },
        within_metres: input.within_metres,
        ...paginate(withOwnership, withOwnership.length, 0),
      };

      return paginatedResponse(payload, input.response_format, (page) =>
        withAttribution(
          [
            `# Parcels ${input.within_metres > 0 ? `within ${input.within_metres}m of` : "adjoining"} ${anchor.label}`,
            "",
            `Found **${page.count}** neighbouring parcel${page.count === 1 ? "" : "s"}.`,
            "",
            parcelTable(rows, true),
            withOwnership.some((p) => p.corporate_owner)
              ? "\n## Corporately-owned neighbours\n\n" +
                markdownTable(
                  ["INSPIRE ID", "Title", "Proprietor", "Source"],
                  withOwnership
                    .filter((p) => p.corporate_owner)
                    .map((p) => [
                      p.inspire_id,
                      String(p.corporate_owner!.title_number),
                      String(p.corporate_owner!.proprietor ?? "—"),
                      String(p.corporate_owner!.dataset).toUpperCase(),
                    ]),
                )
              : null,
            "\n_INSPIRE IDs and title numbers are different identifiers; the " +
              "ownership cross-reference matches only where they coincide, so an " +
              "absent flag is not proof of individual ownership._",
          ]
            .filter((line): line is string => line !== null)
            .join("\n"),
          `${OS_ATTRIBUTION} ${NOT_ADVICE_DISCLAIMER}`,
        ),
      );
    }),
  );

  server.registerTool(
    "hmlr_search_parcels_in_area",
    {
      title: "Search land parcels by area or bounding box",
      description: `Find registered land parcels within a radius of a point or inside a bounding box, filtered by size — "plots over 500 m² within 300 m of this point".

Requires INSPIRE data for the relevant local authority to be cached.

Args:
  - postcode (string) or latitude+longitude (numbers), plus radius_metres (1-5000); or
  - bbox ([min_lon, min_lat, max_lon, max_lat] in WGS84).
  - min_area_sq_m, max_area_sq_m (numbers, optional): size filters.
  - limit (1-200, default 25), offset (default 0)
  - response_format ('markdown'|'json', default 'markdown')

Returns JSON with schema:
  {
    "total": number, "count": number, "offset": number, "has_more": boolean,
    "search": {"type": "radius"|"bbox", "description": string},
    "items": [{
      "inspire_id": string|null, "area": string|null,
      "area_sq_m": number|null, "area_hectares": number|null,
      "distance_m": number|null,
      "centroid": {"latitude": number|null, "longitude": number|null}
    }]
  }

Examples:
  - "Plots over 500 m² within 300 m of TS1 2AB" -> postcode="TS1 2AB", radius_metres=300, min_area_sq_m=500
  - "Everything in this bounding box" -> bbox=[-1.24, 54.57, -1.22, 54.58]

Errors:
  - Explains which local authority to download when nothing is cached for the area.`,
      inputSchema: SearchParcelsFields,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guard(async (input: SearchParcelsInput) => {
      await requireTable(DATASETS.inspire!);
      await ensureSpatial();

      let predicate: string;
      let distanceExpression = "NULL";
      let description: string;
      let searchType: "radius" | "bbox";

      if (input.bbox) {
        const [minLon, minLat, maxLon, maxLat] = input.bbox as [number, number, number, number];
        if (minLon >= maxLon || minLat >= maxLat) {
          throw new Error(
            "bbox must be [min_lon, min_lat, max_lon, max_lat] with min values below max values.",
          );
        }
        const box = `ST_Transform(ST_MakeEnvelope(${minLon}, ${minLat}, ${maxLon}, ${maxLat}), 'EPSG:4326', 'EPSG:27700', always_xy := true)`;
        predicate = `ST_Intersects(geom, ${box})`;
        description = `bounding box ${input.bbox.join(", ")}`;
        searchType = "bbox";
      } else {
        const location = await resolveLocation(input);
        const point = bngPoint(location.longitude, location.latitude);
        predicate = `ST_DWithin(geom, ${point}, ${input.radius_metres})`;
        distanceExpression = `ST_Distance(geom, ${point})`;
        description = `within ${input.radius_metres}m of ${location.label}`;
        searchType = "radius";
      }

      const sizeClauses: string[] = [];
      if (input.min_area_sq_m !== undefined) sizeClauses.push(`area_sq_m >= ${input.min_area_sq_m}`);
      if (input.max_area_sq_m !== undefined) sizeClauses.push(`area_sq_m <= ${input.max_area_sq_m}`);
      const where = [predicate, ...sizeClauses].join(" AND ");

      const countRows = await query<{ total: number | bigint }>(
        `SELECT COUNT(*) AS total FROM ${TABLE} WHERE ${where}`,
      );
      const total = Number(countRows[0]?.total ?? 0);

      const rows = await query<ParcelRow>(
        `SELECT inspire_id, area, area_sq_m, centroid_lon, centroid_lat,
                ${distanceExpression} AS distance_m
         FROM ${TABLE} WHERE ${where}
         ORDER BY ${searchType === "radius" ? "distance_m" : "area_sq_m DESC"}
         LIMIT ${Math.trunc(input.limit)} OFFSET ${Math.trunc(input.offset)}`,
      );

      if (total === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `No cached parcels found ${description}. Either the local authority's ` +
                "INSPIRE data is not downloaded, or the size filters excluded everything.",
            },
          ],
          structuredContent: { total: 0, count: 0, offset: input.offset, has_more: false, items: [] },
        };
      }

      const items = rows.map((row) => ({
        inspire_id: row.inspire_id,
        area: row.area,
        area_sq_m: row.area_sq_m,
        area_hectares: row.area_sq_m === null ? null : row.area_sq_m / 10_000,
        distance_m: row.distance_m ?? null,
        centroid: { latitude: row.centroid_lat, longitude: row.centroid_lon },
      }));

      const payload = {
        search: { type: searchType, description },
        ...paginate(items, total, input.offset),
      };

      return paginatedResponse(payload, input.response_format, (page) =>
        withAttribution(
          [
            `# Parcels ${description}`,
            "",
            `Found **${total.toLocaleString("en-GB")}** parcel${total === 1 ? "" : "s"} (showing ${page.count}).`,
            "",
            parcelTable(rows, searchType === "radius"),
            page.has_more ? `\n_More available — call again with offset=${page.next_offset}._` : null,
          ]
            .filter((line): line is string => line !== null)
            .join("\n"),
          `${OS_ATTRIBUTION} ${NOT_ADVICE_DISCLAIMER}`,
        ),
      );
    }),
  );
}
