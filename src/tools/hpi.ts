/** Group B — UK House Price Index tools. Live SPARQL, no authentication needed. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { monthField, responseFormatField } from "../schemas/common.js";
import {
  gbp,
  guard,
  markdownTable,
  objectResponse,
  pct,
  withAttribution,
} from "../services/format.js";
import {
  ALL_MEASURE_GROUPS,
  getHpiSeries,
  getIndexValue,
  getLatestHpi,
  isMoneyMeasure,
  isPercentMeasure,
  measuresFor,
  toMonth,
  type HpiRow,
  type MeasureGroup,
} from "../services/hpi.js";
import { lookupPostcode } from "../services/postcodes.js";
import { regionForPostcodeAreas, resolveRegion, resolveRegions } from "../services/regions.js";

const measureGroupsField = z
  .array(z.enum(ALL_MEASURE_GROUPS as [MeasureGroup, ...MeasureGroup[]]))
  .min(1)
  .max(6)
  .default(["headline"])
  .describe(
    "Which measure groups to return: 'headline' (average price, index, monthly " +
      "and annual change, sales volume), 'property_type', 'buyer_status' " +
      "(first-time buyer vs former owner-occupier), 'funding' (cash vs mortgage), " +
      "'build_status' (new build vs existing), 'seasonally_adjusted'.",
  );

const regionField = z
  .string()
  .min(2)
  .max(80)
  .describe(
    "Region name: a country ('England', 'Wales', 'Scotland', 'Northern Ireland'), " +
      "a statistical region ('North East', 'London'), a county ('Surrey'), or a " +
      "local authority ('Middlesbrough'). Resolved case-insensitively.",
  );

const GetHpiFields = {
  region: regionField,
  date_from: monthField.optional().describe("First month to return (YYYY-MM). Defaults to the latest month only."),
  date_to: monthField.optional().describe("Last month to return (YYYY-MM)."),
  measures: measureGroupsField,
  response_format: responseFormatField,
} as const;

const GetHpiInputSchema = z
  .object(GetHpiFields)
  .strict()
  .superRefine((value, context) => {
    if (value.date_from && value.date_to && value.date_from > value.date_to) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `date_from (${value.date_from}) is after date_to (${value.date_to}).`,
      });
    }
  });

const CompareFields = {
  regions: z
    .array(regionField)
    .min(2, "Provide at least two regions to compare.")
    .max(5, "Compare at most five regions at once.")
    .describe("Two to five region names to compare side by side."),
  date_from: monthField.optional().describe("First month (YYYY-MM)."),
  date_to: monthField.optional().describe("Last month (YYYY-MM)."),
  measure: z
    .enum(["averagePrice", "housePriceIndex", "percentageAnnualChange", "salesVolume"])
    .default("averagePrice")
    .describe("The single measure to compare across regions."),
  response_format: responseFormatField,
} as const;

const CompareInputSchema = z.object(CompareFields).strict();

const AdjustFields = {
  price: z.number().positive().describe("The historical price paid, in pounds."),
  original_date: z
    .string()
    .regex(/^\d{4}-\d{2}(-\d{2})?$/, "Use YYYY-MM or YYYY-MM-DD.")
    .describe("When the price was paid (YYYY-MM or YYYY-MM-DD)."),
  target_date: z
    .string()
    .regex(/^\d{4}-\d{2}(-\d{2})?$/, "Use YYYY-MM or YYYY-MM-DD.")
    .optional()
    .describe("Date to express the price in. Defaults to the latest published month."),
  region: regionField.optional().describe("Region whose index to use. Provide this or `postcode`."),
  postcode: z
    .string()
    .min(5)
    .max(10)
    .optional()
    .describe("Postcode whose local authority index to use. Provide this or `region`."),
  response_format: responseFormatField,
} as const;

const AdjustInputSchema = z
  .object(AdjustFields)
  .strict()
  .superRefine((value, context) => {
    if (!value.region && !value.postcode) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide either `region` or `postcode` so the right local index is used.",
      });
    }
  });

type GetHpiInput = z.infer<typeof GetHpiInputSchema>;
type CompareInput = z.infer<typeof CompareInputSchema>;
type AdjustInput = z.infer<typeof AdjustInputSchema>;

/** Formats a measure value according to whether it is money, a percentage or a count. */
function formatMeasure(measure: string, value: number | null): string {
  if (value === null) return "—";
  if (isMoneyMeasure(measure)) return gbp(value);
  if (isPercentMeasure(measure)) return pct(value);
  return value.toLocaleString("en-GB");
}

