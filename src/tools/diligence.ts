/**
 * Group E — due-diligence flags from the registered leases and restrictive
 * covenants bulk datasets.
 *
 * Both datasets sit behind an account login, and HM Land Registry has changed
 * their column layouts between releases, so these tools discover the available
 * columns at runtime rather than assuming a fixed schema. That keeps them
 * working across releases at the cost of returning whatever fields the current
 * file happens to carry.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { DATASETS, NOT_ADVICE_DISCLAIMER } from "../constants.js";
import { responseFormatField } from "../schemas/common.js";
import { likeContains, query, requireTable, sqlIdent, sqlLit } from "../services/cache.js";
import { guard, markdownTable, objectResponse, withAttribution } from "../services/format.js";
import { normalisePostcode } from "../services/postcodes.js";

/** Columns present in a cached table, lower-cased. */
async function columnsOf(table: string): Promise<string[]> {
  const rows = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = ${sqlLit(table)} ORDER BY ordinal_position`,
  );
  return rows.map((row) => row.column_name);
}

/** Finds the first column whose name contains any of the given fragments. */
function findColumn(columns: string[], fragments: string[]): string | null {
  for (const fragment of fragments) {
    const match = columns.find((column) => column.toLowerCase().includes(fragment));
    if (match) return match;
  }
  return null;
}

/**
 * Builds the WHERE clause for a title-number or address lookup against a
 * schema we discovered rather than declared.
 */
function buildLookup(
  columns: string[],
  titleNumber: string | undefined,
  postcode: string | undefined,
  address: string | undefined,
): { where: string; matchedOn: string } {
  const clauses: string[] = [];
  const matchedOn: string[] = [];

  if (titleNumber) {
    const column = findColumn(columns, ["title_number", "titleno", "title"]);
    if (!column) {
      throw new Error(
        `This dataset has no title-number column. Available columns: ${columns.join(", ")}.`,
      );
    }
    clauses.push(`upper(TRIM(${sqlIdent(column)})) = ${sqlLit(titleNumber.trim().toUpperCase())}`);
    matchedOn.push(`title number (${column})`);
  }

  if (postcode) {
    const column = findColumn(columns, ["postcode", "post_code"]);
    if (!column) {
      throw new Error(
        `This dataset has no postcode column. Available columns: ${columns.join(", ")}.`,
      );
    }
    clauses.push(`upper(TRIM(${sqlIdent(column)})) = ${sqlLit(normalisePostcode(postcode))}`);
    matchedOn.push(`postcode (${column})`);
  }

  if (address) {
    const column = findColumn(columns, ["address", "property"]);
    if (!column) {
      throw new Error(
        `This dataset has no address column. Available columns: ${columns.join(", ")}.`,
      );
    }
    clauses.push(`upper(${sqlIdent(column)}) LIKE upper(${likeContains(address)})`);
    matchedOn.push(`address (${column})`);
  }

  if (clauses.length === 0) {
    throw new Error("Provide title_number, postcode or address.");
  }

  return { where: clauses.join(" AND "), matchedOn: matchedOn.join(", ") };
}

const LookupFields = {
  title_number: z.string().min(3).max(20).optional().describe("Land Registry title number."),
  postcode: z.string().min(5).max(10).optional().describe("Full postcode of the property."),
  address: z
    .string()
    .min(3)
    .max(200)
    .optional()
    .describe("Address fragment, matched case-insensitively."),
  limit: z.number().int().min(1).max(50).default(10).describe("Maximum matching records."),
  response_format: responseFormatField,
} as const;

const LookupSchema = z
  .object(LookupFields)
  .strict()
  .superRefine((value, context) => {
    if (!value.title_number && !value.postcode && !value.address) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide at least one of `title_number`, `postcode` or `address`.",
      });
    }
  });

type LookupInput = z.infer<typeof LookupSchema>;

/** Shared implementation for both flag tools. */
async function runFlagLookup(
  datasetKey: "leases" | "covenants",
  input: LookupInput,
): Promise<{ payload: Record<string, unknown>; rows: Array<Record<string, unknown>>; columns: string[] }> {
  const spec = DATASETS[datasetKey]!;
  await requireTable(spec);

  const columns = await columnsOf(spec.table);
  const { where, matchedOn } = buildLookup(
    columns,
    input.title_number,
    input.postcode,
    input.address,
  );

  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM ${sqlIdent(spec.table)} WHERE ${where} LIMIT ${Math.trunc(input.limit)}`,
  );

  const payload = {
    dataset: datasetKey,
    found: rows.length > 0,
    match_count: rows.length,
    matched_on: matchedOn,
    available_columns: columns,
    records: rows,
  };

  return { payload, rows, columns };
}

/** Renders discovered rows generically, skipping empty fields. */
function renderRows(rows: Array<Record<string, unknown>>): string {
  return rows
    .map((row, index) => {
      const entries = Object.entries(row).filter(
        ([, value]) => value !== null && value !== undefined && String(value).trim() !== "",
      );
      return [
        `### Record ${index + 1}`,
        "",
        markdownTable(
          ["Field", "Value"],
          entries.map(([key, value]) => [key, String(value)]),
        ),
      ].join("\n");
    })
    .join("\n\n");
}

