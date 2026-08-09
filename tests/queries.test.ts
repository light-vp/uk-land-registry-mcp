/**
 * Query-construction tests with a stubbed transport.
 *
 * These assert on the SPARQL text we emit rather than on data returned by
 * HM Land Registry, so they run offline and deterministically in CI.
 *
 * Triple order is the thing most worth protecting here. The endpoint evaluates
 * patterns roughly in written order, so a selective filter written after the
 * OPTIONAL blocks turns a 0.3-second query into one that exceeds 70 seconds and
 * times out. That is invisible in a unit test unless it is asserted directly.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  countTransactions,
  fetchForAggregate,
  searchTransactions,
} from "../dist/services/ppd.js";
import { getHpiSeries } from "../dist/services/hpi.js";
import { QueryTooBroadError } from "../dist/types.js";

/** Captures the SPARQL sent by the next call, returning an empty result set. */
let captured: string[] = [];
const originalFetch = globalThis.fetch;

function stubTransport(): void {
  captured = [];
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = new URLSearchParams(init?.body ?? "");
    captured.push(body.get("query") ?? "");
    return {
      ok: true,
      status: 200,
      json: async () => ({ head: { vars: [] }, results: { bindings: [] } }),
      text: async () => "",
    };
  }) as unknown as typeof fetch;
}

/** Index of a substring in the last captured query, asserting it is present. */
function indexOf(needle: string): number {
  const query = captured[0] ?? "";
  const position = query.indexOf(needle);
  assert.notEqual(position, -1, `expected query to contain ${JSON.stringify(needle)}:\n${query}`);
  return position;
}

describe("Price Paid query construction", () => {
  beforeEach(stubTransport);
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("places the selective postcode triple before the transaction join", async () => {
    await searchTransactions({ postcode: "BA1 1AA" }, "date_desc", 10, 0);
    assert.ok(
      indexOf('lrcommon:postcode "BA1 1AA"') < indexOf("ppd:propertyAddress ?address"),
      "postcode filter must precede the record join or the query times out",
    );
  });

  it("places every OPTIONAL block after the filters", async () => {
    await searchTransactions(
      { postcode: "BA1 1AA", date_from: "2020-01-01" },
      "date_desc",
      10,
      0,
    );
    assert.ok(indexOf("FILTER(?date >=") < indexOf("OPTIONAL"));
  });

  it("omits the TransactionRecord type triple, which alone matches every row", async () => {
    await searchTransactions({ postcode: "BA1 1AA" }, "date_desc", 10, 0);
    assert.ok(
      !(captured[0] ?? "").includes("a ppd:TransactionRecord"),
      "the type triple must not be emitted",
    );
  });

  it("normalises a postcode before embedding it", async () => {
    await searchTransactions({ postcode: "ba11aa" }, "date_desc", 10, 0);
    indexOf('lrcommon:postcode "BA1 1AA"');
  });

  it("upper-cases street and town, matching how HMLR stores them", async () => {
    await searchTransactions({ street: "high street", town: "bath" }, "date_desc", 10, 0);
    indexOf('lrcommon:street "HIGH STREET"');
    indexOf('lrcommon:town "BATH"');
  });

  it("escapes a quote in a street name instead of closing the literal", async () => {
    await searchTransactions(
      { street: 'A" . ?x ?y ?z . #', town: "BATH" },
      "date_desc",
      10,
      0,
    );
    const query = captured[0] ?? "";
    assert.ok(query.includes('\\"'), "the quote must be escaped");
    assert.ok(!query.includes('"A" . ?x'), "the injected pattern must not appear unescaped");
  });

  it("binds several candidate districts with VALUES rather than picking one", async () => {
    await searchTransactions(
      { postcode_prefix: "TS1", districts: ["MIDDLESBROUGH", "REDCAR AND CLEVELAND"] },
      "date_desc",
      10,
      0,
    );
    indexOf('VALUES ?districtValue { "MIDDLESBROUGH" "REDCAR AND CLEVELAND" }');
    assert.ok(
      indexOf("VALUES ?districtValue") < indexOf("STRSTARTS"),
      "the indexed anchor must precede the prefix scan",
    );
  });

  it("applies LIMIT and OFFSET for pagination", async () => {
    await searchTransactions({ postcode: "BA1 1AA" }, "date_desc", 25, 50);
    indexOf("LIMIT 25");
    indexOf("OFFSET 50");
  });

  it("orders by price when asked", async () => {
    await searchTransactions({ postcode: "BA1 1AA" }, "price_desc", 10, 0);
    indexOf("ORDER BY DESC(?amount)");
  });

  it("maps friendly property types to HMLR's vocabulary URIs", async () => {
    await searchTransactions({ postcode: "BA1 1AA", property_type: "flat" }, "date_desc", 10, 0);
    indexOf("def/common/flat-maisonette");
  });

  it("filters to category A when standard transactions are requested", async () => {
    await searchTransactions(
      { postcode: "BA1 1AA", transaction_category: "standard" },
      "date_desc",
      10,
      0,
    );
    // Vocabulary terms are emitted as absolute IRIs, not prefixed names.
    indexOf("def/ppi/standardPricePaidTransaction");
  });

  it("drops the OPTIONAL blocks entirely when only counting", async () => {
    await countTransactions({ postcode: "BA1 1AA" });
    const query = captured[0] ?? "";
    assert.ok(query.includes("COUNT(*)"));
    assert.ok(!query.includes("OPTIONAL"), "a count needs no optional projections");
  });

  it("projects only the columns an aggregate needs", async () => {
    await fetchForAggregate({ postcode: "BA1 1AA" });
    const query = captured[0] ?? "";
    assert.ok(query.includes("?ptype"), "property type drives the breakdown");
    assert.ok(!query.includes("?county"), "unused address columns should not be fetched");
  });
});

