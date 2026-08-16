/**
 * Price Paid Data query construction.
 *
 * The HMLR SPARQL endpoint will happily accept a query with no locality
 * filter and then time out on it — PPD holds ~30 million transactions. Every
 * search therefore requires at least one selective filter, and that constraint
 * is enforced here rather than being left to the caller to discover.
 */

import { AGGREGATE_ROW_CAP, NS, PROPERTY_TYPES, PROPERTY_TYPE_TO_URI } from "../constants.js";
import { QueryTooBroadError, type PropertyAddress, type Transaction } from "../types.js";
import { normalisePostcode } from "./postcodes.js";
import { bool, iri, lit, localName, num, runQuery, str, typedLit } from "./sparql.js";

export interface TransactionFilters {
  postcode?: string;
  /**
   * Postcode sector ("TS1 2") or outward code ("TS1"). Matched as a prefix,
   * which cannot use an index, so a district/town/county anchor is required
   * alongside it — see assertSelective.
   */
  postcode_prefix?: string;
  street?: string;
  town?: string;
  district?: string;
  /**
   * Several candidate districts, bound with VALUES. An outward code can span
   * more than one local authority, and picking just the first would silently
   * drop transactions in the others.
   */
  districts?: string[];
  county?: string;
  paon?: string;
  saon?: string;
  date_from?: string;
  date_to?: string;
  min_price?: number;
  max_price?: number;
  property_type?: string;
  new_build?: boolean;
  tenure?: string;
  /**
   * HMLR category A ("standard") is an arm's-length sale of a residential
   * property at full market value. Category B ("additional") covers
   * repossessions, buy-to-lets, transfers to companies and commercial
   * property, and will badly skew a median if left in.
   */
  transaction_category?: "standard" | "additional";
}

export type SortOrder = "date_desc" | "date_asc" | "price_desc" | "price_asc";

const SORT_CLAUSES: Record<SortOrder, string> = {
  date_desc: "ORDER BY DESC(?date) DESC(?amount)",
  date_asc: "ORDER BY ?date ?amount",
  price_desc: "ORDER BY DESC(?amount) DESC(?date)",
  price_asc: "ORDER BY ?amount ?date",
};

/**
 * True when the filter set is selective enough to run. A postcode, or a street
 * combined with a town/district, keeps the query on an index; a bare town is
 * allowed only alongside a date range.
 */
function isSelective(filters: TransactionFilters): boolean {
  if (filters.postcode) return true;
  if (filters.street && hasAreaAnchor(filters)) return true;
  // An anchored prefix scan is cheap: the same sector count runs in about a
  // second against a district, versus 30 seconds unanchored.
  if (filters.postcode_prefix && hasAreaAnchor(filters)) return true;
  if (hasAreaAnchor(filters) && (filters.date_from || filters.date_to)) return true;
  return false;
}

/** Anchors a prefix match can be attached to without forcing a full scan. */
function hasAreaAnchor(filters: TransactionFilters): boolean {
  return Boolean(
    filters.district ||
      filters.town ||
      filters.county ||
      (filters.districts && filters.districts.length > 0),
  );
}

function assertSelective(filters: TransactionFilters): void {
  // A prefix match is a scan unless an indexed area triple runs first: the
  // same sector count takes 30s unanchored and 1s anchored to a district.
  if (filters.postcode_prefix && !hasAreaAnchor(filters)) {
    throw new QueryTooBroadError(
      `Filtering by the postcode prefix "${filters.postcode_prefix}" also needs a ` +
        "district, town or county to anchor it, otherwise the query scans every " +
        "address in England and Wales and times out. Call hmlr_lookup_postcode " +
        "with any postcode in that area to get its admin_district, and pass that " +
        "as `district`.",
    );
  }

  if (isSelective(filters)) return;
  throw new QueryTooBroadError(
    "This search is too broad for the Land Registry endpoint and would time out. " +
      "Narrow it with at least one of:\n" +
      "  • a postcode (most reliable), or\n" +
      "  • a street plus a town, district or county, or\n" +
      "  • a town or district plus a date range (date_from / date_to).\n" +
      "If you only know the area, call hmlr_lookup_postcode first to get the " +
      "district, or use hmlr_get_area_stats for an aggregate view.",
  );
}

