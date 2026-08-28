// app/api/cron/sync-sales-ingest-dune/route.ts
//
// Pre-2026 Top Shot sale-INGEST pipeline (Dune). Fills the historical sale-ingest
// gap by INSERTing missing TS sale rows (~73% of the loss is pre-2026) that the
// studio/GQL backfills never captured. Distinct from sync-sales-seller-recovery-dune,
// which only FILLS counterparties on rows that already exist — this one can create
// rows.
//
// Source: the saved Dune query DUNE_SALES_INGEST_QUERY_ID (8030177) over
// flow.cadence_events — one row per c1e4f4f4c4257510 Market MomentPurchased
// (V1 boom era + V3), carrying the authoritative on-chain price (USD) + seller.
// It walks a date-window cursor BACKWARD from 2025-12-31 (public.sales_ingest_state)
// so each run touches a bounded slice of the IOPS-constrained hot `sales` table.
//
// Writes go through public.apply_sales_ingest_external, which is hard-guarded:
// era (sold_at < 2026-01-01), collection (nba_top_shot only), price > 0,
// (tx_hash, nft_id) dedup + (tx_hash, sold_at) NOT-EXISTS guard, edition_id
// resolved via moments or the row is SKIPPED, and every insert/fill is audited
// into sales_ingest_recovered (fully revertible). Multi-moment collisions are
// counted (skipped_multimoment), never silently dropped.
//
// INERT until configured: logs skipped:'dune_not_configured' unless
// DUNE_PROXY_URL + DUNE_PROXY_SECRET + DUNE_SALES_INGEST_QUERY_ID are all set,
// so deploying it changes nothing until the operator activates it (then watch FMV).
//
// Auth: Bearer ${INGEST_SECRET_TOKEN} or ${CRON_SECRET}. Method: POST or GET.

import { NextRequest, NextResponse, after } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat";
import { sweepDeadlineSignal } from "@/lib/http/sweep-deadline";
import {
  readDuneBudget,
  recordDuneUsage,
  columnCount,
  type DuneBudget,
} from "@/lib/dune/budget";

export const dynamic = "force-dynamic";
export const maxDuration = 800; // Pro hard cap; the walk is bounded by HARD_BUDGET_MS.

const PIPELINE_NAME = "sales-ingest-dune";
const PAGE_LIMIT = 1000;
const FILL_CHUNK = 1000; // rows per apply_sales_ingest_external call
const HARD_BUDGET_MS = 720_000;
const INTER_PAGE_MS = 2500;
const MAX_429_RETRIES = 6;
const BACKOFF_BASE_MS = 4000;
const REFRESH_BUDGET_MS = 240_000;
const REFRESH_POLL_MS = 4000;
// Held back from HARD_BUDGET_MS for every per-request abort below, so a hung
// upstream can never consume the headroom the terminal `logRun` needs. Without it
// the last request eats the whole budget and the lambda is killed before recording
// anything — the INVISIBLE failure shape, not merely a slow one.
// The bound is DERIVED from the sweep budget this file already declares rather than
// chosen for Dune: a request that would outlive the remaining budget is already
// doomed (the loop stops on its next check), so aborting it cannot turn a working
// call into a failing one — only a SILENT kill into a LOGGED failure.
const DUNE_LOG_RESERVE_MS = 30_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function authed(req: NextRequest): boolean {
  const auth = req.headers.get("authorization");
  return (
    auth === `Bearer ${process.env.INGEST_SECRET_TOKEN}` ||
    auth === `Bearer ${process.env.CRON_SECRET}`
  );
}

type IngestRow = {
  tx_hash: string;
  nft_id: string;
  seller: string | null;
  buyer: string | null;
  price_usd: string;
  sold_at: string;
};

