import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AnalyticsController } from "../src/analytics/analytics.controller";
import { AnalyticsService } from "../src/analytics/analytics.service";
import { InMemoryAnalyticsStore } from "../src/analytics/analytics.store";
import { ANALYTICS_STORE } from "../src/analytics/analytics.tokens";
import { ANALYTICS_METRICS, AnalyticsFillEvent } from "../src/analytics/analytics.types";
import { enableApiVersioning } from "../src/common/api-versioning";
import { HttpExceptionFilter } from "../src/common/http-exception.filter";

/**
 * Analytics HTTP surface: CSV export on GET /analytics/:metric (#596) and the
 * grouped POST /analytics/query endpoint (#595). The controller is mounted on
 * its own over a seeded in-memory store so the suite needs no TimescaleDB.
 */

const H = (hour: number) => Date.UTC(2026, 0, 1, hour, 0, 0);
const FROM = H(0) / 1000;
const TO = Date.UTC(2026, 0, 2) / 1000;

// Larger than Number.MAX_SAFE_INTEGER so any Number() coercion would show up.
const HUGE = 123456789012345678901234567890n;

function evt(overrides: Partial<AnalyticsFillEvent>): AnalyticsFillEvent {
  return {
    eventId: "fill:x",
    timestamp: H(1),
    chain: "stellar",
    srcToken: "USDC",
    dstToken: "USDC",
    solver: "SOLVER_A",
    volume: 0n,
    fees: 0n,
    durationMs: 1000,
    ...overrides,
  };
}

const EVENTS = [
  evt({ eventId: "1", timestamp: H(1), solver: "SOLVER_A", volume: HUGE, fees: 7n }),
  evt({ eventId: "2", timestamp: H(1), solver: "SOLVER_B", chain: "ethereum", volume: 500n, fees: 5n }),
  evt({ eventId: "3", timestamp: H(3), solver: "SOLVER_B", srcToken: "XLM", volume: 250n, fees: 2n }),
];

/** Parse simple CSV (no embedded commas in these fixtures). */
function parseCsv(text: string): string[][] {
  return text
    .trim()
    .split("\n")
    .map((line) => line.split(","));
}

describe("Analytics endpoints (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const store = new InMemoryAnalyticsStore();
    await store.ingest(EVENTS);

    const moduleRef = await Test.createTestingModule({
      controllers: [AnalyticsController],
      providers: [{ provide: ANALYTICS_STORE, useValue: store }, AnalyticsService],
    }).compile();

    app = moduleRef.createNestApplication();
    enableApiVersioning(app);
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, transformOptions: { enableImplicitConversion: true } }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  describe("GET /api/v1/analytics/:metric?format=csv", () => {
    for (const metric of ANALYTICS_METRICS) {
      it(`${metric}: CSV header matches the JSON field names and row counts match`, async () => {
        const json = await http()
          .get(`/api/v1/analytics/${metric}`)
          .query({ interval: "1h", from: FROM, to: TO })
          .expect(200);
        expect(json.headers["content-type"]).toMatch(/application\/json/);
        const rows = json.body as Record<string, unknown>[];
        expect(rows.length).toBeGreaterThan(0);

        const csv = await http()
          .get(`/api/v1/analytics/${metric}`)
          .query({ interval: "1h", from: FROM, to: TO, format: "csv" })
          .expect(200);
        expect(csv.headers["content-type"]).toMatch(/^text\/csv/);
        expect(csv.headers["content-disposition"]).toBe(`attachment; filename="${metric}.csv"`);

        const [header, ...data] = parseCsv(csv.text);
        expect(header).toEqual(Object.keys(rows[0]));
        expect(data).toHaveLength(rows.length);
        data.forEach((cells, i) => {
          expect(cells).toEqual(header.map((name) => String(rows[i][name])));
        });
      });
    }

    it("writes bigint-as-string amounts verbatim (no Number() precision loss)", async () => {
      const res = await http()
        .get("/api/v1/analytics/volume")
        .query({ interval: "1h", from: FROM, to: TO, format: "csv" })
        .expect(200);
      expect(res.text).toContain(`2026-01-01T01:00:00.000Z,${(HUGE + 500n).toString()}`);
    });

    it("honours Accept: text/csv when no format is given", async () => {
      const res = await http()
        .get("/api/v1/analytics/fees")
        .query({ interval: "1h", from: FROM, to: TO })
        .set("Accept", "text/csv")
        .expect(200);
      expect(res.headers["content-type"]).toMatch(/^text\/csv/);
      expect(res.text.split("\n")[0]).toBe("start,fees");
    });

    it("keeps JSON as the default and lets ?format=json override Accept", async () => {
      const res = await http()
        .get("/api/v1/analytics/fees")
        .query({ interval: "1h", from: FROM, to: TO, format: "json" })
        .set("Accept", "text/csv")
        .expect(200);
      expect(res.headers["content-type"]).toMatch(/application\/json/);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it("rejects an unknown format with 400", async () => {
      await http()
        .get("/api/v1/analytics/fees")
        .query({ interval: "1h", from: FROM, to: TO, format: "xlsx" })
        .expect(400);
    });
  });

  describe("POST /api/v1/analytics/query", () => {
    it("returns one row per bucket × group-by combination", async () => {
      const res = await http()
        .post("/api/v1/analytics/query")
        .send({ metric: "fees", interval: "1h", from: FROM, to: TO, groupBy: ["solver", "chain"] })
        .expect(200);
      expect(res.body).toEqual([
        { start: "2026-01-01T01:00:00.000Z", chain: "ethereum", solver: "SOLVER_B", fees: "5" },
        { start: "2026-01-01T01:00:00.000Z", chain: "stellar", solver: "SOLVER_A", fees: "7" },
        { start: "2026-01-01T03:00:00.000Z", chain: "stellar", solver: "SOLVER_B", fees: "2" },
      ]);
    });

    it("matches GET /analytics/volume when groupBy is empty or omitted", async () => {
      const fixed = await http()
        .get("/api/v1/analytics/volume")
        .query({ interval: "1h", from: FROM, to: TO })
        .expect(200);
      for (const body of [{}, { groupBy: [] }]) {
        const res = await http()
          .post("/api/v1/analytics/query")
          .send({ metric: "volume", interval: "1h", from: FROM, to: TO, ...body })
          .expect(200);
        expect(res.body).toEqual(fixed.body);
      }
    });

    it("rejects a crafted groupBy value with 400 instead of passing it to the store", async () => {
      for (const groupBy of [["src_token"], ['chain"; DROP TABLE analytics_fills; --'], ["chain", "chain"]]) {
        await http()
          .post("/api/v1/analytics/query")
          .send({ metric: "volume", from: FROM, to: TO, groupBy })
          .expect(400);
      }
    });

    it("rejects metrics the grouped builder does not support", async () => {
      await http()
        .post("/api/v1/analytics/query")
        .send({ metric: "latency", from: FROM, to: TO })
        .expect(400);
    });
  });
});
