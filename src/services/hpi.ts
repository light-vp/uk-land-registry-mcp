/**
 * UK House Price Index queries.
 *
 * The index is a linked-data cube: one observation per region per month,
 * carrying ~40 measures. Pulling all of them for a long period is wasteful, so
 * callers select measure groups and only those are projected.
 */

import { iri, num, runQuery, str, typedLit } from "./sparql.js";

/** Measure groups exposed to callers, mapped to UKHPI predicate local names. */
export const MEASURE_GROUPS = {
  headline: [
    "averagePrice",
    "housePriceIndex",
    "percentageChange",
    "percentageAnnualChange",
    "salesVolume",
  ],
  property_type: [
    "averagePriceDetached",
    "averagePriceSemiDetached",
    "averagePriceTerraced",
    "averagePriceFlatMaisonette",
    "percentageAnnualChangeDetached",
    "percentageAnnualChangeSemiDetached",
    "percentageAnnualChangeTerraced",
    "percentageAnnualChangeFlatMaisonette",
  ],
  buyer_status: [
    "averagePriceFirstTimeBuyer",
    "averagePriceFormerOwnerOccupier",
    "percentageAnnualChangeFirstTimeBuyer",
    "percentageAnnualChangeFormerOwnerOccupier",
  ],
  funding: [
    "averagePriceCash",
    "averagePriceMortgage",
    "percentageAnnualChangeCash",
    "percentageAnnualChangeMortgage",
  ],
  build_status: [
    "averagePriceNewBuild",
    "averagePriceExistingProperty",
    "salesVolumeNewBuild",
    "salesVolumeExistingProperty",
  ],
  seasonally_adjusted: ["averagePriceSA", "housePriceIndexSA"],
} as const;

export type MeasureGroup = keyof typeof MEASURE_GROUPS;

export const ALL_MEASURE_GROUPS = Object.keys(MEASURE_GROUPS) as MeasureGroup[];

const ALL_MEASURES: string[] = Object.values(MEASURE_GROUPS).flat();

/** Measures that are money amounts, for formatting. */
const MONEY_MEASURES = new Set<string>(
  ALL_MEASURES.filter((measure) => measure.startsWith("averagePrice")),
);

/** Measures that are percentages, for formatting. */
const PERCENT_MEASURES = new Set<string>(
  ALL_MEASURES.filter((measure) => measure.startsWith("percentage")),
);

export function isMoneyMeasure(measure: string): boolean {
  return MONEY_MEASURES.has(measure);
}

export function isPercentMeasure(measure: string): boolean {
  return PERCENT_MEASURES.has(measure);
}

/** Resolves measure group names to the flat list of predicates to project. */
export function measuresFor(groups: MeasureGroup[]): string[] {
  const seen = new Set<string>();
  for (const group of groups) {
    for (const measure of MEASURE_GROUPS[group]) seen.add(measure);
  }
  return [...seen];
}

export interface HpiRow {
  month: string;
  values: Record<string, number | null>;
}

/**
 * Fetches monthly index observations for one region.
 *
 * `refMonth` is an xsd:gYearMonth, which orders and compares correctly, so
 * date bounds are applied as typed literal comparisons rather than string
 * matching.
 */
export async function getHpiSeries(
  regionUri: string,
  monthFrom?: string,
  monthTo?: string,
  groups: MeasureGroup[] = ["headline"],
  limit = 600,
): Promise<HpiRow[]> {
  const measures = measuresFor(groups);

  const projections = measures.map((measure) => `?${measure}`).join(" ");
  const optionals = measures
    .map((measure) => `  OPTIONAL { ?obs ukhpi:${measure} ?${measure} }`)
    .join("\n");

  const bounds: string[] = [];
  if (monthFrom) {
    bounds.push(`  FILTER(?month >= ${typedLit(monthFrom, "xsd:gYearMonth")})`);
  }
  if (monthTo) {
    bounds.push(`  FILTER(?month <= ${typedLit(monthTo, "xsd:gYearMonth")})`);
  }

  const query = `SELECT ?month ${projections} WHERE {
  ?obs ukhpi:refRegion ${iri(regionUri)} ;
       ukhpi:refMonth ?month .
${bounds.join("\n")}
${optionals}
}
ORDER BY ?month
LIMIT ${Math.trunc(limit)}`;

  const results = await runQuery(query);

  return results.results.bindings.map((binding) => {
    const values: Record<string, number | null> = {};
    for (const measure of measures) {
      values[measure] = num(binding, measure);
    }
    return { month: str(binding, "month") ?? "", values };
  });
}

/** Fetches the single most recent observation for a region. */
export async function getLatestHpi(
  regionUri: string,
  groups: MeasureGroup[] = ["headline"],
): Promise<HpiRow | null> {
  const measures = measuresFor(groups);
  const projections = measures.map((measure) => `?${measure}`).join(" ");
  const optionals = measures
    .map((measure) => `  OPTIONAL { ?obs ukhpi:${measure} ?${measure} }`)
    .join("\n");

  const query = `SELECT ?month ${projections} WHERE {
  { SELECT ?obs ?month WHERE {
      ?obs ukhpi:refRegion ${iri(regionUri)} ;
           ukhpi:refMonth ?month .
    } ORDER BY DESC(?month) LIMIT 1 }
${optionals}
}`;

  const results = await runQuery(query);
  const binding = results.results.bindings[0];
  if (!binding) return null;

  const values: Record<string, number | null> = {};
  for (const measure of measures) values[measure] = num(binding, measure);
  return { month: str(binding, "month") ?? "", values };
}

/**
 * Returns the index value for a region in a given month, walking backwards up
 * to 12 months when the exact month has no published observation (the index is
 * revised and the most recent months lag).
 */
export async function getIndexValue(
  regionUri: string,
  month: string,
): Promise<{ month: string; index: number; averagePrice: number | null } | null> {
  const query = `SELECT ?month ?housePriceIndex ?averagePrice WHERE {
  ?obs ukhpi:refRegion ${iri(regionUri)} ;
       ukhpi:refMonth ?month ;
       ukhpi:housePriceIndex ?housePriceIndex .
  OPTIONAL { ?obs ukhpi:averagePrice ?averagePrice }
  FILTER(?month <= ${typedLit(month, "xsd:gYearMonth")})
}
ORDER BY DESC(?month)
LIMIT 1`;

  const results = await runQuery(query);
  const binding = results.results.bindings[0];
  if (!binding) return null;

  const index = num(binding, "housePriceIndex");
  if (index === null) return null;

  return {
    month: str(binding, "month") ?? month,
    index,
    averagePrice: num(binding, "averagePrice"),
  };
}

/** Converts an ISO date or year-month to the YYYY-MM the index is keyed on. */
export function toMonth(value: string): string {
  return value.slice(0, 7);
}

/** The current month, as YYYY-MM. */
export function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}