describe("Price Paid guardrails", () => {
  beforeEach(stubTransport);
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("refuses a search with no selective filter", async () => {
    await assert.rejects(
      () => searchTransactions({ town: "BATH" }, "date_desc", 10, 0),
      QueryTooBroadError,
    );
    assert.equal(captured.length, 0, "nothing should reach the endpoint");
  });

  it("accepts a town once a date range narrows it", async () => {
    await searchTransactions(
      { town: "BATH", date_from: "2024-01-01" },
      "date_desc",
      10,
      0,
    );
    assert.equal(captured.length, 1);
  });

  it("refuses a postcode prefix with no district, town or county anchor", async () => {
    await assert.rejects(
      () => searchTransactions({ postcode_prefix: "TS1 2" }, "date_desc", 10, 0),
      /anchor it/,
    );
    assert.equal(captured.length, 0);
  });

  it("rejects an unknown property type rather than silently ignoring it", async () => {
    await assert.rejects(
      () => searchTransactions({ postcode: "BA1 1AA", property_type: "castle" }, "date_desc", 10, 0),
      /Unknown property_type/,
    );
  });
});

describe("House Price Index query construction", () => {
  beforeEach(stubTransport);
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("bounds months as typed gYearMonth literals so they compare correctly", async () => {
    await getHpiSeries(
      "http://landregistry.data.gov.uk/id/region/middlesbrough",
      "2024-01",
      "2024-06",
      ["headline"],
    );
    indexOf('FILTER(?month >= "2024-01"^^xsd:gYearMonth)');
    indexOf('FILTER(?month <= "2024-06"^^xsd:gYearMonth)');
  });

  it("projects only the requested measure groups", async () => {
    await getHpiSeries(
      "http://landregistry.data.gov.uk/id/region/england",
      undefined,
      undefined,
      ["buyer_status"],
    );
    const query = captured[0] ?? "";
    assert.ok(query.includes("averagePriceFirstTimeBuyer"));
    assert.ok(!query.includes("averagePriceCash"), "funding measures were not requested");
  });

  it("refuses to build a query from an unsafe region URI", async () => {
    await assert.rejects(
      () => getHpiSeries("http://evil/> . ?s ?p ?o . <x", undefined, undefined, ["headline"]),
      /unsafe IRI/,
    );
    assert.equal(captured.length, 0);
  });
});
