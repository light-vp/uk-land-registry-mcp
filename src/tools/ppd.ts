/** Group A — Price Paid Data tools. Live SPARQL, no authentication needed. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { NOT_ADVICE_DISCLAIMER } from "../constants.js";
import {
  assertDateOrder,
  dateField,
  limitField,
  offsetField,
  postcodeField,
  propertyTypeField,
  responseFormatField,
  tenureField,
} from "../schemas/common.js";
import {
  gbp,
  guard,
  humanDate,
  markdownTable,
  objectResponse,
  paginate,
  paginatedResponse,
  pct,
  withAttribution,
} from "../services/format.js";
import { lookupOutcode, normalisePostcode } from "../services/postcodes.js";
import {
  annualisedGrowth,
  countTransactions,
  fetchForAggregate,
  mean,
  median,
  searchTransactions,
  type SortOrder,
  type TransactionFilters,
} from "../services/ppd.js";
import { QueryTooBroadError, type Transaction } from "../types.js";

const categoryField = z
  .enum(["standard", "additional", "all"])
  .default("all")
  .describe(
    "Transaction category. 'standard' is an arm's-length sale of a residential " +
      "property at full market value (HMLR category A). 'additional' covers " +
      "repossessions, transfers to companies, buy-to-lets and commercial sales " +
      "(category B). 'all' (default) returns both — use 'standard' when you want " +
      "comparables, because category B sales distort averages.",
  );

function categoryFilter(
  value: "standard" | "additional" | "all",
): Pick<TransactionFilters, "transaction_category"> {
  return value === "all" ? {} : { transaction_category: value };
}

/** Renders a list of transactions as a markdown table. */
function transactionsTable(transactions: Transaction[]): string {
  return markdownTable(
    ["Date", "Price", "Address", "Type", "Tenure", "New build"],
    transactions.map((transaction) => [
      humanDate(transaction.date),
      gbp(transaction.price),
      transaction.address.display,
      transaction.property_type ?? "—",
      transaction.tenure ?? "—",
      transaction.new_build === null ? "—" : transaction.new_build ? "Yes" : "No",
    ]),
  );
}

const SearchFields = {
    postcode: postcodeField.optional(),
    postcode_prefix: z
      .string()
      .min(2)
      .max(8)
      .optional()
      .describe(
        "Postcode sector ('TS1 2') or outward code ('TS1'). Requires `district`, " +
          "`town` or `county` alongside it to keep the query fast.",
      ),
    street: z.string().min(2).max(100).optional().describe("Street name, e.g. 'HIGH STREET'."),
    paon: z
      .string()
      .min(1)
      .max(60)
      .optional()
      .describe("Primary addressable object name — the house number or name, e.g. '42' or 'THE OLD RECTORY'."),
    saon: z
      .string()
      .min(1)
      .max(60)
      .optional()
      .describe("Secondary addressable object name — the flat or unit, e.g. 'FLAT 3'."),
    town: z.string().min(2).max(60).optional().describe("Post town, e.g. 'BATH'."),
    district: z
      .string()
      .min(2)
      .max(60)
      .optional()
      .describe("Local authority district, e.g. 'MIDDLESBROUGH'."),
    county: z.string().min(2).max(60).optional().describe("County, e.g. 'SOUTH YORKSHIRE'."),
    date_from: dateField.optional().describe("Earliest transaction date (YYYY-MM-DD)."),
    date_to: dateField.optional().describe("Latest transaction date (YYYY-MM-DD)."),
    min_price: z.number().int().min(0).optional().describe("Minimum price paid in pounds."),
    max_price: z.number().int().min(0).optional().describe("Maximum price paid in pounds."),
    property_type: propertyTypeField.optional(),
    new_build: z.boolean().optional().describe("Filter to new builds (true) or existing (false)."),
    tenure: tenureField.optional(),
    transaction_category: categoryField,
    sort: z
      .enum(["date_desc", "date_asc", "price_desc", "price_asc"])
      .default("date_desc")
      .describe("Sort order (default: most recent first)."),
    limit: limitField,
    offset: offsetField,
    response_format: responseFormatField,
} as const;

