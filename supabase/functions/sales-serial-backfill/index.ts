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
// Auth: `Authorization: Bearer <INGEST_SECRET_TOKEN>`, strict equality, header
// only. (`?token=` was removed 2026-09-03 — it wrote the token into the edge
// log store on every call. See known-issues → Deferred hardening.)
//
// Input body (all optional):
//   { collection_id?: string, batch_size?: number }
//
// Per-collection paths:
//
//   TopShot → ON-CHAIN borrow via TopShot.MomentCollectionPublic.borrowMoment
//             (2026-09-03 rewrite). The prior path — the topshot-proxy worker in
//             front of public-api.nbatopshot.com — is dead: that host is
//             decommissioned (Top Shot moved to Atlas), and every call since
//             2026-08-06 came back as Cloudflare 530 (error 1033, origin
//             unreachable) or 429 (error 1015), 3,071 rows filed as `unknown`
//             with newest failures on every 2-hourly tick. The serial is on
//             chain (`TopShot.NFT.data.serialNumber`), so this lane now does
//             exactly what the AllDay lane does: holder from wallet_moments_cache
//             → else the latest sale buyer (a Top Shot sale's recorded buyer IS
//             the end-user account, verified against wmc), then borrow at
//             /public/MomentCollection. Verified on mainnet before shipping:
//             52356781 @ 0x3795d42c0fc3a373 → serial 41; 52676253 @
//             0xab2277611893d945 (buyer-only, no wmc row) → serial 15.
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

import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

const INGEST_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN");
if (!INGEST_TOKEN) throw new Error("INGEST_SECRET_TOKEN is required");

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const FLOW_REST = Deno.env.get("FLOW_REST_URL") ?? "https://rest-mainnet.onflow.org";

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 1000;

// On-chain borrow tunables, both lanes (mirror allday-listing-serial-backfill).
const SCRIPT_TIMEOUT_MS = 12_000;
const CONCURRENCY = 8;            // gentle Flow REST script fan-out
const MAX_RETRIES = 2;           // bounded retry on transient Flow REST faults
const RETRY_BACKOFF_MS = 800;
const SOFT_BUDGET_MS = 130_000;  // stop borrowing with headroom for the log
const HOLDER_LOOKUP_CHUNK = 200; // wmc .in() chunk size
const LANE_DEAD_MIN_PROCESSED = 20; // a lane that fails EVERY one of ≥ this many targets on transport fails the sweep

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

// TopShot borrow — the public capability at /public/MomentCollection is exposed
// as `&{TopShot.MomentCollectionPublic}` (the interface — the same cast
// app/api/cron/lock-check-batch uses), whose borrowMoment(id:) returns
// &TopShot.NFT? and the serial is `data.serialNumber` (UInt32). Verified against
// 0x0b2a3299cc857e29 on mainnet 2026-09-03; re-verify before any change.
const BORROW_TOPSHOT_SCRIPT = `
import TopShot from 0x0b2a3299cc857e29
access(all) fun main(holder: Address, id: UInt64): {String: String}? {
  let col = getAccount(holder).capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
  if col == nil { return nil }
  let nft = col!.borrowMoment(id: id)
  if nft == nil { return nil }
  return {
    "id": nft!.id.toString(),
    "setID": nft!.data.setID.toString(),
    "playID": nft!.data.playID.toString(),
    "serialNumber": nft!.data.serialNumber.toString()
  }
}
`;

