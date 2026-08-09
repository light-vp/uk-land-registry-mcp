#!/usr/bin/env node
/**
 * Verifies that the answers in evaluation.xml are still factually correct.
 *
 * This does NOT run the evaluation — scoring whether a model can find the
 * answers needs a model and a harness. What it does is re-derive each expected
 * answer from the live endpoints, so the file cannot quietly go stale when
 * HM Land Registry revises the House Price Index or a late registration
 * changes a historical record.
 *
 * Usage:  node scripts/verify-evaluation.mjs
 * Exits non-zero if any answer no longer holds.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const { getHpiSeries, getIndexValue } = await import(join(root, "dist/services/hpi.js"));
const { searchTransactions } = await import(join(root, "dist/services/ppd.js"));
const { lookupPostcode } = await import(join(root, "dist/services/postcodes.js"));
const { resolveRegion } = await import(join(root, "dist/services/regions.js"));

const REGION = "http://landregistry.data.gov.uk/id/region/";

/** One derivation per expected answer in evaluation.xml, in file order. */
const checks = [
  {
    label: "Middlesbrough average price, January 2020",
    expected: "105226",
    async derive() {
      const info = await lookupPostcode("TS1 2AB");
      const region = await resolveRegion(info.admin_district);
      const [row] = await getHpiSeries(region.uri, "2020-01", "2020-01", ["headline"]);
      return String(row.values.averagePrice);
    },
  },
  {
    label: "Price of the single 2017 BA1 1AA transaction",
    expected: "1183255",
    async derive() {
      const [row] = await searchTransactions(
        { postcode: "BA1 1AA", date_from: "2017-01-01", date_to: "2017-12-31" },
        "date_desc",
        5,
        0,
      );
      return String(row.price);
    },
  },
  {
    label: "Earliest sale price, 52 Coates Avenue TS4 3AQ",
    expected: "186100",
    async derive() {
      const [row] = await searchTransactions(
        { postcode: "TS4 3AQ", paon: "52" },
        "date_asc",
        5,
        0,
      );
      return String(row.price);
    },
  },
  {
    label: "£186,100 (Jul 2022) restated in June 2024 money, Middlesbrough",
    expected: "186676",
    async derive() {
      const from = await getIndexValue(`${REGION}middlesbrough`, "2022-07");
      const to = await getIndexValue(`${REGION}middlesbrough`, "2024-06");
      return String(Math.round((186100 * to.index) / from.index));
    },
  },
  {
    label: "England sales volume, February 1997",
    expected: "66246",
    async derive() {
      const [row] = await getHpiSeries(`${REGION}england`, "1997-02", "1997-02", ["headline"]);
      return String(row.values.salesVolume);
    },
  },
  {
    label: "England minus Middlesbrough average price, January 2020",
    expected: "128823",
    async derive() {
      const [england] = await getHpiSeries(`${REGION}england`, "2020-01", "2020-01", ["headline"]);
      const [boro] = await getHpiSeries(`${REGION}middlesbrough`, "2020-01", "2020-01", ["headline"]);
      return String(england.values.averagePrice - boro.values.averagePrice);
    },
  },
  {
    label: "Parliamentary constituency for TS1 2AB",
    expected: "Middlesbrough and Thornaby East",
    async derive() {
      const info = await lookupPostcode("TS1 2AB");
      return info.parliamentary_constituency;
    },
  },
  {
    label: "England average price, February 1997",
    expected: "53060",
    async derive() {
      const [row] = await getHpiSeries(`${REGION}england`, "1997-02", "1997-02", ["headline"]);
      return String(row.values.averagePrice);
    },
  },
  {
    label: "Building name of the 2017 BA1 1AA transaction",
    expected: "ROYAL MAIL DELIVERY OFFICE",
    async derive() {
      const [row] = await searchTransactions(
        { postcode: "BA1 1AA", date_from: "2017-01-01", date_to: "2017-12-31" },
        "date_desc",
        5,
        0,
      );
      return row.address.paon;
    },
  },
  {
    label: "Middlesbrough house price index value, July 2022",
    expected: "96.9",
    async derive() {
      const value = await getIndexValue(`${REGION}middlesbrough`, "2022-07");
      return String(value.index);
    },
  },
];

/** Pulls the <answer> values out of evaluation.xml, in document order. */
async function answersFromFile() {
  const xml = await readFile(join(root, "evaluation.xml"), "utf8");
  return [...xml.matchAll(/<answer>([\s\S]*?)<\/answer>/g)].map((match) => match[1].trim());
}

const fileAnswers = await answersFromFile();

if (fileAnswers.length !== checks.length) {
  console.error(
    `evaluation.xml has ${fileAnswers.length} answers but this script knows how to ` +
      `derive ${checks.length}. Update scripts/verify-evaluation.mjs to match.`,
  );
  process.exit(1);
}

let failures = 0;

for (const [index, check] of checks.entries()) {
  const fromFile = fileAnswers[index];

  if (fromFile !== check.expected) {
    console.error(
      `✖ ${check.label}\n    evaluation.xml says "${fromFile}" but this script expects ` +
        `"${check.expected}" — the two have drifted apart.`,
    );
    failures += 1;
    continue;
  }

  try {
    const actual = await check.derive();
    if (String(actual) === check.expected) {
      console.log(`✔ ${check.label} = ${actual}`);
    } else {
      console.error(`✖ ${check.label}\n    expected "${check.expected}", endpoint now returns "${actual}"`);
      failures += 1;
    }
  } catch (error) {
    console.error(`✖ ${check.label}\n    derivation failed: ${error.message}`);
    failures += 1;
  }
}

console.log(
  failures === 0
    ? `\nAll ${checks.length} evaluation answers still hold.`
    : `\n${failures} of ${checks.length} evaluation answers no longer hold.`,
);

process.exit(failures === 0 ? 0 : 1);
