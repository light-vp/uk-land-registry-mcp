/** Client for postcodes.io — free, no authentication, used as geographic glue. */

import { HTTP_TIMEOUT_MS, POSTCODES_IO_BASE } from "../constants.js";
import type { PostcodeInfo } from "../types.js";

export class PostcodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostcodeError";
  }
}

/** Normalises "sw1a1aa" or "SW1A  1AA" to the canonical "SW1A 1AA". */
export function normalisePostcode(postcode: string): string {
  const compact = postcode.toUpperCase().replace(/\s+/g, "");
  if (compact.length < 5 || compact.length > 7) {
    throw new PostcodeError(
      `"${postcode}" is not a valid UK postcode. Expected something like "SW1A 1AA" or "BA1 1AA".`,
    );
  }
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
}

/** Returns the outward code, e.g. "BA1" from "BA1 1AA". */
export function outcodeOf(postcode: string): string {
  return normalisePostcode(postcode).split(" ")[0]!;
}

/** Returns the postcode sector, e.g. "BA1 1" from "BA1 1AA". */
export function sectorOf(postcode: string): string {
  const normalised = normalisePostcode(postcode);
  const [outward, inward] = normalised.split(" ");
  return `${outward} ${inward!.charAt(0)}`;
}

interface PostcodesIoResponse {
  status: number;
  result: Record<string, unknown> | null;
  error?: string;
}

async function request(path: string): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(`${POSTCODES_IO_BASE}${path}`, {
      headers: { Accept: "application/json", "User-Agent": "uk-land-registry-mcp" },
      signal: controller.signal,
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new PostcodeError(`postcodes.io returned HTTP ${response.status}.`);
    }
    const body = (await response.json()) as PostcodesIoResponse;
    return body.result;
  } catch (error) {
    if (error instanceof PostcodeError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new PostcodeError("The postcodes.io request timed out. Try again.");
    }
    throw new PostcodeError(
      `Could not reach postcodes.io: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

function toStr(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toNum(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function shape(raw: Record<string, unknown>): PostcodeInfo {
  const postcode = toStr(raw.postcode) ?? "";
  let sector: string | null = null;
  try {
    sector = postcode ? sectorOf(postcode) : null;
  } catch {
    sector = null;
  }

  return {
    postcode,
    latitude: toNum(raw.latitude),
    longitude: toNum(raw.longitude),
    eastings: toNum(raw.eastings),
    northings: toNum(raw.northings),
    country: toStr(raw.country),
    region: toStr(raw.region),
    admin_district: toStr(raw.admin_district),
    admin_county: toStr(raw.admin_county),
    admin_ward: toStr(raw.admin_ward),
    parliamentary_constituency: toStr(raw.parliamentary_constituency),
    lsoa: toStr(raw.lsoa),
    msoa: toStr(raw.msoa),
    outcode: toStr(raw.outcode),
    incode: toStr(raw.incode),
    sector,
    codes: (raw.codes as Record<string, string> | undefined) ?? null,
  };
}

/** Looks up a full postcode. Returns null when the postcode does not exist. */
export async function lookupPostcode(postcode: string): Promise<PostcodeInfo | null> {
  const normalised = normalisePostcode(postcode);
  const raw = await request(`/postcodes/${encodeURIComponent(normalised)}`);
  return raw ? shape(raw) : null;
}

/** Reverse geocodes a coordinate to the nearest postcodes. */
export async function reverseGeocode(
  latitude: number,
  longitude: number,
  limit = 5,
): Promise<PostcodeInfo[]> {
  const query = new URLSearchParams({
    lat: String(latitude),
    lon: String(longitude),
    limit: String(limit),
  });
  const raw = (await request(`/postcodes?${query}`)) as unknown;
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => shape(entry as Record<string, unknown>));
}

/**
 * Reverse geocodes many coordinates in one request.
 *
 * postcodes.io accepts up to 100 geolocations per call, so a parcel list is
 * chunked rather than looked up one at a time — a 200-parcel search would
 * otherwise make 200 round trips.
 *
 * Returns one entry per input point, in the same order, with `null` where no
 * postcode lies within the search radius (common on rural land).
 */
export async function bulkReverseGeocode(
  points: Array<{ latitude: number; longitude: number }>,
  radiusMetres = 500,
): Promise<Array<{ postcode: string; admin_district: string | null } | null>> {
  if (points.length === 0) return [];

  const results: Array<{ postcode: string; admin_district: string | null } | null> = [];

  for (let start = 0; start < points.length; start += 100) {
    const chunk = points.slice(start, start + 100);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

    try {
      const response = await fetch(`${POSTCODES_IO_BASE}/postcodes`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "uk-land-registry-mcp",
        },
        body: JSON.stringify({
          geolocations: chunk.map((point) => ({
            longitude: point.longitude,
            latitude: point.latitude,
            limit: 1,
            radius: radiusMetres,
          })),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new PostcodeError(`postcodes.io bulk lookup returned HTTP ${response.status}.`);
      }

      const body = (await response.json()) as {
        result?: Array<{ result: Array<Record<string, unknown>> | null }>;
      };

      for (let index = 0; index < chunk.length; index += 1) {
        const nearest = body.result?.[index]?.result?.[0];
        const postcode = nearest ? toStr(nearest.postcode) : null;
        results.push(
          postcode ? { postcode, admin_district: toStr(nearest!.admin_district) } : null,
        );
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new PostcodeError("The postcodes.io bulk lookup timed out. Try a smaller limit.");
      }
      if (error instanceof PostcodeError) throw error;
      throw new PostcodeError(
        `Could not reach postcodes.io: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return results;
}

/**
 * Looks up an outward code (e.g. "BA1"). Useful when only a partial postcode
 * is known; returns the centroid and the admin areas it covers.
 */
export async function lookupOutcode(outcode: string): Promise<Record<string, unknown> | null> {
  const clean = outcode.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[A-Z]{1,2}[0-9][A-Z0-9]?$/.test(clean)) {
    throw new PostcodeError(`"${outcode}" is not a valid outward code (e.g. "BA1", "SW1A").`);
  }
  return request(`/outcodes/${encodeURIComponent(clean)}`);
}
