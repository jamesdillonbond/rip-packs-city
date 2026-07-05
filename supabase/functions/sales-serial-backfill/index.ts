// supabase/functions/sales-serial-backfill/index.ts
// Phase 2A. Re-resolve serial_number for historical sales rows that landed
// with a NULL/0 serial. Every target row carries a working nft_id + edition_id
// + transaction_hash, so we can re-resolve via the right per-collection path.
//
// Trigger: ad-hoc via curl (one-shot) OR a low-cadence cron. Returns 202
// immediately and processes the queue asynchronously via EdgeRuntime.waitUntil()
// when available. Re-runs are safe — update_sale_serial only updates if the
// current value is 0/NULL and the resolved serial is a valid positive integer.
//
// Auth: Authorization header must contain INGEST_SECRET_TOKEN (or pass it
// as ?token=<value>). Same pattern as special-serial-sweep.
//
// Input body (all optional):
//   { collection_id?: string, batch_size?: number }
//
// Per-collection paths:
//
//   TopShot → topshot-proxy worker /topshot (public-api.nbatopshot.com).
//             One request per nft_id — getMintedMoment(momentId).data is a
//             union, requires the `... on MintedMoment` fragment. 50ms
//             inter-request throttle. Mirrors app/api/sales-indexer/route.ts.
//             HEALTHY — untouched.
//
//   AllDay  → ON-CHAIN borrow via AllDay.borrowMomentNFT (2026-07-05 rewrite).
//             The prior AllDay consumer-GQL path (searchMomentNFTsV2 via the
//             topshot-proxy /allday-consumer route) is permanently dead —
//             nflallday's Cloudflare hard-blocks the worker egress IP (403 /
//             error code 1009); a byte-identical request change cannot revive
//             an upstream ban (memory allday-consumer-gql-cf1009-blocked). The
//             serial lives on chain: resolve the moment's current holder
//             (wallet_moments_cache first, then the latest non-intermediate
//             sale buyer), borrow AllDay.NFT from that account at
//             /public/AllDayNFTCollection, and read serialNumber. This hits only
//             rest-mainnet.onflow.org (proven reachable from Supabase edge fns)
//             and reuses the exact borrow script the healthy
//             allday-listing-serial-backfill + allday-sales-indexer already run.
//             Escrowed/burned moments resolve to nil → left NULL for a later
//             run, and auto-resolve once a moment exits Dapper escrow back into
//             a public collection. The ~711 residual is the measured floor
//             (8,964/9,675 recovered 2026-07-05).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const INGEST_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN");
if (!INGEST_TOKEN) throw new Error("INGEST_SECRET_TOKEN is required");

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const TS_PROXY_URL = Deno.env.get("TS_PROXY_URL") ?? "https://topshot-proxy.tdillonbond.workers.dev/topshot";
const TS_PROXY_SECRET = Deno.env.get("TS_PROXY_SECRET") ?? "";
const FLOW_REST = Deno.env.get("FLOW_REST_URL") ?? "https://rest-mainnet.onflow.org";

const REQ_THROTTLE_MS = 50;      // ~20 req/s ceiling on TopShot per-id calls.
const TS_GQL_TIMEOUT_MS = 8_000;
const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 1000;

// AllDay on-chain borrow tunables (mirror allday-listing-serial-backfill).
const SCRIPT_TIMEOUT_MS = 12_000;
const CONCURRENCY = 8;            // gentle Flow REST script fan-out
const MAX_RETRIES = 2;           // bounded retry on transient Flow REST faults
const RETRY_BACKOFF_MS = 800;
const SOFT_BUDGET_MS = 130_000;  // stop borrowing with headroom for the log
const HOLDER_LOOKUP_CHUNK = 200; // wmc .in() chunk size

const COLLECTION_IDS = {
  topshot: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
  allday:  "dee28451-5d62-409e-a1ad-a83f763ac070",
} as const;

