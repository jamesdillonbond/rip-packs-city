// supabase/functions/backfill-allday-listing-serials/index.ts
//
// Item 2 of handoff-2026-06-18-allday-deal-link-serial.md — populates
// public.allday_moment_serials with the serial number of each AllDay
// floor-listing moment, so cross_collection_deals_board's AllDay leg can carry
// low_ask_serial (and the deal-alert formatter renders "#<serial>").
//
// 2026-06-20 rewrite — ON-CHAIN serial resolution (was: nflallday consumer GQL).
//
//   The original implementation fetched serials from AllDay's consumer GraphQL
//   (nflallday.com/consumer/graphql via the topshot-proxy /allday-consumer
//   route). That endpoint is now hard-blocked by nflallday's Cloudflare —
//   every chunk returns `http_403: error code: 1009` (Cloudflare region/IP
//   ban against the worker egress). The block is upstream and persistent
//   (every run since this fn was created 2026-06-19 failed 5/5 chunks); the
//   sibling allday-unmapped-resolver only *looks* healthy because its backlog
//   drained, so it no longer exercises the same dead path. A byte-identical
//   request change cannot fix an upstream Cloudflare ban, so the serial source
//   was moved off nflallday entirely.
//
//   The serial lives ON CHAIN. Every AllDay floor listing carries its seller's
//   address (cached_listings_v2.seller_address; 100% populated), and the moment
//   stays in the seller's collection while the listing is active (the V1 Dapper
//   NFTStorefront lists by capability, not escrow). So we borrow the moment
//   directly from the seller's account via the AllDay-typed accessor — the
//   exact `borrowMomentNFT` script the healthy allday-sales-indexer already
//   uses — and read serialNumber + editionID off it. This path hits only
//   rest-mainnet.onflow.org (proven reachable + healthy from Supabase edge
//   functions, e.g. the UFC enrichment chain) and has zero nflallday dependency.
//
// Each invocation:
//   1. get_allday_listing_serial_targets(limit, board_only, stale_hours) ->
//      distinct floor (nft_id, seller_address) missing/stale in
//      allday_moment_serials.
//   2. For each, borrow AllDay.NFT from the seller's /public/AllDayNFTCollection
//      and read { serialNumber, editionID }. Fanned out with a small pool +
//      bounded retry (Flow REST script reads against the sealed block).
//   3. Upsert (nft_id, serial_number, edition_flow_id, fetched_at=now()) into
//      allday_moment_serials ON CONFLICT (nft_id) DO UPDATE.
//   4. log_pipeline_run under pipeline "allday-listing-serial-backfill".
//
// Auth: INGEST_SECRET_TOKEN bearer (or ?token=). EdgeRuntime.waitUntil drains.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const INGEST_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN");
if (!INGEST_TOKEN) throw new Error("INGEST_SECRET_TOKEN is required");

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const FLOW_REST = Deno.env.get("FLOW_REST_URL") ?? "https://rest-mainnet.onflow.org";

const DEFAULT_BATCH_SIZE = 200;
const MAX_BATCH_SIZE = 2000;
const SCRIPT_TIMEOUT_MS = 12_000;
const CONCURRENCY = 8;            // gentle Flow REST script fan-out
const MAX_RETRIES = 2;           // bounded retry on transient Flow REST faults
const RETRY_BACKOFF_MS = 800;
const SOFT_BUDGET_MS = 130_000;  // stop borrowing with headroom for the upsert + log

// AllDay-typed borrow — the public capability at /public/AllDayNFTCollection is
// published as `&AllDay.Collection` (the contract's concrete collection
// resource), whose `borrowMomentNFT(id:)` accessor returns `&AllDay.NFT?`
// directly with editionID + serialNumber exposed. Copied verbatim from the
// production allday-sales-indexer (healthy 72/0); do not "improve" without
// re-verifying against the on-chain AllDay contract at 0xe4cf4bdc1751c65d.
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

interface SerialTarget {
  nft_id: string;
  seller_address: string | null;
}

interface SerialRow {
  nft_id: string;
  serial_number: number | null;
  edition_flow_id: string | null;
  fetched_at: string;
}

