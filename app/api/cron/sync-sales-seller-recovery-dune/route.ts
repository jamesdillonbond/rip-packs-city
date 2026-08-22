// app/api/cron/sync-sales-seller-recovery-dune/route.ts
//
// Sales seller-recovery Pipeline (Dune). Supersedes the Flow-REST decode grind
// of workers/sales-counterparty-backfill for the HISTORICAL backlog: fills
// public.sales.seller_address on rows the studio/GQL imports landed without a
// wallet (~3.6M null-seller rows with real tx hashes).
//
// Source: the saved Dune query DUNE_SALES_SELLER_QUERY_ID over flow.cadence_events.
// A Withdraw.from is a SALE seller iff the same (tx, nft) carries a marketplace
// settlement event (MarketV3.MomentPurchased / OffersV2.OfferCompleted /
// NFTStorefront.ListingCompleted) — validated end-to-end 2026-07-19 (0 conflicts
// across 13,874 rows where we already knew the seller). It walks a date-window
// cursor BACKWARD (public.sales_seller_recovery_state) so each run touches a
// bounded slice of the IOPS-constrained hot `sales` table.
//
// Writes go through public.apply_sales_counterparty_external (fill-only via
// COALESCE + IS NULL, idempotent, audited into sales_counterparty_recovered,
// seller-only, NO INSERT/DELETE on sales). It does NOT touch the Flow-REST
// worker's cursor (sales_counterparty_backfill_state), so the two lanes coexist.
//
// INERT until configured: logs skipped:'dune_not_configured' unless
// DUNE_PROXY_URL + DUNE_PROXY_SECRET + DUNE_SALES_SELLER_QUERY_ID are all set,
// so deploying it changes nothing until the operator provisions Dune.
//
// Auth: Bearer ${INGEST_SECRET_TOKEN} or ${CRON_SECRET}. Method: POST or GET.
// Recommended: cron-job.org (or vercel.json crons) every ~30 min, off the :00 rush.

import { NextRequest, NextResponse, after } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat";
import {
  readDuneBudget,
  recordDuneUsage,
  columnCount,
  type DuneBudget,
} from "@/lib/dune/budget";

export const dynamic = "force-dynamic";
export const maxDuration = 800; // Pro hard cap; the walk is bounded by HARD_BUDGET_MS below.

const PIPELINE_NAME = "sales-seller-recovery-dune";
const PAGE_LIMIT = 1000; // dune-proxy / Dune results page cap
const FILL_CHUNK = 1000; // rows per apply_sales_counterparty_external call
const HARD_BUDGET_MS = 720_000; // stop before the 800s lambda ceiling
const INTER_PAGE_MS = 2500; // ~24 pages/min, under Dune's free-tier per-minute cap
const MAX_429_RETRIES = 6;
const BACKOFF_BASE_MS = 4000; // 4s, 8s, 16s, ... (or Retry-After when present)
const REFRESH_BUDGET_MS = 240_000; // max wait for one window's execution to complete
const REFRESH_POLL_MS = 4000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function authed(req: NextRequest): boolean {
  const auth = req.headers.get("authorization");
  return (
    auth === `Bearer ${process.env.INGEST_SECRET_TOKEN}` ||
    auth === `Bearer ${process.env.CRON_SECRET}`
  );
}

type FillRow = { tx_hash: string; nft_id: string; seller: string };