// Dapper/Flowty intermediates — the recorded `buyer` on an AllDay sale is often
// one of these routers/escrow accounts, not the real end-user (memory
// allday-sale-buyer-is-dapper-intermediate). Borrowing from them returns nil, so
// skip them as a holder guess and let wmc / a later sale be the source.
const INTERMEDIATE_ADDRS = new Set<string>([
  "0xedf9df96c92f4595", // AllDay/Golazos/UFC trade contract
  "0x3cdbb3d569211ff3", // Flowty fork fee router
  "0x18eb4ee6b3c026d2", // NFTStorefrontV2 escrow
  "0xead892083b3e2c6c", // DUC payment
]);

const TS_GQL_QUERY = `query($id:ID!){getMintedMoment(momentId:$id){data{...on MintedMoment{flowSerialNumber}}}}`;

// AllDay-typed borrow — verbatim from the healthy allday-listing-serial-backfill
// / allday-sales-indexer. The public capability at /public/AllDayNFTCollection is
// `&AllDay.Collection` (concrete), whose borrowMomentNFT(id:) returns &AllDay.NFT?
// with editionID + serialNumber. Do NOT swap to the generic borrowNFG cast, and
// re-verify against 0xe4cf4bdc1751c65d before any change (CLAUDE.md AllDay gotcha).
const BORROW_MOMENT_SCRIPT = `
import AllDay from 0xe4cf4bdc1751c65d
access(all) fun main(buyer: Address, id: UInt64): {String: String}? {
  let col = getAccount(buyer).capabilities.borrow<&AllDay.Collection>(/public/AllDayNFTCollection)
  if col == nil { return nil }
  let nft = col!.borrowMomentNFT(id: id)
  if nft == nil { return nil }
  return {
    "id": nft!.id.toString(),
    "editionID": nft!.editionID.toString(),
    "serialNumber": nft!.serialNumber.toString()
  }
}
`;

interface BackfillTarget {
  sale_id: string;
  collection_id: string;
  nft_id: string;
  edition_id: string;
  sold_at: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface FetchResult {
  serial: number | null;
  reason: "ok" | "gql_404" | "gql_null_serial" | "timeout" | "unknown"
        | "no_holder" | "onchain_nil" | "borrow_error";
  detail: string | null;
}

// ── TopShot per-id resolver (UNTOUCHED) ──────────────────────────────────────

async function fetchSerialTopShot(target: BackfillTarget): Promise<FetchResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "rip-packs-city/sales-serial-backfill",
  };
  if (TS_PROXY_SECRET) headers["X-Proxy-Secret"] = TS_PROXY_SECRET;

  let res: Response;
  try {
    res = await fetch(TS_PROXY_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: TS_GQL_QUERY, variables: { id: target.nft_id } }),
      signal: AbortSignal.timeout(TS_GQL_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("aborted") || msg.toLowerCase().includes("timeout")) {
      return { serial: null, reason: "timeout", detail: `topshot:${msg.slice(0, 120)}` };
    }
    return { serial: null, reason: "unknown", detail: `topshot:${msg.slice(0, 120)}` };
  }

  if (!res.ok) {
    let bodySnippet = "";
    try { bodySnippet = (await res.text()).slice(0, 160).replace(/\s+/g, " "); } catch { /* ignore */ }
    if (res.status === 404) return { serial: null, reason: "gql_404", detail: `http_404${bodySnippet ? `:${bodySnippet}` : ""}` };
    return { serial: null, reason: "unknown", detail: `http_${res.status}${bodySnippet ? `:${bodySnippet}` : ""}` };
  }

  let json: any;
  try { json = await res.json(); }
  catch (err) {
    return { serial: null, reason: "unknown", detail: `json_parse:${err instanceof Error ? err.message.slice(0, 80) : "err"}` };
  }

  const data = json?.data?.getMintedMoment?.data;
  if (!data) return { serial: null, reason: "gql_null_serial", detail: "no_minted_moment" };
  const raw = data.flowSerialNumber;
  if (raw == null) return { serial: null, reason: "gql_null_serial", detail: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return { serial: null, reason: "gql_null_serial", detail: `raw=${String(raw).slice(0, 40)}` };
  return { serial: n, reason: "ok", detail: null };
}

// ── AllDay on-chain resolver ─────────────────────────────────────────────────

