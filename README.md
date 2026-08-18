# uk-land-registry-mcp

[![npm](https://img.shields.io/npm/v/uk-land-registry-mcp)](https://www.npmjs.com/package/uk-land-registry-mcp)
[![licence: MIT](https://img.shields.io/npm/l/uk-land-registry-mcp)](LICENSE)
[![node](https://img.shields.io/node/v/uk-land-registry-mcp)](https://nodejs.org)

An MCP server for **HM Land Registry open data** — sold prices, the UK House Price Index, corporate and overseas property ownership, title boundaries and due-diligence flags for England and Wales.

Free, MIT-licensed, runs locally over stdio. No hosting, no telemetry, no account required to get started.

```
"What did 52 Coates Avenue, TS4 3AQ sell for?"

  52 COATES AVENUE, MIDDLESBROUGH, TS4 3AQ — 2 registered sales since 1995.

  | Date          | Price    | Change | Annualised |
  |---------------|----------|--------|------------|
  | 29 July 2022  | £186,100 | —      | —          |
  | 20 April 2026 | £195,000 | +4.8%  | +1.3%/yr   |
```

---

## 60-second quickstart

No API key needed for sold prices, the House Price Index or postcode lookups. Nothing to install either — `npx` fetches the package on demand, so the config below is the whole setup.

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "land-registry": {
      "command": "npx",
      "args": ["-y", "uk-land-registry-mcp"]
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add land-registry -- npx -y uk-land-registry-mcp
```

Restart your client and ask it something like *"How has the Middlesbrough housing market moved over the last five years?"*

---

## What you can ask

**Sold prices** — every property sale registered in England and Wales since 1995.

- *"What sold on Manvers Street in Bath in 2023?"*
- *"What did this house sell for, and when?"*
- *"Median flat price in TS1 2 last year, and how that compares to the year before"*

**House Price Index** — the official mix-adjusted measure of price movement.

- *"How has Middlesbrough tracked against the North East and England?"*
- *"First-time buyer prices in Wales"*
- *"£185,000 in March 2017 in Bath — what's that in today's money?"*

**Ownership** (needs a free API key) — which companies own what.

- *"What does this company own in England and Wales?"*
- *"Who owns property in SW1 through offshore companies?"*
- *"Which jurisdictions own the most property in Westminster?"*

**Boundaries and due diligence** (needs a free API key)

- *"How big is this plot, and what adjoins it?"*
- *"Any corporately-owned land within 50m?"*
- *"Does this title carry a restrictive covenant?"*

---

## Two tiers of tools

| Tier | Tools | Setup |
|---|---|---|
| **Live** | Price Paid Data, House Price Index, postcode lookup | None. Queries public endpoints directly. |
| **Cached** | Ownership, boundaries, leases, covenants | Free API key + a one-off download per dataset. |

The cached tier exists because of how HM Land Registry publishes the data. The *Use land and property data* API has **no query endpoint** — it serves monthly bulk files and signed download URLs. So CCOD, OCOD, INSPIRE, leases and covenants have to be pulled down once and queried locally. This server loads them into an embedded [DuckDB](https://duckdb.org) database under `~/.hmlr-mcp/`.

If a tool needs data you don't have, it tells you the exact call to make. Start with `hmlr_data_status`.

---

## Setting up the API key

Only needed for ownership, boundaries and due-diligence tools.

1. Register free at **[use-land-property-data.service.gov.uk](https://use-land-property-data.service.gov.uk/)**.
2. **Accept the licence for each dataset you want.** Access is granted per dataset — a key that works for CCOD will not fetch OCOD until you accept OCOD's licence too. This is the single most common cause of a `403`.
3. Copy the API key from your account page.
4. Add it to your MCP client config:

```json
{
  "mcpServers": {
    "land-registry": {
      "command": "npx",
      "args": ["-y", "uk-land-registry-mcp"],
      "env": { "HMLR_API_KEY": "your-key-here" }
    }
  }
}
```

Then download a dataset. Start with OCOD — it's the smallest:

> *"Download the overseas ownership dataset."*

`hmlr_download_dataset` is deliberately a two-step operation: the first call reports the file name and size and downloads nothing, so you can see the cost before committing. CCOD is several hundred MB; INSPIRE is per local authority.

### Which dataset for which question

| You want | Dataset | Rough size |
|---|---|---|
| UK companies that own property | `ccod` | ~3.5M rows, several hundred MB |
| Overseas companies that own property | `ocod` | ~100k rows, small — start here |
| Title boundary polygons | `inspire` | Per local authority |
| Registered leases | `leases` | Large |
| Restrictive covenant indicators | `covenants` | Moderate |

### If a download fails

| Symptom | Cause |
|---|---|
| `401`/`403` | The licence for *that specific dataset* isn't accepted on your account. Accepting CCOD's licence does not grant OCOD. This is by far the most common cause. |
| `404` on a file name | File names are dated (`CCOD_FULL_2026_07.zip`). Run `hmlr_data_status`, or just call `hmlr_download_dataset` without a file name and let it pick the latest. |
| "signed download URL returned HTTP 403" | These URLs expire about 10 seconds after they're issued. Retry — on a slow connection a large file may need a couple of attempts. |
| "No file matches area" | INSPIRE files are named per local authority. Use the name exactly as HM Land Registry publishes it; the error lists examples. |

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `HMLR_API_KEY` | unset | Key for the bulk datasets. Live tools work without it. |
| `HMLR_DATA_DIR` | `~/.hmlr-mcp` | Where downloads and the DuckDB cache live. |

---

## Tools

**Price Paid Data** (live)
| Tool | Purpose |
|---|---|
| `hmlr_search_transactions` | Search sold prices by location, date, price, type, tenure |
| `hmlr_get_property_history` | Every recorded sale of one address, with appreciation |
| `hmlr_get_area_stats` | Median/mean, type and tenure breakdown, year-on-year change |

**House Price Index** (live)
| Tool | Purpose |
|---|---|
| `hmlr_get_hpi` | Index for a region, optionally by property type, buyer status, funding |
| `hmlr_compare_hpi_regions` | Two to five regions side by side |
| `hmlr_index_adjust_price` | Restate a past sale in another period's money |

**Ownership** (cached — CCOD/OCOD)
| Tool | Purpose |
|---|---|
| `hmlr_search_company_properties` | Titles owned by a company |
| `hmlr_search_ownership_by_area` | Corporately-owned titles in an area |
| `hmlr_get_overseas_ownership_summary` | Overseas ownership by jurisdiction |
| `hmlr_get_title_ownership` | Proprietors of a single title number |

**Boundaries** (cached — INSPIRE)
| Tool | Purpose |
|---|---|
| `hmlr_get_title_polygon` | Boundary geometry and area for a parcel |
| `hmlr_find_adjacent_parcels` | Neighbouring parcels, flagging corporate owners |
| `hmlr_search_parcels_in_area` | Parcels by radius or bounding box, filtered by size |

**Due diligence** (cached)
| Tool | Purpose |
|---|---|
| `hmlr_check_leasehold` | Registered leases against a title or address |
| `hmlr_check_restrictive_covenants` | Covenant presence indicator |

**Utilities**
| Tool | Purpose |
|---|---|
| `hmlr_lookup_postcode` | Postcode → coordinates, district, ward, region |
| `hmlr_data_status` | What's cached, what's configured, what to do next |
| `hmlr_download_dataset` | Fetch a bulk dataset into the cache |

### Prompts

Three bundled workflows: `due_diligence_report` (an address), `ownership_investigation` (a company or area), `site_analysis` (a development site).

---

## Things worth knowing before trusting a result

**Searches must be narrow.** Price Paid Data holds ~30 million transactions. A search with no selective filter is *refused* rather than left to time out — supply a postcode, or a street plus a town, or a town plus a date range.

**Category A vs category B.** HM Land Registry classifies sales as standard (arm's-length residential, at full market value) or additional (repossessions, transfers to companies, buy-to-lets, commercial). Category B badly skews averages — one £11.3M commercial sale in a town-centre postcode sector will move a mean by an order of magnitude. `hmlr_get_area_stats` therefore defaults to standard-only; `hmlr_search_transactions` returns both unless you ask otherwise.

**Ownership data covers companies only.** Property held by private individuals is not published in bulk. An empty ownership result means *"no company owns registered title here"* — never *"unowned"* or *"unregistered"*.

**Around 12% of land in England and Wales is still unregistered** and has no INSPIRE polygon and no title.

**You cannot join a boundary polygon to its owner using open data.** This one catches people out, so it's worth being precise. INSPIRE polygons carry an *INSPIRE ID*; ownership data is keyed on a *title number*. HM Land Registry deliberately does not publish the mapping between them — that link is the [National Polygon Service](https://use-land-property-data.service.gov.uk/datasets/nps), which costs £20,000 + VAT a year. The two identifiers aren't even the same shape: title numbers are 2–3 letters plus digits (`CS72510`), INSPIRE IDs are bare integers (`52288545`), so they can never match.

So `hmlr_find_adjacent_parcels` matches corporate owners **by postcode proximity** instead: it reverse-geocodes each parcel's centroid and asks which companies own registered title at that postcode. That answers *"which companies are active around here?"* — useful for land assembly — but **not** *"who owns this parcel?"*. Specifically:

- A postcode usually covers several titles, so a match is a neighbourhood signal, not an ownership claim.
- The centroid resolves to the *nearest* postcode, which for a large or rural parcel may not be the parcel's own.
- Titles with no address (bare land) often have no postcode recorded, so they never match.
- An empty result means nothing matched — not that the land is individually owned.

For actual ownership of a specific title, use `hmlr_get_title_ownership` with a title number, or buy an official copy of the register (£3 via GOV.UK).

**INSPIRE polygons are indicative**, derived from Ordnance Survey mapping. They are not legally definitive boundaries.

**The covenants dataset excludes the covenant wording** by design. It can tell you a title is burdened, never what the burden is. Reading it needs an official copy of the register and the referenced deed (£3 each via GOV.UK).

**Bulk datasets are monthly snapshots** and lag the live register. `hmlr_data_status` reports the extract date.

---

## Development

Requires Node 22 or later (the test runner uses native TypeScript stripping).

```bash
npm install
npm run build
npm test
```

Test interactively with the MCP Inspector:

```bash
npm run inspect
```

### Test layout

The default suite is **offline and deterministic** — no network, no API key — so it is safe to run in CI and on a plane.

| File | Covers |
|---|---|
| `tests/units.test.ts` | SPARQL and SQL escaping, postcode handling, region slugs, growth arithmetic |
| `tests/queries.test.ts` | Generated SPARQL, against a stubbed transport |
| `tests/ingest.test.ts` | The DuckDB CSV pipeline, against a synthetic CCOD file |
| `tests/spatial.test.ts` | INSPIRE GML ingest, reprojection, parcel adjacency |
| `tests/e2e.test.ts` | The live endpoints — **skipped unless `HMLR_E2E=1`** |

```bash
HMLR_E2E=1 npm test     # include the live-endpoint suite
npm run verify-eval     # re-derive every evaluation.xml answer from live data
```

Two of these suites guard against things that are easy to regress silently and expensive to notice:

- **`queries.test.ts` asserts triple order.** The endpoint evaluates patterns roughly as written, so a selective filter placed after the `OPTIONAL` blocks turns a 0.3-second query into one that exceeds 70 seconds. Nothing else would catch that.
- **`spatial.test.ts` asserts real distances.** DuckDB's spatial extension returns `0` from `ST_Distance` and `true` from `ST_DWithin` for *any* polygon pair, so `hmlr_find_adjacent_parcels` derives separation from boundary geometry instead. The tests assert the correct answers, not the workaround, so they keep passing if DuckDB fixes it.

### CI

`.github/workflows/ci.yml` runs type-checking (including unused-code detection), the build, the offline suite and a server smoke test across Node 22/24 on Linux and macOS — both platforms, because DuckDB ships per-platform native binaries.

A second job runs the live-endpoint suite and re-verifies the evaluation answers. It is marked `continue-on-error`: government endpoints are outside our control, and a transient outage should report rather than block a pull request.

### Releasing

`.github/workflows/publish.yml` publishes to npm when a **GitHub Release** is published — never on merge, so shipping is always deliberate.

1. Bump `version` in `package.json` and merge that to `main`.
2. Draft a GitHub Release tagged `v<version>` (matching exactly) and publish it.

The workflow then refuses to continue if the tag disagrees with `package.json`, or if that version is already on the registry. It builds, checks the server still lists 18 tools, and publishes — at which point `prepublishOnly` cleans, rebuilds and runs the offline suite one more time before the tarball is packed.

Authentication is npm **trusted publishing**: the job exchanges a GitHub OIDC token for a short-lived credential, so there is no npm token stored in this repository and nothing to rotate. It also attaches a provenance attestation, which is why npm shows the package as built from this repo at a specific commit.

`workflow_dispatch` runs the same pipeline with `dry_run` on by default, if you want to rehearse it without uploading.

Versions are permanent — npm never lets a published version number be reused, even after an unpublish.

### Other files

`manifest.json` is an [MCPB](https://github.com/anthropics/mcpb) bundle manifest, for packaging the server as a one-click Claude Desktop install that prompts for the API key instead of requiring hand-edited JSON. It has not yet been packed or tested with `mcpb pack`.

`evaluation.xml` holds ten read-only question/answer pairs. All are answerable with the live tools alone, and the answers come from historical records and settled index months so they stay stable. `npm run verify-eval` re-derives each one from the live endpoints — it checks that the answers remain *factually correct*, which is not the same as scoring whether a model can find them.

The test suite runs against the compiled output in `dist/`. `tests/units.test.ts` covers query escaping, postcode handling and the growth arithmetic; `tests/ingest.test.ts` drives the real DuckDB pipeline against a synthetic CCOD file using HM Land Registry's published column names.

DuckDB is an **optional** dependency. If its native binary won't install on your platform, the live tools keep working and the cached tools report the problem rather than crashing the server.

---

## Licence and attribution

The **code** is MIT licensed. The **data** is not — see [NOTICE](./NOTICE) for the full terms. In summary:

- Price Paid Data, House Price Index, INSPIRE: Open Government Licence v3.0. Attribution required; the tools emit it with every response.
- INSPIRE geometry also contains Ordnance Survey data and is subject to OS licensing terms.
- CCOD/OCOD/leases/covenants: free, but under HM Land Registry's own licence, with restrictions on commercial re-use and republishing.

This server **never redistributes government data**. Live tools query public endpoints at request time; bulk datasets are downloaded by you, under your own account and licence acceptance, to your own machine.

> Contains HM Land Registry data © Crown copyright and database right. Licensed under the Open Government Licence v3.0.

**Not legal advice.** Nothing this produces is a substitute for official Land Registry searches or a conveyancer's report.