// Map a Dune result row to an ingest row. Returns null (skipped, not fatal)
// unless tx_hash + nft_id + a positive price + a sold_at are all present. seller
// and buyer are optional (the RPC re-validates the 0x…16-hex shape and drops
// anything malformed); the RPC also hard-scopes to sold_at < 2026-01-01.
function mapDuneRow(raw: Record<string, unknown>): IngestRow | null {
  const tx = raw.transaction_hash ?? raw.tx_hash ?? raw.tx;
  const nft = raw.nft_id ?? raw.nftId ?? raw.id;
  const price = raw.price_usd ?? raw.price;
  const soldAt = raw.sold_at ?? raw.timestamp;
  if (tx == null || nft == null || price == null || soldAt == null) return null;
  const priceStr = String(price);
  if (!/^[0-9]+(\.[0-9]+)?$/.test(priceStr) || Number(priceStr) <= 0) return null;
  const seller = raw.seller != null ? String(raw.seller) : null;
  const buyer = raw.buyer != null ? String(raw.buyer) : null;
  return { tx_hash: String(tx), nft_id: String(nft), seller, buyer, price_usd: priceStr, sold_at: String(soldAt) };
}

const iso = (d: Date) => d.toISOString().slice(0, 10); // YYYY-MM-DD

export async function POST(req: NextRequest) {
  return run(req);
}
export async function GET(req: NextRequest) {
  return run(req);
}

