import { PrismaService } from "../prisma/prisma.service";
import {
  AnalyticsFillEvent,
  AnalyticsGroupedQuery,
  AnalyticsInterval,
  AnalyticsQuery,
  FeesPoint,
  GroupByDimension,
  GroupedMetric,
  GroupedPoint,
  LatencyPoint,
  normalizeGroupBy,
  SolverSharePoint,
  VolumePoint,
} from "./analytics.types";

/** Abstraction over the analytics store so dev/tests (in-memory) and production
 * (TimescaleDB) are interchangeable. */
export interface IAnalyticsStore {
  /** Idempotently ingest fill events. Returns the number newly stored. */
  ingest(events: AnalyticsFillEvent[]): Promise<number>;
  queryVolume(query: AnalyticsQuery): Promise<VolumePoint[]>;
  queryFees(query: AnalyticsQuery): Promise<FeesPoint[]>;
  queryLatency(query: AnalyticsQuery): Promise<LatencyPoint[]>;
  querySolverShare(query: AnalyticsQuery): Promise<SolverSharePoint[]>;
  /**
   * Aggregate `volume` or `fees` per bucket and per combination of the
   * requested group-by dimensions. An empty `groupBy` returns the same rows as
   * `queryVolume`/`queryFees`.
   */
  queryGrouped(query: AnalyticsGroupedQuery): Promise<GroupedPoint[]>;
}

/** Value of a group-by dimension for a raw fill event. */
function dimensionValue(event: AnalyticsFillEvent, dim: GroupByDimension): string {
  switch (dim) {
    case "chain":
      return event.chain;
    case "token":
      return event.srcToken;
    case "solver":
      return event.solver;
  }
}

/** Sort grouped rows by bucket, then by each requested dimension in order. */
function compareGrouped(dims: GroupByDimension[]) {
  return (a: GroupedPoint, b: GroupedPoint): number => {
    const byStart = a.start.localeCompare(b.start);
    if (byStart !== 0) return byStart;
    for (const dim of dims) {
      const cmp = (a[dim] ?? "").localeCompare(b[dim] ?? "");
      if (cmp !== 0) return cmp;
    }
    return 0;
  };
}

/** Nearest-rank percentile (the p-th smallest value when sorted). */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

/** Bucket start (epoch ms) for a timestamp and interval. */
export function bucketStart(timestampMs: number, intervalMs: number): number {
  return Math.floor(timestampMs / intervalMs) * intervalMs;
}

function matches(event: AnalyticsFillEvent, query: AnalyticsQuery): boolean {
  if (event.timestamp < query.from || event.timestamp >= query.to) return false;
  if (query.chain && event.chain !== query.chain) return false;
  if (query.token && event.srcToken !== query.token && event.dstToken !== query.token) return false;
  return true;
}

/**
 * In-memory store. Computes aggregates on the fly from raw events, which keeps
 * unit tests independent of a live TimescaleDB while exercising the same
 * filtering/bucketing semantics as the SQL backend.
 */
export class InMemoryAnalyticsStore implements IAnalyticsStore {
  private readonly events = new Map<string, AnalyticsFillEvent>();

  async ingest(events: AnalyticsFillEvent[]): Promise<number> {
    let inserted = 0;
    for (const event of events) {
      if (!this.events.has(event.eventId)) {
        this.events.set(event.eventId, event);
        inserted++;
      }
    }
    return inserted;
  }

  private matching(query: AnalyticsQuery): AnalyticsFillEvent[] {
    return [...this.events.values()].filter((e) => matches(e, query));
  }

  private bucketEvents(query: AnalyticsQuery): Map<number, AnalyticsFillEvent[]> {
    const intervalMs = intervalToMs(query.interval);
    const buckets = new Map<number, AnalyticsFillEvent[]>();
    for (const event of this.matching(query)) {
      const start = bucketStart(event.timestamp, intervalMs);
      const list = buckets.get(start) ?? [];
      list.push(event);
      buckets.set(start, list);
    }
    return buckets;
  }

  async queryVolume(query: AnalyticsQuery): Promise<VolumePoint[]> {
    const points: VolumePoint[] = [];
    for (const [start, events] of this.bucketEvents(query)) {
      const volume = events.reduce((sum, e) => sum + e.volume, 0n);
      points.push({ start: new Date(start).toISOString(), volume: volume.toString() });
    }
    return points.sort((a, b) => a.start.localeCompare(b.start));
  }

  async queryFees(query: AnalyticsQuery): Promise<FeesPoint[]> {
    const points: FeesPoint[] = [];
    for (const [start, events] of this.bucketEvents(query)) {
      const fees = events.reduce((sum, e) => sum + e.fees, 0n);
      points.push({ start: new Date(start).toISOString(), fees: fees.toString() });
    }
    return points.sort((a, b) => a.start.localeCompare(b.start));
  }

