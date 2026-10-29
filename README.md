# @pipeworx/bts-ontime

US domestic airline on-time performance and delay causes: monthly on-time %,
average arrival delay, cancellations, diversions, and delay minutes broken
down by cause (carrier, weather, air-traffic-control/NAS, security, late
aircraft) — by route, by carrier, and by arrival airport. Fleet #2953.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `route_ontime(origin, dest, carrier?, months?)` — monthly on-time
  performance for one origin->destination route, optionally scoped to one
  carrier. Each month carries flights, completed flights, on-time arrivals
  and on-time %, average arrival delay, cancellations, diversions, and delay
  minutes by cause.
- `carrier_ontime(carrier, airport?, months?)` — the same monthly shape,
  aggregated across one airline's whole network (or just the flights
  touching one airport).
- `bts_airport_delays(airport, year?, month?, limit?, offset?)` —
  delay-cause breakdown by carrier for flights ARRIVING at one airport,
  optionally scoped to a year and/or month. `limit` defaults to 50 (max
  200); a response with more matching rows than returned carries
  `truncated: true` and `total_matching` rather than silently dropping them.
- `delay_causes(year, carrier?, airport?, limit?, offset?)` — the same
  delay-cause rows, organized by year first, for scanning a whole year
  across carriers or airports. Same `limit`/`truncated`/`total_matching`
  pagination as `bts_airport_delays`.
- `list_coverage()` — the earliest/latest month actually loaded, and when.
  Call this first if you're not sure a given period is covered.

Carrier accepts either the 2-letter reporting-carrier code (`"DL"`) or a
common airline name (`"Delta"`). Airport codes are validated against what is
actually loaded (not a static list) — an unrecognized code is refused with a
clear error, never an empty success.

## Auth

Keyless. The tools answer only through the Pipeworx gateway, which holds the
data; a standalone `npm install` has no data to read, and every tool throws
a clear "not bound in this runtime" error there instead of returning an
empty list.

## Data sources

- US DOT Bureau of Transportation Statistics (BTS), TranStats — "Reporting
  Carrier On-Time Performance" monthly bulk data. US federal government
  work: public domain (17 U.S.C. §105). The agency publishes bulk files
  only (no live query API for this dataset), so this pack builds a copy
  (`scripts/bts-ontime/load-data.mjs`) rather than proxying — raw
  flight-level rows (~600k/month) are never stored; the loader aggregates
  each month down to two small tables and discards the raw file before
  moving to the next one.

### What `delay_cause` is, and is not

BTS separately publishes its own "Airline Delay Cause" product, which
apportions each delayed flight's minutes into fractional per-cause *counts*
via a methodology this pack does not reimplement. The `delay_cause` table
here is derived from the same underlying per-flight delay-minute fields
(carrier/weather/NAS/security/late-aircraft) as `route_month`, rolled up by
carrier x arrival-airport x month, and reported as **minute sums**, not
fractional counts. It will be consistent with BTS's own published cause
breakdown but is not guaranteed to match it row-for-row — this is one
pipeline over one raw source, not a second download of BTS's own aggregate.

### Known gaps — read before extending this pack

**Coverage is the most recent months as of the load, not full history.**
BTS's bulk-file server throttles hard per connection — one file download
measured ~170 seconds regardless of a modest concurrency increase helping
(3 concurrent downloads of this upstream finished in about the same wall
time as 1 serial one, measured 2026-10-12), so pulling the full 1987-present
archive (400+ monthly files) in one sitting is a multi-hour job, not a
pack-build step. This first load covers the most recent 12 months as of
2026-10-12 (call `list_coverage` for the exact range) for BOTH tables —
there is no separate 2003-onward backfill for `delay_cause` in this
commit; it is derived from the same months as `route_month`.

**Extending coverage is mechanical, not research** — see "Refreshing or
extending the data" below. Re-running the loader with a larger `--months`
(and a `--concurrency` tuned to be polite to the upstream) pulls further
back; nothing about the schema or the tools changes.

### Refreshing or extending the data

```bash
node scripts/bts-ontime/load-data.mjs --months 12                 # default: most recent 12 months
node scripts/bts-ontime/load-data.mjs --months 36 --concurrency 4 # extend further back
node scripts/bts-ontime/load-data.mjs --through 2026-7            # pin the "latest" month instead of probing
```

Needs `wrangler` logged in to the Pipeworx Cloudflare account. Each run
**replaces** `route_month`, `delay_cause` and `bts_ontime_meta` (DROP +
reload) rather than appending — BTS's own monthly files are themselves
revised occasionally, so a clean reload is the only way to be sure stale
rows from a withdrawn/corrected file don't linger. A monthly refresh (BTS
publishes with a roughly 2-month lag) should re-run this with a `--months`
large enough to cover the gap since the last load, not just `12`, or the
oldest previously-loaded months will quietly drop off the window.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "bts-ontime": {
      "url": "https://gateway.pipeworx.io/bts-ontime/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/bts-ontime/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/route_ontime \
  -H 'Content-Type: application/json' \
  -d '{"origin":"JFK","dest":"LAX","months":3}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/route_ontime`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-bts-ontime` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/bts-ontime/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "bts-ontime": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-bts-ontime"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Bts Ontime data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
