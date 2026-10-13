/**
 * Reads for bts-ontime (fleet #2953).
 *
 * Data: US DOT Bureau of Transportation Statistics (BTS) TranStats,
 * "Reporting Carrier On-Time Performance (1987-present)" monthly bulk CSVs
 * (https://transtats.bts.gov/PREZIP/). US federal government work -- public
 * domain, 17 U.S.C. §105. Loaded into a D1 database the gateway hands this
 * pack as `_d1` (pack-manifest "d1Binding": "BTS_ONTIME_DB") by
 * scripts/bts-ontime/load-data.mjs -- never by a deploy.
 *
 * Two tables, both derived from the SAME monthly raw file:
 *   - route_month: carrier x origin x dest x month.
 *   - delay_cause: carrier x (arrival) airport x month -- delay-minute sums
 *     by cause, rolled up by arrival airport instead of by route. This is
 *     NOT the separately-published BTS "Airline Delay Cause" product (which
 *     apportions delay into fractional per-cause counts); it is the same
 *     underlying CarrierDelay/WeatherDelay/NASDelay/SecurityDelay/
 *     LateAircraftDelay minute fields, summed. See README.md.
 *
 * SCOPE, found 2026-10-13: loaded the most recent N months as of the run
 * (see bts_ontime_meta for the exact range) rather than back to 2003 -- BTS's
 * per-connection throttling (measured: one download ~170s regardless of file
 * size vs wall time, 3 concurrent downloads of the same upstream in the same
 * wall time as 1 serial one) makes a multi-decade backfill a multi-hour job
 * better run as a scheduled extension than inline in one pack-build session.
 * Re-run the loader with a larger --months to extend further back -- see
 * README.md "Refresh".
 */

