/**
 * Shared response construction. Every tool returns the same envelope shape:
 * a text rendering (markdown or JSON) plus `structuredContent`.
 */

import { z } from "zod";

import { CHARACTER_LIMIT, CROWN_ATTRIBUTION } from "../constants.js";
import {
  DatasetNotCachedError,
  MissingApiKeyError,
  QueryTooBroadError,
  ResponseFormat,
  type Paginated,
} from "../types.js";

export interface ToolResponse {
  // The SDK's result type carries an open index signature; matching it here
  // lets handlers return ToolResponse directly.
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Formats a number as GBP with no decimal places. */
export function gbp(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `£${Math.round(value).toLocaleString("en-GB")}`;
}

/** Formats an ISO date as "17 May 1996". */
export function humanDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Formats a percentage with one decimal place and an explicit sign. */
export function pct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

/** Renders an array of records as a GitHub-flavoured markdown table. */
export function markdownTable(
  headers: string[],
  rows: Array<Array<string | number | null | undefined>>,
): string {
  if (rows.length === 0) return "_No rows._";
  const escapeCell = (cell: string | number | null | undefined): string =>
    cell === null || cell === undefined
      ? "—"
      : String(cell).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`),
  ];
  return lines.join("\n");
}

/** Builds the standard pagination envelope around a page of items. */
export function paginate<T>(
  items: T[],
  total: number,
  offset: number,
): Paginated<T> {
  const hasMore = total > offset + items.length;
  return {
    total,
    count: items.length,
    offset,
    has_more: hasMore,
    ...(hasMore ? { next_offset: offset + items.length } : {}),
    items,
  };
}

/**
 * Applies CHARACTER_LIMIT to a rendered response, halving the item list until
 * it fits and explaining the truncation to the caller.
 */
function enforceLimit<T>(
  text: string,
  payload: Paginated<T>,
  render: (payload: Paginated<T>) => string,
): { text: string; payload: Paginated<T> } {
  let current = text;
  let working = payload;

  while (current.length > CHARACTER_LIMIT && working.items.length > 1) {
    const keep = Math.max(1, Math.floor(working.items.length / 2));
    working = {
      ...working,
      items: working.items.slice(0, keep),
      count: keep,
      truncated: true,
      truncation_message:
        `Response truncated from ${payload.items.length} to ${keep} items to stay ` +
        `within the ${CHARACTER_LIMIT.toLocaleString("en-GB")}-character limit. ` +
        "Use 'offset' to page through the rest, or narrow the search with more filters.",
    };
    current = render(working);
  }

  return { text: current, payload: working };
}

/** Builds a tool response from a paginated payload plus a markdown renderer. */
export function paginatedResponse<T>(
  payload: Paginated<T>,
  format: ResponseFormat,
  renderMarkdown: (payload: Paginated<T>) => string,
): ToolResponse {
  const render = (p: Paginated<T>): string =>
    format === ResponseFormat.JSON
      ? JSON.stringify(p, null, 2)
      : renderMarkdown(p);

  const { text, payload: finalPayload } = enforceLimit(
    render(payload),
    payload,
    render,
  );

  return {
    content: [{ type: "text", text }],
    structuredContent: finalPayload as unknown as Record<string, unknown>,
  };
}

/** Builds a tool response from an arbitrary object plus a markdown renderer. */
export function objectResponse(
  payload: Record<string, unknown>,
  format: ResponseFormat,
  renderMarkdown: () => string,
): ToolResponse {
  let text =
    format === ResponseFormat.JSON
      ? JSON.stringify(payload, null, 2)
      : renderMarkdown();

  if (text.length > CHARACTER_LIMIT) {
    text = `${text.slice(0, CHARACTER_LIMIT)}\n\n_[Response truncated at ${CHARACTER_LIMIT.toLocaleString("en-GB")} characters. Narrow the request to see the rest.]_`;
  }

  return {
    content: [{ type: "text", text }],
    structuredContent: payload,
  };
}

/** Appends the OGL attribution line required for HM Land Registry data. */
export function withAttribution(markdown: string, extra?: string): string {
  const lines = [markdown, "", "---", `_${CROWN_ATTRIBUTION}_`];
  if (extra) lines.push(`_${extra}_`);
  return lines.join("\n");
}

/**
 * Converts a thrown error into an MCP error response. Known error types carry
 * remediation guidance already, so their messages pass through verbatim.
 */
export function errorResponse(error: unknown): ToolResponse {
  let message: string;

  if (error instanceof z.ZodError) {
    // Cross-field rules (e.g. "provide one of X or Y") are enforced here rather
    // than in the tool's declared schema, so surface them readably.
    message =
      "Invalid arguments:\n" +
      error.issues
        .map((issue) => {
          const path = issue.path.join(".");
          return path ? `  • ${path}: ${issue.message}` : `  • ${issue.message}`;
        })
        .join("\n");
  } else if (
    error instanceof MissingApiKeyError ||
    error instanceof DatasetNotCachedError ||
    error instanceof QueryTooBroadError
  ) {
    message = error.message;
  } else if (error instanceof Error) {
    message = error.message;
  } else {
    message = String(error);
  }

  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}

/**
 * Wraps a tool handler so thrown errors become structured tool errors.
 *
 * The optional `schema` re-validates the arguments against a refined schema.
 * The MCP SDK builds its own object schema from the declared field shape, which
 * cannot express cross-field rules ("provide either X or Y"), so those live
 * here and their failures are reported as ordinary tool errors.
 */
export function guard<TArgs, TParsed = TArgs>(
  handler: (args: TParsed) => Promise<ToolResponse>,
  schema?: { parse(value: unknown): TParsed },
): (args: TArgs) => Promise<ToolResponse> {
  return async (args: TArgs): Promise<ToolResponse> => {
    try {
      const parsed = schema ? schema.parse(args) : (args as unknown as TParsed);
      return await handler(parsed);
    } catch (error) {
      return errorResponse(error);
    }
  };
}
