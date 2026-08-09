/**
 * Ingest and query tests.
 *
 * These exercise the real DuckDB pipeline against a synthetic CCOD file that
 * uses HM Land Registry's published column names, including the "Row Count: N"
 * trailer their extracts end with. Run against a temporary HMLR_DATA_DIR so a
 * developer's real cache is never touched. Imports target dist/ so the tests
 * exercise the compiled artefact that actually ships.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "hmlr-mcp-test-"));
process.env.HMLR_DATA_DIR = dataDir;

const CCOD_CSV = `"Title Number","Tenure","Property Address","District","County","Region","Postcode","Multiple Address Indicator","Price Paid","Proprietor Name (1)","Company Registration No. (1)","Proprietorship Category (1)","Proprietor (1) Address (1)","Proprietor (1) Address (2)","Proprietor (1) Address (3)","Proprietor Name (2)","Company Registration No. (2)","Proprietorship Category (2)","Proprietor (2) Address (1)","Proprietor (2) Address (2)","Proprietor (2) Address (3)","Date Proprietor Added","Additional Proprietor Indicator"
"TS100001","Freehold","1 EXAMPLE STREET, MIDDLESBROUGH (TS1 2AB)","MIDDLESBROUGH","","NORTH EAST","TS1 2AB","N","150000","EXAMPLE HOLDINGS LIMITED","01234567","Limited Company or Public Limited Company","1 CORPORATE WAY","LONDON","EC1A 1BB","","","","","","","15-03-2019",""
"TS100002","Leasehold","2 EXAMPLE STREET, MIDDLESBROUGH (TS1 2AB)","MIDDLESBROUGH","","NORTH EAST","TS1 2AB","N","","SECOND EXAMPLE LTD","07654321","Limited Company or Public Limited Company","2 CORPORATE WAY","LEEDS","LS1 1AA","JOINT OWNER PLC","09999999","Limited Company or Public Limited Company","3 CORPORATE WAY","YORK","YO1 1AA","01-11-2021","Y"
"BA200003","Freehold","10 OTHER ROAD, BATH (BA1 1AA)","BATH AND NORTH EAST SOMERSET","","SOUTH WEST","BA1 1AA","N","875000","EXAMPLE HOLDINGS LIMITED","01234567","Limited Company or Public Limited Company","1 CORPORATE WAY","LONDON","EC1A 1BB","","","","","","","20-06-2023",""
Row Count: 3
`;

describe("CCOD ingest", () => {
  let loadCsv: typeof import("../dist/services/ingest.js").loadCsv;
  let query: typeof import("../dist/services/cache.js").query;
  let DATASETS: typeof import("../dist/constants.js").DATASETS;

  before(async () => {
    ({ loadCsv } = await import("../dist/services/ingest.js"));
    ({ query } = await import("../dist/services/cache.js"));
    ({ DATASETS } = await import("../dist/constants.js"));

    const csvPath = join(dataDir, "CCOD_FULL_TEST.csv");
    writeFileSync(csvPath, CCOD_CSV);
    await loadCsv(DATASETS.ccod!, [csvPath], null);
  });

  it("loads every data row and drops the Row Count trailer", async () => {
    const rows = await query<{ n: bigint | number }>("SELECT COUNT(*) AS n FROM ccod");
    assert.equal(Number(rows[0]!.n), 3);
  });

  it("maps HMLR's parenthesised headers to canonical columns", async () => {
    const rows = await query<{ title_number: string; postcode: string; tenure: string }>(
      "SELECT title_number, postcode, tenure FROM ccod WHERE title_number = 'TS100001'",
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.postcode, "TS1 2AB");
    assert.equal(rows[0]!.tenure, "Freehold");
  });

  it("parses price paid as a number and leaves blanks null", async () => {
    const rows = await query<{ title_number: string; price_paid: number | null }>(
      "SELECT title_number, price_paid FROM ccod ORDER BY title_number",
    );
    const byTitle = Object.fromEntries(rows.map((r) => [r.title_number, r.price_paid]));
    assert.equal(byTitle.BA200003, 875000);
    assert.equal(byTitle.TS100001, 150000);
    assert.equal(byTitle.TS100002, null);
  });

  it("parses DD-MM-YYYY proprietor dates", async () => {
    const rows = await query<{ iso: string }>(
      "SELECT strftime(date_proprietor_added, '%Y-%m-%d') AS iso FROM ccod WHERE title_number = 'TS100001'",
    );
    assert.equal(rows[0]!.iso, "2019-03-15");
  });

  it("concatenates the three proprietor address lines", async () => {
    const rows = await query<{ addr: string }>(
      "SELECT proprietor_1_address AS addr FROM ccod WHERE title_number = 'TS100001'",
    );
    assert.equal(rows[0]!.addr, "1 CORPORATE WAY, LONDON, EC1A 1BB");
  });

  it("captures a second proprietor when present, and leaves it null otherwise", async () => {
    const rows = await query<{ title_number: string; second: string | null }>(
      "SELECT title_number, proprietor_2_name AS second FROM ccod ORDER BY title_number",
    );
    const byTitle = Object.fromEntries(rows.map((r) => [r.title_number, r.second]));
    assert.equal(byTitle.TS100002, "JOINT OWNER PLC");
    assert.equal(byTitle.TS100001, null);
  });

  it("finds all titles for a company across districts", async () => {
    const rows = await query<{ n: bigint | number }>(
      "SELECT COUNT(*) AS n FROM ccod WHERE upper(proprietor_1_name) LIKE '%EXAMPLE HOLDINGS%'",
    );
    assert.equal(Number(rows[0]!.n), 2);
  });

  after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(dataDir, { recursive: true, force: true });
  });
});
