/**
 * Infra check others can run after clone: Redis + optional GET /health.
 * Usage: `npm test` (loads `.env` via dotenv if you run through npm).
 *
 * Env overrides:
 *   TEST_SKIP_HEALTH=1     — only ping Redis
 *   TEST_HEALTH_URL=...    — base URL (default http://127.0.0.1:$PORT)
 */
import "dotenv/config";
import { Redis } from "ioredis";

async function checkRedis(): Promise<void> {
  const url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  const redis = new Redis(url, { maxRetriesPerRequest: null });
  try {
    const pong = await redis.ping();
    console.log(`[ok] Redis ${url} → PING ${pong}`);
  } finally {
    await redis.quit();
  }
}

async function checkHealth(): Promise<void> {
  const port = process.env.PORT ?? "3000";
  const base = process.env.TEST_HEALTH_URL ?? `http://127.0.0.1:${port}`;
  const url = `${base.replace(/\/$/, "")}/health`;

  if (process.env.TEST_SKIP_HEALTH === "1") {
    console.log("[skip] TEST_SKIP_HEALTH=1 — not calling /health");
    return;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 4000);
  try {
    const res = await fetch(url, { signal: ac.signal });
    const text = await res.text();
    if (!res.ok) {
      console.error(`[fail] ${url} → HTTP ${res.status} ${text}`);
      process.exitCode = 1;
      return;
    }
    console.log(`[ok] ${url} → HTTP ${res.status} ${text}`);
  } catch (err) {
    console.warn(
      `[warn] ${url} unreachable (${err instanceof Error ? err.message : String(err)}).`,
      "Start the API: npm run dev (RUN_MODE=both or api)."
    );
  } finally {
    clearTimeout(timer);
  }
}

await checkRedis();
await checkHealth();
