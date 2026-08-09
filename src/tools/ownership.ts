/**
 * Group C — corporate and overseas property ownership (CCOD / OCOD).
 *
 * These read the local DuckDB cache, not a live API. HM Land Registry's
 * "Use land and property data" service publishes CCOD and OCOD as monthly bulk
 * files only — there is no query endpoint — so the data has to be downloaded
 * once with hmlr_download_dataset before these tools can answer anything.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { DATASETS, NOT_ADVICE_DISCLAIMER } from "../constants.js";
import {
  datasetChoiceField,
  limitField,
  offsetField,
  responseFormatField,
} from "../schemas/common.js";
import { likeContains, query, requireTable, sqlIdent, sqlLit } from "../services/cache.js";
import {
  gbp,
  guard,
  markdownTable,
  objectResponse,
  paginate,
  paginatedResponse,
  withAttribution,
} from "../services/format.js";
import { normalisePostcode } from "../services/postcodes.js";
import type { OwnershipRecord, Proprietor } from "../types.js";

const MAX_PROPRIETORS = 4;

/** Datasets to search, resolved from the 'ccod' | 'ocod' | 'both' choice. */
function datasetsFor(choice: "ccod" | "ocod" | "both"): Array<"ccod" | "ocod"> {
  return choice === "both" ? ["ccod", "ocod"] : [choice];
}

/** Ensures every requested dataset is cached, with actionable guidance if not. */
async function requireDatasets(keys: Array<"ccod" | "ocod">): Promise<void> {
  for (const key of keys) {
    await requireTable(DATASETS[key]!);
  }
}

/** The canonical column list selected from an ownership table. */
const OWNERSHIP_COLUMNS = [
  "title_number",
  "tenure",
  "property_address",
  "district",
  "county",
  "region",
  "postcode",
  "price_paid",
  "date_proprietor_added",
  "multiple_address_indicator",
  "additional_proprietor_indicator",
  "dataset",
  ...Array.from({ length: MAX_PROPRIETORS }, (_, i) => [
    `proprietor_${i + 1}_name`,
    `proprietor_${i + 1}_company_no`,
    `proprietor_${i + 1}_category`,
    `proprietor_${i + 1}_country`,
    `proprietor_${i + 1}_address`,
  ]).flat(),
];

const SELECT_LIST = OWNERSHIP_COLUMNS.map(sqlIdent).join(", ");

/** Builds a UNION ALL across the requested ownership tables. */
function unionSource(keys: Array<"ccod" | "ocod">, where: string): string {
  return keys
    .map(
      (key) =>
        `SELECT ${SELECT_LIST} FROM ${sqlIdent(DATASETS[key]!.table)} WHERE ${where}`,
    )
    .join("\n  UNION ALL\n  ");
}

/** Predicate matching any of the four proprietor-name columns. */
function proprietorNameMatch(name: string): string {
  return Array.from(
    { length: MAX_PROPRIETORS },
    (_, i) => `upper(${sqlIdent(`proprietor_${i + 1}_name`)}) LIKE upper(${likeContains(name)})`,
  ).join(" OR ");
}

/** Predicate matching any of the four company-number columns. */
function companyNumberMatch(number: string): string {
  const clean = number.trim().toUpperCase();
  return Array.from(
    { length: MAX_PROPRIETORS },
    (_, i) => `upper(TRIM(${sqlIdent(`proprietor_${i + 1}_company_no`)})) = ${sqlLit(clean)}`,
  ).join(" OR ");
}

/** Predicate matching any of the four country-of-incorporation columns. */
function jurisdictionMatch(jurisdiction: string): string {
  return Array.from(
    { length: MAX_PROPRIETORS },
    (_, i) => `upper(${sqlIdent(`proprietor_${i + 1}_country`)}) = upper(${sqlLit(jurisdiction)})`,
  ).join(" OR ");
}

