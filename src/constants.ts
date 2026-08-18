/** Shared constants for the UK Land Registry MCP server. */

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

export const SERVER_NAME = "uk-land-registry-mcp";

/**
 * Read from package.json rather than restated here. When this was its own
 * literal it silently fell behind: 0.5.0 shipped introducing itself to clients
 * as 0.4.0, because `npm version` only rewrites package.json. The path holds in
 * both layouts — dist/constants.js and src/constants.ts each sit one level
 * below the manifest — and package.json is always in the published tarball.
 */
const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

export const SERVER_VERSION = version;

/** HM Land Registry Linked Data SPARQL endpoint. No authentication required. */
export const SPARQL_ENDPOINT =
  "https://landregistry.data.gov.uk/landregistry/query";

/** HM Land Registry "Use land and property data" API. Requires a free API key. */
export const ULPD_API_BASE = "https://use-land-property-data.service.gov.uk/api/v1";

/** Free postcode lookup service. No authentication required. */
export const POSTCODES_IO_BASE = "https://api.postcodes.io";

/** Where bulk datasets are cached locally. */
export const DATA_DIR: string =
  process.env.HMLR_DATA_DIR ?? join(homedir(), ".hmlr-mcp");

/** Maximum characters in any single tool response before truncation kicks in. */
export const CHARACTER_LIMIT = 25_000;

/** Network timeouts (ms). SPARQL aggregates over PPD can be genuinely slow. */
export const SPARQL_TIMEOUT_MS = 60_000;
export const HTTP_TIMEOUT_MS = 30_000;

/** Upper bound on rows pulled from SPARQL for a server-side aggregate. */
export const AGGREGATE_ROW_CAP = 20_000;

/** Attribution required by the Open Government Licence. */
export const CROWN_ATTRIBUTION =
  "Contains HM Land Registry data © Crown copyright and database right " +
  `${new Date().getFullYear()}. This data is licensed under the Open Government Licence v3.0.`;

export const OS_ATTRIBUTION =
  "Contains Ordnance Survey data © Crown copyright and database right. " +
  "Use of INSPIRE Index Polygon geometry is subject to Ordnance Survey licensing terms.";

export const NOT_ADVICE_DISCLAIMER =
  "This is information derived from published open data, not legal advice. " +
  "It is not a substitute for official Land Registry searches or a conveyancer's report.";

/** RDF namespaces used by the HMLR linked-data service. */
export const NS = {
  ppd: "http://landregistry.data.gov.uk/def/ppi/",
  common: "http://landregistry.data.gov.uk/def/common/",
  ukhpi: "http://landregistry.data.gov.uk/def/ukhpi/",
  region: "http://landregistry.data.gov.uk/id/region/",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
} as const;

/** Prefix block prepended to every SPARQL query. */
export const SPARQL_PREFIXES = `PREFIX ppd: <${NS.ppd}>
PREFIX lrcommon: <${NS.common}>
PREFIX ukhpi: <${NS.ukhpi}>
PREFIX rdfs: <${NS.rdfs}>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>`;

/**
 * Bulk datasets available through the "Use land and property data" API.
 * `apiName` is the dataset slug the API expects; `filePrefix` matches the
 * monthly full-file naming convention (e.g. CCOD_FULL_2024_06.zip).
 */
export interface DatasetSpec {
  readonly key: string;
  readonly apiName: string;
  readonly title: string;
  readonly filePrefix: string;
  /** Per-local-authority datasets need an area argument when downloading. */
  readonly perArea: boolean;
  /** Table name used in the local DuckDB cache. */
  readonly table: string;
  readonly notes: string;
}

export const DATASETS: Record<string, DatasetSpec> = {
  ccod: {
    key: "ccod",
    apiName: "ccod",
    title: "UK companies that own property in England and Wales",
    filePrefix: "CCOD_FULL",
    perArea: false,
    table: "ccod",
    notes: "Roughly 3.5 million rows. Expect a download of several hundred MB.",
  },
  ocod: {
    key: "ocod",
    apiName: "ocod",
    title: "Overseas companies that own property in England and Wales",
    filePrefix: "OCOD_FULL",
    perArea: false,
    table: "ocod",
    notes: "Roughly 100,000 rows. Small, fast download.",
  },
  leases: {
    key: "leases",
    apiName: "nps_leases",
    title: "National Polygon Service — registered leases",
    filePrefix: "LEASES_FULL",
    perArea: false,
    table: "leases",
    notes:
      "Registered leases dataset. Large. Availability depends on the licences " +
      "accepted on your Use land and property data account.",
  },
  covenants: {
    key: "covenants",
    apiName: "res_cov",
    title: "Restrictive covenants",
    filePrefix: "RES_COV_FULL",
    perArea: false,
    table: "covenants",
    notes:
      "Presence/absence indicator only — the dataset deliberately excludes the " +
      "wording of the covenant.",
  },
  inspire: {
    key: "inspire",
    apiName: "inspire",
    title: "INSPIRE Index Polygons (title boundaries)",
    filePrefix: "INSPIRE",
    perArea: true,
    table: "inspire",
    notes:
      "Published per local authority as GML. Requires the DuckDB spatial " +
      "extension, which is downloaded on first use.",
  },
};

/** Maps PPD property-type URIs to friendly names, and back. */
export const PROPERTY_TYPES: Record<string, string> = {
  detached: "detached",
  "semi-detached": "semi",
  terraced: "terraced",
  "flat-maisonette": "flat",
  otherPropertyType: "other",
};

export const PROPERTY_TYPE_TO_URI: Record<string, string> = {
  detached: "detached",
  semi: "semi-detached",
  terraced: "terraced",
  flat: "flat-maisonette",
  other: "otherPropertyType",
};