const SearchInputSchema = z
  .object(SearchFields)
  .strict()
  .superRefine((value, context) => {
    assertDateOrder(value.date_from, value.date_to, context);
    if (
      value.min_price !== undefined &&
      value.max_price !== undefined &&
      value.min_price > value.max_price
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `min_price (${value.min_price}) is above max_price (${value.max_price}).`,
      });
    }
  });

const HistoryFields = {
    postcode: postcodeField,
    paon: z
      .string()
      .min(1)
      .max(60)
      .describe("House number or name, e.g. '42' or 'THE OLD RECTORY'."),
    saon: z
      .string()
      .min(1)
      .max(60)
      .optional()
      .describe("Flat or unit designation where relevant, e.g. 'FLAT 3'."),
    street: z
      .string()
      .min(2)
      .max(100)
      .optional()
      .describe("Street name. Optional — the postcode usually pins it down."),
    response_format: responseFormatField,
} as const;

const HistoryInputSchema = z.object(HistoryFields).strict();

const AreaStatsFields = {
    postcode_sector: z
      .string()
      .min(3)
      .max(8)
      .optional()
      .describe("Postcode sector ('TS1 2') or outward code ('TS1'). Resolved to its district automatically."),
    town: z.string().min(2).max(60).optional().describe("Post town, e.g. 'BATH'."),
    district: z.string().min(2).max(60).optional().describe("Local authority district."),
    county: z.string().min(2).max(60).optional().describe("County."),
    date_from: dateField.describe("Start of the period (YYYY-MM-DD). Required — statistics are always period-bounded."),
    date_to: dateField.describe("End of the period (YYYY-MM-DD)."),
    property_type: propertyTypeField.optional(),
    transaction_category: z
      .enum(["standard", "additional", "all"])
      .default("standard")
      .describe(
        "Defaults to 'standard' (arm's-length residential sales) because " +
          "category B transactions distort medians. Set to 'all' to include them.",
      ),
    response_format: responseFormatField,
} as const;

const AreaStatsInputSchema = z
  .object(AreaStatsFields)
  .strict()
  .superRefine((value, context) => {
    assertDateOrder(value.date_from, value.date_to, context);
    if (!value.postcode_sector && !value.town && !value.district && !value.county) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Provide at least one area: postcode_sector, town, district or county.",
      });
    }
  });

type SearchInput = z.infer<typeof SearchInputSchema>;
type HistoryInput = z.infer<typeof HistoryInputSchema>;
type AreaStatsInput = z.infer<typeof AreaStatsInputSchema>;

