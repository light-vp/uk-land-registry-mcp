/**
 * Bundled workflows. Each prompt orchestrates several tools into a report a
 * professional would recognise, and each names the tools to call in order so
 * the model does not have to rediscover the sequence.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { CROWN_ATTRIBUTION, NOT_ADVICE_DISCLAIMER } from "./constants.js";

const CLOSING = `
Close the report with these two lines verbatim:

> ${CROWN_ATTRIBUTION}
> ${NOT_ADVICE_DISCLAIMER}`;

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "due_diligence_report",
    {
      title: "Pre-offer due diligence report",
      description:
        "Build a structured pre-offer report for one address: sale history, " +
        "local market context, index-adjusted valuation anchor, ownership and " +
        "tenure/covenant flags.",
      argsSchema: {
        address: z
          .string()
          .describe("The property address, including postcode, e.g. '42 Coates Avenue, TS4 3AQ'."),
      },
    },
    ({ address }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Produce a pre-offer due diligence report for: ${address}

Work through these steps, and state clearly when a step returns nothing rather than skipping it silently.

1. **Locate** — call hmlr_lookup_postcode with the postcode to get the local authority district, ward and coordinates. You will need the district for later steps.

2. **Sale history** — call hmlr_get_property_history with the postcode and the house number/name (and saon if it is a flat). Report every recorded sale, the gap between them, and the growth rate.

3. **Today's money** — take the most recent sale and call hmlr_index_adjust_price with that price, its date, and the postcode. This is a market-movement anchor, not a valuation; say so.

4. **Local market** — call hmlr_get_area_stats for the district (or postcode sector if the district is large) covering the last 24 months, with transaction_category="standard". Report the median, the direction of travel, and where this property's last sale sits relative to the local median.

5. **Comparables** — call hmlr_search_transactions for the same street or postcode sector over the last 24 months, matching property type where known. List up to eight, closest first in price terms.

6. **Ownership** — call hmlr_get_title_ownership if you have a title number, otherwise hmlr_search_ownership_by_area with the postcode. If the datasets are not cached, say what would be needed and move on — do not stall the report.

7. **Tenure and burdens** — if the sale history shows leasehold, call hmlr_check_leasehold. Call hmlr_check_restrictive_covenants for the title or address. Report both, and be explicit that the covenants dataset shows only presence, never the wording, and that absence is weak evidence.

Structure the output as:
- Summary (four or five bullets a buyer could act on)
- Sale history
- Valuation context
- Local market
- Comparables
- Ownership
- Flags and unknowns

In the final section, list plainly what the open data could not answer — the covenant wording, the current proprietor if individually owned, condition, planning history, lease term remaining — and note that these need an official copy of the register or a conveyancer.
${CLOSING}`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "ownership_investigation",
    {
      title: "Corporate and overseas ownership investigation",
      description:
        "Investigate who owns property across an area, or what a company owns, " +
        "combining the corporate and overseas ownership datasets with sold prices.",
      argsSchema: {
        target: z
          .string()
          .describe(
            "A company name, a company number, or an area (postcode, district or county).",
          ),
      },
    },
    ({ target }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Investigate property ownership for: ${target}

First decide whether the target is a company or an area, and say which reading you took.

**If it is a company:**
1. hmlr_search_company_properties with company_name (or company_number), dataset="both". Page through with offset until you have the full picture or a clear count.
2. Summarise the portfolio: how many titles, which districts, the tenure split, total and median price paid where recorded, and the earliest and latest date_proprietor_added.
3. For the three highest-value or most recent titles, call hmlr_get_title_ownership for the full proprietor detail including any co-proprietors and the address for service.
4. Where a title has a property address, call hmlr_search_transactions on that postcode to see what has sold nearby and whether the price paid looks in line.

**If it is an area:**
1. hmlr_search_ownership_by_area for the area, dataset="both".
2. hmlr_get_overseas_ownership_summary for the same area to break overseas ownership down by jurisdiction.
3. Identify the largest holders by title count, then run hmlr_search_company_properties on each to see whether their holdings extend beyond this area.
4. hmlr_get_area_stats for the same area over the last 24 months for market context.

**Always:**
- State plainly that these datasets cover companies only. Property held by private individuals is not published in bulk, so an absence is never evidence of no owner.
- Note the extract date from hmlr_data_status — the data is a monthly snapshot and lags the live register.
- Distinguish what the data shows from what it suggests. A Jersey-incorporated proprietor is a fact; an inference about why is not.
${CLOSING}`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "site_analysis",
    {
      title: "Development site analysis",
      description:
        "Analyse a site for development or land assembly: parcel extents, " +
        "adjoining ownership, and local sold-price evidence.",
      argsSchema: {
        location: z
          .string()
          .describe("A postcode, an address, or 'latitude, longitude' coordinates."),
      },
    },
    ({ location }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Analyse this location as a potential development or land-assembly site: ${location}

1. **Locate** — hmlr_lookup_postcode (or use the coordinates directly) to establish the local authority. Everything downstream needs INSPIRE data for that authority; if hmlr_data_status shows it is not cached, say exactly which hmlr_download_dataset call is needed and continue with whatever else you can answer.

2. **The parcel** — hmlr_get_title_polygon for the location. Report the area in m², hectares and acres.

3. **Neighbours** — hmlr_find_adjacent_parcels with check_ownership=true, first with within_metres=0 (directly touching), then again with within_metres=50 for the wider context. Flag every corporately-owned neighbour: those are the assembly opportunities and the ransom-strip risks.

4. **Nearby plots** — hmlr_search_parcels_in_area with a radius of 300m and min_area_sq_m set to something meaningful for the scheme, to find other developable plots.

5. **Value evidence** — hmlr_get_area_stats for the district over the last 24 months, then hmlr_search_transactions for the immediate postcode sector. Establish what completed units sell for locally.

6. **Trajectory** — hmlr_get_hpi for the local authority over the last five years, to show whether the local market is rising or falling.

Structure the output as:
- Site summary (extent, ownership pattern, immediate constraints)
- Parcel and neighbours (with a table of adjoining parcels and their owners where known)
- Assembly opportunities
- Value evidence
- Market trajectory
- Unknowns

Be explicit in the Unknowns section that INSPIRE polygons are indicative title extents from Ordnance Survey mapping and not legally definitive boundaries; that around 12% of land in England and Wales is unregistered and therefore invisible here; and that this analysis says nothing about planning status, allocations, access rights, easements or ground conditions.
${CLOSING}`,
          },
        },
      ],
    }),
  );
}