// Cadence/JSON unwrapper — copied from allday-listing-serial-backfill.
function unwrapCdc(node: unknown): unknown {
  if (node === null || node === undefined) return node;
  if (Array.isArray(node)) return node.map(unwrapCdc);
  if (typeof node !== "object") return node;
  const { type, value } = node as { type?: string; value?: unknown };
  if (type !== undefined && value !== undefined) {
    switch (type) {
      case "Optional": return value === null ? null : unwrapCdc(value);
      case "Array": return (value as unknown[]).map(unwrapCdc);
      case "Dictionary": {
        const out: Record<string, unknown> = {};
        for (const kv of value as Array<{ key: unknown; value: unknown }>) {
          out[String(unwrapCdc(kv.key))] = unwrapCdc(kv.value);
        }
        return out;
      }
      default:
        return value;
    }
  }
  return node;
}

async function runScript(
  code: string,
  args: Array<{ type: string; value: unknown }>,
): Promise<unknown> {
  const body = {
    script: btoa(code),
    arguments: args.map((a) => btoa(JSON.stringify(a))),
  };
  const res = await fetch(`${FLOW_REST}/v1/scripts?block_height=sealed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SCRIPT_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`script HTTP ${res.status}`);
  const json = (await res.json()) as { value?: string } | string;
  const rawValue = typeof json === "string" ? json : String(json.value ?? "");
  if (!rawValue) return null;
  const decoded = JSON.parse(atob(rawValue));
  return unwrapCdc(decoded);
}

function normalizeAddr(a: unknown): string | null {
  const s = String(a ?? "").trim().toLowerCase();
  return /^0x[0-9a-f]{16}$/.test(s) ? s : null;
}

// Batch-resolve current holders for a set of nft_ids from wallet_moments_cache
// (the most authoritative CURRENT-ownership source when the wallet is seeded).
async function resolveHoldersFromWmc(nftIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (let i = 0; i < nftIds.length; i += HOLDER_LOOKUP_CHUNK) {
    const chunk = nftIds.slice(i, i + HOLDER_LOOKUP_CHUNK);
    const { data, error } = await supabase
      .from("wallet_moments_cache")
      .select("moment_id, wallet_address")
      .eq("collection_id", COLLECTION_IDS.allday)
      .in("moment_id", chunk);
    if (error) { console.log(`[backfill] wmc holder lookup err ${error.message.slice(0, 120)}`); continue; }
    for (const r of (data ?? []) as Array<{ moment_id: string; wallet_address: string | null }>) {
      const addr = normalizeAddr(r.wallet_address);
      if (addr && !map.has(String(r.moment_id))) map.set(String(r.moment_id), addr);
    }
  }
  return map;
}

// Fallback holder: the most-recent non-intermediate sale buyer for this nft_id.
// May be stale (the moment can have moved on again) — a nil borrow then just
// leaves the row NULL for a later run, which is correct.
async function latestSaleBuyer(nftId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("sales")
    .select("buyer_address, sold_at")
    .eq("collection_id", COLLECTION_IDS.allday)
    .eq("nft_id", nftId)
    .not("buyer_address", "is", null)
    .order("sold_at", { ascending: false })
    .limit(8);
  if (error || !data) return null;
  for (const r of data as Array<{ buyer_address: string | null }>) {
    const addr = normalizeAddr(r.buyer_address);
    if (addr && !INTERMEDIATE_ADDRS.has(addr)) return addr;
  }
  return null;
}

// Borrow the moment from `holder` and read its serial. nil = not in that
// account's collection (moved/escrowed/burned) → onchain_nil (no write).
async function borrowSerial(holder: string, nftId: string): Promise<FetchResult> {
  let lastErr: string | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = (await runScript(BORROW_MOMENT_SCRIPT, [
        { type: "Address", value: holder },
        { type: "UInt64", value: nftId },
      ])) as Record<string, string> | null;
      if (!result || typeof result !== "object") {
        return { serial: null, reason: "onchain_nil", detail: `not_in:${holder}` };
      }
      const raw = result.serialNumber;
      const n = raw != null ? Number(raw) : NaN;
      if (!Number.isFinite(n) || n <= 0) {
        return { serial: null, reason: "onchain_nil", detail: `bad_serial:${String(raw).slice(0, 40)}` };
      }
      return { serial: n, reason: "ok", detail: null };
    } catch (err) {
      lastErr = err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160);
      if (attempt < MAX_RETRIES) await sleep(RETRY_BACKOFF_MS * (attempt + 1));
    }
  }
  return { serial: null, reason: "borrow_error", detail: `borrow:${lastErr ?? "unknown"}` };
}

// Resolve one AllDay target: holder (wmc → latest buyer) then borrow.
async function fetchSerialAllDay(
  target: BackfillTarget,
  wmcHolders: Map<string, string>,
): Promise<FetchResult> {
  const n = Number(target.nft_id);
  if (!Number.isFinite(n) || n <= 0) {
    return { serial: null, reason: "unknown", detail: `bad_nft_id:${String(target.nft_id).slice(0, 20)}` };
  }
  const holder = wmcHolders.get(target.nft_id) ?? (await latestSaleBuyer(target.nft_id));
  if (!holder) {
    return { serial: null, reason: "no_holder", detail: "escrowed_or_unseeded" };
  }
  return borrowSerial(holder, target.nft_id);
}

// ── Per-target write path (shared, UNTOUCHED) ────────────────────────────────

interface CollectionStats {
  processed: number;
  resolved: number;
  noop: number;
  failed: number;
  failures_by_reason: Record<string, number>;
}

async function applyResult(
  target: BackfillTarget,
  result: FetchResult,
  stats: CollectionStats,
): Promise<void> {
  stats.processed += 1;
  if (result.reason === "ok" && result.serial != null) {
    const { data: updated, error: updErr } = await supabase.rpc("update_sale_serial", {
      p_sale_id: target.sale_id,
      p_serial_number: result.serial,
    });
    if (updErr) {
      stats.failed += 1;
      stats.failures_by_reason["unknown"] = (stats.failures_by_reason["unknown"] ?? 0) + 1;
      await supabase.rpc("record_serial_backfill_failure", {
        p_sale_id: target.sale_id,
        p_collection_id: target.collection_id,
        p_nft_id: target.nft_id,
        p_reason: "unknown",
        p_detail: `update_rpc:${updErr.message.slice(0, 200)}`,
      });
    } else if (updated === true) {
      stats.resolved += 1;
    } else {
      stats.noop += 1;
    }
  } else {
    stats.failed += 1;
    stats.failures_by_reason[result.reason] = (stats.failures_by_reason[result.reason] ?? 0) + 1;
    const { error: failErr } = await supabase.rpc("record_serial_backfill_failure", {
      p_sale_id: target.sale_id,
      p_collection_id: target.collection_id,
      p_nft_id: target.nft_id,
      p_reason: result.reason,
      p_detail: result.detail,
    });
    if (failErr) console.log(`[backfill] failure-record err ${failErr.message.slice(0, 120)}`);
  }
}

async function runCollection(collectionId: string, batchSize: number): Promise<CollectionStats> {
  // batchSize is the total cap of targets processed per invocation. The 24h
  // cooldown in get_serial_backfill_targets ensures re-runs don't re-touch
  // just-failed targets.
  const stats: CollectionStats = {
    processed: 0,
    resolved: 0,
    noop: 0,
    failed: 0,
    failures_by_reason: {},
  };

  const { data, error } = await supabase.rpc("get_serial_backfill_targets", {
    p_collection_id: collectionId,
    p_limit: batchSize,
    p_offset: 0,
  });
  if (error) {
    console.log(`[backfill] rpc err collection=${collectionId} ${error.message}`);
    return stats;
  }
  const targets = (data ?? []) as BackfillTarget[];
  if (targets.length === 0) return stats;

  if (collectionId === COLLECTION_IDS.allday) {
    // Batch-resolve holders from wmc once, then a bounded-concurrency pool over
    // per-target on-chain borrows (wmc holder → else latest sale buyer).
    const t0 = Date.now();
    const wmcHolders = await resolveHoldersFromWmc(targets.map((t) => t.nft_id));
    let cursor = 0;
    let budgetStopped = false;
    async function worker(): Promise<void> {
      while (true) {
        if (Date.now() - t0 > SOFT_BUDGET_MS) { budgetStopped = true; return; }
        const idx = cursor++;
        if (idx >= targets.length) return;
        const t = targets[idx];
        try {
          const r = await fetchSerialAllDay(t, wmcHolders);
          await applyResult(t, r, stats);
        } catch (err) {
          stats.failed += 1;
          stats.failures_by_reason["unknown"] = (stats.failures_by_reason["unknown"] ?? 0) + 1;
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`[backfill] allday err sale=${t.sale_id} ${msg.slice(0, 200)}`);
          await supabase.rpc("record_serial_backfill_failure", {
            p_sale_id: t.sale_id,
            p_collection_id: t.collection_id,
            p_nft_id: t.nft_id,
            p_reason: "unknown",
            p_detail: msg.slice(0, 200),
          }).catch(() => { /* swallow */ });
        }
      }
    }
    const pool = Math.max(1, Math.min(CONCURRENCY, targets.length));
    await Promise.all(Array.from({ length: pool }, () => worker()));
    if (budgetStopped) console.log(`[backfill] allday budget_stopped at processed=${stats.processed}`);
  } else if (collectionId === COLLECTION_IDS.topshot) {
    // One GQL call per target with a tiny throttle. UNTOUCHED.
    for (const t of targets) {
      try {
        const r = await fetchSerialTopShot(t);
        await applyResult(t, r, stats);
      } catch (err) {
        stats.failed += 1;
        stats.failures_by_reason["unknown"] = (stats.failures_by_reason["unknown"] ?? 0) + 1;
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[backfill] err sale=${t.sale_id} ${msg.slice(0, 200)}`);
        await supabase.rpc("record_serial_backfill_failure", {
          p_sale_id: t.sale_id,
          p_collection_id: t.collection_id,
          p_nft_id: t.nft_id,
          p_reason: "unknown",
          p_detail: msg.slice(0, 200),
        }).catch(() => { /* swallow */ });
      }
      await sleep(REQ_THROTTLE_MS);
    }
  } else {
    console.log(`[backfill] unsupported collection=${collectionId}`);
  }

  console.log(
    `[backfill] done collection=${collectionId} processed=${stats.processed} resolved=${stats.resolved} noop=${stats.noop} failed=${stats.failed} reasons=${JSON.stringify(stats.failures_by_reason)}`,
  );
  return stats;
}