  async queryLatency(query: AnalyticsQuery): Promise<LatencyPoint[]> {
    const points: LatencyPoint[] = [];
    for (const [start, events] of this.bucketEvents(query)) {
      const durations = events.map((e) => e.durationMs);
      const count = durations.length;
      const avgMs = count ? durations.reduce((a, b) => a + b, 0) / count : 0;
      const p95Ms = percentile(durations, 0.95);
      points.push({ start: new Date(start).toISOString(), avgMs: Math.round(avgMs), p95Ms, count });
    }
    return points.sort((a, b) => a.start.localeCompare(b.start));
  }

  async querySolverShare(query: AnalyticsQuery): Promise<SolverSharePoint[]> {
    const points: SolverSharePoint[] = [];
    for (const [start, events] of this.bucketEvents(query)) {
      const bySolver = new Map<string, bigint>();
      let total = 0n;
      for (const event of events) {
        bySolver.set(event.solver, (bySolver.get(event.solver) ?? 0n) + event.volume);
        total += event.volume;
      }
      const iso = new Date(start).toISOString();
      for (const [solver, volume] of bySolver) {
        points.push({
          start: iso,
          solver,
          volume: volume.toString(),
          share: total === 0n ? 0 : Number((volume * 1_000_000n) / total) / 1_000_000,
        });
      }
    }
    return points.sort((a, b) => a.start.localeCompare(b.start) || b.share - a.share);
  }

  async queryGrouped(query: AnalyticsGroupedQuery): Promise<GroupedPoint[]> {
    const dims = normalizeGroupBy(query.groupBy);
    const points: GroupedPoint[] = [];
    for (const [start, events] of this.bucketEvents(query)) {
      const groups = new Map<string, { values: string[]; total: bigint }>();
      for (const event of events) {
        const values = dims.map((d) => dimensionValue(event, d));
        const key = JSON.stringify(values);
        const group = groups.get(key) ?? { values, total: 0n };
        group.total += query.metric === "volume" ? event.volume : event.fees;
        groups.set(key, group);
      }
      const iso = new Date(start).toISOString();
      for (const { values, total } of groups.values()) {
        const point: GroupedPoint = { start: iso };
        dims.forEach((d, i) => (point[d] = values[i]));
        point[query.metric] = total.toString();
        points.push(point);
      }
    }
    return points.sort(compareGrouped(dims));
  }
}

/**
 * SQL column for each group-by dimension. The grouped query only ever emits
 * these fixed identifiers — caller input selects a key, it is never spliced
 * into the SQL text.
 */
const GROUP_BY_COLUMNS: Record<GroupByDimension, string> = {
  chain: `"chain"`,
  token: `"src_token"`,
  solver: `"solver"`,
};

/** SQL column summed for each grouped metric (same allowlist discipline). */
const GROUPED_METRIC_COLUMNS: Record<GroupedMetric, string> = {
  volume: `"volume"`,
  fees: `"fees"`,
};

/**
 * TimescaleDB store. Queries the continuous aggregates created by
 * `prisma/migrations/*_analytics/migration.sql` (`analytics_fills_1m/1h/1d`).
 * Ingestion is idempotent via `ON CONFLICT (event_id, time) DO NOTHING`.
 */
export class TimescaleAnalyticsStore implements IAnalyticsStore {
  constructor(private readonly prisma: PrismaService) {}

  async ingest(events: AnalyticsFillEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    const values = events
      .map(
        (e) =>
          `(${this.lit(e.eventId)}, to_timestamp(${Math.floor(e.timestamp / 1000)}), ${this.lit(
            e.chain,
          )}, ${this.lit(e.srcToken)}, ${this.lit(e.dstToken)}, ${this.lit(e.solver)}, ${e.volume.toString()}, ${e.fees.toString()}, ${e.durationMs})`,
      )
      .join(",");
    const result = await this.prisma.$executeRawUnsafe(
      `INSERT INTO analytics_fills (event_id, time, chain, src_token, dst_token, solver, volume, fees, duration_ms)
       VALUES ${values}
       ON CONFLICT (event_id, time) DO NOTHING`,
    );
    return result;
  }

  private view(query: AnalyticsQuery): string {
    return `analytics_fills_${query.interval}`;
  }

  private where(query: AnalyticsQuery): string {
    const parts: string[] = [
      `bucket >= to_timestamp(${Math.floor(query.from / 1000)})`,
      `bucket < to_timestamp(${Math.ceil(query.to / 1000)})`,
    ];
    if (query.chain) parts.push(`chain = ${this.lit(query.chain)}`);
    if (query.token) parts.push(`(src_token = ${this.lit(query.token)} OR dst_token = ${this.lit(query.token)})`);
    return parts.join(" AND ");
  }

