/**
 * SPARQL client for the HM Land Registry linked-data service.
 *
 * Every user-supplied value that reaches a query MUST go through `lit`, `iri`
 * or one of the typed helpers. Interpolating raw strings into SPARQL is an
 * injection vector in exactly the way raw SQL is.
 */

import { SPARQL_ENDPOINT, SPARQL_PREFIXES, SPARQL_TIMEOUT_MS } from "../constants.js";
import type { SparqlBindingValue, SparqlResults } from "../types.js";

/**
 * Escapes a value for use as a SPARQL string literal, per the SPARQL 1.1
 * grammar for STRING_LITERAL_QUOTE. Returns the value *including* its quotes.
 */
export function lit(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    // Strip remaining control characters rather than trying to encode them.
    .replace(/[\u0000-\u001f\u007f]/g, "");
  return `"${escaped}"`;
}

/** Escapes a value as a typed SPARQL literal, e.g. "2024-01-01"^^xsd:date. */
export function typedLit(value: string, datatype: string): string {
  return `${lit(value)}^^${datatype}`;
}

/**
 * Renders an absolute IRI. Rejects anything containing characters that could
 * break out of the angle-bracket form.
 */
export function iri(value: string): string {
  if (!/^https?:\/\/[^\s<>"{}|\\^`]+$/.test(value)) {
    throw new Error(`Refusing to build a SPARQL query with an unsafe IRI: ${value}`);
  }
  return `<${value}>`;
}

/**
 * Renders a slug-safe IRI from a namespace and an identifier. Only accepts
 * lowercase alphanumerics and hyphens, which covers every HMLR region slug.
 */
export function slugIri(namespace: string, slug: string): string {
  if (!/^[a-z0-9-]+$/.test(slug)) {
    throw new Error(
      `Invalid identifier "${slug}": expected lowercase letters, digits and hyphens only.`,
    );
  }
  return iri(namespace + slug);
}

/** Escapes a value for use inside a SPARQL regex, escaping regex metacharacters too. */
export function regexLit(value: string): string {
  // Escape regex metacharacters first, then apply string-literal escaping.
  const regexEscaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return lit(regexEscaped);
}

export class SparqlError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "SparqlError";
  }
}

/**
 * Executes a SPARQL SELECT query and returns the raw JSON results.
 *
 * Uses POST with a form-encoded body: PPD queries routinely exceed the length
 * that is safe to put in a URL.
 */
export async function runQuery(
  query: string,
  timeoutMs: number = SPARQL_TIMEOUT_MS,
): Promise<SparqlResults> {
  const fullQuery = `${SPARQL_PREFIXES}\n${query}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(SPARQL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/sparql-results+json",
        "User-Agent": "uk-land-registry-mcp",
      },
      body: new URLSearchParams({ query: fullQuery }).toString(),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = (await response.text().catch(() => "")).slice(0, 500);
      throw new SparqlError(
        `HM Land Registry SPARQL endpoint returned ${response.status}. ${body}`,
        response.status,
      );
    }

    return (await response.json()) as SparqlResults;
  } catch (error) {
    if (error instanceof SparqlError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new SparqlError(
        `The query to HM Land Registry timed out after ${Math.round(timeoutMs / 1000)}s. ` +
          "This usually means the search was too broad — add a postcode, a street " +
          "and town, or a narrower date range, then try again.",
      );
    }
    throw new SparqlError(
      `Could not reach the HM Land Registry SPARQL endpoint: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Reads a binding as a string, or null when the variable is unbound. */
export function str(
  binding: Record<string, SparqlBindingValue> | undefined,
  name: string,
): string | null {
  const value = binding?.[name]?.value;
  return value === undefined ? null : value;
}

/** Reads a binding as a number, or null when unbound or not numeric. */
export function num(
  binding: Record<string, SparqlBindingValue> | undefined,
  name: string,
): number | null {
  const value = binding?.[name]?.value;
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Reads a binding as a boolean, or null when unbound. */
export function bool(
  binding: Record<string, SparqlBindingValue> | undefined,
  name: string,
): boolean | null {
  const value = binding?.[name]?.value;
  if (value === undefined) return null;
  return value === "true" || value === "1";
}

/**
 * Reads a binding that holds a URI and returns its final path segment.
 * HMLR encodes controlled vocabularies (property type, tenure, category) as
 * URIs whose last segment is the human-meaningful token.
 */
export function localName(
  binding: Record<string, SparqlBindingValue> | undefined,
  name: string,
): string | null {
  const value = binding?.[name]?.value;
  if (value === undefined) return null;
  const segment = value.split(/[/#]/).pop();
  return segment && segment.length > 0 ? segment : null;
}
