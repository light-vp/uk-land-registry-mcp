#!/usr/bin/env node
/**
 * uk-land-registry-mcp — MCP server for HM Land Registry open data.
 *
 * Two tiers of tools:
 *   • Live   — Price Paid Data and the UK House Price Index over HMLR's public
 *              SPARQL endpoint, plus postcodes.io. No key, no setup.
 *   • Cached — corporate/overseas ownership, INSPIRE boundaries and
 *              due-diligence flags. These need a free HM Land Registry API key
 *              and a one-off bulk download into a local DuckDB cache, because
 *              the "Use land and property data" API publishes files rather
 *              than exposing a query endpoint.
 *
 * Nothing is transmitted anywhere except to the government endpoints being
 * queried. There is no telemetry.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { CROWN_ATTRIBUTION, SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { registerPrompts } from "./prompts.js";
import { registerDiligenceTools } from "./tools/diligence.js";
import { registerHpiTools } from "./tools/hpi.js";
import { registerOwnershipTools } from "./tools/ownership.js";
import { registerPolygonTools } from "./tools/polygons.js";
import { registerPpdTools } from "./tools/ppd.js";
import { registerUtilityTools } from "./tools/utility.js";

const INSTRUCTIONS = `HM Land Registry open data for England and Wales.

Start with hmlr_data_status if a tool reports missing data — it says exactly what to download.

Tool selection:
  • One address's sale history      -> hmlr_get_property_history
  • Sales in a street or postcode   -> hmlr_search_transactions
  • Aggregate picture of an area    -> hmlr_get_area_stats
  • How prices have moved           -> hmlr_get_hpi / hmlr_compare_hpi_regions
  • Old price in today's money      -> hmlr_index_adjust_price
  • Postcode to district/coords     -> hmlr_lookup_postcode
  • Who owns it (companies only)    -> hmlr_search_company_properties,
                                       hmlr_search_ownership_by_area,
                                       hmlr_get_title_ownership
  • Boundaries and neighbouring land-> hmlr_get_title_polygon,
                                       hmlr_find_adjacent_parcels,
                                       hmlr_search_parcels_in_area
  • Lease/covenant flags            -> hmlr_check_leasehold,
                                       hmlr_check_restrictive_covenants

Two things worth knowing before interpreting results:
  1. Price Paid searches must be narrow (a postcode, or a street plus a town, or
     a town plus a date range). Broad searches are refused rather than timing out.
  2. The ownership datasets cover companies only. Property held by private
     individuals is not published in bulk, so an empty result never means
     "unowned" or "unregistered".

${CROWN_ATTRIBUTION}`;

function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  registerPpdTools(server);
  registerHpiTools(server);
  registerOwnershipTools(server);
  registerPolygonTools(server);
  registerDiligenceTools(server);
  registerUtilityTools(server);
  registerPrompts(server);

  return server;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    // stdout is the MCP channel, but --help is a deliberate CLI invocation.
    process.stdout.write(
      `${SERVER_NAME} v${SERVER_VERSION}

An MCP server for HM Land Registry open data. Runs over stdio.

Environment:
  HMLR_API_KEY    Free key from https://use-land-property-data.service.gov.uk/
                  Needed only for the ownership, boundary and due-diligence
                  tools. Price Paid Data, the House Price Index and postcode
                  lookups work without it.
  HMLR_DATA_DIR   Where bulk datasets are cached. Default: ~/.hmlr-mcp

Claude Desktop config:
  {
    "mcpServers": {
      "land-registry": {
        "command": "npx",
        "args": ["-y", "uk-land-registry-mcp"],
        "env": { "HMLR_API_KEY": "your-key-here" }
      }
    }
  }

${CROWN_ATTRIBUTION}
`,
    );
    return;
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stdout carries the protocol, so all logging goes to stderr.
  console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio`);
}

main().catch((error: unknown) => {
  console.error(
    `${SERVER_NAME} failed to start:`,
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});

export { createServer };