/** Reshapes a flat database row into an OwnershipRecord with nested proprietors. */
function toRecord(row: Record<string, unknown>): OwnershipRecord {
  const text = (key: string): string | null => {
    const value = row[key];
    if (value === null || value === undefined) return null;
    const asString = String(value).trim();
    return asString.length > 0 ? asString : null;
  };

  const proprietors: Proprietor[] = [];
  for (let i = 1; i <= MAX_PROPRIETORS; i += 1) {
    const name = text(`proprietor_${i}_name`);
    if (!name) continue;
    proprietors.push({
      name,
      company_registration_no: text(`proprietor_${i}_company_no`),
      proprietorship_category: text(`proprietor_${i}_category`),
      country_incorporated: text(`proprietor_${i}_country`),
      address: text(`proprietor_${i}_address`),
    });
  }

  const price = row.price_paid;

  return {
    title_number: text("title_number") ?? "",
    tenure: text("tenure"),
    property_address: text("property_address"),
    district: text("district"),
    county: text("county"),
    region: text("region"),
    postcode: text("postcode"),
    price_paid: typeof price === "number" && Number.isFinite(price) ? price : null,
    date_proprietor_added: text("date_proprietor_added")?.slice(0, 10) ?? null,
    multiple_address_indicator: text("multiple_address_indicator"),
    additional_proprietor_indicator: text("additional_proprietor_indicator"),
    dataset: (text("dataset") as "ccod" | "ocod") ?? "ccod",
    proprietors,
  };
}