// AllDay-typed borrow — verbatim from the healthy allday-listing-serial-backfill
// / allday-sales-indexer. The public capability at /public/AllDayNFTCollection is
// `&AllDay.Collection` (concrete), whose borrowMomentNFT(id:) returns &AllDay.NFT?
// with editionID + serialNumber. Do NOT swap to the generic borrowNFG cast, and
// re-verify against 0xe4cf4bdc1751c65d before any change (CLAUDE.md AllDay gotcha).
const BORROW_ALLDAY_SCRIPT = `
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
  reason: "ok" | "unknown" | "no_holder" | "onchain_nil" | "borrow_error";
  detail: string | null;
}

// Per-lane borrow script. Both collections resolve the same way — holder, then
// a typed borrow from that holder's public collection — and differ only here.
const BORROW_SCRIPT_BY_COLLECTION: Record<string, string> = {
  [COLLECTION_IDS.topshot]: BORROW_TOPSHOT_SCRIPT,
  [COLLECTION_IDS.allday]: BORROW_ALLDAY_SCRIPT,
};

// ── On-chain resolver (both lanes) ───────────────────────────────────────────

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
async function resolveHoldersFromWmc(collectionId: string, nftIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (let i = 0; i < nftIds.length; i += HOLDER_LOOKUP_CHUNK) {
    const chunk = nftIds.slice(i, i + HOLDER_LOOKUP_CHUNK);
    const { data, error } = await supabase
      .from("wallet_moments_cache")
      .select("moment_id, wallet_address")
      .eq("collection_id", collectionId)
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
async function latestSaleBuyer(collectionId: string, nftId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("sales")
    .select("buyer_address, sold_at")
    .eq("collection_id", collectionId)
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
async function borrowSerial(script: string, holder: string, nftId: string): Promise<FetchResult> {
  let lastErr: string | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = (await runScript(script, [
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

// Resolve one target: holder (wmc → latest buyer) then a typed borrow.
async function fetchSerialOnChain(
  target: BackfillTarget,
  wmcHolders: Map<string, string>,
  script: string,
): Promise<FetchResult> {
  const n = Number(target.nft_id);
  if (!Number.isFinite(n) || n <= 0) {
    return { serial: null, reason: "unknown", detail: `bad_nft_id:${String(target.nft_id).slice(0, 20)}` };
  }
  const holder = wmcHolders.get(target.nft_id) ?? (await latestSaleBuyer(target.collection_id, target.nft_id));
  if (!holder) {
    return { serial: null, reason: "no_holder", detail: "escrowed_or_unseeded" };
  }
  return borrowSerial(script, holder, target.nft_id);
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

  const script = BORROW_SCRIPT_BY_COLLECTION[collectionId];
  if (script) {
    // Batch-resolve holders from wmc once, then a bounded-concurrency pool over
    // per-target on-chain borrows (wmc holder → else latest sale buyer).
    const lane = SLUG_BY_ID[collectionId] ?? collectionId;
    const t0 = Date.now();
    const wmcHolders = await resolveHoldersFromWmc(collectionId, targets.map((t) => t.nft_id));
    let cursor = 0;
    let budgetStopped = false;
    async function worker(): Promise<void> {
      while (true) {
        if (Date.now() - t0 > SOFT_BUDGET_MS) { budgetStopped = true; return; }
        const idx = cursor++;
        if (idx >= targets.length) return;
        const t = targets[idx];
        try {
          const r = await fetchSerialOnChain(t, wmcHolders, script);
          await applyResult(t, r, stats);
        } catch (err) {
          stats.failed += 1;
          stats.failures_by_reason["unknown"] = (stats.failures_by_reason["unknown"] ?? 0) + 1;
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`[backfill] ${lane} err sale=${t.sale_id} ${msg.slice(0, 200)}`);
          try {
            await supabase.rpc("record_serial_backfill_failure", {
              p_sale_id: t.sale_id,
              p_collection_id: t.collection_id,
              p_nft_id: t.nft_id,
              p_reason: "unknown",
              p_detail: msg.slice(0, 200),
            });
          } catch { /* swallow — failure-recording is best-effort */ }
        }
      }
    }
    const pool = Math.max(1, Math.min(CONCURRENCY, targets.length));
    await Promise.all(Array.from({ length: pool }, () => worker()));
    if (budgetStopped) console.log(`[backfill] ${lane} budget_stopped at processed=${stats.processed}`);
  } else {
    console.log(`[backfill] unsupported collection=${collectionId}`);
  }

  console.log(
    `[backfill] done collection=${collectionId} processed=${stats.processed} resolved=${stats.resolved} noop=${stats.noop} failed=${stats.failed} reasons=${JSON.stringify(stats.failures_by_reason)}`,
  );
  return stats;
}

const SLUG_BY_ID: Record<string, string> = {
  [COLLECTION_IDS.topshot]: "topshot",
  [COLLECTION_IDS.allday]: "allday",
};

async function runSweep(collectionId: string | null, batchSize: number, startedAtIso: string) {
  const list = collectionId ? [collectionId] : [COLLECTION_IDS.topshot, COLLECTION_IDS.allday];
  const perCollection: Record<string, CollectionStats> = {};
  let sweepError: string | null = null;
  let totalProcessed = 0, totalResolved = 0, totalNoop = 0, totalFailed = 0;
  const failuresByReason: Record<string, number> = {};

  for (const c of list) {
    try {
      const s = await runCollection(c, batchSize);
      perCollection[SLUG_BY_ID[c] ?? c] = s;
      // A lane whose EVERY target failed on TRANSPORT (borrow_error / unknown —
      // a dead host, a broken script, a failing RPC) is a pipeline failure, not
      // an expected per-target miss. This is the shape the Top Shot lane wore
      // for a month (2026-08-06 → 09-03: 100% `unknown`, http_530/429) while
      // every sweep logged ok=true, so no silence or no-success arm could see it.
      // Data reasons (onchain_nil / no_holder — escrowed or moved moments) are
      // NOT counted: the AllDay residual legitimately produces batches of those.
      // The floor of 20 keeps a one-off target from flipping the sweep.
      const transportFailures = (s.failures_by_reason["borrow_error"] ?? 0) + (s.failures_by_reason["unknown"] ?? 0);
      if (s.processed >= LANE_DEAD_MIN_PROCESSED && transportFailures === s.processed) {
        const laneErr = `${SLUG_BY_ID[c] ?? c}: all ${s.processed} targets failed on transport ${JSON.stringify(s.failures_by_reason)}`;
        sweepError = sweepError ?? laneErr;
        console.log(`[backfill] lane_dead ${laneErr}`);
      }
      totalProcessed += s.processed;
      totalResolved += s.resolved;
      totalNoop += s.noop;
      totalFailed += s.failed;
      for (const [k, v] of Object.entries(s.failures_by_reason)) {
        failuresByReason[k] = (failuresByReason[k] ?? 0) + v;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sweepError = sweepError ?? `${SLUG_BY_ID[c] ?? c}: ${msg.slice(0, 200)}`;
      console.log(`[backfill] fatal collection=${c}: ${msg}`);
    }
  }

  // Durable visibility: log_pipeline_run so the sweep surfaces in pipeline_runs
  // / detect_stalled (it was console-only before, invisible to health checks).
  // ok=true when the sweep itself completed — per-target DATA failures are
  // expected (escrowed/un-borrowable moments) and captured in
  // extra.failures_by_reason, not treated as a pipeline failure. A lane that
  // fails every target on TRANSPORT is (see lane_dead above) — that flips ok
  // to false so the cadence watchlist's no-success arm can see a dead host.
  try {
    // deno-lint-ignore no-explicit-any
    await (supabase as any).rpc("log_pipeline_run", {
      p_pipeline: "sales-serial-backfill",
      p_started_at: startedAtIso,
      p_rows_found: totalProcessed,
      p_rows_written: totalResolved,
      p_rows_skipped: totalNoop + totalFailed,
      p_ok: !sweepError,
      p_error: sweepError,
      p_collection_slug: collectionId ? (SLUG_BY_ID[collectionId] ?? null) : null,
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: {
        per_collection: perCollection,
        failures_by_reason: failuresByReason,
        resolved: totalResolved,
        noop: totalNoop,
        failed: totalFailed,
      },
    });
  } catch (err) {
    console.log(`[backfill] log_pipeline_run err: ${err instanceof Error ? err.message.slice(0, 120) : "x"}`);
  }
}

Deno.serve(async (req: Request) => {
  // Strict Bearer equality, header only (steps (a)+(c) of the register's
  // deferred-hardening item, 2026-09-03). The `?token=` branch is gone: a token
  // in the URL is written to the edge log store on every call, and the only
  // caller (app/api/cron/sales-serial-backfill) has sent the header since
  // 2026-09-02. The substring `.includes()` test is gone with it.
  const auth = req.headers.get("Authorization") ?? "";
  if (auth !== `Bearer ${INGEST_TOKEN}`) {
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
    try { await runSweep(collectionId, batchSize, startedAt); }
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