/**
 * Builds the address-matching triples shared by all PPD queries.
 *
 * Ordered most-selective-first: the anchor triples (district/town/county) are
 * emitted before the prefix FILTER so the planner narrows before scanning.
 */
function addressPatterns(filters: TransactionFilters): string[] {
  const patterns: string[] = [];

  // Exact-match fields use a bound triple, which the endpoint can index.
  if (filters.postcode) {
    patterns.push(`?address lrcommon:postcode ${lit(normalisePostcode(filters.postcode))} .`);
  }
  if (filters.street) {
    patterns.push(`?address lrcommon:street ${lit(filters.street.toUpperCase())} .`);
  }
  if (filters.town) {
    patterns.push(`?address lrcommon:town ${lit(filters.town.toUpperCase())} .`);
  }
  if (filters.district) {
    patterns.push(`?address lrcommon:district ${lit(filters.district.toUpperCase())} .`);
  }
  if (filters.districts && filters.districts.length > 0) {
    const values = filters.districts.map((d) => lit(d.toUpperCase())).join(" ");
    patterns.push(`VALUES ?districtValue { ${values} }`);
    patterns.push(`?address lrcommon:district ?districtValue .`);
  }
  if (filters.county) {
    patterns.push(`?address lrcommon:county ${lit(filters.county.toUpperCase())} .`);
  }
  if (filters.paon) {
    patterns.push(`?address lrcommon:paon ${lit(filters.paon.toUpperCase())} .`);
  }
  if (filters.saon) {
    patterns.push(`?address lrcommon:saon ${lit(filters.saon.toUpperCase())} .`);
  }

  // Prefix match goes last, once the anchors above have narrowed the set.
  if (filters.postcode_prefix) {
    const prefix = filters.postcode_prefix.toUpperCase().trim();
    patterns.push(`?address lrcommon:postcode ?pcprefix .`);
    patterns.push(`FILTER(STRSTARTS(?pcprefix, ${lit(prefix)}))`);
  }

  return patterns;
}

/** Builds the transaction-level triples and FILTER clauses, kept separate so
 * bound triples can be emitted before FILTERs. */
function transactionPatterns(filters: TransactionFilters): {
  triples: string[];
  filters: string[];
} {
  const patterns: string[] = [];
  const filterClauses: string[] = [];

  if (filters.transaction_category) {
    const slug =
      filters.transaction_category === "standard"
        ? "standardPricePaidTransaction"
        : "additionalPricePaidTransaction";
    patterns.push(`?record ppd:transactionCategory ${iri(NS.ppd + slug)} .`);
  }

  if (filters.property_type) {
    const slug = PROPERTY_TYPE_TO_URI[filters.property_type];
    if (!slug) {
      throw new QueryTooBroadError(
        `Unknown property_type "${filters.property_type}". Use one of: ${Object.keys(
          PROPERTY_TYPE_TO_URI,
        ).join(", ")}.`,
      );
    }
    patterns.push(`?record ppd:propertyType ${iri(NS.common + slug)} .`);
  }

  if (filters.tenure) {
    if (filters.tenure !== "freehold" && filters.tenure !== "leasehold") {
      throw new QueryTooBroadError(
        `Unknown tenure "${filters.tenure}". Use 'freehold' or 'leasehold'.`,
      );
    }
    patterns.push(`?record ppd:estateType ${iri(NS.common + filters.tenure)} .`);
  }

  if (filters.new_build !== undefined) {
    patterns.push(
      `?record ppd:newBuild ${typedLit(String(filters.new_build), "xsd:boolean")} .`,
    );
  }

  if (filters.date_from) {
    filterClauses.push(`FILTER(?date >= ${typedLit(filters.date_from, "xsd:date")})`);
  }
  if (filters.date_to) {
    filterClauses.push(`FILTER(?date <= ${typedLit(filters.date_to, "xsd:date")})`);
  }
  if (filters.min_price !== undefined) {
    filterClauses.push(`FILTER(?amount >= ${Math.trunc(filters.min_price)})`);
  }
  if (filters.max_price !== undefined) {
    filterClauses.push(`FILTER(?amount <= ${Math.trunc(filters.max_price)})`);
  }

  return { triples: patterns, filters: filterClauses };
}