// Map a Dune result row to a fill row. Returns null (skipped, not fatal) unless
// tx_hash + nft_id + a well-formed Flow seller address are all present.
function mapDuneRow(raw: Record<string, unknown>): FillRow | null {
  const tx = raw.transaction_hash ?? raw.tx_hash ?? raw.tx;
  const nft = raw.nft_id ?? raw.nftId ?? raw.nftID ?? raw.id;
  const sellerRaw = raw.seller ?? raw.from ?? raw.seller_address;
  if (tx == null || nft == null || sellerRaw == null) return null;
  const seller = String(sellerRaw).toLowerCase();
  if (!/^0x[0-9a-f]{16}$/.test(seller)) return null;
  return { tx_hash: String(tx), nft_id: String(nft), seller };
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
  const queryId = process.env.DUNE_SALES_SELLER_QUERY_ID;
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
    let written = 0;
    let skipped = 0;
    let windowsDone = 0;
    let drained = false;
    let lastWindow: string | null = null;
    // ── Dune spend budget (2026-08-22) ──────────────────────────────────────
    // This lane is hourly and each tick walks windows flat out for up to 12
    // minutes, so on 2026-07-24 it and its sibling spent the whole billing
    // cycle's datapoints between the 00:00 UTC reset and 06:11. Read LAZILY —
    // only once there is a window to buy — so the ~24 drained no-op ticks a day
    // (cursor_end == floor_date since 2026-07-26) cost nothing extra.
    let budget: DuneBudget | null = null;
    // Datapoints are the binding meter (Dune's cycle limit is 1,000,000 of
    // them); rows are the secondary per-day bound. This lane's work is
    // RESUMABLE — the cursor advances only on a completed window — so unlike the
    // ownership walk it may stop anywhere, and its min_start is 0.
    let dpAllowance = 0;
    let rowsAllowance = 0;
    let budgetStopped = false;

    try {
      // Load the backward-walking date-window cursor.
      const { data: st, error: stErr } = await supabaseAdmin
        .from("sales_seller_recovery_state")
        .select("cursor_end, floor_date, window_days")
        .eq("id", 1)
        .single();
      if (stErr || !st) throw new Error(`state read: ${stErr?.message ?? "no row"}`);

      const floor = new Date(`${st.floor_date}T00:00:00Z`);
      const windowDays = Math.max(1, Number(st.window_days) || 7);
      let cursorEnd = new Date(`${st.cursor_end}T00:00:00Z`);

      // Process windows until the time budget is spent or the backlog is drained.
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
        // A window costs a fresh execution plus its whole result set, so stop at
        // the window boundary — the cursor only advances on a completed window,
        // which is what makes stopping here resumable and lossless.
        if (!budget.canStart || dpAllowance <= 0 || rowsAllowance <= 0) {
          budgetStopped = true;
          break;
        }
        const windowStart = new Date(
          Math.max(floor.getTime(), cursorEnd.getTime() - windowDays * 86_400_000)
        );
        lastWindow = `${iso(windowStart)}..${iso(cursorEnd)}`;

        // Trigger a fresh execution of the saved query for this window and poll it.
        const execBody = JSON.stringify({
          query_parameters: { start_date: iso(windowStart), end_date: iso(cursorEnd) },
        });
        const exRes = await fetch(`${proxyUrl}/execute?query_id=${encodeURIComponent(queryId)}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${proxySecret}`, "Content-Type": "application/json" },
          body: execBody,
          cache: "no-store",
        });
        await recordDuneUsage({
          pipeline: PIPELINE_NAME,
          endpoint: "execute",
          queryId,
          httpStatus: exRes.status,
          note: lastWindow,
        });
        // Surface Dune's OWN error text, not just the status. This threw with
        // `execute HTTP 400` alone and three consecutive hourly ticks burned
        // without producing a single diagnosable fact — the failure was visible
        // but its cause was not. Dune returns the reason in the body (unknown /
        // mistyped parameter names, malformed values, query not found), and
        // that string is the whole diagnosis. Body is read defensively and
        // capped: a proxy hiccup returning HTML must not blow up the error path
        // that exists to explain failures. Nothing secret transits here — the
        // request carries no key (dune-proxy injects it) and the response is
        // Dune's public error text.
        if (!exRes.ok) {
          const detail = await exRes.text().catch(() => "<body unreadable>");
          throw new Error(
            `execute HTTP ${exRes.status} (${lastWindow}) params=${execBody.slice(0, 120)} dune=${detail.slice(0, 300)}`
          );
        }
        const execId = ((await exRes.json()) as { execution_id?: string }).execution_id;
        if (!execId) throw new Error(`no execution_id (${lastWindow})`);

        let completed = false;
        const refreshDeadline = Date.now() + REFRESH_BUDGET_MS;
        while (Date.now() < refreshDeadline) {
          await sleep(REFRESH_POLL_MS);
          const stRes = await fetch(
            `${proxyUrl}/status?execution_id=${encodeURIComponent(execId)}`,
            { headers: { Authorization: `Bearer ${proxySecret}` }, cache: "no-store" }
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

        // Page this window's result set, filling as we go.
        let offset = 0;
        while (Date.now() - startedMs < HARD_BUDGET_MS) {
          const url = `${proxyUrl}/results?query_id=${encodeURIComponent(queryId)}&limit=${PAGE_LIMIT}&offset=${offset}`;
          let res: Response | null = null;
          for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
            res = await fetch(url, {
              headers: { Authorization: `Bearer ${proxySecret}` },
              cache: "no-store",
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

          const mapped: FillRow[] = [];
          for (const r of rows) {
            const m = mapDuneRow(r);
            if (m) mapped.push(m);
            else skipped++;
          }

          for (let i = 0; i < mapped.length; i += FILL_CHUNK) {
            const chunk = mapped.slice(i, i + FILL_CHUNK);
            const { data: applyRes, error: applyErr } = await supabaseAdmin.rpc(
              "apply_sales_counterparty_external",
              { p_rows: chunk }
            );
            if (applyErr) throw new Error(`apply: ${applyErr.message} (${lastWindow})`);
            const applied = Number((applyRes as { applied?: number } | null)?.applied ?? 0);
            written += Number.isFinite(applied) ? applied : 0;
          }

          if (rows.length < PAGE_LIMIT || j.next_offset == null) break;
          offset = Number(j.next_offset);
          await sleep(INTER_PAGE_MS);
        }

        // Window done — advance the cursor backward and persist so a crash resumes here.
        cursorEnd = windowStart;
        const { error: updErr } = await supabaseAdmin
          .from("sales_seller_recovery_state")
          .update({ cursor_end: iso(cursorEnd), updated_at: new Date().toISOString() })
          .eq("id", 1);
        if (updErr) throw new Error(`state advance: ${updErr.message}`);
        windowsDone++;
      }
    } catch (e) {
      ok = false;
      errMsg = `${errMsg ? errMsg + "; " : ""}threw: ${e instanceof Error ? e.message : String(e)}`;
    }

    // A tick stopped by a CONFIGURED cap did what it was told, so it stays ok.
    // A tick stopped because the budget could not be READ proved nothing — that
    // is an unknown state, and a lane that silently stops while reporting
    // success is the failure this repo keeps finding.
    if (budgetStopped && budget?.read === "failed") {
      ok = false;
      errMsg = errMsg ?? `dune budget unreadable: ${budget.reason ?? "unknown"}`;
    }

    try {
      await supabaseAdmin.rpc("log_pipeline_run", {
        p_pipeline: PIPELINE_NAME,
        p_started_at: startedAt,
        p_rows_found: found,
        p_rows_written: written,
        p_rows_skipped: skipped,
        p_ok: ok,
        p_error: errMsg,
        p_extra: {
          windows_done: windowsDone,
          last_window: lastWindow,
          drained,
          duration_ms: Date.now() - startedMs,
          query_id: queryId,
          // Present only when the budget was actually consulted — a drained tick
          // never reads it, so its absence is meaningful rather than a default.
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
