/** Zod fragments reused across tool input schemas. */

import { z } from "zod";
import { ResponseFormat } from "../types.js";

export const responseFormatField = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe(
    "Output format: 'markdown' for a human-readable summary (default) or 'json' for full structured data.",
  );

export const limitField = z
  .number()
  .int()
  .min(1)
  .max(200)
  .default(25)
  .describe("Maximum number of results to return (1-200, default 25).");

export const offsetField = z
  .number()
  .int()
  .min(0)
  .default(0)
  .describe("Number of results to skip, for paging through a large result set.");

/** ISO date (YYYY-MM-DD). */
export const dateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Dates must be in YYYY-MM-DD format, e.g. 2024-01-31")
  .describe("Date in YYYY-MM-DD format.");

/** Year-month (YYYY-MM), the granularity of the House Price Index. */
export const monthField = z
  .string()
  .regex(/^\d{4}-\d{2}$/, "Months must be in YYYY-MM format, e.g. 2024-06")
  .describe("Month in YYYY-MM format.");

export const postcodeField = z
  .string()
  .min(5)
  .max(10)
  .describe("Full UK postcode, e.g. 'BA1 1AA'. Spacing and case are normalised.");

export const propertyTypeField = z
  .enum(["detached", "semi", "terraced", "flat", "other"])
  .describe(
    "Property type: 'detached', 'semi' (semi-detached), 'terraced', 'flat' (flat or maisonette), or 'other'.",
  );

export const tenureField = z
  .enum(["freehold", "leasehold"])
  .describe("Tenure of the estate: 'freehold' or 'leasehold'.");

export const datasetChoiceField = z
  .enum(["ccod", "ocod", "both"])
  .default("both")
  .describe(
    "Which ownership dataset to search: 'ccod' (UK companies), 'ocod' (overseas companies), or 'both' (default).",
  );

/**
 * Validates that a date range is the right way round. Applied as a refinement
 * so the error reaches the model as a validation message, not a runtime throw.
 */
export function assertDateOrder(
  from: string | undefined,
  to: string | undefined,
  context: z.RefinementCtx,
): void {
  if (from && to && from > to) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `date_from (${from}) is after date_to (${to}). Swap them.`,
    });
  }
}