export function registerDiligenceTools(server: McpServer): void {
  server.registerTool(
    "hmlr_check_leasehold",
    {
      title: "Check whether a property appears in the registered leases dataset",
      description: `Check whether a title or address appears in HM Land Registry's registered leases dataset, and return the lease metadata the dataset carries — typically the term, the date of the lease and the parties as recorded.

Requires the leases dataset to be cached (hmlr_download_dataset with dataset="leases"). That dataset is large and requires its own licence acceptance on your HM Land Registry account.

What this does and does not tell you: a match confirms a registered lease exists against the title. Absence is weaker evidence — the dataset covers registered leases only, and short leases (typically seven years or under) are not registered at all. For tenure on a specific sale, hmlr_search_transactions returns the tenure recorded at the point of sale, which is often the faster answer.

Args:
  - title_number (string, optional), postcode (string, optional), address (string, optional): at least one required.
  - limit (1-50, default 10)
  - response_format ('markdown'|'json', default 'markdown')

Returns JSON with schema:
  {
    "dataset": "leases", "found": boolean, "match_count": number,
    "matched_on": string,             // which columns were used to match
    "available_columns": [string],    // the columns this release of the dataset carries
    "records": [ {<column>: <value>} ]
  }

Examples:
  - "Is TS12345 leasehold?" -> title_number="TS12345"
  - "Any registered leases at BA1 1AA?" -> postcode="BA1 1AA"

Errors:
  - Explains the hmlr_download_dataset call needed when the dataset is missing.
  - Lists the available columns when the requested lookup field is absent from this release.`,
      inputSchema: LookupFields,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guard(async (input: LookupInput) => {
      const { payload, rows } = await runFlagLookup("leases", input);

      return objectResponse(payload, input.response_format, () =>
        withAttribution(
          rows.length === 0
            ? [
                "# No registered lease found",
                "",
                "Nothing in the registered leases dataset matches that lookup.",
                "",
                "This is not proof the property is freehold. The dataset covers " +
                  "registered leases only — leases of seven years or less are not " +
                  "registrable — and the extract lags the live register. For the " +
                  "tenure recorded at a sale, use hmlr_search_transactions.",
              ].join("\n")
            : [
                `# Registered lease${rows.length === 1 ? "" : "s"} found (${rows.length})`,
                "",
                renderRows(rows),
                "",
                "_Fields shown are those carried by the cached release of the dataset._",
              ].join("\n"),
          NOT_ADVICE_DISCLAIMER,
        ),
      );
    }),
  );

  server.registerTool(
    "hmlr_check_restrictive_covenants",
    {
      title: "Check whether a title carries a restrictive covenant",
      description: `Check whether a title appears in HM Land Registry's restrictive covenants dataset.

Requires the covenants dataset to be cached (hmlr_download_dataset with dataset="covenants").

Important limitation, by design of the source data: this is a presence-or-absence indicator only. The dataset deliberately excludes the wording of the covenant, so it can tell you that a title is burdened but never what the burden is. To read the covenant itself you need an official copy of the register and the referenced deed — £3 each via GOV.UK, which is outside what this server does.

Absence is also weaker evidence than presence: covenants recorded before the register was digitised, or held in retained deeds, may not appear.

Args:
  - title_number (string, optional), postcode (string, optional), address (string, optional): at least one required.
  - limit (1-50, default 10)
  - response_format ('markdown'|'json', default 'markdown')

Returns JSON with schema:
  {
    "dataset": "covenants", "found": boolean, "match_count": number,
    "matched_on": string, "available_columns": [string],
    "records": [ {<column>: <value>} ],
    "caveat": string
  }

Examples:
  - "Does TS12345 have covenants?" -> title_number="TS12345"
  - "Covenants at 42 High Street" -> address="42 HIGH STREET", postcode="BA1 1AA"

Errors:
  - Explains the hmlr_download_dataset call needed when the dataset is missing.`,
      inputSchema: LookupFields,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guard(async (input: LookupInput) => {
      const { payload, rows } = await runFlagLookup("covenants", input);
      const caveat =
        "Presence/absence indicator only. The dataset excludes the covenant wording; " +
        "obtain an official copy of the register and the referenced deed (£3 each " +
        "via GOV.UK) to read the actual restriction.";

      return objectResponse({ ...payload, caveat }, input.response_format, () =>
        withAttribution(
          rows.length === 0
            ? [
                "# No restrictive covenant indicator found",
                "",
                "Nothing in the restrictive covenants dataset matches that lookup.",
                "",
                "Treat this as weak evidence rather than a clean bill of health: " +
                  "covenants predating digitisation, or held in retained deeds, may " +
                  "not be captured. A conveyancer's search remains the reliable check.",
              ].join("\n")
            : [
                `# Restrictive covenant indicator present (${rows.length} record${rows.length === 1 ? "" : "s"})`,
                "",
                renderRows(rows),
                "",
                `**${caveat}**`,
              ].join("\n"),
          NOT_ADVICE_DISCLAIMER,
        ),
      );
    }),
  );
}