function toSerial(raw: unknown): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Cadence/JSON unwrapper — mirrors the helper every Flow-REST edge fn uses.
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

// Borrow one moment from its seller's account and read serial + editionID.
// Returns a SerialRow on success, or { row: null, error } when the on-chain
// read faulted (a moment that simply moved/sold resolves to nil → row:null,
// error:null, which is normal and silently skipped).
async function resolveOne(
  target: SerialTarget,
  fetchedAt: string,
): Promise<{ row: SerialRow | null; error: string | null }> {
  const seller = (target.seller_address ?? "").trim();
  if (!/^0x[0-9a-fA-F]{16}$/.test(seller)) {
    return { row: null, error: `bad_seller:${seller.slice(0, 20)}` };
  }
  const n = Number(target.nft_id);
  if (!Number.isFinite(n) || n <= 0) {
    return { row: null, error: `bad_nft_id:${String(target.nft_id).slice(0, 20)}` };
  }

  let lastErr: string | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = (await runScript(BORROW_MOMENT_SCRIPT, [
        { type: "Address", value: seller },
        { type: "UInt64", value: target.nft_id },
      ])) as Record<string, string> | null;

      // nil = the moment is no longer in the seller's collection (moved/sold).
      // Not an error — just nothing to write this run.
      if (!result || typeof result !== "object") return { row: null, error: null };

      const editionID = result.editionID != null ? String(result.editionID).trim() : "";
      return {
        row: {
          nft_id: target.nft_id,
          serial_number: toSerial(result.serialNumber),
          edition_flow_id: editionID === "" ? null : editionID,
          fetched_at: fetchedAt,
        },
        error: null,
      };
    } catch (err) {
      lastErr = err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160);
      if (attempt < MAX_RETRIES) await sleep(RETRY_BACKOFF_MS * (attempt + 1));
    }
  }
  return { row: null, error: `borrow:${lastErr ?? "unknown"}` };
}

interface Summary {
  batch_requested: number;
  board_only: boolean;
  stale_hours: number;
  targets_returned: number;
  serials_resolved: number;
  rows_upserted: number;
  borrow_errors: number;
  first_borrow_error: string | null;
  budget_stopped: boolean;
  fatal: string | null;
}