async function runSweep(collectionId: string | null, batchSize: number) {
  const list = collectionId ? [collectionId] : [COLLECTION_IDS.topshot, COLLECTION_IDS.allday];
  for (const c of list) {
    try {
      await runCollection(c, batchSize);
    } catch (err) {
      console.log(`[backfill] fatal collection=${c}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const auth = req.headers.get("Authorization") ?? "";
  const tokenParam = url.searchParams.get("token") ?? "";
  if (!auth.includes(INGEST_TOKEN!) && tokenParam !== INGEST_TOKEN) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: { collection_id?: string; batch_size?: number } = {};
  if (req.method === "POST") {
    try { body = await req.json(); } catch { /* empty body is fine */ }
  }

  const collectionId = body.collection_id ?? null;
  if (collectionId && collectionId !== COLLECTION_IDS.topshot && collectionId !== COLLECTION_IDS.allday) {
    return new Response(
      JSON.stringify({
        error: `collection_id ${collectionId} is not eligible for serial backfill (only TopShot + AllDay)`,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const batchSize = clampInt(body.batch_size ?? DEFAULT_BATCH_SIZE, 1, MAX_BATCH_SIZE);
  const startedAt = new Date().toISOString();

  const work = (async () => {
    try { await runSweep(collectionId, batchSize); }
    catch (err) { console.log(`[backfill] fatal: ${err instanceof Error ? err.message : String(err)}`); }
  })();

  // deno-lint-ignore no-explicit-any
  const er = (globalThis as any).EdgeRuntime;
  if (er && typeof er.waitUntil === "function") er.waitUntil(work);
  else await work;

  return new Response(
    JSON.stringify({
      status: "accepted",
      collection_id: collectionId ?? "all",
      batch_size: batchSize,
      started_at: startedAt,
    }),
    { status: 202, headers: { "Content-Type": "application/json" } },
  );
});

function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}