/** Runs a paginated ownership query and returns records plus the total. */
async function runOwnershipQuery(
  keys: Array<"ccod" | "ocod">,
  where: string,
  limit: number,
  offset: number,
): Promise<{ records: OwnershipRecord[]; total: number }> {
  const source = unionSource(keys, where);

  const countRows = await query<{ total: number | bigint }>(
    `SELECT COUNT(*) AS total FROM (\n  ${source}\n) AS combined`,
  );
  const total = Number(countRows[0]?.total ?? 0);

  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM (\n  ${source}\n) AS combined
     ORDER BY "title_number"
     LIMIT ${Math.trunc(limit)} OFFSET ${Math.trunc(offset)}`,
  );

  return { records: rows.map(toRecord), total };
}

function ownershipTable(records: OwnershipRecord[]): string {
  return markdownTable(
    ["Title", "Proprietor(s)", "Address", "Tenure", "Price paid", "Since", "Source"],
    records.map((record) => [
      record.title_number,
      record.proprietors
        .map((p) => `${p.name}${p.country_incorporated ? ` (${p.country_incorporated})` : ""}`)
        .join("; ") || "—",
      record.property_address,
      record.tenure,
      record.price_paid === null ? "—" : gbp(record.price_paid),
      record.date_proprietor_added ?? "—",
      record.dataset.toUpperCase(),
    ]),
  );
}

const CompanySearchFields = {
  company_name: z
    .string()
    .min(2)
    .max(160)
    .optional()
    .describe("Company name, matched as a case-insensitive substring, e.g. 'TESCO'."),
  company_number: z
    .string()
    .min(2)
    .max(20)
    .optional()
    .describe("Companies House registration number, matched exactly, e.g. '00445790'."),
  dataset: datasetChoiceField,
  limit: limitField,
  offset: offsetField,
  response_format: responseFormatField,
} as const;

const CompanySearchSchema = z
  .object(CompanySearchFields)
  .strict()
  .superRefine((value, context) => {
    if (!value.company_name && !value.company_number) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide `company_name` or `company_number`.",
      });
    }
  });

const AreaSearchFields = {
  postcode: z.string().min(2).max(10).optional().describe("Full postcode, or an outward code prefix like 'TS1'."),
  district: z.string().min(2).max(60).optional().describe("Local authority district."),
  county: z.string().min(2).max(60).optional().describe("County."),
  region: z.string().min(2).max(60).optional().describe("Region as recorded by HM Land Registry."),
  jurisdiction: z
    .string()
    .min(2)
    .max(60)
    .optional()
    .describe("Country of incorporation, for OCOD, e.g. 'JERSEY' or 'BRITISH VIRGIN ISLANDS'."),
  proprietor_category: z
    .string()
    .min(2)
    .max(80)
    .optional()
    .describe("Proprietorship category, e.g. 'Limited Company or Public Limited Company'."),
  dataset: datasetChoiceField,
  limit: limitField,
  offset: offsetField,
  response_format: responseFormatField,
} as const;

const AreaSearchSchema = z
  .object(AreaSearchFields)
  .strict()
  .superRefine((value, context) => {
    if (!value.postcode && !value.district && !value.county && !value.region) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide at least one area: postcode, district, county or region.",
      });
    }
  });

const OverseasSummaryFields = {
  district: z.string().min(2).max(60).optional().describe("Local authority district to summarise."),
  county: z.string().min(2).max(60).optional().describe("County to summarise."),
  postcode_prefix: z.string().min(2).max(8).optional().describe("Outward code, e.g. 'SW1'."),
  jurisdiction: z
    .string()
    .min(2)
    .max(60)
    .optional()
    .describe("Summarise the top areas for this country of incorporation instead."),
  limit: z.number().int().min(1).max(100).default(20).describe("Rows in the summary."),
  response_format: responseFormatField,
} as const;

const OverseasSummarySchema = z
  .object(OverseasSummaryFields)
  .strict()
  .superRefine((value, context) => {
    if (!value.district && !value.county && !value.postcode_prefix && !value.jurisdiction) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Provide an area (district, county or postcode_prefix) to break down by " +
          "jurisdiction, or a `jurisdiction` to see its top areas.",
      });
    }
  });

const TitleLookupFields = {
  title_number: z.string().min(3).max(20).describe("Land Registry title number, e.g. 'TS12345'."),
  response_format: responseFormatField,
} as const;

const TitleLookupSchema = z.object(TitleLookupFields).strict();

type CompanySearchInput = z.infer<typeof CompanySearchSchema>;
type AreaSearchInput = z.infer<typeof AreaSearchSchema>;
type OverseasSummaryInput = z.infer<typeof OverseasSummarySchema>;
type TitleLookupInput = z.infer<typeof TitleLookupSchema>;

export function registerOwnershipTools(server: McpServer): void {
  server.registerTool(
    "hmlr_search_company_properties",
    {
      title: "Find property owned by a company",
      description: `List the registered titles owned by a company, from HM Land Registry's corporate ownership datasets: CCOD (UK companies) and OCOD (overseas companies).

Requires the dataset to be cached first — run hmlr_download_dataset with dataset="ccod" and/or "ocod". Call hmlr_data_status if you are unsure what is available.

Args:
  - company_name (string, optional): case-insensitive substring match. Registered names include suffixes like 'LIMITED', so a partial name usually works best.
  - company_number (string, optional): exact Companies House number.
  - dataset ('ccod'|'ocod'|'both', default 'both')
  - limit (1-200, default 25), offset (default 0)
  - response_format ('markdown'|'json', default 'markdown')

Returns JSON with schema:
  {
    "total": number, "count": number, "offset": number, "has_more": boolean,
    "items": [{
      "title_number": string, "tenure": string|null, "property_address": string|null,
      "district": string|null, "county": string|null, "region": string|null, "postcode": string|null,
      "price_paid": number|null, "date_proprietor_added": "YYYY-MM-DD"|null,
      "dataset": "ccod"|"ocod",
      "proprietors": [{"name","company_registration_no","proprietorship_category","country_incorporated","address"}]
    }]
  }

Examples:
  - "What does Tesco own in England?" -> company_name="TESCO"
  - "Properties held by company 00445790" -> company_number="00445790"
  - Don't use when: you want everything corporate in an area (use hmlr_search_ownership_by_area).

Errors:
  - Explains the exact hmlr_download_dataset call to make when the dataset is not cached.

Licence note: CCOD/OCOD are free but carry HM Land Registry's own licence terms, including restrictions on republishing the data wholesale. You downloaded this under your own account and licence acceptance.`,
      inputSchema: CompanySearchFields,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guard(async (input: CompanySearchInput) => {
      const keys = datasetsFor(input.dataset);
      await requireDatasets(keys);

      const clauses: string[] = [];
      if (input.company_name) clauses.push(`(${proprietorNameMatch(input.company_name)})`);
      if (input.company_number) clauses.push(`(${companyNumberMatch(input.company_number)})`);
      const where = clauses.join(" AND ");

      const { records, total } = await runOwnershipQuery(keys, where, input.limit, input.offset);

      if (records.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `No titles found for ${input.company_name ?? input.company_number}. ` +
                "Registered proprietor names are stored as they appear on the register, " +
                "usually in upper case and including the suffix (e.g. 'TESCO STORES LIMITED'). " +
                "Try a shorter fragment of the name, or search the other dataset — " +
                "UK companies are in CCOD and overseas companies in OCOD.",
            },
          ],
          structuredContent: { total: 0, count: 0, offset: input.offset, has_more: false, items: [] },
        };
      }

      return paginatedResponse(
        paginate(records, total, input.offset),
        input.response_format,
        (page) =>
          withAttribution(
            [
              `# Titles owned by ${input.company_name ?? input.company_number}`,
              "",
              `Found **${total.toLocaleString("en-GB")}** title${total === 1 ? "" : "s"} (showing ${page.count}).`,
              "",
              ownershipTable(page.items),
              page.has_more ? `\n_More available — call again with offset=${page.next_offset}._` : null,
            ]
              .filter((line): line is string => line !== null)
              .join("\n"),
            NOT_ADVICE_DISCLAIMER,
          ),
      );
    }),
  );

  server.registerTool(
    "hmlr_search_ownership_by_area",
    {
      title: "Find corporately-owned property in an area",
      description: `List titles in an area that are held by companies rather than individuals, optionally filtered by the company's country of incorporation or proprietorship category.

Requires 'ccod' and/or 'ocod' to be cached (hmlr_download_dataset).

Note that only corporate ownership is published — titles held by private individuals are not in these datasets, by design. Absence from the results means "not corporately owned", not "not registered".

Args:
  - postcode (string, optional): full postcode, or an outward code prefix like 'TS1'.
  - district, county, region (string, optional): area filters, matched case-insensitively.
  - jurisdiction (string, optional): OCOD country of incorporation, e.g. 'JERSEY'.
  - proprietor_category (string, optional): e.g. 'Limited Company or Public Limited Company'.
  - dataset ('ccod'|'ocod'|'both', default 'both')
  - limit (1-200, default 25), offset (default 0)
  - response_format ('markdown'|'json', default 'markdown')

Returns the same item schema as hmlr_search_company_properties.

Examples:
  - "Who owns property in SW1 through offshore companies?" -> postcode="SW1", dataset="ocod"
  - "Corporate landlords in Middlesbrough" -> district="MIDDLESBROUGH", dataset="ccod"
  - "Jersey-registered owners in Westminster" -> district="WESTMINSTER", jurisdiction="JERSEY", dataset="ocod"

Errors:
  - Explains the required hmlr_download_dataset call when data is missing.`,
      inputSchema: AreaSearchFields,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guard(async (input: AreaSearchInput) => {
      const keys = datasetsFor(input.dataset);
      await requireDatasets(keys);

      const clauses: string[] = [];

      if (input.postcode) {
        const raw = input.postcode.trim().toUpperCase();
        const isFull = raw.replace(/\s+/g, "").length >= 5;
        if (isFull) {
          clauses.push(`upper(TRIM("postcode")) = ${sqlLit(normalisePostcode(raw))}`);
        } else {
          clauses.push(`upper("postcode") LIKE ${likeContains(raw)}`);
        }
      }
      if (input.district) clauses.push(`upper("district") = upper(${sqlLit(input.district)})`);
      if (input.county) clauses.push(`upper("county") = upper(${sqlLit(input.county)})`);
      if (input.region) clauses.push(`upper("region") = upper(${sqlLit(input.region)})`);
      if (input.jurisdiction) clauses.push(`(${jurisdictionMatch(input.jurisdiction)})`);
      if (input.proprietor_category) {
        const category = Array.from(
          { length: MAX_PROPRIETORS },
          (_, i) =>
            `upper(${sqlIdent(`proprietor_${i + 1}_category`)}) LIKE upper(${likeContains(input.proprietor_category!)})`,
        ).join(" OR ");
        clauses.push(`(${category})`);
      }

      const where = clauses.join(" AND ");
      const { records, total } = await runOwnershipQuery(keys, where, input.limit, input.offset);

      if (records.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "No corporately-owned titles match those filters. Remember these " +
                "datasets cover only companies — property held by individuals is not " +
                "included, so an empty result means no company owns registered title " +
                "there, not that the area is unregistered.",
            },
          ],
          structuredContent: { total: 0, count: 0, offset: input.offset, has_more: false, items: [] },
        };
      }

      return paginatedResponse(
        paginate(records, total, input.offset),
        input.response_format,
        (page) =>
          withAttribution(
            [
              "# Corporately-owned titles",
              "",
              `Found **${total.toLocaleString("en-GB")}** title${total === 1 ? "" : "s"} (showing ${page.count}).`,
              "",
              ownershipTable(page.items),
              page.has_more ? `\n_More available — call again with offset=${page.next_offset}._` : null,
            ]
              .filter((line): line is string => line !== null)
              .join("\n"),
            NOT_ADVICE_DISCLAIMER,
          ),
      );
    }),
  );

  server.registerTool(
    "hmlr_get_overseas_ownership_summary",
    {
      title: "Summarise overseas property ownership",
      description: `Aggregate view of the OCOD dataset: how many titles in an area are held by companies incorporated in each jurisdiction, or which areas a given jurisdiction's companies hold most property in.

Requires 'ocod' to be cached (hmlr_download_dataset with dataset="ocod" — it is the smallest of the bulk datasets).

Args:
  - district, county, postcode_prefix (string, optional): the area to break down by jurisdiction.
  - jurisdiction (string, optional): instead, show the top areas for this country of incorporation.
  - limit (1-100, default 20): rows in the summary.
  - response_format ('markdown'|'json', default 'markdown')

Returns JSON with schema:
  {
    "mode": "by_jurisdiction"|"by_area",
    "filter": string,
    "total_titles": number,
    "rows": [{"label": string, "titles": number, "share_pct": number,
              "median_price_paid": number|null}]
  }

Examples:
  - "Which countries own the most property in Westminster?" -> district="WESTMINSTER"
  - "Where do BVI companies own property?" -> jurisdiction="BRITISH VIRGIN ISLANDS"
  - "Offshore ownership in SW1" -> postcode_prefix="SW1"

Errors:
  - Explains the hmlr_download_dataset call needed when OCOD is not cached.`,
      inputSchema: OverseasSummaryFields,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guard(async (input: OverseasSummaryInput) => {
      await requireTable(DATASETS.ocod!);
      const table = sqlIdent(DATASETS.ocod!.table);

      const clauses: string[] = [];
      if (input.district) clauses.push(`upper("district") = upper(${sqlLit(input.district)})`);
      if (input.county) clauses.push(`upper("county") = upper(${sqlLit(input.county)})`);
      if (input.postcode_prefix) {
        clauses.push(`upper("postcode") LIKE ${likeContains(input.postcode_prefix.toUpperCase())}`);
      }

      const byArea = Boolean(input.jurisdiction);
      if (input.jurisdiction) clauses.push(`(${jurisdictionMatch(input.jurisdiction)})`);

      const where = clauses.length > 0 ? clauses.join(" AND ") : "TRUE";

      // Group by the first proprietor's jurisdiction (or the area, in by_area
      // mode); the vast majority of OCOD titles have a single proprietor.
      const groupExpression = byArea
        ? `COALESCE(NULLIF(TRIM("district"), ''), '(district not recorded)')`
        : `COALESCE(NULLIF(TRIM("proprietor_1_country"), ''), '(not recorded)')`;

      const rows = await query<{
        label: string;
        titles: number | bigint;
        median_price: number | null;
      }>(
        `SELECT ${groupExpression} AS label,
                COUNT(*) AS titles,
                MEDIAN("price_paid") AS median_price
         FROM ${table}
         WHERE ${where}
         GROUP BY 1
         ORDER BY titles DESC
         LIMIT ${Math.trunc(input.limit)}`,
      );

      const totalRows = await query<{ total: number | bigint }>(
        `SELECT COUNT(*) AS total FROM ${table} WHERE ${where}`,
      );
      const total = Number(totalRows[0]?.total ?? 0);

      if (total === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No OCOD titles match those filters.",
            },
          ],
          structuredContent: { mode: byArea ? "by_area" : "by_jurisdiction", total_titles: 0, rows: [] },
        };
      }

      const shaped = rows.map((row) => ({
        label: row.label,
        titles: Number(row.titles),
        share_pct: (Number(row.titles) / total) * 100,
        median_price_paid:
          typeof row.median_price === "number" && Number.isFinite(row.median_price)
            ? row.median_price
            : null,
      }));

      const filterLabel =
        input.jurisdiction ??
        input.district ??
        input.county ??
        input.postcode_prefix ??
        "England and Wales";

      const payload = {
        mode: byArea ? "by_area" : "by_jurisdiction",
        filter: filterLabel,
        total_titles: total,
        rows: shaped,
      };

      return objectResponse(payload, input.response_format, () =>
        withAttribution(
          [
            byArea
              ? `# Where ${filterLabel} companies own property`
              : `# Overseas ownership in ${filterLabel} by jurisdiction`,
            "",
            `**${total.toLocaleString("en-GB")}** overseas-owned titles in scope.`,
            "",
            markdownTable(
              [byArea ? "District" : "Jurisdiction", "Titles", "Share", "Median price paid"],
              shaped.map((row) => [
                row.label,
                row.titles.toLocaleString("en-GB"),
                `${row.share_pct.toFixed(1)}%`,
                gbp(row.median_price_paid),
              ]),
            ),
            "",
            "_Price paid is recorded only where HM Land Registry holds it, so medians " +
              "are based on a subset of titles._",
          ].join("\n"),
          NOT_ADVICE_DISCLAIMER,
        ),
      );
    }),
  );

  server.registerTool(
    "hmlr_get_title_ownership",
    {
      title: "Look up who owns a title number",
      description: `Look up a single Land Registry title number in the corporate ownership datasets: registered proprietors, company numbers, proprietorship category, country of incorporation and address for service.

Requires 'ccod' and/or 'ocod' to be cached. A title that is not found is most likely owned by a private individual — individual ownership is not published in these datasets.

Args:
  - title_number (string, required): e.g. 'TS12345'.
  - response_format ('markdown'|'json', default 'markdown')

Returns JSON with schema:
  {
    "found": boolean,
    "title_number": string,
    "record": {  // null when not found
      "title_number","tenure","property_address","district","county","region","postcode",
      "price_paid","date_proprietor_added","dataset",
      "proprietors": [{"name","company_registration_no","proprietorship_category","country_incorporated","address"}]
    }|null,
    "note": string
  }

Examples:
  - "Who owns title TS12345?" -> title_number="TS12345"
  - Use after hmlr_find_adjacent_parcels to identify a neighbouring owner.

Errors:
  - Explains the required hmlr_download_dataset call when neither dataset is cached.`,
      inputSchema: TitleLookupFields,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guard(async (input: TitleLookupInput) => {
      // Search whichever datasets happen to be cached rather than demanding both.
      const available: Array<"ccod" | "ocod"> = [];
      for (const key of ["ccod", "ocod"] as const) {
        try {
          await requireTable(DATASETS[key]!);
          available.push(key);
        } catch {
          continue;
        }
      }

      if (available.length === 0) {
        await requireTable(DATASETS.ccod!); // throws with full guidance
      }

      const titleNumber = input.title_number.trim().toUpperCase();
      const where = `upper(TRIM("title_number")) = ${sqlLit(titleNumber)}`;
      const { records } = await runOwnershipQuery(available, where, 5, 0);
      const record = records[0] ?? null;

      const payload = {
        found: record !== null,
        title_number: titleNumber,
        record,
        note:
          record === null
            ? "Not found in the corporate ownership datasets. This most often means " +
              "the title is held by one or more private individuals, whose names " +
              "HM Land Registry does not publish in bulk. An official copy of the " +
              "register (£3 via GOV.UK) will name the proprietor."
            : "Proprietor details are as recorded in the monthly bulk extract and may " +
              "lag the live register.",
      };

      return objectResponse(payload, input.response_format, () =>
        withAttribution(
          record === null
            ? `# Title ${titleNumber}\n\nNot found in ${available.map((a) => a.toUpperCase()).join(" or ")}.\n\n${payload.note}`
            : [
                `# Title ${record.title_number}`,
                "",
                `- **Address**: ${record.property_address ?? "—"}`,
                `- **Tenure**: ${record.tenure ?? "—"}`,
                `- **District**: ${record.district ?? "—"}`,
                `- **Price paid**: ${record.price_paid === null ? "—" : gbp(record.price_paid)}`,
                `- **Proprietor since**: ${record.date_proprietor_added ?? "—"}`,
                `- **Source**: ${record.dataset.toUpperCase()}`,
                "",
                "## Registered proprietors",
                "",
                markdownTable(
                  ["Name", "Company no.", "Category", "Incorporated in", "Address for service"],
                  record.proprietors.map((p) => [
                    p.name,
                    p.company_registration_no,
                    p.proprietorship_category,
                    p.country_incorporated,
                    p.address,
                  ]),
                ),
                "",
                `_${payload.note}_`,
              ].join("\n"),
          NOT_ADVICE_DISCLAIMER,
        ),
      );
    }),
  );
}
