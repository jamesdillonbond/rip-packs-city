// Flow historical spork event proxy. Routes /v1/events requests to the
// correct historical access node (port 8070) based on block height.
// Vercel Edge Functions can't reach :8070 directly from Supabase, so this
// Cloudflare Worker sits in front and does the routing.
//
// Auth: Authorization: Bearer <SPORK_PROXY_SECRET>
// Request: GET /?start_height=X&end_height=Y&event_type=A.xxx.Contract.Event
// Response: upstream JSON body + X-Spork-Node header naming the spork used.

interface Env {
  SPORK_PROXY_SECRET: string;
}

interface Spork {
  name: string;
  maxHeight: number;
}

// Ordered ascending by maxHeight. First spork whose maxHeight >= end_height wins.
const SPORKS: Spork[] = [
  { name: "mainnet19", maxHeight: 35_000_000 },
  { name: "mainnet20", maxHeight: 40_171_900 },
  { name: "mainnet21", maxHeight: 44_950_080 },
  { name: "mainnet22", maxHeight: 52_185_950 },
  { name: "mainnet23", maxHeight: 57_479_600 },
  { name: "mainnet24", maxHeight: 65_257_098 },
  { name: "mainnet25", maxHeight: 106_258_784 },
  { name: "mainnet26", maxHeight: 137_390_145 },
];

const CURRENT_SPORK_MIN_HEIGHT = 137_390_146;
const NODE_URL = (name: string) =>
  `http://access-001.${name}.nodes.onflow.org:8070`;
const REQUEST_TIMEOUT_MS = 25_000;

function jsonError(status: number, error: string, extra?: Record<string, unknown>) {
  return new Response(
    JSON.stringify({ error, ...extra }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

function pickSpork(startHeight: number, endHeight: number): Spork | null {
  const startSpork = SPORKS.find((s) => startHeight <= s.maxHeight);
  const endSpork = SPORKS.find((s) => endHeight <= s.maxHeight);
  if (!startSpork || !endSpork) return null;
  if (startSpork.name !== endSpork.name) return null;
  return startSpork;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      if (request.method !== "GET") {
        return jsonError(405, "method_not_allowed");
      }

      const url = new URL(request.url);

      // Health check: any GET without start_height is treated as a ping.
      // Intentionally unauthenticated so we can confirm the Worker is reachable
      // without shipping the secret to whoever is probing.
      if (!url.searchParams.get("start_height")) {
        return new Response(
          JSON.stringify({ ok: true, worker: "spork-proxy" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      const auth = request.headers.get("Authorization") ?? "";
      const expected = `Bearer ${env.SPORK_PROXY_SECRET}`;
      if (!env.SPORK_PROXY_SECRET || auth !== expected) {
        return jsonError(401, "unauthorized");
      }

      const startParam = url.searchParams.get("start_height");
      const endParam = url.searchParams.get("end_height");
      const eventType = url.searchParams.get("event_type");

      if (!startParam || !endParam || !eventType) {
        return jsonError(400, "missing_required_params", {
          required: ["start_height", "end_height", "event_type"],
        });
      }

      const startHeight = Number(startParam);
      const endHeight = Number(endParam);
      if (!Number.isFinite(startHeight) || !Number.isFinite(endHeight)) {
        return jsonError(400, "invalid_height", {
          hint: "start_height and end_height must be integers",
        });
      }
      if (startHeight > endHeight) {
        return jsonError(400, "invalid_range", {
          hint: "start_height must be <= end_height",
        });
      }

      if (endHeight >= CURRENT_SPORK_MIN_HEIGHT) {
        return jsonError(400, "current_spork_not_supported", {
          hint: "For blocks >= 137390146, use https://rest-mainnet.onflow.org directly",
          current_spork_min_height: CURRENT_SPORK_MIN_HEIGHT,
        });
      }

      const spork = pickSpork(startHeight, endHeight);
      if (!spork) {
        return jsonError(400, "range_crosses_spork_boundary", {
          hint: "start_height and end_height must fall within a single spork",
          sporks: SPORKS,
        });
      }

      const upstream = `${NODE_URL(spork.name)}/v1/events?type=${encodeURIComponent(
        eventType,
      )}&start_height=${startHeight}&end_height=${endHeight}`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const upstreamRes = await fetch(upstream, {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });

        const headers = new Headers();
        const upstreamCT = upstreamRes.headers.get("Content-Type");
        headers.set("Content-Type", upstreamCT ?? "application/json");
        headers.set("X-Spork-Node", spork.name);

        return new Response(upstreamRes.body, {
          status: upstreamRes.status,
          headers,
        });
      } catch (err) {
        const aborted = (err as Error)?.name === "AbortError";
        return jsonError(aborted ? 504 : 502, aborted ? "upstream_timeout" : "upstream_fetch_failed", {
          spork: spork.name,
          upstream,
          detail: (err as Error)?.message ?? String(err),
        });
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      const e = err as Error;
      return new Response(
        JSON.stringify({
          code: 500,
          message: e?.message ?? String(err),
          stack: e?.stack ?? null,
        }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
  },
};
