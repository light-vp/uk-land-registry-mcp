/** Group F — utilities: postcode lookup, dataset download, cache status. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { DATASETS, DATA_DIR } from "../constants.js";
import { responseFormatField } from "../schemas/common.js";
import {
  cacheSizeBytes,
  cacheStatus,
  formatBytes,
  CacheUnavailableError,
} from "../services/cache.js";
import { guard, markdownTable, objectResponse } from "../services/format.js";
import { ingestDataset } from "../services/ingest.js";
import { lookupOutcode, lookupPostcode, reverseGeocode } from "../services/postcodes.js";
import {
  getApiKey,
  getDatasetMetadata,
  pickLatestFullFile,
  resolveDataset,
} from "../services/ulpd.js";

const PostcodeFields = {
  postcode: z
    .string()
    .min(2)
    .max(10)
    .optional()
    .describe("Full postcode ('BA1 1AA') or outward code ('BA1')."),
  latitude: z.number().min(49).max(61).optional().describe("Latitude, for reverse lookup."),
  longitude: z.number().min(-9).max(2).optional().describe("Longitude, for reverse lookup."),
  response_format: responseFormatField,
} as const;

const PostcodeInputSchema = z
  .object(PostcodeFields)
  .strict()
  .superRefine((value, context) => {
    const hasCoords = value.latitude !== undefined && value.longitude !== undefined;
    if (!value.postcode && !hasCoords) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide either `postcode`, or both `latitude` and `longitude`.",
      });
    }
  });

const DownloadFields = {
  dataset: z
    .enum(["ccod", "ocod", "leases", "covenants", "inspire"])
    .describe(
      "Which bulk dataset to fetch: 'ccod' (UK company ownership), 'ocod' " +
        "(overseas company ownership), 'leases', 'covenants', or 'inspire' " +
        "(title boundary polygons, per local authority).",
    ),
  area: z
    .string()
    .min(2)
    .max(60)
    .optional()
    .describe("Local authority name. Required for 'inspire', ignored otherwise."),
  confirm: z
    .boolean()
    .default(false)
    .describe(
      "Set true to actually download. With false (default) the tool reports the " +
        "file name and size and downloads nothing, so you can check the cost first.",
    ),
  response_format: responseFormatField,
} as const;

const DownloadInputSchema = z.object(DownloadFields).strict();

const StatusFields = { response_format: responseFormatField } as const;

const StatusInputSchema = z.object(StatusFields).strict();

type PostcodeInput = z.infer<typeof PostcodeInputSchema>;
type DownloadInput = z.infer<typeof DownloadInputSchema>;
type StatusInput = z.infer<typeof StatusInputSchema>;

export function registerUtilityTools(server: McpServer): void {
  server.registerTool(
    "hmlr_lookup_postcode",
    {
      title: "Look up a UK postcode",
      description: `Resolve a postcode to coordinates and administrative geography — local authority district, county, ward, region, constituency, LSOA/MSOA — or reverse-geocode a coordinate to nearby postcodes.

This is the glue tool. Land Registry data is keyed on districts and counties written exactly as registered, so when you only know a postcode, call this first to get the \`admin_district\` that the Price Paid and ownership tools need.

Args:
  - postcode (string, optional): full postcode or outward code.
  - latitude + longitude (numbers, optional): for reverse lookup. Provide these or \`postcode\`.
  - response_format ('markdown'|'json', default 'markdown')

Returns JSON with schema:
  {
    "postcode": string, "latitude": number|null, "longitude": number|null,
    "eastings": number|null, "northings": number|null,
    "country": string|null, "region": string|null,
    "admin_district": string|null, "admin_county": string|null, "admin_ward": string|null,
    "parliamentary_constituency": string|null, "lsoa": string|null, "msoa": string|null,
    "outcode": string|null, "incode": string|null, "sector": string|null,
    "codes": {"admin_district": string, ...}|null
  }
  For an outward code or a reverse lookup, returns {"matches": [ ... ]}.

Examples:
  - "Where is TS1 2AB?" -> postcode="TS1 2AB"
  - "Which council covers 51.501, -0.141?" -> latitude=51.501, longitude=-0.141
  - Use before hmlr_get_area_stats when you know a postcode but not the district.

Errors:
  - Returns a "not found" message for postcodes that do not exist or have been retired.

Data source: postcodes.io (Open Government Licence, ONS Postcode Directory).`,
      inputSchema: PostcodeFields,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guard(async (input: PostcodeInput) => {
      if (input.latitude !== undefined && input.longitude !== undefined) {
        const matches = await reverseGeocode(input.latitude, input.longitude);
        const payload = { matches };
        return objectResponse(payload, input.response_format, () =>
          matches.length === 0
            ? `No postcodes found near ${input.latitude}, ${input.longitude}.`
            : [
                `# Postcodes near ${input.latitude}, ${input.longitude}`,
                "",
                markdownTable(
                  ["Postcode", "District", "Ward", "Region"],
                  matches.map((m) => [m.postcode, m.admin_district, m.admin_ward, m.region]),
                ),
              ].join("\n"),
        );
      }

      const raw = input.postcode!.trim();
      const isOutcode = raw.replace(/\s+/g, "").length <= 4;

      if (isOutcode) {
        const result = await lookupOutcode(raw);
        if (!result) {
          return {
            content: [{ type: "text" as const, text: `Outward code "${raw}" was not found.` }],
            isError: true,
          };
        }
        return objectResponse(result, input.response_format, () =>
          [
            `# ${result.outcode}`,
            "",
            `- **Centroid**: ${result.latitude}, ${result.longitude}`,
            `- **Districts**: ${(result.admin_district as string[] | undefined)?.join(", ") ?? "—"}`,
            `- **Counties**: ${(result.admin_county as string[] | undefined)?.join(", ") ?? "—"}`,
            `- **Region**: ${(result.region as string[] | undefined)?.join(", ") ?? "—"}`,
            "",
            "_This is an outward code covering several districts. For Land Registry " +
              "searches, pick the relevant district from the list above._",
          ].join("\n"),
        );
      }

      const info = await lookupPostcode(raw);
      if (!info) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Postcode "${raw}" was not found. It may be mistyped, or retired — ` +
                "postcodes.io only holds currently active postcodes.",
            },
          ],
          isError: true,
        };
      }

      return objectResponse(info as unknown as Record<string, unknown>, input.response_format, () =>
        [
          `# ${info.postcode}`,
          "",
          `- **Coordinates**: ${info.latitude}, ${info.longitude}`,
          `- **Local authority**: ${info.admin_district ?? "—"}`,
          `- **County**: ${info.admin_county ?? "—"}`,
          `- **Ward**: ${info.admin_ward ?? "—"}`,
          `- **Region**: ${info.region ?? "—"}`,
          `- **Country**: ${info.country ?? "—"}`,
          `- **Constituency**: ${info.parliamentary_constituency ?? "—"}`,
          `- **Sector**: ${info.sector ?? "—"}`,
          "",
          `Use \`district="${(info.admin_district ?? "").toUpperCase()}"\` with the Price Paid tools.`,
        ].join("\n"),
      );
    }),
  );

  server.registerTool(
    "hmlr_data_status",
    {
      title: "Check API key and cached datasets",
      description: `Report what this server can currently do: whether an HM Land Registry API key is configured, which bulk datasets are cached locally, how many rows each holds, when they were downloaded, and how much disk the cache uses.

Call this first whenever an ownership, boundary or due-diligence tool reports missing data — it tells you exactly which hmlr_download_dataset call to make.

Args:
  - response_format ('markdown'|'json', default 'markdown')

Returns JSON with schema:
  {
    "api_key_configured": boolean,
    "data_dir": string,
    "cache_size": string,
    "duckdb_available": boolean,
    "live_tools": ["hmlr_search_transactions", ...],   // always available, no setup
    "datasets": [{
      "key": string, "title": string, "cached": boolean,
      "row_count": number|null, "source_file": string|null,
      "downloaded_at": string|null, "areas"?: [string]
    }]
  }

Examples:
  - "Why can't you look up who owns this?" -> call this, then follow its instructions.
  - "What data do you have locally?" -> call this.

Never fails: reports what is missing rather than erroring.`,
      inputSchema: StatusFields,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guard(async (input: StatusInput) => {
      const apiKeyConfigured = Boolean(getApiKey());

      let datasets: Awaited<ReturnType<typeof cacheStatus>> = [];
      let duckdbAvailable = true;
      let cacheError: string | null = null;

      try {
        datasets = await cacheStatus();
      } catch (error) {
        duckdbAvailable = !(error instanceof CacheUnavailableError);
        cacheError = error instanceof Error ? error.message : String(error);
        datasets = Object.values(DATASETS).map((spec) => ({
          key: spec.key,
          title: spec.title,
          cached: false,
          table: spec.table,
          row_count: null,
          source_file: null,
          downloaded_at: null,
        }));
      }

      const sizeBytes = await cacheSizeBytes().catch(() => 0);

      const payload = {
        api_key_configured: apiKeyConfigured,
        data_dir: DATA_DIR,
        cache_size: formatBytes(sizeBytes),
        duckdb_available: duckdbAvailable,
        ...(cacheError ? { cache_error: cacheError } : {}),
        live_tools: [
          "hmlr_search_transactions",
          "hmlr_get_property_history",
          "hmlr_get_area_stats",
          "hmlr_get_hpi",
          "hmlr_compare_hpi_regions",
          "hmlr_index_adjust_price",
          "hmlr_lookup_postcode",
        ],
        datasets,
      };

      return objectResponse(payload, input.response_format, () =>
        [
          "# HM Land Registry MCP — status",
          "",
          `- **API key configured**: ${apiKeyConfigured ? "yes" : "no"}`,
          `- **Cache directory**: \`${DATA_DIR}\``,
          `- **Cache size**: ${formatBytes(sizeBytes)}`,
          `- **DuckDB available**: ${duckdbAvailable ? "yes" : "no"}`,
          "",
          "## Always available (no setup)",
          "",
          "Price Paid Data, House Price Index and postcode lookups query public " +
            "endpoints directly and need neither an API key nor a download.",
          "",
          "## Bulk datasets",
          "",
          markdownTable(
            ["Dataset", "Cached", "Rows", "Source file", "Downloaded"],
            datasets.map((dataset) => [
              dataset.key,
              dataset.cached ? "yes" : "no",
              dataset.row_count?.toLocaleString("en-GB") ?? "—",
              dataset.source_file ?? "—",
              dataset.downloaded_at ? dataset.downloaded_at.slice(0, 10) : "—",
            ]),
          ),
          "",
          !apiKeyConfigured
            ? "**To enable ownership, boundary and due-diligence tools**: register free at " +
              "https://use-land-property-data.service.gov.uk/, accept the licence for each " +
              "dataset you want, then set `HMLR_API_KEY` in your MCP client config."
            : datasets.every((d) => !d.cached)
              ? "**Next step**: run `hmlr_download_dataset` with `dataset=\"ocod\"` " +
                "(small, fast) to try the ownership tools."
              : null,
          cacheError ? `\n_Cache note: ${cacheError}_` : null,
        ]
          .filter((line): line is string => line !== null)
          .join("\n"),
      );
    }),
  );

  server.registerTool(
    "hmlr_download_dataset",
    {
      title: "Download a bulk dataset into the local cache",
      description: `Fetch an HM Land Registry bulk dataset and load it into the local DuckDB cache, so the ownership, boundary and due-diligence tools can query it.

Requires a free HM Land Registry API key (HMLR_API_KEY) and that you have accepted the relevant dataset licence on your account.

This tool writes to disk and downloads potentially large files, so it defaults to a dry run: called with confirm=false (the default) it reports the file name and size and downloads nothing. Call again with confirm=true to proceed.

Args:
  - dataset ('ccod'|'ocod'|'leases'|'covenants'|'inspire', required)
  - area (string, optional): local authority name. Required for 'inspire'.
  - confirm (boolean, default false): false reports size only; true downloads.
  - response_format ('markdown'|'json', default 'markdown')

Returns JSON with schema:
  {
    "dataset": string, "file_name": string, "file_size": string,
    "last_updated": string, "dry_run": boolean,
    "downloaded": boolean, "rows_loaded": number|null,
    "message": string
  }

Examples:
  - "Set up overseas ownership data" -> dataset="ocod", confirm=false, then confirm=true
  - "Get boundaries for Westminster" -> dataset="inspire", area="Westminster", confirm=true

Errors:
  - Explains how to register when no API key is set.
  - Explains which licence to accept when HM Land Registry returns 401/403.
  - Lists available file names when an area does not match.`,
      inputSchema: DownloadFields,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guard(async (input: DownloadInput) => {
      const spec = resolveDataset(input.dataset);

      if (spec.perArea && !input.area) {
        throw new Error(
          `The "${spec.key}" dataset is published per local authority, so it needs an ` +
            "`area`. For example area=\"Westminster\". Use hmlr_lookup_postcode to " +
            "find the local authority for a postcode.",
        );
      }

      const metadata = await getDatasetMetadata(spec.apiName);
      const file = pickLatestFullFile(metadata, spec, input.area);

      if (!input.confirm) {
        const payload = {
          dataset: spec.key,
          file_name: file.file_name,
          file_size: file.file_size,
          last_updated: metadata.last_updated,
          dry_run: true,
          downloaded: false,
          rows_loaded: null,
          message:
            `Ready to download ${file.file_name} (${file.file_size}), published ` +
            `${metadata.last_updated}. Call again with confirm=true to proceed. ` +
            spec.notes,
        };
        return objectResponse(payload, input.response_format, () =>
          [
            `# ${spec.title} — ready to download`,
            "",
            `- **File**: \`${file.file_name}\``,
            `- **Size**: ${file.file_size}`,
            `- **Published**: ${metadata.last_updated}`,
            file.row_count ? `- **Rows**: ${file.row_count.toLocaleString("en-GB")}` : null,
            "",
            spec.notes,
            "",
            "Nothing has been downloaded. Call again with `confirm=true` to proceed.",
          ]
            .filter((line): line is string => line !== null)
            .join("\n"),
        );
      }

      const result = await ingestDataset(spec, file.file_name, input.area ?? null);

      const payload = {
        dataset: spec.key,
        file_name: file.file_name,
        file_size: file.file_size,
        last_updated: metadata.last_updated,
        dry_run: false,
        downloaded: true,
        rows_loaded: result.rowCount,
        message: `Loaded ${result.rowCount.toLocaleString("en-GB")} rows into table "${spec.table}".`,
      };

      return objectResponse(payload, input.response_format, () =>
        [
          `# ${spec.title} — downloaded`,
          "",
          `- **File**: \`${file.file_name}\` (${file.file_size})`,
          `- **Published**: ${metadata.last_updated}`,
          `- **Rows loaded**: ${result.rowCount.toLocaleString("en-GB")}`,
          `- **Table**: \`${spec.table}\``,
          input.area ? `- **Area**: ${input.area}` : null,
          "",
          "The tools backed by this dataset are now available.",
        ]
          .filter((line): line is string => line !== null)
          .join("\n"),
      );
    }),
  );
}