/**
 * The core graph pattern.
 *
 * Triple order is load-bearing, not cosmetic. The endpoint evaluates patterns
 * roughly in written order, so the selective address triples must come first:
 * an identical query with the postcode filter written last takes over 70
 * seconds and times out, against 0.3 seconds when it is written first.
 * Likewise `?record a ppd:TransactionRecord` is deliberately omitted —
 * ppd:propertyAddress already implies the type, and the type triple alone
 * matches ~30 million rows.
 */
type QueryVariant = "full" | "count" | "aggregate";

const OPTIONAL_BLOCKS: Record<QueryVariant, string[]> = {
  count: [],
  aggregate: [
    "OPTIONAL { ?record ppd:propertyType ?ptype }",
    "OPTIONAL { ?record ppd:estateType ?tenure }",
    "OPTIONAL { ?record ppd:newBuild ?newBuild }",
    "OPTIONAL { ?address lrcommon:postcode ?postcode }",
  ],
  full: [
    "OPTIONAL { ?record ppd:propertyType ?ptype }",
    "OPTIONAL { ?record ppd:estateType ?tenure }",
    "OPTIONAL { ?record ppd:newBuild ?newBuild }",
    "OPTIONAL { ?record ppd:transactionCategory ?category }",
    "OPTIONAL { ?address lrcommon:paon ?paon }",
    "OPTIONAL { ?address lrcommon:saon ?saon }",
    "OPTIONAL { ?address lrcommon:street ?street }",
    "OPTIONAL { ?address lrcommon:locality ?locality }",
    "OPTIONAL { ?address lrcommon:town ?town }",
    "OPTIONAL { ?address lrcommon:district ?district }",
    "OPTIONAL { ?address lrcommon:county ?county }",
    "OPTIONAL { ?address lrcommon:postcode ?postcode }",
  ],
};

function whereClause(filters: TransactionFilters, variant: QueryVariant = "full"): string {
  const { triples, filters: filterClauses } = transactionPatterns(filters);

  const patterns = [
    // 1. Most selective first: exact address matches.
    ...addressPatterns(filters),
    // 2. Join to the transaction record.
    "?record ppd:propertyAddress ?address ;",
    "        ppd:pricePaid ?amount ;",
    "        ppd:transactionDate ?date ;",
    "        ppd:transactionId ?txid .",
    // 3. Further bound triples, then range filters.
    ...triples,
    ...filterClauses,
    // 4. Optional projections last — they cannot restrict the result set.
    ...OPTIONAL_BLOCKS[variant],
  ];
  return patterns.join("\n  ");
}

const SELECT_VARS =
  "?txid ?amount ?date ?ptype ?tenure ?newBuild ?category ?address " +
  "?paon ?saon ?street ?locality ?town ?district ?county ?postcode";

/** Renders a BS7666 address as a single readable line. */
export function displayAddress(address: Omit<PropertyAddress, "display">): string {
  const premises = [address.saon, address.paon].filter(Boolean).join(", ");
  const parts = [
    premises && address.street ? `${premises} ${address.street}` : premises || address.street,
    address.locality && address.locality !== address.town ? address.locality : null,
    address.town,
    address.postcode,
  ].filter((part): part is string => Boolean(part));
  return parts.join(", ") || "Address not recorded";
}

function toTransaction(binding: Record<string, import("../types.js").SparqlBindingValue>): Transaction {
  const address: Omit<PropertyAddress, "display"> = {
    paon: str(binding, "paon"),
    saon: str(binding, "saon"),
    street: str(binding, "street"),
    locality: str(binding, "locality"),
    town: str(binding, "town"),
    district: str(binding, "district"),
    county: str(binding, "county"),
    postcode: str(binding, "postcode"),
  };

  const rawType = localName(binding, "ptype");

  return {
    transaction_id: str(binding, "txid") ?? "",
    address_id: str(binding, "address"),
    price: num(binding, "amount") ?? 0,
    date: str(binding, "date") ?? "",
    property_type: rawType ? (PROPERTY_TYPES[rawType] ?? rawType) : null,
    tenure: localName(binding, "tenure"),
    new_build: bool(binding, "newBuild"),
    transaction_category: localName(binding, "category"),
    address: { ...address, display: displayAddress(address) },
  };
}