async function logPipelineRun(args: {
  startedAt: string;
  rowsFound: number;
  rowsWritten: number;
  rowsSkipped: number;
  ok: boolean;
  error?: string | null;
  extra: Record<string, unknown>;
}): Promise<void> {
  try {
    // deno-lint-ignore no-explicit-any
    await (supabase as any).rpc("log_pipeline_run", {
      p_pipeline: "allday-listing-serial-backfill",
      p_started_at: args.startedAt,
      p_rows_found: args.rowsFound,
      p_rows_written: args.rowsWritten,
      p_rows_skipped: args.rowsSkipped,
      p_ok: args.ok,
      p_error: args.error ?? null,
      p_collection_slug: "nfl-all-day",
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: args.extra,
    });
  } catch (err) {
    console.log(`[allday-serial] log_pipeline_run failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function run(
  batchSize: number,
  boardOnly: boolean,
  staleHours: number,
  startedAt: string,
): Promise<Summary> {
  const t0 = Date.now();
  const summary: Summary = {
    batch_requested: batchSize,
    board_only: boardOnly,
    stale_hours: staleHours,
    targets_returned: 0,
    serials_resolved: 0,
    rows_upserted: 0,
    borrow_errors: 0,
    first_borrow_error: null,
    budget_stopped: false,
    fatal: null,
  };

  const { data: targetsData, error: targetsErr } = await supabase.rpc(
    "get_allday_listing_serial_targets",
    { p_limit: batchSize, p_board_only: boardOnly, p_stale_hours: staleHours },
  );
  if (targetsErr) {
    summary.fatal = `get_allday_listing_serial_targets:${targetsErr.message.slice(0, 200)}`;
    await logPipelineRun({
      startedAt, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
      ok: false, error: summary.fatal, extra: summary as unknown as Record<string, unknown>,
    });
    return summary;
  }

  const targets = ((targetsData ?? []) as SerialTarget[]).filter((t) => t && t.nft_id);
  summary.targets_returned = targets.length;
  if (targets.length === 0) {
    await logPipelineRun({
      startedAt, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
      ok: true, error: null, extra: summary as unknown as Record<string, unknown>,
    });
    return summary;
  }

  const fetchedAt = new Date().toISOString();
  const allRows: SerialRow[] = [];

  // Bounded-concurrency pool over the borrow calls. The soft budget stops
  // dispatching new work with headroom so the upsert + log always run.
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      if (Date.now() - t0 > SOFT_BUDGET_MS) { summary.budget_stopped = true; return; }
      const idx = cursor++;
      if (idx >= targets.length) return;
      const { row, error } = await resolveOne(targets[idx], fetchedAt);
      if (row) allRows.push(row);
      if (error) {
        summary.borrow_errors++;
        if (!summary.first_borrow_error) summary.first_borrow_error = error;
      }
    }
  }
  const pool = Math.max(1, Math.min(CONCURRENCY, targets.length));
  await Promise.all(Array.from({ length: pool }, () => worker()));

  summary.serials_resolved = allRows.length;

  if (allRows.length > 0) {
    const { error: upsertErr, count } = await supabase
      .from("allday_moment_serials")
      .upsert(allRows, { onConflict: "nft_id", count: "exact" });
    if (upsertErr) {
      summary.fatal = `upsert:${upsertErr.message.slice(0, 200)}`;
      await logPipelineRun({
        startedAt, rowsFound: targets.length, rowsWritten: 0, rowsSkipped: targets.length,
        ok: false, error: summary.fatal, extra: summary as unknown as Record<string, unknown>,
      });
      return summary;
    }
    summary.rows_upserted = count ?? allRows.length;
  }

  await logPipelineRun({
    startedAt,
    rowsFound: targets.length,
    rowsWritten: summary.rows_upserted,
    rowsSkipped: Math.max(0, targets.length - summary.serials_resolved),
    // A handful of unresolved ids per run is normal (moment moved/sold, or a
    // transient Flow REST fault). Only a total wipe-out — every target errored
    // and nothing resolved — is a real failure.
    ok: summary.serials_resolved > 0 || summary.borrow_errors < targets.length,
    error: summary.first_borrow_error,
    extra: summary as unknown as Record<string, unknown>,
  });

  console.log(
    `[allday-serial] targets=${summary.targets_returned} resolved=${summary.serials_resolved} upserted=${summary.rows_upserted} borrow_errors=${summary.borrow_errors} budget_stopped=${summary.budget_stopped}`,
  );
  return summary;
}

function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const auth = req.headers.get("Authorization") ?? "";
  const tokenParam = url.searchParams.get("token") ?? "";
  if (!auth.includes(INGEST_TOKEN!) && tokenParam !== INGEST_TOKEN) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }

  let body: { batch_size?: number; board_only?: boolean; stale_hours?: number } = {};
  if (req.method === "POST") {
    try { body = await req.json(); } catch { /* empty body is fine */ }
  }

  const batchSize = clampInt(body.batch_size ?? DEFAULT_BATCH_SIZE, 1, MAX_BATCH_SIZE);
  const boardOnly = body.board_only ?? true;
  const staleHours = clampInt(body.stale_hours ?? 24, 1, 24 * 30);
  const startedAt = new Date().toISOString();

  const work = (async () => {
    try { await run(batchSize, boardOnly, staleHours, startedAt); }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[allday-serial] fatal: ${msg.slice(0, 300)}`);
      await logPipelineRun({
        startedAt, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
        ok: false, error: msg.slice(0, 500),
        extra: { batch_size: batchSize, board_only: boardOnly, fatal: msg.slice(0, 500) },
      });
    }
  })();

  // deno-lint-ignore no-explicit-any
  const er = (globalThis as any).EdgeRuntime;
  if (er && typeof er.waitUntil === "function") er.waitUntil(work);
  else await work;

  return new Response(
    JSON.stringify({
      status: "accepted",
      batch_size: batchSize,
      board_only: boardOnly,
      stale_hours: staleHours,
      started_at: startedAt,
      note: "Results appear in pipeline_runs as pipeline=allday-listing-serial-backfill within ~10s.",
    }),
    { status: 202, headers: { "Content-Type": "application/json" } },
  );
});
