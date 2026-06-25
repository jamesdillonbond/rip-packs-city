// Flow historical spork proxy. Two capabilities, both fronting the historical
// access nodes (port 8070) that Vercel/Supabase egress can't reach directly:
//
//  1. EVENTS (original): GET /?start_height=X&end_height=Y&event_type=A.x.C.E
//     Routes to the single spork whose range covers [start,end].
//
//  2. TRANSACTION RESULT (added 2026-06-19): GET /?tx=<hex>[&spork=<name>]
//     Fetches /v1/transactions/{tx}?expand=result (envelope + events) for a
//     historical transaction. Most callers don't know which spork a tx belongs
//     to (we don't store block_height for pre-2026 sales), so when `spork` is
//     omitted the worker WALKS the spork nodes newest→oldest and returns the
//     first that has the tx. A tx not found in ANY listed spork (mainnet17→27)
//     is pre-mainnet17 (before 2022-04-06) and is reported tx_not_found_in_listed_sporks
//     — the older nodes (mainnet1–16) are decommissioned (503/no-DNS), so that
//     history is unrecoverable via public sporks (see the FLOOR note on SPORKS).
//
// Auth: Authorization: Bearer <SPORK_PROXY_SECRET>
// Response: upstream JSON body + X-Spork-Node header naming the spork used.

interface Env {
  SPORK_PROXY_SECRET: string;
}

interface Spork {
  name: string;
  maxHeight: number;
}

// Ordered ascending by maxHeight. First spork whose maxHeight >= end_height wins.
// maxHeight = (next spork's rootHeight - 1), taken from the canonical Flow spork
// list (github.com/onflow/flow/sporks.json). The old values here were set near each
// spork's ROOT (not its end), so events queries near a spork's upper range were
// mis-routed to the next node; corrected 2026-06-25.
//
// FLOOR (measured 2026-06-25): the public historical access nodes are only alive
// down to mainnet17 (root 27,341,470 = 2022-04-06). mainnet17 + mainnet18 serve
// blocks AND events (HTTP 200); mainnet16 and older return 503 "upstream connect
// error" (decommissioned) and mainnet1 has no DNS. So ~2022-04-06 is the earliest
// recoverable on-chain history via public sporks — pre-2022-04 (mainnet1–16,
// 2020-10 → 2022-02) is permanently unrecoverable this way.
const SPORKS: Spork[] = [
  { name: "mainnet17", maxHeight: 31_735_954 },
  { name: "mainnet18", maxHeight: 35_858_810 },
  { name: "mainnet19", maxHeight: 40_171_633 },
  { name: "mainnet20", maxHeight: 44_950_206 },
  { name: "mainnet21", maxHeight: 47_169_686 },
  { name: "mainnet22", maxHeight: 55_114_466 },
  { name: "mainnet23", maxHeight: 65_264_618 },
  { name: "mainnet24", maxHeight: 85_981_134 },
  { name: "mainnet25", maxHeight: 88_226_266 },
  { name: "mainnet26", maxHeight: 130_290_658 },
  { name: "mainnet27", maxHeight: 137_390_145 },
];

const CURRENT_SPORK_MIN_HEIGHT = 137_390_146; // mainnet28 root
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

// Per-node timeout + total wall budget for the tx walk. Newest→oldest, so a
// 2022 tx (mainnet19–21) is the worst case at ~6 hops; healthy nodes 404 fast
// (~0.5s) so a typical walk is a few seconds — the timeouts only bite on a
// hung/down node. Total budget keeps the whole walk under Cloudflare's limit.
const TX_NODE_TIMEOUT_MS = 3_500;
const TX_WALK_BUDGET_MS = 22_000;

async function fetchTxFromSpork(
  sporkName: string,
  txClean: string,
): Promise<{ status: number; body: ArrayBuffer; contentType: string } | null> {
  const upstream = `${NODE_URL(sporkName)}/v1/transactions/${txClean}?expand=result`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TX_NODE_TIMEOUT_MS);
  try {
    const res = await fetch(upstream, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    // A spork node returns 404 (or 400) for a tx outside its range — skip it.
    if (res.status !== 200) return null;
    const body = await res.arrayBuffer();
    return { status: 200, body, contentType: res.headers.get("Content-Type") ?? "application/json" };
  } catch {
    return null; // hung/aborted node — move on
  } finally {
    clearTimeout(timeout);
  }
}

async function handleTxResult(txParam: string, sporkParam: string | null): Promise<Response> {
  const txClean = txParam.trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(txClean)) {
    return jsonError(400, "invalid_tx_id", { hint: "tx must be a 64-char hex transaction id" });
  }

  // Explicit spork: single lookup. Otherwise walk newest→oldest within budget.
  const candidates = sporkParam
    ? SPORKS.filter((s) => s.name === sporkParam).map((s) => s.name)
    : [...SPORKS].reverse().map((s) => s.name);
  if (candidates.length === 0) {
    return jsonError(400, "unknown_spork", { sporks: SPORKS.map((s) => s.name) });
  }

  const walkStart = Date.now();
  const tried: string[] = [];
  for (const name of candidates) {
    if (Date.now() - walkStart > TX_WALK_BUDGET_MS) {
      return jsonError(504, "tx_walk_budget_exhausted", { tried });
    }
    tried.push(name);
    const hit = await fetchTxFromSpork(name, txClean);
    if (hit) {
      const headers = new Headers();
      headers.set("Content-Type", hit.contentType);
      headers.set("X-Spork-Node", name);
      return new Response(hit.body, { status: 200, headers });
    }
  }
  return jsonError(404, "tx_not_found_in_listed_sporks", {
    hint: "tx is likely pre-mainnet19 (2020–21) — not served by the wired sporks",
    tried,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      if (request.method !== "GET") {
        return jsonError(405, "method_not_allowed");
      }

      const url = new URL(request.url);

      // Health check: a GET with neither start_height nor tx is a ping.
      // Intentionally unauthenticated so we can confirm the Worker is reachable
      // without shipping the secret to whoever is probing.
      if (!url.searchParams.get("start_height") && !url.searchParams.get("tx")) {
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

      // Transaction-result lookup (buyer/seller/exec for historical sales).
      const txParam = url.searchParams.get("tx");
      if (txParam) {
        return handleTxResult(txParam, url.searchParams.get("spork"));
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