/** Turns a measure predicate into a readable column heading. */
function measureLabel(measure: string): string {
  return measure
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (character) => character.toUpperCase())
    .trim();
}

function seriesTable(rows: HpiRow[], measures: string[]): string {
  return markdownTable(
    ["Month", ...measures.map(measureLabel)],
    rows.map((row) => [row.month, ...measures.map((m) => formatMeasure(m, row.values[m] ?? null))]),
  );
}

export function registerHpiTools(server: McpServer): void {
  server.registerTool(
    "hmlr_get_hpi",
    {
      title: "Get UK House Price Index figures",
      description: `Official UK House Price Index for a region: average price, index value, monthly and annual change, sales volume, and optional breakdowns by property type, buyer status, funding method and build status.

The index is the authoritative measure of house price movement — unlike raw sold prices it is mix-adjusted, so it is the right tool for "how have prices moved" questions. Published monthly, with the most recent months subject to revision.

Args:
  - region (string, required): country, statistical region, county or local authority. Unrecognised names return suggestions.
  - date_from, date_to (YYYY-MM, optional): month range. With neither, returns only the latest published month.
  - measures (array, default ['headline']): any of 'headline', 'property_type', 'buyer_status', 'funding', 'build_status', 'seasonally_adjusted'.
  - response_format ('markdown'|'json', default 'markdown')

Returns JSON with schema:
  {
    "region": string, "region_uri": string,
    "months": number,
    "latest": {"month": string, "values": {"<measure>": number|null}}|null,
    "series": [{"month": "YYYY-MM", "values": {"<measure>": number|null}}]
  }

Examples:
  - "What's the average house price in Middlesbrough?" -> region="Middlesbrough"
  - "London prices 2023-2024 by property type" -> region="London", date_from="2023-01", date_to="2024-12", measures=["headline","property_type"]
  - "First-time buyer prices in Wales" -> region="Wales", measures=["buyer_status"]
  - Don't use when: comparing several regions (use hmlr_compare_hpi_regions).

Errors:
  - "No House Price Index region matches X" with suggested alternatives.
  - Recent months may return null for salesVolume and build_status measures, which lag the headline index by a few months. This is expected, not an error.`,
      inputSchema: GetHpiFields,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guard(async (input: GetHpiInput) => {
      const region = await resolveRegion(input.region);
      const measures = measuresFor(input.measures);

      const series =
        input.date_from || input.date_to
          ? await getHpiSeries(region.uri, input.date_from, input.date_to, input.measures)
          : [];

      const latest =
        series.length > 0 ? series[series.length - 1]! : await getLatestHpi(region.uri, input.measures);

      if (!latest && series.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `No House Price Index observations found for ${region.label} in that period. ` +
                "The index starts in January 1995 for most regions; local authority " +
                "series sometimes start later.",
            },
          ],
          structuredContent: { region: region.label, region_uri: region.uri, months: 0, series: [] },
        };
      }

      const payload = {
        region: region.label,
        region_uri: region.uri,
        months: series.length,
        latest,
        series,
      };

      return objectResponse(payload, input.response_format, () =>
        withAttribution(
          [
            `# UK House Price Index — ${region.label}`,
            "",
            latest
              ? [
                  `**Latest (${latest.month})**`,
                  ...measures.map(
                    (measure) => `- ${measureLabel(measure)}: ${formatMeasure(measure, latest.values[measure] ?? null)}`,
                  ),
                ].join("\n")
              : null,
            series.length > 1 ? `\n## Series (${series.length} months)\n` : null,
            series.length > 1 ? seriesTable(series, measures) : null,
          ]
            .filter((line): line is string => line !== null)
            .join("\n"),
        ),
      );
    }),
  );

  server.registerTool(
    "hmlr_compare_hpi_regions",
    {
      title: "Compare House Price Index across regions",
      description: `The same House Price Index measure for two to five regions side by side over a period — "how has Middlesbrough tracked against the North East and England?".

Returns one row per month with a column per region, plus the change over the period for each region so relative performance is immediately visible.

Args:
  - regions (array of 2-5 strings, required): region names to compare.
  - date_from, date_to (YYYY-MM, optional): month range. Defaults to the last 24 months.
  - measure ('averagePrice'|'housePriceIndex'|'percentageAnnualChange'|'salesVolume', default 'averagePrice')
  - response_format ('markdown'|'json', default 'markdown')

Returns JSON with schema:
  {
    "measure": string,
    "period": {"from": string, "to": string},
    "regions": [{
      "region": string, "region_uri": string,
      "first": number|null, "last": number|null, "change_pct": number|null
    }],
    "series": [{"month": "YYYY-MM", "values": {"<region name>": number|null}}]
  }

Examples:
  - "Compare Middlesbrough with the North East and England" -> regions=["Middlesbrough","North East","England"]
  - "Sales volumes: Manchester vs Liverpool since 2020" -> regions=["Manchester","Liverpool"], measure="salesVolume", date_from="2020-01"
  - Don't use when: you only care about one region (use hmlr_get_hpi).

Errors:
  - Names each region that could not be resolved, with suggestions.`,
      inputSchema: CompareFields,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guard(async (input: CompareInput) => {
      const regions = await resolveRegions(input.regions);

      // Default to the trailing two years when no range is given.
      const now = new Date();
      const defaultTo = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
      const defaultFrom = `${now.getUTCFullYear() - 2}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
      const from = input.date_from ?? defaultFrom;
      const to = input.date_to ?? defaultTo;

      // Every comparable measure lives in the headline group.
      const allSeries = await Promise.all(
        regions.map((region) => getHpiSeries(region.uri, from, to, ["headline"])),
      );

      const months = [...new Set(allSeries.flat().map((row) => row.month))].sort();

      const series = months.map((month) => {
        const values: Record<string, number | null> = {};
        regions.forEach((region, index) => {
          const row = allSeries[index]!.find((r) => r.month === month);
          values[region.label] = row?.values[input.measure] ?? null;
        });
        return { month, values };
      });

      const summaries = regions.map((region, index) => {
        const rows = allSeries[index]!.filter((row) => row.values[input.measure] !== null);
        const first = rows[0]?.values[input.measure] ?? null;
        const last = rows[rows.length - 1]?.values[input.measure] ?? null;
        return {
          region: region.label,
          region_uri: region.uri,
          first,
          last,
          change_pct:
            first !== null && last !== null && first !== 0 ? ((last - first) / first) * 100 : null,
        };
      });

      const payload = {
        measure: input.measure,
        period: { from, to },
        regions: summaries,
        series,
      };

      return objectResponse(payload, input.response_format, () =>
        withAttribution(
          [
            `# ${measureLabel(input.measure)}: ${regions.map((r) => r.label).join(" vs ")}`,
            `_${from} to ${to}_`,
            "",
            markdownTable(
              ["Region", "First", "Latest", "Change"],
              summaries.map((summary) => [
                summary.region,
                formatMeasure(input.measure, summary.first),
                formatMeasure(input.measure, summary.last),
                summary.change_pct === null ? "—" : pct(summary.change_pct),
              ]),
            ),
            "",
            "## Monthly series",
            markdownTable(
              ["Month", ...regions.map((r) => r.label)],
              series.map((row) => [
                row.month,
                ...regions.map((r) => formatMeasure(input.measure, row.values[r.label] ?? null)),
              ]),
            ),
          ].join("\n"),
        ),
      );
    }),
  );

  server.registerTool(
    "hmlr_index_adjust_price",
    {
      title: "Adjust a historical price using the House Price Index",
      description: `Restate a past sale price in another period's money using the local House Price Index — the standard way to turn an old comparable into a present-day estimate.

Give it a price and when it was paid, plus either a region or a postcode (whose local authority index is then used). Returns the adjusted figure and the index values behind it.

This is an index adjustment, not a valuation: it captures how the local market moved, not what has happened to the individual property.

Args:
  - price (number, required): the historical price in pounds.
  - original_date (YYYY-MM or YYYY-MM-DD, required): when it was paid.
  - target_date (YYYY-MM or YYYY-MM-DD, optional): defaults to the latest published month.
  - region (string, optional) OR postcode (string, optional): one is required.
  - response_format ('markdown'|'json', default 'markdown')

Returns JSON with schema:
  {
    "original": {"price": number, "date": string, "index": number, "index_month": string},
    "target": {"price": number, "date": string, "index": number, "index_month": string},
    "change_pct": number,
    "region": string, "region_uri": string,
    "note": string
  }

Examples:
  - "£185,000 in March 2017 in Bath — what's that now?" -> price=185000, original_date="2017-03", postcode="BA1 1AA"
  - "Adjust £320k from 2019 to 2022 in Surrey" -> price=320000, original_date="2019-06", target_date="2022-06", region="Surrey"
  - Don't use when: you want the actual index series (use hmlr_get_hpi).

Errors:
  - Explains when the index has no observation on or before the requested month (the index starts in 1995).`,
      inputSchema: AdjustFields,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guard(async (input: AdjustInput) => {
      let region;
      if (input.region) {
        region = await resolveRegion(input.region);
      } else {
        const info = await lookupPostcode(input.postcode!);
        if (!info) {
          throw new Error(
            `Postcode "${input.postcode}" was not found. Check it, or pass \`region\` instead.`,
          );
        }
        region = await regionForPostcodeAreas(info.admin_district, info.region, info.country);
      }

      const originalMonth = toMonth(input.original_date);
      const targetMonth = input.target_date ? toMonth(input.target_date) : null;

      const originalIndex = await getIndexValue(region.uri, originalMonth);
      if (!originalIndex) {
        throw new Error(
          `No House Price Index observation for ${region.label} on or before ${originalMonth}. ` +
            "The index starts in January 1995; some local authority series start later.",
        );
      }

      const targetIndex = targetMonth
        ? await getIndexValue(region.uri, targetMonth)
        : await (async () => {
            const latest = await getLatestHpi(region.uri, ["headline"]);
            if (!latest) return null;
            return {
              month: latest.month,
              index: latest.values.housePriceIndex ?? 0,
              averagePrice: latest.values.averagePrice ?? null,
            };
          })();

      if (!targetIndex || targetIndex.index === 0) {
        throw new Error(
          `No House Price Index observation for ${region.label} at ${targetMonth ?? "the latest month"}.`,
        );
      }

      const adjusted = Math.round((input.price * targetIndex.index) / originalIndex.index);
      const changePct = ((targetIndex.index - originalIndex.index) / originalIndex.index) * 100;

      const payload = {
        original: {
          price: input.price,
          date: input.original_date,
          index: originalIndex.index,
          index_month: originalIndex.month,
        },
        target: {
          price: adjusted,
          date: input.target_date ?? targetIndex.month,
          index: targetIndex.index,
          index_month: targetIndex.month,
        },
        change_pct: changePct,
        region: region.label,
        region_uri: region.uri,
        note:
          "Index adjustment reflects how the local market moved. It does not " +
          "account for changes to this specific property, such as extensions, " +
          "condition or planning consents.",
      };

      return objectResponse(payload, input.response_format, () =>
        withAttribution(
          [
            `# ${gbp(input.price)} (${originalIndex.month}) → **${gbp(adjusted)}** (${targetIndex.month})`,
            "",
            `Using the House Price Index for **${region.label}**.`,
            "",
            markdownTable(
              ["Point", "Month", "Index", "Price"],
              [
                ["Original", originalIndex.month, originalIndex.index.toFixed(2), gbp(input.price)],
                ["Target", targetIndex.month, targetIndex.index.toFixed(2), gbp(adjusted)],
              ],
            ),
            "",
            `Local market movement over the period: **${pct(changePct)}**.`,
            "",
            `_${payload.note}_`,
          ].join("\n"),
        ),
      );
    }),
  );
}