export interface D1Like {
  prepare(sql: string): D1StmtLike;
}
export interface D1StmtLike {
  bind(...values: unknown[]): D1StmtLike;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export class StoreUnavailableError extends Error {
  constructor() {
    super(
      'bts-ontime: the on-time performance store is not bound in this runtime (no _d1). These tools only answer through the Pipeworx gateway; a standalone install has no data to read.',
    );
    this.name = 'StoreUnavailableError';
  }
}
export function requireDb(d1: unknown): D1Like {
  if (!d1 || typeof (d1 as D1Like).prepare !== 'function') throw new StoreUnavailableError();
  return d1 as D1Like;
}

export const SOURCE = {
  source: 'US DOT Bureau of Transportation Statistics (BTS), TranStats "Reporting Carrier On-Time Performance (1987-present)"',
  source_url: 'https://transtats.bts.gov/PREZIP/',
  license: 'US federal government work -- public domain (17 U.S.C. §105)',
};

// ── carrier code resolution ─────────────────────────────────────────────
// Reporting_Airline in the raw file is already a short code (e.g. "DL",
// "AA", "WN"); this just lets a caller say a common name instead. Codes NOT
// in this alias table still work fine as long as they're typed as the code
// itself -- validity is checked against what the DB actually holds
// (validCarrier below), not against this list.
const CARRIER_ALIASES: Record<string, string> = {
  AA: 'AA', AMERICAN: 'AA', 'AMERICAN AIRLINES': 'AA',
  DL: 'DL', DELTA: 'DL', 'DELTA AIR LINES': 'DL',
  UA: 'UA', UNITED: 'UA', 'UNITED AIRLINES': 'UA',
  WN: 'WN', SOUTHWEST: 'WN', 'SOUTHWEST AIRLINES': 'WN',
  B6: 'B6', JETBLUE: 'B6', 'JETBLUE AIRWAYS': 'B6',
  AS: 'AS', ALASKA: 'AS', 'ALASKA AIRLINES': 'AS',
  NK: 'NK', SPIRIT: 'NK', 'SPIRIT AIRLINES': 'NK',
  F9: 'F9', FRONTIER: 'F9', 'FRONTIER AIRLINES': 'F9',
  G4: 'G4', ALLEGIANT: 'G4', 'ALLEGIANT AIR': 'G4',
  HA: 'HA', HAWAIIAN: 'HA', 'HAWAIIAN AIRLINES': 'HA',
  OO: 'OO', SKYWEST: 'OO', 'SKYWEST AIRLINES': 'OO',
  MQ: 'MQ', ENVOY: 'MQ', 'ENVOY AIR': 'MQ',
  YX: 'YX', REPUBLIC: 'YX', 'REPUBLIC AIRWAYS': 'YX',
  OH: 'OH', PSA: 'OH', 'PSA AIRLINES': 'OH',
  '9E': '9E', ENDEAVOR: '9E', 'ENDEAVOR AIR': '9E',
  YV: 'YV', MESA: 'YV', 'MESA AIRLINES': 'YV',
  QX: 'QX', HORIZON: 'QX', 'HORIZON AIR': 'QX',
  ZW: 'ZW', 'AIR WISCONSIN': 'ZW',
};

/** Normalize caller input to a candidate carrier code -- does NOT guarantee
 *  the code actually exists in this pack's data; call validCarrier() for that. */
export function resolveCarrierCode(input: unknown): string | null {
  if (input == null) return null;
  const s = String(input).trim().toUpperCase();
  if (!s) return null;
  return CARRIER_ALIASES[s] ?? (/^[0-9A-Z]{2}$/.test(s) ? s : null);
}

export async function validCarrier(db: D1Like, code: string): Promise<boolean> {
  const r = await db.prepare('SELECT 1 AS x FROM route_month WHERE carrier = ? LIMIT 1').bind(code).first<{ x: number }>();
  return r != null;
}

export async function validAirport(db: D1Like, code: string): Promise<boolean> {
  const r = await db
    .prepare('SELECT 1 AS x FROM route_month WHERE origin = ? OR dest = ? LIMIT 1')
    .bind(code, code)
    .first<{ x: number }>();
  return r != null;
}

export function normAirport(input: unknown): string | null {
  if (input == null) return null;
  const s = String(input).trim().toUpperCase();
  return /^[A-Z]{3,4}$/.test(s) ? s : null;
}

export interface Meta {
  loaded_at: string;
  earliest_month: string; // "YYYY-MM"
  latest_month: string; // "YYYY-MM"
  months_loaded: number;
}
let cachedMeta: Meta | null = null;
export async function getMeta(db: D1Like): Promise<Meta> {
  if (cachedMeta) return cachedMeta;
  const r = await db.prepare('SELECT key, value FROM bts_ontime_meta').all<{ key: string; value: string }>();
  const m = Object.fromEntries(r.results.map((row) => [row.key, row.value]));
  cachedMeta = {
    loaded_at: m.loaded_at ?? '',
    earliest_month: m.earliest_month ?? '',
    latest_month: m.latest_month ?? '',
    months_loaded: Number(m.months_loaded ?? 0),
  };
  return cachedMeta;
}

/** Row-count limit for the delay-cause listing tools: default 50, max 200,
 *  so a default call stays well under the ~40KB response-size guidance. */
export function clampLimit(requested: unknown, dflt = 50, max = 200): number {
  const n = Math.floor(Number(requested));
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(n, max);
}

/** How many of the most recent loaded months to look back, clamped to what
 *  is actually loaded. */
export function clampMonths(requested: unknown, monthsLoaded: number, dflt = 12): number {
  const n = Math.floor(Number(requested));
  if (!Number.isFinite(n) || n <= 0) return Math.min(dflt, monthsLoaded);
  return Math.min(n, monthsLoaded);
}

export interface RouteMonthRow {
  year: number;
  month: number;
  carrier: string;
  origin: string;
  dest: string;
  flights: number;
  completed_flights: number;
  ontime_arrivals: number;
  sum_arr_delay: number;
  cancelled: number;
  diverted: number;
  carrier_delay_min: number;
  weather_delay_min: number;
  nas_delay_min: number;
  security_delay_min: number;
  late_aircraft_delay_min: number;
}

function shapeRoute(r: RouteMonthRow) {
  return {
    year: r.year,
    month: r.month,
    carrier: r.carrier,
    origin: r.origin,
    dest: r.dest,
    flights: r.flights,
    completed_flights: r.completed_flights,
    cancelled: r.cancelled,
    diverted: r.diverted,
    ontime_arrivals: r.ontime_arrivals,
    ontime_pct: r.completed_flights > 0 ? round2((r.ontime_arrivals / r.completed_flights) * 100) : null,
    avg_arr_delay_min: r.completed_flights > 0 ? round2(r.sum_arr_delay / r.completed_flights) : null,
    delay_minutes_by_cause: {
      carrier: round2(r.carrier_delay_min),
      weather: round2(r.weather_delay_min),
      nas: round2(r.nas_delay_min),
      security: round2(r.security_delay_min),
      late_aircraft: round2(r.late_aircraft_delay_min),
    },
  };
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Same shape as shapeRoute, but for a carrier-level aggregate that has no
 *  single origin/dest (it is summed across every route that matched). */
function shapeCarrierMonth(carrier: string, r: Omit<RouteMonthRow, 'carrier' | 'origin' | 'dest'>) {
  return {
    year: r.year,
    month: r.month,
    carrier,
    flights: r.flights,
    completed_flights: r.completed_flights,
    cancelled: r.cancelled,
    diverted: r.diverted,
    ontime_arrivals: r.ontime_arrivals,
    ontime_pct: r.completed_flights > 0 ? round2((r.ontime_arrivals / r.completed_flights) * 100) : null,
    avg_arr_delay_min: r.completed_flights > 0 ? round2(r.sum_arr_delay / r.completed_flights) : null,
    delay_minutes_by_cause: {
      carrier: round2(r.carrier_delay_min),
      weather: round2(r.weather_delay_min),
      nas: round2(r.nas_delay_min),
      security: round2(r.security_delay_min),
      late_aircraft: round2(r.late_aircraft_delay_min),
    },
  };
}

export async function routeMonths(db: D1Like, origin: string, dest: string, carrier: string | null, limitMonths: number) {
  const where = ['origin = ?', 'dest = ?'];
  const params: unknown[] = [origin, dest];
  if (carrier) {
    where.push('carrier = ?');
    params.push(carrier);
  }
  const sql = `SELECT year, month, carrier, origin, dest, flights, completed_flights, ontime_arrivals, sum_arr_delay, cancelled, diverted, carrier_delay_min, weather_delay_min, nas_delay_min, security_delay_min, late_aircraft_delay_min
    FROM route_month WHERE ${where.join(' AND ')}
    ORDER BY year DESC, month DESC, carrier
    LIMIT ?`;
  params.push(limitMonths * 20); // generous cap: several carriers per route per month
  const r = await db.prepare(sql).bind(...params).all<RouteMonthRow>();
  return r.results.map(shapeRoute);
}

export async function carrierMonths(db: D1Like, carrier: string, airport: string | null, limitMonths: number) {
  const where = ['carrier = ?'];
  const params: unknown[] = [carrier];
  if (airport) {
    where.push('(origin = ? OR dest = ?)');
    params.push(airport, airport);
  }
  const sql = `SELECT year, month,
      SUM(flights) AS flights, SUM(completed_flights) AS completed_flights, SUM(ontime_arrivals) AS ontime_arrivals,
      SUM(sum_arr_delay) AS sum_arr_delay, SUM(cancelled) AS cancelled, SUM(diverted) AS diverted,
      SUM(carrier_delay_min) AS carrier_delay_min, SUM(weather_delay_min) AS weather_delay_min,
      SUM(nas_delay_min) AS nas_delay_min, SUM(security_delay_min) AS security_delay_min, SUM(late_aircraft_delay_min) AS late_aircraft_delay_min
    FROM route_month WHERE ${where.join(' AND ')}
    GROUP BY year, month
    ORDER BY year DESC, month DESC
    LIMIT ?`;
  params.push(limitMonths);
  const r = await db.prepare(sql).bind(...params).all<Omit<RouteMonthRow, 'carrier' | 'origin' | 'dest'>>();
  return r.results.map((row) => shapeCarrierMonth(carrier, row));
}

export interface DelayCauseRow {
  year: number;
  month: number;
  carrier: string;
  airport: string;
  arr_flights: number;
  arr_del15: number;
  arr_cancelled: number;
  arr_diverted: number;
  carrier_delay_min: number;
  weather_delay_min: number;
  nas_delay_min: number;
  security_delay_min: number;
  late_aircraft_delay_min: number;
}
function shapeCause(r: DelayCauseRow) {
  return {
    year: r.year,
    month: r.month,
    carrier: r.carrier,
    airport: r.airport,
    arr_flights: r.arr_flights,
    arr_del15: r.arr_del15,
    arr_del15_pct: r.arr_flights > 0 ? round2((r.arr_del15 / r.arr_flights) * 100) : null,
    arr_cancelled: r.arr_cancelled,
    arr_diverted: r.arr_diverted,
    delay_minutes_by_cause: {
      carrier: round2(r.carrier_delay_min),
      weather: round2(r.weather_delay_min),
      nas: round2(r.nas_delay_min),
      security: round2(r.security_delay_min),
      late_aircraft: round2(r.late_aircraft_delay_min),
    },
  };
}

export interface PagedResult<T> {
  rows: T[];
  total_matching: number;
  truncated: boolean;
}

export async function delayCausesAtAirport(
  db: D1Like,
  airport: string,
  year: number | null,
  month: number | null,
  limit: number,
  offset: number,
): Promise<PagedResult<ReturnType<typeof shapeCause>>> {
  const where = ['airport = ?'];
  const params: unknown[] = [airport];
  if (year != null) {
    where.push('year = ?');
    params.push(year);
  }
  if (month != null) {
    where.push('month = ?');
    params.push(month);
  }
  const whereSql = where.join(' AND ');
  const sql = `SELECT year, month, carrier, airport, arr_flights, arr_del15, arr_cancelled, arr_diverted, carrier_delay_min, weather_delay_min, nas_delay_min, security_delay_min, late_aircraft_delay_min
    FROM delay_cause WHERE ${whereSql}
    ORDER BY year DESC, month DESC, arr_flights DESC
    LIMIT ? OFFSET ?`;
  const countSql = `SELECT COUNT(*) AS n FROM delay_cause WHERE ${whereSql}`;
  const [r, c] = await Promise.all([
    db.prepare(sql).bind(...params, limit, offset).all<DelayCauseRow>(),
    db.prepare(countSql).bind(...params).first<{ n: number }>(),
  ]);
  const total = c?.n ?? r.results.length;
  return { rows: r.results.map(shapeCause), total_matching: total, truncated: offset + r.results.length < total };
}

export async function delayCauses(
  db: D1Like,
  carrier: string | null,
  airport: string | null,
  year: number,
  limit: number,
  offset: number,
): Promise<PagedResult<ReturnType<typeof shapeCause>>> {
  const where = ['year = ?'];
  const params: unknown[] = [year];
  if (carrier) {
    where.push('carrier = ?');
    params.push(carrier);
  }
  if (airport) {
    where.push('airport = ?');
    params.push(airport);
  }
  const whereSql = where.join(' AND ');
  const sql = `SELECT year, month, carrier, airport, arr_flights, arr_del15, arr_cancelled, arr_diverted, carrier_delay_min, weather_delay_min, nas_delay_min, security_delay_min, late_aircraft_delay_min
    FROM delay_cause WHERE ${whereSql}
    ORDER BY month DESC, arr_flights DESC
    LIMIT ? OFFSET ?`;
  const countSql = `SELECT COUNT(*) AS n FROM delay_cause WHERE ${whereSql}`;
  const [r, c] = await Promise.all([
    db.prepare(sql).bind(...params, limit, offset).all<DelayCauseRow>(),
    db.prepare(countSql).bind(...params).first<{ n: number }>(),
  ]);
  const total = c?.n ?? r.results.length;
  return { rows: r.results.map(shapeCause), total_matching: total, truncated: offset + r.results.length < total };
}
