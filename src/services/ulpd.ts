/**
 * Client for the HM Land Registry "Use land and property data" API.
 *
 * Important: this API does not expose a query interface. It publishes bulk
 * files (zipped CSV, or GML for INSPIRE) and hands out short-lived signed
 * download URLs. Everything built on CCOD/OCOD/leases/covenants/INSPIRE
 * therefore has to be downloaded once and queried from the local cache.
 */

import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { DATASETS, HTTP_TIMEOUT_MS, ULPD_API_BASE, type DatasetSpec } from "../constants.js";
import { MissingApiKeyError } from "../types.js";

export interface DatasetResource {
  file_name: string;
  file_size: string;
  name: string;
  format: string;
  row_count?: number;
  file_count?: number;
}

export interface DatasetMetadata {
  name: string;
  title: string;
  description: string;
  last_updated: string;
  update_frequency: string;
  fee: string;
  format: string;
  file_size: string;
  resources: DatasetResource[];
  public_resources?: DatasetResource[];
}

export function getApiKey(): string | undefined {
  const key = process.env.HMLR_API_KEY?.trim();
  return key && key.length > 0 ? key : undefined;
}

export function requireApiKey(datasetKey?: string): string {
  const key = getApiKey();
  if (!key) throw new MissingApiKeyError(datasetKey);
  return key;
}

export class UlpdError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "UlpdError";
  }
}

function explainStatus(status: number, datasetName: string): string {
  switch (status) {
    case 401:
    case 403:
      return (
        `HM Land Registry rejected the API key for "${datasetName}" (HTTP ${status}). ` +
        "Two things to check: that HMLR_API_KEY is correct, and that you have " +
        "accepted this dataset's licence on your account at " +
        "https://use-land-property-data.service.gov.uk/ — access is granted per " +
        "dataset, so a key that works for CCOD may not yet cover OCOD or INSPIRE."
      );
    case 404:
      return (
        `HM Land Registry has no file by that name in "${datasetName}" (HTTP 404). ` +
        "File names are dated, e.g. CCOD_FULL_2024_06.zip. Call " +
        "hmlr_data_status to list the file names currently published."
      );
    case 429:
      return "HM Land Registry rate-limited the request (HTTP 429). Wait a minute and retry.";
    default:
      return `HM Land Registry API request failed with HTTP ${status}.`;
  }
}

async function apiRequest<T>(path: string, datasetName: string): Promise<T> {
  const key = requireApiKey(datasetName);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  try {
    const response = await fetch(`${ULPD_API_BASE}${path}`, {
      headers: {
        Authorization: key,
        Accept: "application/json",
        "User-Agent": "uk-land-registry-mcp",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new UlpdError(explainStatus(response.status, datasetName), response.status);
    }

    const body = (await response.json()) as { result?: T; success?: boolean };
    if (body.success === false || body.result === undefined) {
      throw new UlpdError(
        `HM Land Registry API reported failure for "${datasetName}". ` +
          "Confirm the dataset licence is accepted on your account.",
      );
    }
    return body.result;
  } catch (error) {
    if (error instanceof UlpdError || error instanceof MissingApiKeyError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new UlpdError("The HM Land Registry API request timed out. Try again.");
    }
    throw new UlpdError(
      `Could not reach the HM Land Registry API: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Lists the datasets the account can see. */
export async function listDatasets(): Promise<Array<{ name: string; title: string }>> {
  return apiRequest<Array<{ name: string; title: string }>>("/datasets", "datasets");
}

/** Fetches metadata (including the list of downloadable files) for one dataset. */
export async function getDatasetMetadata(apiName: string): Promise<DatasetMetadata> {
  return apiRequest<DatasetMetadata>(
    `/datasets/${encodeURIComponent(apiName)}`,
    apiName,
  );
}

/** Exchanges a file name for a signed download URL (valid ~10 seconds). */
export async function getDownloadUrl(apiName: string, fileName: string): Promise<string> {
  const result = await apiRequest<{ download_url: string; resource: string }>(
    `/datasets/${encodeURIComponent(apiName)}/${encodeURIComponent(fileName)}`,
    apiName,
  );
  if (!result.download_url) {
    throw new UlpdError(
      `HM Land Registry did not return a download URL for "${fileName}".`,
    );
  }
  return result.download_url;
}

/**
 * Picks the most recent full (not change-only) file from a dataset's resources.
 * Falls back to the newest resource of any kind when no full file is present.
 */
export function pickLatestFullFile(
  metadata: DatasetMetadata,
  spec: DatasetSpec,
  area?: string,
): DatasetResource {
  const resources = metadata.resources ?? [];
  if (resources.length === 0) {
    throw new UlpdError(
      `HM Land Registry lists no downloadable files for "${metadata.name}". ` +
        "This usually means the dataset licence has not been accepted on your account.",
    );
  }

  let candidates = resources;

  if (spec.perArea && area) {
    // INSPIRE files are named per local authority, e.g. Westminster.zip.
    const needle = area.toLowerCase().replace(/[^a-z0-9]/g, "");
    const matched = resources.filter(
      (r) => r.file_name.toLowerCase().replace(/[^a-z0-9]/g, "").includes(needle),
    );
    if (matched.length === 0) {
      const sample = resources
        .slice(0, 10)
        .map((r) => r.file_name)
        .join(", ");
      throw new UlpdError(
        `No "${metadata.name}" file matches area "${area}". ` +
          `File names look like: ${sample}. Use the local authority name exactly ` +
          "as HM Land Registry publishes it.",
      );
    }
    candidates = matched;
  } else {
    // Prefer the monthly FULL snapshot over the change-only (COU) file.
    const fullFiles = resources.filter((r) =>
      r.file_name.toUpperCase().includes("FULL"),
    );
    if (fullFiles.length > 0) candidates = fullFiles;
  }

  // File names embed YYYY_MM, so a descending lexicographic sort is a date sort.
  const sorted = [...candidates].sort((a, b) =>
    b.file_name.localeCompare(a.file_name),
  );
  return sorted[0]!;
}

/**
 * Streams a signed download URL to disk. Writes to a temporary path and
 * renames on success so a cancelled download never leaves a half-written file
 * that later looks cached.
 */
export async function downloadToFile(
  url: string,
  destination: string,
): Promise<number> {
  await mkdir(dirname(destination), { recursive: true });
  const tempPath = `${destination}.partial`;

  const response = await fetch(url, {
    headers: { "User-Agent": "uk-land-registry-mcp" },
  });
  if (!response.ok || !response.body) {
    throw new UlpdError(
      `The signed download URL returned HTTP ${response.status}. ` +
        "These URLs expire after about 10 seconds — retry the download.",
      response.status,
    );
  }

  try {
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(tempPath),
    );
    await rename(tempPath, destination);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }

  const { stat } = await import("node:fs/promises");
  return (await stat(destination)).size;
}

/** Resolves a dataset key from the tool-facing vocabulary to its spec. */
export function resolveDataset(key: string): DatasetSpec {
  const spec = DATASETS[key];
  if (!spec) {
    throw new UlpdError(
      `Unknown dataset "${key}". Available: ${Object.keys(DATASETS).join(", ")}.`,
    );
  }
  return spec;
}

/** Local path a dataset's downloaded archive is stored at. */
export function cachePathFor(dataDir: string, spec: DatasetSpec, fileName: string): string {
  return join(dataDir, "downloads", spec.key, fileName);
}
