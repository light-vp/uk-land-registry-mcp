/**
 * Resolves human region names ("Middlesbrough", "North East", "England") to
 * the HM Land Registry region URIs the House Price Index is keyed on.
 *
 * HMLR region URIs are slugs of the English label, so slugifying gets it right
 * most of the time; the label lookup catches the cases where it does not and
 * supplies suggestions when nothing matches.
 */

import { NS } from "../constants.js";
import { lit, regexLit, runQuery, slugIri, str } from "./sparql.js";

export interface ResolvedRegion {
  uri: string;
  slug: string;
  label: string;
}

const cache = new Map<string, ResolvedRegion>();

/** Turns "Bath and North East Somerset" into "bath-and-north-east-somerset". */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** True when a slug is present in the House Price Index. */
async function slugHasData(slug: string): Promise<string | null> {
  const results = await runQuery(
    `SELECT ?label WHERE {
       ${slugIri(NS.region, slug)} rdfs:label ?label .
       FILTER(LANG(?label) = "en" || LANG(?label) = "")
     } LIMIT 1`,
  );
  const binding = results.results.bindings[0];
  return binding ? str(binding, "label") : null;
}

/** Finds regions whose English label matches a search term. */
async function searchByLabel(name: string, limit = 8): Promise<ResolvedRegion[]> {
  const results = await runQuery(
    `SELECT ?region ?label WHERE {
       ?region rdfs:label ?label .
       FILTER(STRSTARTS(STR(?region), ${lit(NS.region)}))
       FILTER(LANG(?label) = "en" || LANG(?label) = "")
       FILTER(REGEX(?label, ${regexLit(name)}, "i"))
     } LIMIT ${Math.trunc(limit)}`,
  );

  return results.results.bindings.flatMap((binding) => {
    const uri = str(binding, "region");
    const label = str(binding, "label");
    if (!uri || !label) return [];
    return [{ uri, slug: uri.slice(NS.region.length), label }];
  });
}

export class UnknownRegionError extends Error {
  constructor(name: string, suggestions: ResolvedRegion[]) {
    const hint =
      suggestions.length > 0
        ? ` Did you mean: ${suggestions.map((s) => s.label).join(", ")}?`
        : " Try a local authority name (e.g. 'Middlesbrough'), a county " +
          "(e.g. 'Surrey'), a statistical region (e.g. 'North East'), or a " +
          "country ('England', 'Wales', 'Scotland', 'Northern Ireland').";
    super(`No House Price Index region matches "${name}".${hint}`);
    this.name = "UnknownRegionError";
  }
}

/**
 * Resolves a region name or slug to its URI. Accepts an already-resolved slug
 * or a full URI so callers can chain results without re-resolving.
 */
export async function resolveRegion(name: string): Promise<ResolvedRegion> {
  const key = name.trim().toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;

  // Accept a full HMLR region URI directly.
  if (name.startsWith(NS.region)) {
    const slug = name.slice(NS.region.length);
    const label = (await slugHasData(slug)) ?? slug;
    const resolved: ResolvedRegion = { uri: name, slug, label };
    cache.set(key, resolved);
    return resolved;
  }

  const slug = slugify(name);
  if (slug.length === 0) {
    throw new UnknownRegionError(name, []);
  }

  const directLabel = await slugHasData(slug);
  if (directLabel !== null) {
    const resolved: ResolvedRegion = {
      uri: NS.region + slug,
      slug,
      label: directLabel,
    };
    cache.set(key, resolved);
    return resolved;
  }

  const matches = await searchByLabel(name);
  const exact = matches.find((m) => m.label.toLowerCase() === key);
  const chosen = exact ?? matches[0];
  if (!chosen) {
    throw new UnknownRegionError(name, []);
  }

  // Only auto-accept a fuzzy match when it is unambiguous.
  if (!exact && matches.length > 1) {
    throw new UnknownRegionError(name, matches);
  }

  cache.set(key, chosen);
  return chosen;
}

/** Resolves several region names concurrently. */
export async function resolveRegions(names: string[]): Promise<ResolvedRegion[]> {
  return Promise.all(names.map((name) => resolveRegion(name)));
}

/**
 * Picks the best House Price Index region for a postcode, preferring the local
 * authority district and falling back to the statistical region. Used by
 * hmlr_index_adjust_price so callers do not have to know which regions exist.
 */
export async function regionForPostcodeAreas(
  adminDistrict: string | null,
  region: string | null,
  country: string | null,
): Promise<ResolvedRegion> {
  for (const candidate of [adminDistrict, region, country, "England and Wales"]) {
    if (!candidate) continue;
    try {
      return await resolveRegion(candidate);
    } catch {
      continue;
    }
  }
  throw new UnknownRegionError(adminDistrict ?? region ?? "unknown", []);
}