  async queryVolume(query: AnalyticsQuery): Promise<VolumePoint[]> {
    const rows = await this.prisma.$queryRawUnsafe<{ bucket: Date; volume: string }[]>(
      `SELECT time_bucket('1 ${unit(query.interval)}', bucket) AS bucket, sum(volume) AS volume
       FROM ${this.view(query)}
       WHERE ${this.where(query)}
       GROUP BY 1 ORDER BY 1`,
    );
    return rows.map((r) => ({ start: r.bucket.toISOString(), volume: String(r.volume) }));
  }

  async queryFees(query: AnalyticsQuery): Promise<FeesPoint[]> {
    const rows = await this.prisma.$queryRawUnsafe<{ bucket: Date; fees: string }[]>(
      `SELECT time_bucket('1 ${unit(query.interval)}', bucket) AS bucket, sum(fees) AS fees
       FROM ${this.view(query)}
       WHERE ${this.where(query)}
       GROUP BY 1 ORDER BY 1`,
    );
    return rows.map((r) => ({ start: r.bucket.toISOString(), fees: String(r.fees) }));
  }

  async queryLatency(query: AnalyticsQuery): Promise<LatencyPoint[]> {
    const rows = await this.prisma.$queryRawUnsafe<
      { bucket: Date; avg_ms: number; p95_ms: number; fills: number }[]
    >(
      `SELECT time_bucket('1 ${unit(query.interval)}', bucket) AS bucket,
              (sum(duration_sum) / sum(fills)) AS avg_ms,
              approx_percentile(0.95, rollup(duration_sketch)) AS p95_ms,
              sum(fills) AS fills
       FROM ${this.view(query)}
       WHERE ${this.where(query)}
       GROUP BY 1 ORDER BY 1`,
    );
    return rows.map((r) => ({
      start: r.bucket.toISOString(),
      avgMs: Math.round(Number(r.avg_ms)),
      p95Ms: Math.round(Number(r.p95_ms)),
      count: Number(r.fills),
    }));
  }

  async querySolverShare(query: AnalyticsQuery): Promise<SolverSharePoint[]> {
    const rows = await this.prisma.$queryRawUnsafe<
      { bucket: Date; solver: string; volume: string; total: string }[]
    >(
      `WITH per_solver AS (
         SELECT time_bucket('1 ${unit(query.interval)}', bucket) AS bucket, solver, sum(volume) AS volume
         FROM ${this.view(query)} WHERE ${this.where(query)}
         GROUP BY 1, solver
       ),
       totals AS (
         SELECT bucket, sum(volume) AS total FROM per_solver GROUP BY bucket
       )
       SELECT p.bucket, p.solver, p.volume, t.total
       FROM per_solver p JOIN totals t ON t.bucket = p.bucket
       ORDER BY p.bucket, p.volume DESC`,
    );
    return rows.map((r) => ({
      start: r.bucket.toISOString(),
      solver: r.solver,
      volume: String(r.volume),
      share: Number(r.total) === 0 ? 0 : Number(r.volume) / Number(r.total),
    }));
  }

  async queryGrouped(query: AnalyticsGroupedQuery): Promise<GroupedPoint[]> {
    // normalizeGroupBy throws on anything outside the allowlist, so only the
    // fixed GROUP_BY_COLUMNS identifiers below can ever reach the SQL text.
    const dims = normalizeGroupBy(query.groupBy);
    const metricColumn = GROUPED_METRIC_COLUMNS[query.metric];
    if (!metricColumn) throw new Error(`Unsupported grouped metric "${String(query.metric)}"`);

    const dimSelect = dims.map((d) => `, ${GROUP_BY_COLUMNS[d]} AS "${d}"`).join("");
    const dimGroup = dims.map((d) => `, ${GROUP_BY_COLUMNS[d]}`).join("");
    const rows = await this.prisma.$queryRawUnsafe<
      ({ bucket: Date; value: string } & Partial<Record<GroupByDimension, string>>)[]
    >(
      `SELECT time_bucket('1 ${unit(query.interval)}', bucket) AS bucket${dimSelect}, sum(${metricColumn}) AS value
       FROM ${this.view(query)}
       WHERE ${this.where(query)}
       GROUP BY 1${dimGroup} ORDER BY 1${dimGroup}`,
    );
    return rows.map((r) => {
      const point: GroupedPoint = { start: r.bucket.toISOString() };
      for (const d of dims) point[d] = String(r[d]);
      point[query.metric] = String(r.value);
      return point;
    });
  }

  /** SQL-escape a string literal (single quotes). */
  private lit(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }
}

function intervalToMs(interval: AnalyticsInterval): number {
  switch (interval) {
    case "1m":
      return 60_000;
    case "1h":
      return 3_600_000;
    case "1d":
      return 86_400_000;
  }
}

function unit(interval: AnalyticsInterval): string {
  switch (interval) {
    case "1m":
      return "minute";
    case "1h":
      return "hour";
    case "1d":
      return "day";
  }
}
