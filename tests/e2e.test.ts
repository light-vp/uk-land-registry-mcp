/**
 * End-to-end tests against the live HM Land Registry endpoints.
 *
 * Skipped unless HMLR_E2E=1, so the default suite stays offline and
 * deterministic. Run with:
 *
 *   HMLR_E2E=1 npm test
 *
 * These use only the no-authentication endpoints, so they need no API key.
 * Assertions are deliberately loose about values that move (the latest
 * published month, current prices) and strict only about shape and about
 * historical figures that are settled.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const enabled = process.env.HMLR_E2E === "1";
const suite = enabled ? describe : describe.skip;

suite("live HM Land Registry endpoints", () => {
  it("returns sold prices for a known postcode", async () => {
    const { searchTransactions } = await import("../dist/services/ppd.js");
    const rows = await searchTransactions({ postcode: "TS4 3AQ" }, "date_desc", 5, 0);

    assert.ok(rows.length > 0, "expected at least one transaction");
    for (const row of rows) {
      assert.match(row.date, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(row.price > 0);
      assert.equal(row.address.postcode, "TS4 3AQ");
      assert.ok(row.address.display.length > 0);
    }
  });

  it("counts transactions without timing out", async () => {
    const { countTransactions } = await import("../dist/services/ppd.js");
    const total = await countTransactions({ postcode: "TS4 3AQ" });
    assert.ok(total !== null && total > 0, `expected a positive count, got ${total}`);
  });

  it("returns a settled House Price Index observation", async () => {
    const { getHpiSeries } = await import("../dist/services/hpi.js");
    const rows = await getHpiSeries(
      "http://landregistry.data.gov.uk/id/region/england",
      "1997-02",
      "1997-02",
      ["headline"],
    );
    assert.equal(rows.length, 1);
    // Published figures for 1997 are long settled.
    assert.equal(rows[0]!.values.averagePrice, 53060);
    assert.equal(rows[0]!.values.salesVolume, 66246);
  });

  it("resolves a local authority name to its index region", async () => {
    const { resolveRegion } = await import("../dist/services/regions.js");
    const region = await resolveRegion("Middlesbrough");
    assert.equal(region.slug, "middlesbrough");
    assert.equal(region.label, "Middlesbrough");
  });

  it("suggests alternatives for an unknown region", async () => {
    const { resolveRegion } = await import("../dist/services/regions.js");
    await assert.rejects(() => resolveRegion("Narnia"), /No House Price Index region matches/);
  });

  it("looks up a postcode's administrative geography", async () => {
    const { lookupPostcode } = await import("../dist/services/postcodes.js");
    const info = await lookupPostcode("TS1 2AB");
    assert.ok(info, "expected a result");
    assert.equal(info.admin_district, "Middlesbrough");
    assert.equal(info.sector, "TS1 2");
    assert.ok(typeof info.latitude === "number");
  });

  it("returns the districts an outward code spans", async () => {
    const { lookupOutcode } = await import("../dist/services/postcodes.js");
    const result = await lookupOutcode("TS1");
    assert.ok(result, "expected a result");
    const districts = result.admin_district as string[];
    assert.ok(Array.isArray(districts) && districts.length > 0);
  });

  it("returns null for a well-formed postcode that does not exist", async () => {
    const { lookupPostcode } = await import("../dist/services/postcodes.js");
    assert.equal(await lookupPostcode("ZZ1 1ZZ"), null);
  });

  it("refuses an over-broad search before contacting the endpoint", async () => {
    const { searchTransactions } = await import("../dist/services/ppd.js");
    const started = Date.now();
    await assert.rejects(() => searchTransactions({ town: "LONDON" }, "date_desc", 10, 0));
    assert.ok(Date.now() - started < 1000, "the refusal must be local, not a timeout");
  });

  it("keeps an anchored postcode-prefix aggregate well under the timeout", async () => {
    const { fetchForAggregate } = await import("../dist/services/ppd.js");
    const started = Date.now();
    const { transactions } = await fetchForAggregate({
      postcode_prefix: "TS1 2",
      districts: ["MIDDLESBROUGH"],
      date_from: "2024-01-01",
      date_to: "2024-12-31",
    });
    const elapsed = Date.now() - started;
    assert.ok(Array.isArray(transactions));
    // Unanchored, the same query takes about 30 seconds.
    assert.ok(elapsed < 15_000, `anchored prefix query took ${elapsed}ms`);
  });
});