/** Runs a filtered PPD search with sorting and pagination. */
export async function searchTransactions(
  filters: TransactionFilters,
  sort: SortOrder,
  limit: number,
  offset: number,
): Promise<Transaction[]> {
  assertSelective(filters);

  const query = `SELECT ${SELECT_VARS} WHERE {
  ${whereClause(filters)}
}
${SORT_CLAUSES[sort]}
LIMIT ${Math.trunc(limit)}
OFFSET ${Math.trunc(offset)}`;

  const results = await runQuery(query);
  return results.results.bindings.map(toTransaction);
}

/**
 * Counts matching transactions. Returns null rather than failing when the
 * count is too expensive — the caller still has the page of results, and a
 * missing total is better than a failed search.
 */
export async function countTransactions(
  filters: TransactionFilters,
): Promise<number | null> {
  assertSelective(filters);

  const query = `SELECT (COUNT(*) AS ?total) WHERE {
  ${whereClause(filters, "count")}
}`;

  try {
    const results = await runQuery(query, 25_000);
    return num(results.results.bindings[0], "total");
  } catch {
    return null;
  }
}

/**
 * Fetches every transaction matching the filters, up to AGGREGATE_ROW_CAP.
 * Used for statistics that SPARQL cannot compute (medians, quantiles).
 */
export async function fetchForAggregate(
  filters: TransactionFilters,
): Promise<{ transactions: Transaction[]; capped: boolean }> {
  assertSelective(filters);

  const query = `SELECT ?txid ?amount ?date ?ptype ?tenure ?newBuild ?postcode WHERE {
  ${whereClause(filters, "aggregate")}
}
ORDER BY ?date
LIMIT ${AGGREGATE_ROW_CAP + 1}`;

  const results = await runQuery(query);
  const rows = results.results.bindings.map(toTransaction);
  const capped = rows.length > AGGREGATE_ROW_CAP;
  return { transactions: capped ? rows.slice(0, AGGREGATE_ROW_CAP) : rows, capped };
}

/**
 * Decides whether a run of sales can be treated as one dwelling's history.
 *
 * Price Paid Data does not guarantee that one address string means one
 * property. A Georgian townhouse converted into flats, whose units were
 * registered without SAONs, produces a dozen sales under a single address;
 * differencing those prices yields figures like "-75% in a month" that
 * describe two different flats rather than any change in value. Appreciation
 * is therefore withheld unless the sales can be attributed to one dwelling.
 *
 * Note that distinct address *nodes* are not evidence of distinct dwellings:
 * HMLR routinely holds two nodes for the same address differing only in an
 * administrative field such as `locality`. The identifying fields are
 * compared instead.
 */
export function assessSingleProperty(
  sales: Transaction[],
  saonProvided: boolean,
): { single: boolean; reasons: string[]; distinctAddresses: number } {
  const dwellingKey = (sale: Transaction): string =>
    [sale.address.saon, sale.address.paon, sale.address.street, sale.address.postcode]
      .map((part) => (part ?? "").trim().toUpperCase())
      .join("|");

  const distinctAddresses = new Set(sales.map(dwellingKey)).size;
  const looksLikeFlats = sales.some((sale) => sale.property_type === "flat");
  const reasons: string[] = [];

  if (distinctAddresses > 1) {
    reasons.push(
      `these sales span ${distinctAddresses} different addresses, so they are not ` +
        "all the same registered property",
    );
  }
  if (looksLikeFlats && !saonProvided) {
    reasons.push(
      "the sales are of flats and no `saon` (unit number) was given, so this address " +
        "may cover every flat in the building rather than one of them",
    );
  }

  return { single: reasons.length === 0, reasons, distinctAddresses };
}

/** Median of a numeric array. Returns null for an empty array. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
    : sorted[mid]!;
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

/** Compound annual growth rate between two prices, as a percentage. */
export function annualisedGrowth(
  fromPrice: number,
  fromDate: string,
  toPrice: number,
  toDate: string,
): number | null {
  const start = new Date(fromDate).getTime();
  const end = new Date(toDate).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  if (fromPrice <= 0) return null;
  const years = (end - start) / (365.2425 * 24 * 60 * 60 * 1000);
  if (years < 0.08) return null;
  return (Math.pow(toPrice / fromPrice, 1 / years) - 1) * 100;
}