async function run(req: NextRequest) {
  if (!authed(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const proxyUrl = process.env.DUNE_PROXY_URL;
  const proxySecret = process.env.DUNE_PROXY_SECRET;
  const queryId = process.env.DUNE_SALES_INGEST_QUERY_ID;
  const startedAt = new Date().toISOString();

  // ── Invocation heartbeat (2026-08-20) ────────────────────────────────────
  // `maxDuration` here is 800 s — the longest in the fleet, so this is where a
  // wall kill is most likely, and this route's terminal `log_pipeline_run` sits
  // INSIDE the `after()` body below. A kill terminates the function with that
  // insert still pending, so the tick writes NOTHING and is indistinguishable
  // from a cron that never fired. `try/catch` cannot close it (the kill is
  // outside the language) and `finally` does not run reliably here.
  //
  // Written BEFORE any early return below, so a skipped tick still proves the
  // route was reached. Kills are then read by CORRELATION — a
  // `${PIPELINE_NAME}-heartbeat` row with no matching terminal row. Never throws.
  await writeInvocationHeartbeat({
    pipeline: PIPELINE_NAME,
    startedAtMs: Date.parse(startedAt),
  });


  if (!proxyUrl || !proxySecret || !queryId) {
    try {
      await supabaseAdmin.rpc("log_pipeline_run", {
        p_pipeline: PIPELINE_NAME,
        p_started_at: startedAt,
        p_rows_found: 0,
        p_rows_written: 0,
        p_rows_skipped: 0,
        p_ok: true,
        p_error: null,
        p_extra: { skipped: "dune_not_configured" },
      });
    } catch {
      /* non-fatal */
    }
    return NextResponse.json(
      { ok: true, accepted: true, pipeline: PIPELINE_NAME, skipped: "dune_not_configured" },
      { status: 202 }
    );
  }

  after(async () => {
    const startedMs = Date.now();
    let ok = true;
    let errMsg: string | null = null;
    let found = 0;
    let inserted = 0;
    let filled = 0;
    let skippedUnresolved = 0;
    let skippedExisting = 0;
    let skippedMultimoment = 0;
    let mapSkipped = 0;
    let windowsDone = 0;
    let drained = false;
    let lastWindow: string | null = null;
    // ── Dune spend budget (2026-08-22) ──────────────────────────────────────
    // ⚠ THIS IS THE LANE THAT BURNED THE 2026-07-24 CYCLE. It returned ~636,956
    // rows across 37 windows before Dune refused, 90.2% of them discarded
    // immediately as `skipped_unresolved` (docs/dune-budget-analysis-2026-07-26.md).
    // Its Vercel schedule was retired on 07-28 and the route deliberately kept,
    // so the guard belongs here NOW — the day someone re-adds the cron is the
    // day it would otherwise repeat, and that is exactly when nobody is looking
    // for a budget bug. Read lazily so a drained tick costs nothing.
    let budget: DuneBudget | null = null;
    // Datapoints are the binding meter (Dune's cycle limit is 1,000,000 of
    // them); rows are the secondary per-day bound. This lane's work is
    // RESUMABLE — the cursor advances only on a completed window — so unlike the
    // ownership walk it may stop anywhere, and its min_start is 0.
    let dpAllowance = 0;
    let rowsAllowance = 0;
    let budgetStopped = false;

    try {
      const { data: st, error: stErr } = await supabaseAdmin
        .from("sales_ingest_state")
        .select("cursor_end, floor_date, window_days")
        .eq("id", 1)
        .single();
      if (stErr || !st) throw new Error(`state read: ${stErr?.message ?? "no row"}`);

      const floor = new Date(`${st.floor_date}T00:00:00Z`);
      const windowDays = Math.max(1, Number(st.window_days) || 7);
      let cursorEnd = new Date(`${st.cursor_end}T00:00:00Z`);

      while (Date.now() - startedMs < HARD_BUDGET_MS) {
        if (cursorEnd.getTime() <= floor.getTime()) {
          drained = true;
          break;
        }
        if (budget === null) {
          budget = await readDuneBudget(PIPELINE_NAME);
          dpAllowance = budget.datapointsAllowedNow;
          rowsAllowance = budget.rowsAllowedNow;
        }
        // Stop at the WINDOW boundary: the cursor advances only on a completed
        // window, so this is resumable and loses nothing.
        if (!budget.canStart || dpAllowance <= 0 || rowsAllowance <= 0) {
          budgetStopped = true;
          break;
        }
        const windowStart = new Date(
          Math.max(floor.getTime(), cursorEnd.getTime() - windowDays * 86_400_000)
        );
        lastWindow = `${iso(windowStart)}..${iso(cursorEnd)}`;

        const execBody = JSON.stringify({
          query_parameters: { start_date: iso(windowStart), end_date: iso(cursorEnd) },
        });
        const exRes = await fetch(`${proxyUrl}/execute?query_id=${encodeURIComponent(queryId)}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${proxySecret}`, "Content-Type": "application/json" },
          body: execBody,
          cache: "no-store",
          signal: sweepDeadlineSignal(startedMs, HARD_BUDGET_MS, { reserveMs: DUNE_LOG_RESERVE_MS }),
        });
        await recordDuneUsage({
          pipeline: PIPELINE_NAME,
          endpoint: "execute",
          queryId,
          httpStatus: exRes.status,
          note: lastWindow,
        });
        if (!exRes.ok) throw new Error(`execute HTTP ${exRes.status} (${lastWindow}): ${(await exRes.text()).slice(0, 200)}`);
        const execId = ((await exRes.json()) as { execution_id?: string }).execution_id;
        if (!execId) throw new Error(`no execution_id (${lastWindow})`);

        let completed = false;
        const refreshDeadline = Date.now() + REFRESH_BUDGET_MS;
        while (Date.now() < refreshDeadline) {
          await sleep(REFRESH_POLL_MS);
          const stRes = await fetch(
            `${proxyUrl}/status?execution_id=${encodeURIComponent(execId)}`,
            {
              headers: { Authorization: `Bearer ${proxySecret}` },
              cache: "no-store",
              signal: sweepDeadlineSignal(startedMs, HARD_BUDGET_MS, { reserveMs: DUNE_LOG_RESERVE_MS }),
            }
          );
          if (!stRes.ok) throw new Error(`status HTTP ${stRes.status} (${lastWindow})`);
          const state = ((await stRes.json()) as { state?: string }).state ?? "";
          if (state === "QUERY_STATE_COMPLETED") { completed = true; break; }
          if (
            state === "QUERY_STATE_FAILED" ||
            state === "QUERY_STATE_CANCELLED" ||
            state === "QUERY_STATE_EXPIRED"
          ) {
            throw new Error(`execution ${state} (${lastWindow})`);
          }
        }
        if (!completed) throw new Error(`execution poll timed out (${lastWindow})`);

        let offset = 0;
        while (Date.now() - startedMs < HARD_BUDGET_MS) {
          const url = `${proxyUrl}/results?query_id=${encodeURIComponent(queryId)}&limit=${PAGE_LIMIT}&offset=${offset}`;
          let res: Response | null = null;
          for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
            res = await fetch(url, {
              headers: { Authorization: `Bearer ${proxySecret}` },
              cache: "no-store",
              signal: sweepDeadlineSignal(startedMs, HARD_BUDGET_MS, { reserveMs: DUNE_LOG_RESERVE_MS }),
            });
            if (res.status !== 429) break;
            if (attempt === MAX_429_RETRIES) break;
            const retryAfter = Number(res.headers.get("retry-after"));
            const waitMs =
              Number.isFinite(retryAfter) && retryAfter > 0
                ? retryAfter * 1000
                : BACKOFF_BASE_MS * 2 ** attempt;
            if (Date.now() - startedMs + waitMs > HARD_BUDGET_MS) break;
            await sleep(waitMs);
          }
          if (!res || !res.ok) {
            throw new Error(`dune proxy HTTP ${res?.status ?? "no-response"} at offset ${offset} (${lastWindow})`);
          }
          const j = (await res.json()) as {
            result?: { rows?: Array<Record<string, unknown>> };
            next_offset?: number | null;
          };
          const rows = j.result?.rows ?? [];
          found += rows.length;
          rowsAllowance -= rows.length;
          dpAllowance -= rows.length * columnCount(rows);
          await recordDuneUsage({
            pipeline: PIPELINE_NAME,
            endpoint: "results",
            queryId,
            rows: rows.length,
            columns: columnCount(rows),
            httpStatus: res.status,
            note: lastWindow,
          });

          const mapped: IngestRow[] = [];
          for (const r of rows) {
            const m = mapDuneRow(r);
            if (m) mapped.push(m);
            else mapSkipped++;
          }

          for (let i = 0; i < mapped.length; i += FILL_CHUNK) {
            const chunk = mapped.slice(i, i + FILL_CHUNK);
            const { data: applyRes, error: applyErr } = await supabaseAdmin.rpc(
              "apply_sales_ingest_external",
              { p_rows: chunk }
            );
            if (applyErr) throw new Error(`apply: ${applyErr.message} (${lastWindow})`);
            const a = (applyRes as Record<string, number> | null) ?? {};
            inserted += Number(a.inserted ?? 0) || 0;
            filled += Number(a.filled ?? 0) || 0;
            skippedUnresolved += Number(a.skipped_unresolved ?? 0) || 0;
            skippedExisting += Number(a.skipped_existing ?? 0) || 0;
            skippedMultimoment += Number(a.skipped_multimoment ?? 0) || 0;
          }

          if (rows.length < PAGE_LIMIT || j.next_offset == null) break;
          offset = Number(j.next_offset);
          await sleep(INTER_PAGE_MS);
        }

        cursorEnd = windowStart;
        const { error: updErr } = await supabaseAdmin
          .from("sales_ingest_state")
          .update({ cursor_end: iso(cursorEnd), updated_at: new Date().toISOString() })
          .eq("id", 1);
        if (updErr) throw new Error(`state advance: ${updErr.message}`);
        windowsDone++;
      }
    } catch (e) {
      ok = false;
      errMsg = `${errMsg ? errMsg + "; " : ""}threw: ${e instanceof Error ? e.message : String(e)}`;
    }

    // Paced by a configured cap = did as told (ok). Stopped because the budget
    // could not be READ = an unknown state, which must not report success.
    if (budgetStopped && budget?.read === "failed") {
      ok = false;
      errMsg = errMsg ?? `dune budget unreadable: ${budget.reason ?? "unknown"}`;
    }

    try {
      await supabaseAdmin.rpc("log_pipeline_run", {
        p_pipeline: PIPELINE_NAME,
        p_started_at: startedAt,
        p_rows_found: found,
        p_rows_written: inserted + filled,
        p_rows_skipped: skippedUnresolved + skippedExisting + skippedMultimoment + mapSkipped,
        p_ok: ok,
        p_error: errMsg,
        p_extra: {
          inserted,
          filled,
          skipped_unresolved: skippedUnresolved,
          skipped_existing: skippedExisting,
          skipped_multimoment: skippedMultimoment,
          map_skipped: mapSkipped,
          windows_done: windowsDone,
          last_window: lastWindow,
          drained,
          duration_ms: Date.now() - startedMs,
          query_id: queryId,
          ...(budget
            ? {
                budget_datapoints_allowed: budget.datapointsAllowedNow,
                budget_datapoints_left: dpAllowance,
                budget_rows_left: rowsAllowance,
              }
            : {}),
          ...(budgetStopped ? { budget_stopped: true, budget_reason: budget?.reason } : {}),
        },
      });
    } catch (logErr) {
      console.log(
        `[${PIPELINE_NAME}] log_pipeline_run err: ${logErr instanceof Error ? logErr.message : String(logErr)}`
      );
    }
  });

  return NextResponse.json({ ok: true, accepted: true, pipeline: PIPELINE_NAME }, { status: 202 });
}