export function registerPpdTools(server: McpServer): void {
  server.registerTool(
    "hmlr_search_transactions",
    {
      title: "Search sold property prices",
      description: `Search HM Land Registry Price Paid Data — every property sale registered in England and Wales since 1995.

Use this to answer "what has sold near here, and for how much". For the sale history of one specific address use hmlr_get_property_history; for an aggregate picture of an area use hmlr_get_area_stats.

The search must be narrow enough to run. Supply at least one of:
  - postcode (most reliable), or
  - street plus town/district/county, or
  - town or district plus a date range.
A postcode_prefix additionally needs district, town or county alongside it.

Args:
  - postcode, postcode_prefix, street, paon, saon, town, district, county (string, optional): location filters. Matching is exact and case-insensitive.
  - date_from, date_to (YYYY-MM-DD, optional): transaction date bounds.
  - min_price, max_price (integer, optional): price bounds in pounds.
  - property_type ('detached'|'semi'|'terraced'|'flat'|'other', optional)
  - new_build (boolean, optional), tenure ('freehold'|'leasehold', optional)
  - transaction_category ('standard'|'additional'|'all', default 'all')
  - sort ('date_desc'|'date_asc'|'price_desc'|'price_asc', default 'date_desc')
  - limit (1-200, default 25), offset (default 0)
  - response_format ('markdown'|'json', default 'markdown')

Returns JSON with schema:
  {
    "total": number|null,      // null when the count was too expensive to compute
    "count": number, "offset": number, "has_more": boolean, "next_offset"?: number,
    "items": [{
      "transaction_id": string, "price": number, "date": "YYYY-MM-DD",
      "property_type": "detached"|"semi"|"terraced"|"flat"|"other"|null,
      "tenure": "freehold"|"leasehold"|null, "new_build": boolean|null,
      "transaction_category": string|null,
      "address": { "paon","saon","street","locality","town","district","county","postcode": string|null, "display": string }
    }]
  }

Examples:
  - "What sold on Manvers Street in Bath in 2023?" -> street="MANVERS STREET", town="BATH", date_from="2023-01-01", date_to="2023-12-31"
  - "Flats over £500k in BA1 1AA" -> postcode="BA1 1AA", property_type="flat", min_price=500000
  - Don't use when: you want one address's full history (use hmlr_get_property_history).

Errors:
  - "too broad" with guidance on which filters to add, when the filter set would time out.
  - Returns an empty list with an explanation when the filters match nothing.`,
      inputSchema: SearchFields,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guard(async (input: SearchInput) => {
      SearchInputSchema.parse(input);
      const filters: TransactionFilters = {
        ...(input.postcode ? { postcode: input.postcode } : {}),
        ...(input.postcode_prefix ? { postcode_prefix: input.postcode_prefix } : {}),
        ...(input.street ? { street: input.street } : {}),
        ...(input.paon ? { paon: input.paon } : {}),
        ...(input.saon ? { saon: input.saon } : {}),
        ...(input.town ? { town: input.town } : {}),
        ...(input.district ? { district: input.district } : {}),
        ...(input.county ? { county: input.county } : {}),
        ...(input.date_from ? { date_from: input.date_from } : {}),
        ...(input.date_to ? { date_to: input.date_to } : {}),
        ...(input.min_price !== undefined ? { min_price: input.min_price } : {}),
        ...(input.max_price !== undefined ? { max_price: input.max_price } : {}),
        ...(input.property_type ? { property_type: input.property_type } : {}),
        ...(input.new_build !== undefined ? { new_build: input.new_build } : {}),
        ...(input.tenure ? { tenure: input.tenure } : {}),
        ...categoryFilter(input.transaction_category),
      };

      const [transactions, total] = await Promise.all([
        searchTransactions(filters, input.sort as SortOrder, input.limit, input.offset),
        countTransactions(filters),
      ]);

      if (transactions.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "No Price Paid transactions match those filters. Land Registry " +
                "records sales from 1995 onward, and street/town values are stored " +
                "in upper case exactly as registered — if you filtered on a street " +
                "name, try the postcode instead, or widen the date range.",
            },
          ],
          structuredContent: { total: 0, count: 0, offset: input.offset, has_more: false, items: [] },
        };
      }

      const payload = {
        ...paginate(transactions, total ?? input.offset + transactions.length, input.offset),
        ...(total === null
          ? {
              total_note:
                "Exact total unavailable: counting all matches would have timed out. " +
                "Page with `offset` to see more.",
            }
          : {}),
      };

      return paginatedResponse(payload, input.response_format, (page) =>
        withAttribution(
          [
            `# Sold prices (${page.count} of ${total ?? "many"})`,
            "",
            transactionsTable(page.items),
            page.has_more ? `\n_More available — call again with offset=${page.next_offset}._` : null,
            page.truncation_message ? `\n_${page.truncation_message}_` : null,
          ]
            .filter((line): line is string => line !== null)
            .join("\n"),
        ),
      );
    }),
  );

  server.registerTool(
    "hmlr_get_property_history",
    {
      title: "Get a property's sale history",
      description: `Every registered sale of one specific address, oldest to newest, with the appreciation between consecutive sales and the annualised growth rate.

This is the "what did this house sell for, and when" tool. It matches on postcode plus house number/name, which uniquely identifies almost every property in England and Wales.

Args:
  - postcode (string, required): full postcode, e.g. 'BA1 1AA'.
  - paon (string, required): house number or name, e.g. '42' or 'THE OLD RECTORY'.
  - saon (string, optional): flat or unit, e.g. 'FLAT 3'. Needed to isolate one flat in a block.
  - street (string, optional): street name, to disambiguate if the postcode spans several.
  - response_format ('markdown'|'json', default 'markdown')

Returns JSON with schema:
  {
    "address": string,             // resolved display address
    "sale_count": number,
    "first_sale": {"date","price"}|null,
    "last_sale": {"date","price"}|null,
    "total_appreciation_pct": number|null,
    "annualised_growth_pct": number|null,
    "sales": [{
      "date": "YYYY-MM-DD", "price": number,
      "property_type": string|null, "tenure": string|null, "new_build": boolean|null,
      "transaction_category": string|null,
      "change_from_previous_pct": number|null,   // vs the preceding sale
      "annualised_since_previous_pct": number|null
    }]
  }

Examples:
  - "What did 42 Coates Avenue, TS4 3AQ sell for?" -> postcode="TS4 3AQ", paon="42"
  - "History of Flat 3, 12 High Street BA1 1AA" -> postcode="BA1 1AA", paon="12", saon="FLAT 3"
  - Don't use when: you want everything on a street (use hmlr_search_transactions).

Errors:
  - Returns a "no sales recorded" explanation when the address has not changed hands since 1995, which is common and is not an error.`,
      inputSchema: HistoryFields,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guard(async (input: HistoryInput) => {
      const filters: TransactionFilters = {
        postcode: input.postcode,
        paon: input.paon,
        ...(input.saon ? { saon: input.saon } : {}),
        ...(input.street ? { street: input.street } : {}),
      };

      const sales = await searchTransactions(filters, "date_asc", 100, 0);

      if (sales.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `No registered sales found for ${input.paon}${input.saon ? `, ${input.saon}` : ""}, ` +
                `${normalisePostcode(input.postcode)}.\n\n` +
                "This usually means one of three things: the property has not been " +
                "sold since 1995 (Price Paid Data starts there); the house number is " +
                "recorded differently (try hmlr_search_transactions with just the " +
                "postcode to see how addresses on it are written); or it is a flat " +
                "that needs a `saon` such as 'FLAT 3'.",
            },
          ],
          structuredContent: { address: null, sale_count: 0, sales: [] },
        };
      }

      const enriched = sales.map((sale, index) => {
        const previous = index > 0 ? sales[index - 1] : undefined;
        const changePct =
          previous && previous.price > 0
            ? ((sale.price - previous.price) / previous.price) * 100
            : null;
        const annualised = previous
          ? annualisedGrowth(previous.price, previous.date, sale.price, sale.date)
          : null;
        return {
          date: sale.date,
          price: sale.price,
          property_type: sale.property_type,
          tenure: sale.tenure,
          new_build: sale.new_build,
          transaction_category: sale.transaction_category,
          change_from_previous_pct: changePct,
          annualised_since_previous_pct: annualised,
        };
      });

      const first = sales[0]!;
      const last = sales[sales.length - 1]!;
      const totalAppreciation =
        sales.length > 1 && first.price > 0
          ? ((last.price - first.price) / first.price) * 100
          : null;
      const overallAnnualised =
        sales.length > 1
          ? annualisedGrowth(first.price, first.date, last.price, last.date)
          : null;

      const payload = {
        address: last.address.display,
        sale_count: sales.length,
        first_sale: { date: first.date, price: first.price },
        last_sale: { date: last.date, price: last.price },
        total_appreciation_pct: totalAppreciation,
        annualised_growth_pct: overallAnnualised,
        sales: enriched,
      };

      return objectResponse(payload, input.response_format, () =>
        withAttribution(
          [
            `# ${last.address.display}`,
            "",
            `**${sales.length} registered sale${sales.length === 1 ? "" : "s"}** since 1995.`,
            "",
            markdownTable(
              ["Date", "Price", "Change", "Annualised", "Type", "Tenure"],
              enriched.map((sale) => [
                humanDate(sale.date),
                gbp(sale.price),
                sale.change_from_previous_pct === null ? "—" : pct(sale.change_from_previous_pct),
                sale.annualised_since_previous_pct === null
                  ? "—"
                  : `${pct(sale.annualised_since_previous_pct)}/yr`,
                sale.property_type ?? "—",
                sale.tenure ?? "—",
              ]),
            ),
            "",
            totalAppreciation !== null
              ? `Overall: **${pct(totalAppreciation)}** between ${humanDate(first.date)} and ` +
                `${humanDate(last.date)}` +
                (overallAnnualised !== null ? ` (${pct(overallAnnualised)} per year).` : ".")
              : null,
            "",
            "To express an older sale in today's money, pass it to hmlr_index_adjust_price.",
          ]
            .filter((line): line is string => line !== null)
            .join("\n"),
          NOT_ADVICE_DISCLAIMER,
        ),
      );
    }),
  );

  server.registerTool(
    "hmlr_get_area_stats",
    {
      title: "Summarise sold prices for an area",
      description: `Aggregate sold-price statistics for a postcode sector, town, district or county over a period: transaction count, median and mean price, a breakdown by property type and tenure, and the year-on-year change against the preceding equivalent period.

Computed server-side, so you get the summary without paging through raw transactions. Prefer this over hmlr_search_transactions whenever the question is about an area rather than specific properties.

Args:
  - postcode_sector (string, optional): sector 'TS1 2' or outward code 'TS1'. Its district is resolved automatically via postcode lookup.
  - town, district, county (string, optional): at least one area filter is required.
  - date_from, date_to (YYYY-MM-DD, required): the period to summarise.
  - property_type ('detached'|'semi'|'terraced'|'flat'|'other', optional)
  - transaction_category ('standard'|'additional'|'all', default 'standard')
  - response_format ('markdown'|'json', default 'markdown')

Returns JSON with schema:
  {
    "area": string, "period": {"from","to"},
    "transaction_count": number,
    "median_price": number|null, "mean_price": number|null,
    "min_price": number|null, "max_price": number|null,
    "by_property_type": {"<type>": {"count": number, "median": number|null, "mean": number|null}},
    "by_tenure": {"<tenure>": {"count": number, "median": number|null}},
    "new_build_count": number,
    "year_on_year": {"previous_period": {"from","to"}, "previous_count": number,
                     "previous_median": number|null, "median_change_pct": number|null}|null,
    "sample_capped": boolean    // true if the period exceeded the 20,000-row sample cap
  }

Examples:
  - "How's the Middlesbrough market in 2024?" -> district="MIDDLESBROUGH", date_from="2024-01-01", date_to="2024-12-31"
  - "Median flat price in TS1 2 last year" -> postcode_sector="TS1 2", property_type="flat", date_from=..., date_to=...
  - Don't use when: you need individual sales (use hmlr_search_transactions).

Errors:
  - Explains which area filter to add when none is supplied.
  - Sets sample_capped=true rather than failing when a period is very large; narrow the dates for exact figures.`,
      inputSchema: AreaStatsFields,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guard(async (input: AreaStatsInput) => {
      AreaStatsInputSchema.parse(input);
      const base: TransactionFilters = {
        ...(input.town ? { town: input.town } : {}),
        ...(input.district ? { district: input.district } : {}),
        ...(input.county ? { county: input.county } : {}),
        ...(input.property_type ? { property_type: input.property_type } : {}),
        ...categoryFilter(input.transaction_category),
      };

      let areaLabel: string;

      if (input.postcode_sector) {
        const prefix = input.postcode_sector.toUpperCase().trim();
        base.postcode_prefix = prefix;
        areaLabel = prefix;

        // A prefix match needs an indexed anchor. The outward code maps to the
        // local authorities it covers — often more than one, so bind them all
        // rather than picking the first and silently dropping the rest.
        if (!base.district && !base.town && !base.county) {
          const outcode = prefix.split(/\s+/)[0]!;
          const info = await lookupOutcode(outcode).catch(() => null);
          const districts = (info?.admin_district as string[] | undefined) ?? [];

          if (districts.length === 0) {
            throw new QueryTooBroadError(
              `Could not resolve a district for "${input.postcode_sector}" automatically. ` +
                "Pass `district` explicitly (call hmlr_lookup_postcode with a full " +
                "postcode in that area to find it), otherwise the query would scan " +
                "every address in England and Wales.",
            );
          }

          base.districts = districts.map((district) => district.toUpperCase());
          areaLabel = `${prefix} (${districts.join(", ")})`;
        }
      } else {
        areaLabel = input.district ?? input.town ?? input.county ?? "area";
      }

      const period = { from: input.date_from, to: input.date_to };
      const current = await fetchForAggregate({ ...base, date_from: period.from, date_to: period.to });

      // Same-length window immediately before, for the year-on-year comparison.
      const spanMs = new Date(period.to).getTime() - new Date(period.from).getTime();
      const prevTo = new Date(new Date(period.from).getTime() - 86_400_000);
      const prevFrom = new Date(prevTo.getTime() - spanMs);
      const previousPeriod = {
        from: prevFrom.toISOString().slice(0, 10),
        to: prevTo.toISOString().slice(0, 10),
      };

      const previous = await fetchForAggregate({
        ...base,
        date_from: previousPeriod.from,
        date_to: previousPeriod.to,
      }).catch(() => null);

      const prices = current.transactions.map((t) => t.price);
      const currentMedian = median(prices);
      const previousMedian = previous ? median(previous.transactions.map((t) => t.price)) : null;

      const byType: Record<string, { count: number; median: number | null; mean: number | null }> = {};
      const byTenure: Record<string, { count: number; median: number | null }> = {};

      for (const transaction of current.transactions) {
        const type = transaction.property_type ?? "unknown";
        const typeBucket = (byType[type] ??= { count: 0, median: null, mean: null });
        typeBucket.count += 1;

        const tenure = transaction.tenure ?? "unknown";
        const tenureBucket = (byTenure[tenure] ??= { count: 0, median: null });
        tenureBucket.count += 1;
      }

      for (const [type, bucket] of Object.entries(byType)) {
        const subset = current.transactions
          .filter((t) => (t.property_type ?? "unknown") === type)
          .map((t) => t.price);
        bucket.median = median(subset);
        bucket.mean = mean(subset);
      }
      for (const [tenure, bucket] of Object.entries(byTenure)) {
        bucket.median = median(
          current.transactions.filter((t) => (t.tenure ?? "unknown") === tenure).map((t) => t.price),
        );
      }

      const payload = {
        area: areaLabel,
        period,
        transaction_count: current.transactions.length,
        median_price: currentMedian,
        mean_price: mean(prices),
        min_price: prices.length > 0 ? Math.min(...prices) : null,
        max_price: prices.length > 0 ? Math.max(...prices) : null,
        by_property_type: byType,
        by_tenure: byTenure,
        new_build_count: current.transactions.filter((t) => t.new_build === true).length,
        year_on_year:
          previous === null
            ? null
            : {
                previous_period: previousPeriod,
                previous_count: previous.transactions.length,
                previous_median: previousMedian,
                median_change_pct:
                  currentMedian !== null && previousMedian !== null && previousMedian > 0
                    ? ((currentMedian - previousMedian) / previousMedian) * 100
                    : null,
              },
        sample_capped: current.capped,
      };

      return objectResponse(payload, input.response_format, () =>
        withAttribution(
          [
            `# ${areaLabel}: ${humanDate(period.from)} to ${humanDate(period.to)}`,
            "",
            `- **Transactions**: ${payload.transaction_count.toLocaleString("en-GB")}`,
            `- **Median price**: ${gbp(currentMedian)}`,
            `- **Mean price**: ${gbp(payload.mean_price)}`,
            `- **Range**: ${gbp(payload.min_price)} – ${gbp(payload.max_price)}`,
            `- **New builds**: ${payload.new_build_count}`,
            payload.year_on_year?.median_change_pct !== null &&
            payload.year_on_year?.median_change_pct !== undefined
              ? `- **Change vs previous period**: ${pct(payload.year_on_year.median_change_pct)} ` +
                `(median ${gbp(payload.year_on_year.previous_median)} on ` +
                `${payload.year_on_year.previous_count.toLocaleString("en-GB")} sales)`
              : null,
            "",
            "## By property type",
            markdownTable(
              ["Type", "Sales", "Median", "Mean"],
              Object.entries(byType)
                .sort(([, a], [, b]) => b.count - a.count)
                .map(([type, bucket]) => [type, bucket.count, gbp(bucket.median), gbp(bucket.mean)]),
            ),
            "",
            "## By tenure",
            markdownTable(
              ["Tenure", "Sales", "Median"],
              Object.entries(byTenure)
                .sort(([, a], [, b]) => b.count - a.count)
                .map(([tenure, bucket]) => [tenure, bucket.count, gbp(bucket.median)]),
            ),
            current.capped
              ? "\n_Sample capped at 20,000 transactions — narrow the date range for exact figures._"
              : null,
            input.transaction_category === "standard"
              ? "\n_Category A (standard, arm's-length residential) sales only._"
              : null,
          ]
            .filter((line): line is string => line !== null)
            .join("\n"),
        ),
      );
    }),
  );
}
