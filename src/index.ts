interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * bts-ontime -- US airline on-time performance and delay causes (fleet #2953).
 *
 * Data: US DOT Bureau of Transportation Statistics (BTS) TranStats,
 * "Reporting Carrier On-Time Performance (1987-present)" monthly bulk CSVs
 * (transtats.bts.gov/PREZIP). US federal government work -- public domain
 * (17 U.S.C. §105). The site publishes bulk files only (no live API), so
 * this pack builds a copy (scripts/bts-ontime/load-data.mjs) into a D1
 * database the gateway hands it as `_d1` (pack-manifest "d1Binding":
 * "BTS_ONTIME_DB"). Raw flight-level rows are NEVER stored -- the loader
 * aggregates each month to two small tables and discards the ~600k-row raw
 * file before moving to the next month. Design note: this file + store.ts.
 *
 * SCOPE: the most recent N months as of the load (see bts_ontime_meta /
 * list_coverage below) -- not the full 1987-present or 2003-present history,
 * because BTS throttles per connection hard enough that a multi-decade
 * backfill is a multi-hour job better run as a scheduled extension than
 * inline in one build. See README.md "Known gaps" / "Refresh".
 *
 * Every response carries `source`, `source_url`, `license` and `data_as_of`
 * (the latest BTS month actually loaded).
 */
import {
  carrierMonths,
  clampLimit,
  clampMonths,
  delayCauses,
  delayCausesAtAirport,
  getMeta,
  normAirport,
  requireDb,
  resolveCarrierCode,
  routeMonths,
  SOURCE,
  validAirport,
  validCarrier,
  type D1Like,
} from './store.js';

const tools: McpToolExport['tools'] = [
  {
    name: 'route_ontime',
    description:
      'Monthly on-time performance for one US domestic flight route (origin airport -> destination airport), from BTS TranStats Reporting Carrier On-Time Performance. Returns, per month (and per carrier if more than one serves the route): flights, completed flights, on-time arrivals and on-time %, average arrival delay in minutes, cancellations, diversions, and delay minutes broken down by cause (carrier, weather, NAS/air-traffic-control, security, late aircraft). Pass carrier (2-letter code like "DL", or a common name like "Delta") to scope to one airline; omit it to see every carrier that flew the route. months caps how many of the most recently loaded months to return (default 12). Covers the most recent months loaded (see data_as_of and the earliest/latest fields), not full history. Unknown origin/destination airport codes are refused with a clear error, never an empty success.',
    summary: 'Monthly on-time %, average delay and delay causes for one origin->destination route.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        origin: { type: 'string', description: 'Origin airport code, e.g. "JFK".' },
        dest: { type: 'string', description: 'Destination airport code, e.g. "LAX".' },
        carrier: { type: 'string', description: 'Optional: 2-letter carrier code ("DL") or common name ("Delta") to scope to one airline.' },
        months: { type: 'number', description: 'How many of the most recently loaded months to return, most recent first. Default 12.' },
      },
      required: ['origin', 'dest'],
    },
  },
  {
    name: 'carrier_ontime',
    description:
      'Monthly on-time performance for one airline, aggregated across all its routes (or just the routes touching one airport), from BTS TranStats Reporting Carrier On-Time Performance. Pass carrier as a 2-letter code ("WN") or common name ("Southwest"). Pass airport to scope to flights where that airport is the origin or destination. Returns the same per-month shape as route_ontime (flights, on-time %, average arrival delay, cancellations, diversions, delay minutes by cause). months caps how many of the most recently loaded months to return (default 12). Unknown carrier codes are refused with a clear error, never an empty success.',
    summary: "Monthly on-time %, average delay and delay causes for one airline, system-wide or at one airport.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        carrier: { type: 'string', description: '2-letter carrier code ("WN") or common name ("Southwest").' },
        airport: { type: 'string', description: 'Optional: scope to flights where this airport is the origin or destination.' },
        months: { type: 'number', description: 'How many of the most recently loaded months to return, most recent first. Default 12.' },
      },
      required: ['carrier'],
    },
  },
  {
    name: 'bts_airport_delays',
    description:
      'Delay-cause breakdown at one US airport (as the ARRIVAL airport), by carrier, from BTS TranStats on-time data: arriving flights, how many arrived 15+ minutes late, cancellations, diversions, and delay minutes attributed to carrier, weather, NAS (air-traffic-control/system), security, and late-aircraft causes. Pass year and/or month to scope to a specific period; omit both to get every loaded month, most recent first. Rows beyond `limit` are reported via truncated/total_matching rather than silently dropped -- narrow with year/month or page with limit/offset to see the rest. Unknown airport codes are refused with a clear error, never an empty success.',
    summary: 'Delay-cause breakdown by carrier for arrivals at one airport.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        airport: { type: 'string', description: 'Airport code, e.g. "ORD".' },
        year: { type: 'number', description: 'Optional: scope to one calendar year.' },
        month: { type: 'number', description: 'Optional: scope to one month (1-12). Requires year to be meaningful alongside it, but works alone too (matches that month in any loaded year).' },
        limit: { type: 'number', description: 'Max rows to return, 1-200. Default 50. A truncated response carries truncated:true and total_matching.' },
        offset: { type: 'number', description: 'Pagination offset. Default 0.' },
      },
      required: ['airport'],
    },
  },
  {
    name: 'delay_causes',
    description:
      'Delay-cause rows for a given year, optionally scoped to one carrier and/or one (arrival) airport, from BTS TranStats on-time data. Same fields as bts_airport_delays (arriving flights, 15+ minute-late arrivals, cancellations, diversions, delay minutes by cause) but organized by year first rather than by airport first -- use this to scan a whole year across carriers/airports, or to compare one carrier\'s delay profile across the airports it serves. Rows beyond `limit` are reported via truncated/total_matching rather than silently dropped -- narrow with carrier/airport or page with limit/offset to see the rest. Unknown carrier or airport codes are refused with a clear error, never an empty success.',
    summary: 'Year-scoped delay-cause rows, optionally filtered by carrier and/or airport.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        year: { type: 'number', description: 'Calendar year, e.g. 2026.' },
        carrier: { type: 'string', description: 'Optional: 2-letter carrier code ("AA") or common name ("American").' },
        airport: { type: 'string', description: 'Optional: arrival-airport code, e.g. "DFW".' },
        limit: { type: 'number', description: 'Max rows to return, 1-200. Default 50. A truncated response carries truncated:true and total_matching.' },
        offset: { type: 'number', description: 'Pagination offset. Default 0.' },
      },
      required: ['year'],
    },
  },
  {
    name: 'list_coverage',
    description:
      'What this pack actually has loaded right now: the earliest and latest BTS month covered, how many months, and when it was last loaded. Call this before route_ontime/carrier_ontime/bts_airport_delays/delay_causes if you are not sure a given month or year is covered.',
    summary: 'Earliest/latest BTS month loaded, and when.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

function notFoundAirport(code: unknown) {
  return {
    found: false,
    reason: 'unknown_airport',
    message: `${JSON.stringify(code)} is not a recognized airport code in this pack's loaded data (it may be a valid IATA code that simply had no flights in the loaded window, or a typo). Call list_coverage to see the loaded date range.`,
  };
}
function notFoundCarrier(code: unknown) {
  return {
    found: false,
    reason: 'unknown_carrier',
    message: `${JSON.stringify(code)} is not a recognized carrier code in this pack's loaded data. Use a 2-letter Reporting Carrier code (e.g. "DL", "WN", "AA") or a common airline name.`,
  };
}

async function routeOntimeTool(db: D1Like, args: Record<string, unknown>) {
  const meta = await getMeta(db);
  const origin = normAirport(args.origin);
  const dest = normAirport(args.dest);
  if (!origin) return { found: false, reason: 'invalid_origin', message: `${JSON.stringify(args.origin)} is not a valid airport code (3-4 letters).`, data_as_of: meta.latest_month };
  if (!dest) return { found: false, reason: 'invalid_dest', message: `${JSON.stringify(args.dest)} is not a valid airport code (3-4 letters).`, data_as_of: meta.latest_month };
  if (!(await validAirport(db, origin))) return { ...notFoundAirport(args.origin), data_as_of: meta.latest_month };
  if (!(await validAirport(db, dest))) return { ...notFoundAirport(args.dest), data_as_of: meta.latest_month };

  let carrierCode: string | null = null;
  if (args.carrier != null && args.carrier !== '') {
    carrierCode = resolveCarrierCode(args.carrier);
    if (!carrierCode || !(await validCarrier(db, carrierCode))) return { ...notFoundCarrier(args.carrier), data_as_of: meta.latest_month };
  }

  const months = clampMonths(args.months, meta.months_loaded);
  const rows = await routeMonths(db, origin, dest, carrierCode, months);
  if (!rows.length) {
    return {
      found: false,
      reason: 'no_flights',
      origin,
      dest,
      carrier: carrierCode,
      message: `No ${origin}->${dest} flights found in the loaded window (${meta.earliest_month} to ${meta.latest_month})${carrierCode ? ` for carrier ${carrierCode}` : ''}. The airports are valid but this route may not have been flown (or not by that carrier) in that window.`,
      coverage: { earliest_month: meta.earliest_month, latest_month: meta.latest_month },
      ...SOURCE,
      data_as_of: meta.latest_month,
    };
  }
  return {
    found: true,
    origin,
    dest,
    carrier: carrierCode,
    returned: rows.length,
    coverage: { earliest_month: meta.earliest_month, latest_month: meta.latest_month },
    months: rows,
    ...SOURCE,
    data_as_of: meta.latest_month,
  };
}

async function carrierOntimeTool(db: D1Like, args: Record<string, unknown>) {
  const meta = await getMeta(db);
  const carrierCode = resolveCarrierCode(args.carrier);
  if (!carrierCode || !(await validCarrier(db, carrierCode))) return { ...notFoundCarrier(args.carrier), data_as_of: meta.latest_month };

  let airport: string | null = null;
  if (args.airport != null && args.airport !== '') {
    airport = normAirport(args.airport);
    if (!airport) return { found: false, reason: 'invalid_airport', message: `${JSON.stringify(args.airport)} is not a valid airport code.`, data_as_of: meta.latest_month };
    if (!(await validAirport(db, airport))) return { ...notFoundAirport(args.airport), data_as_of: meta.latest_month };
  }

  const months = clampMonths(args.months, meta.months_loaded);
  const rows = await carrierMonths(db, carrierCode, airport, months);
  if (!rows.length) {
    return {
      found: false,
      reason: 'no_flights',
      carrier: carrierCode,
      airport,
      message: `No flights found for carrier ${carrierCode}${airport ? ` at ${airport}` : ''} in the loaded window (${meta.earliest_month} to ${meta.latest_month}).`,
      coverage: { earliest_month: meta.earliest_month, latest_month: meta.latest_month },
      ...SOURCE,
      data_as_of: meta.latest_month,
    };
  }
  return {
    found: true,
    carrier: carrierCode,
    airport,
    returned: rows.length,
    coverage: { earliest_month: meta.earliest_month, latest_month: meta.latest_month },
    months: rows,
    ...SOURCE,
    data_as_of: meta.latest_month,
  };
}

async function airportDelaysTool(db: D1Like, args: Record<string, unknown>) {
  const meta = await getMeta(db);
  const airport = normAirport(args.airport);
  if (!airport) return { found: false, reason: 'invalid_airport', message: `${JSON.stringify(args.airport)} is not a valid airport code.`, data_as_of: meta.latest_month };
  if (!(await validAirport(db, airport))) return { ...notFoundAirport(args.airport), data_as_of: meta.latest_month };

  const year = args.year != null && args.year !== '' ? Math.floor(Number(args.year)) : null;
  if (args.year != null && args.year !== '' && !Number.isFinite(year)) throw new Error('year must be a valid number');
  const month = args.month != null && args.month !== '' ? Math.floor(Number(args.month)) : null;
  if (args.month != null && args.month !== '' && (!Number.isFinite(month) || (month as number) < 1 || (month as number) > 12)) {
    return { found: false, reason: 'invalid_month', message: `month must be 1-12 (got ${JSON.stringify(args.month)}).`, data_as_of: meta.latest_month };
  }

  const limit = clampLimit(args.limit);
  const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
  const { rows, total_matching, truncated } = await delayCausesAtAirport(db, airport, year, month, limit, offset);
  if (!rows.length) {
    return {
      found: false,
      reason: 'no_data',
      airport,
      year,
      month,
      message: `No delay-cause rows for ${airport}${year ? ` in ${year}` : ''}${month ? ` month ${month}` : ''} in the loaded window (${meta.earliest_month} to ${meta.latest_month}).`,
      coverage: { earliest_month: meta.earliest_month, latest_month: meta.latest_month },
      ...SOURCE,
      data_as_of: meta.latest_month,
    };
  }
  return {
    found: true,
    airport,
    year,
    month,
    returned: rows.length,
    total_matching,
    truncated,
    ...(truncated ? { hint: 'More rows exist than were returned. Narrow with year/month, or page with limit/offset.' } : {}),
    coverage: { earliest_month: meta.earliest_month, latest_month: meta.latest_month },
    rows,
    ...SOURCE,
    data_as_of: meta.latest_month,
  };
}

async function delayCausesTool(db: D1Like, args: Record<string, unknown>) {
  const meta = await getMeta(db);
  const year = Math.floor(Number(args.year));
  if (!Number.isFinite(year)) throw new Error('year must be a valid number');

  let carrierCode: string | null = null;
  if (args.carrier != null && args.carrier !== '') {
    carrierCode = resolveCarrierCode(args.carrier);
    if (!carrierCode || !(await validCarrier(db, carrierCode))) return { ...notFoundCarrier(args.carrier), data_as_of: meta.latest_month };
  }
  let airport: string | null = null;
  if (args.airport != null && args.airport !== '') {
    airport = normAirport(args.airport);
    if (!airport) return { found: false, reason: 'invalid_airport', message: `${JSON.stringify(args.airport)} is not a valid airport code.`, data_as_of: meta.latest_month };
    if (!(await validAirport(db, airport))) return { ...notFoundAirport(args.airport), data_as_of: meta.latest_month };
  }

  const limit = clampLimit(args.limit);
  const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
  const { rows, total_matching, truncated } = await delayCauses(db, carrierCode, airport, year, limit, offset);
  if (!rows.length) {
    return {
      found: false,
      reason: 'no_data',
      year,
      carrier: carrierCode,
      airport,
      message: `No delay-cause rows for ${year}${carrierCode ? ` carrier ${carrierCode}` : ''}${airport ? ` airport ${airport}` : ''} in the loaded window (${meta.earliest_month} to ${meta.latest_month}).`,
      coverage: { earliest_month: meta.earliest_month, latest_month: meta.latest_month },
      ...SOURCE,
      data_as_of: meta.latest_month,
    };
  }
  return {
    found: true,
    year,
    carrier: carrierCode,
    airport,
    returned: rows.length,
    total_matching,
    truncated,
    ...(truncated ? { hint: 'More rows exist than were returned. Narrow with carrier/airport, or page with limit/offset.' } : {}),
    coverage: { earliest_month: meta.earliest_month, latest_month: meta.latest_month },
    rows,
    ...SOURCE,
    data_as_of: meta.latest_month,
  };
}

async function listCoverageTool(db: D1Like) {
  const meta = await getMeta(db);
  return {
    earliest_month: meta.earliest_month,
    latest_month: meta.latest_month,
    months_loaded: meta.months_loaded,
    loaded_at: meta.loaded_at,
    note: 'Scoped to the most recent months as of the load, not full BTS history (1987-present). Re-run the loader with a larger --months to extend further back.',
    ...SOURCE,
    data_as_of: meta.latest_month,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const bound = requireDb(args._d1);
  switch (name) {
    case 'route_ontime':
      return routeOntimeTool(bound, args);
    case 'carrier_ontime':
      return carrierOntimeTool(bound, args);
    case 'bts_airport_delays':
      return airportDelaysTool(bound, args);
    case 'delay_causes':
      return delayCausesTool(bound, args);
    case 'list_coverage':
      return listCoverageTool(bound);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
