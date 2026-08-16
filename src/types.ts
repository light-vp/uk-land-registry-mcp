/** Shared type definitions. */

export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

/** W3C SPARQL 1.1 Query Results JSON Format. */
export interface SparqlBindingValue {
  type: "uri" | "literal" | "bnode";
  value: string;
  datatype?: string;
  "xml:lang"?: string;
}

export interface SparqlResults {
  head: { vars: string[] };
  results: { bindings: Array<Record<string, SparqlBindingValue>> };
}

/** A single Price Paid Data transaction. */
export interface Transaction {
  transaction_id: string;
  /**
   * URI of the PPD address node. Price Paid Data sometimes records several
   * dwellings under one address string, so this is the only reliable way to
   * tell whether two sales are the same property.
   */
  address_id: string | null;
  price: number;
  date: string;
  property_type: string | null;
  tenure: string | null;
  new_build: boolean | null;
  transaction_category: string | null;
  address: PropertyAddress;
}

export interface PropertyAddress {
  paon: string | null;
  saon: string | null;
  street: string | null;
  locality: string | null;
  town: string | null;
  district: string | null;
  county: string | null;
  postcode: string | null;
  /** Single-line rendering, e.g. "FLAT 3, 12 HIGH STREET, BATH, BA1 1AA". */
  display: string;
}

/** One month of UK House Price Index observations for a region. */
export interface HpiObservation {
  month: string;
  region: string;
  region_uri: string;
  [measure: string]: string | number | null;
}

/** Result of a postcodes.io lookup. */
export interface PostcodeInfo {
  postcode: string;
  latitude: number | null;
  longitude: number | null;
  eastings: number | null;
  northings: number | null;
  country: string | null;
  region: string | null;
  admin_district: string | null;
  admin_county: string | null;
  admin_ward: string | null;
  parliamentary_constituency: string | null;
  lsoa: string | null;
  msoa: string | null;
  outcode: string | null;
  incode: string | null;
  /** Postcode sector, e.g. "BA1 1" — the natural unit for local area stats. */
  sector: string | null;
  codes: Record<string, string> | null;
}

/** A title-ownership row from CCOD or OCOD. */
export interface OwnershipRecord {
  title_number: string;
  tenure: string | null;
  property_address: string | null;
  district: string | null;
  county: string | null;
  region: string | null;
  postcode: string | null;
  price_paid: number | null;
  date_proprietor_added: string | null;
  multiple_address_indicator: string | null;
  additional_proprietor_indicator: string | null;
  dataset: "ccod" | "ocod";
  proprietors: Proprietor[];
}

export interface Proprietor {
  name: string | null;
  company_registration_no: string | null;
  proprietorship_category: string | null;
  country_incorporated: string | null;
  address: string | null;
}

/** Standard envelope for paginated list responses. */
export interface Paginated<T> {
  total: number;
  count: number;
  offset: number;
  has_more: boolean;
  next_offset?: number;
  truncated?: boolean;
  truncation_message?: string;
  items: T[];
}

/** Thrown when a tool needs a bulk dataset the user has not downloaded yet. */
export class DatasetNotCachedError extends Error {
  constructor(
    public readonly datasetKey: string,
    public readonly area?: string,
  ) {
    const areaArg = area ? `, area="${area}"` : "";
    super(
      `The "${datasetKey}" dataset is not in the local cache. ` +
        `Run hmlr_download_dataset with dataset="${datasetKey}"${areaArg} first, ` +
        `then retry. Use hmlr_data_status to see what is already cached.`,
    );
    this.name = "DatasetNotCachedError";
  }
}

/** Thrown when an API key is required but not configured. */
export class MissingApiKeyError extends Error {
  constructor(datasetKey?: string) {
    const forWhat = datasetKey ? ` to access the "${datasetKey}" dataset` : "";
    super(
      `No HM Land Registry API key is configured${forWhat}. ` +
        "This is free: register at https://use-land-property-data.service.gov.uk/, " +
        "accept the licence for the dataset you need, copy your API key from your " +
        "account page, and set it as the HMLR_API_KEY environment variable in your " +
        "MCP client config. Price Paid Data, the House Price Index and postcode " +
        "lookups need no key and work without this step.",
    );
    this.name = "MissingApiKeyError";
  }
}

/** Thrown when a query would be too broad to answer reliably. */
export class QueryTooBroadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryTooBroadError";
  }
}
