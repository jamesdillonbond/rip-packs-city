// app/api/cron/sync-topshot-ownership-dune/route.ts
//
// Ownership-index Pipeline A (Dune). Pages a Dune query's current-ownership
// result set through the dune-proxy worker and upserts public.topshot_ownership
// (source='dune'). The fast-parity bootstrap that lights up the per-player
// collector leaderboard (#1) and set completers (#4) — see
// docs/handoff-2026-06-26-ownership-index.md.
//
// INERT until configured: returns/logs skipped:'dune_not_configured' unless
// DUNE_PROXY_URL + DUNE_PROXY_SECRET + DUNE_OWNERSHIP_QUERY_ID are all set, so
// deploying it changes nothing until the operator provisions Dune. Idempotent
// (onConflict nft_id), so re-runs converge; observed_at records freshness.
//
// Expected Dune query result columns (author per the handoff):
//   nft_id, set_id, play_id, sub_edition_id, owner_address, serial_number
// edition_external_id is derived: "<set_id>:<play_id>" (+ "::<sub_edition_id>"
// when sub_edition_id > 0), matching editions.external_id.
//
// Freshness contract: /results returns the LAST cached execution, so the run
// triggers a fresh Dune execution first. If that refresh fails the run reports
// ok=false with extra.stale_cache=true — it accomplished nothing, and this
// pipeline has no cadence-watchlist row, so ok=false is its only alarm.
// extra.refresh_http_status separates the causes (402 = Dune datapoints
// exhausted, 404 = dune-proxy worker missing /execute).
//
// ⚠ CHANGED 2026-08-22: a failed refresh no longer WALKS the cached execution.
// It used to, "so the table is never emptied" — but /results then returns rows
// this pipeline already holds, and it re-bought all ~114k of them at Dune's
// datapoint meter (rows_written was byte-identical, 114,083, on the 08-03
// success and both the 08-10 and 08-17 402s). The walk now runs only when it can
// be shown to add something: an empty table, or fewer rows held than the cached
// execution carries. `?forcewalk=1` overrides. Spend is also capped per UTC day
// by public.dune_budget_status() — see lib/dune/budget.ts.
//
// Auth: Bearer ${INGEST_SECRET_TOKEN} or ${CRON_SECRET}. Method: POST or GET.
// Cron-job.org: daily, off the :00 rush, www domain.

import { NextRequest, NextResponse, after } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat";
import {
  readDuneBudget,
  recordDuneUsage,
  logDuneBudgetStop,
  columnCount,
} from "@/lib/dune/budget";

export const dynamic = "force-dynamic";
export const maxDuration = 800; // Pro hard cap; the walk is bounded by HARD_BUDGET_MS below.

const PIPELINE_NAME = "ownership-sync-dune";
const PAGE_LIMIT = 1000; // dune-proxy / Dune results page cap
const UPSERT_CHUNK = 1000;
const HARD_BUDGET_MS = 750_000; // stop walking before the 800s lambda ceiling
// Dune free tier rate-limits result reads (15-40 req/min). Throttle each page
// and back off on 429 so a full ~103-page walk stays under the cap instead of
// aborting at offset 20000 (which permanently capped the table, since the walk
// restarts at offset 0 every run).
const INTER_PAGE_MS = 2500; // ~24 pages/min, comfortably under the 40/min ceiling
const MAX_429_RETRIES = 6; // per-page backoff attempts before giving up
const BACKOFF_BASE_MS = 4000; // 4s, 8s, 16s, ... (or Retry-After when present)
// Freshness: /results returns the query's LAST execution (cached), so without a
// re-execution the table never changes. Trigger a fresh Dune run + poll to
// completion before walking. Bounded so the walk still fits the 750s budget.
const REFRESH_BUDGET_MS = 300_000; // max wait for the execution to complete
const REFRESH_POLL_MS = 4000; // status poll interval

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function authed(req: NextRequest): boolean {
  const auth = req.headers.get("authorization");
  return (
    auth === `Bearer ${process.env.INGEST_SECRET_TOKEN}` ||
    auth === `Bearer ${process.env.CRON_SECRET}`
  );
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

type OwnershipRow = {
  nft_id: string;
  edition_external_id: string;
  owner_address: string;
  serial_number: number | null;
  source: string;
};

// Map a Dune result row to a topshot_ownership row. Returns null if the row is
// missing the fields needed to key it (skipped, not fatal).
function mapDuneRow(raw: Record<string, unknown>): OwnershipRow | null {
  const nftId = raw.nft_id ?? raw.nftId ?? raw.moment_id ?? raw.id;
  const owner = raw.owner_address ?? raw.owner ?? raw.holder ?? raw.account;
  const setId = num(raw.set_id ?? raw.setId ?? raw.setID);
  const playId = num(raw.play_id ?? raw.playId ?? raw.playID);
  const subId = num(raw.sub_edition_id ?? raw.subedition_id ?? raw.subeditionID ?? raw.parallel_id);
  if (nftId == null || owner == null || setId == null || playId == null) return null;

  let ext = `${setId}:${playId}`;
  if (subId != null && subId > 0) ext = `${ext}::${subId}`;

  return {
    nft_id: String(nftId),
    edition_external_id: ext,
    owner_address: String(owner),
    serial_number: num(raw.serial_number ?? raw.serial ?? raw.serialNumber),
    source: "dune",
  };
}

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
  const queryId = process.env.DUNE_OWNERSHIP_QUERY_ID;
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


  // Inert until provisioned — log an honest skip so the absence is visible in
  // pipeline_runs rather than looking like a silent stall.
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
    let offset = 0;
    let exhausted = false;
    let refreshed = false;
    let refreshNote: string | null = null;
    let refreshAttempted = false;
    let refreshStatus: number | null = null;
    let executeBody: string | undefined;
    let batchSets: number[] = [];
    let budgetStopped = false;
    let walkSkip: string | null = null;
    let duneRowsHeld: number | null = null;
    let cachedTotalRows: number | null = null;

    // ── Dune spend budget (2026-08-22) ──────────────────────────────────────
    // 🚨 ONE FULL WALK IS 87.7% OF THE MONTH. 146,100 rows x 6 columns =
    // 876,600 datapoints against a 1,000,000-datapoint cycle. That is why the
    // weekly cadence 402'd on 08-10 and 08-17: the second walk of a cycle cannot
    // fit, and no amount of retrying changes the arithmetic.
    //
    // ⚠ SIZED BY THE TABLE, NOT BY THE LAST EXECUTION. This comment previously
    // said 68.4% / 684,498, derived from the 08-03 run's 114,083 rows. That is
    // the wrong bound: the reservation has to cover the LARGEST execution that
    // might arrive, and a reservation the workload outgrows fails as a lane that
    // silently stops starting. Re-derived live 2026-08-22 from
    // `dune_budget_allocation`, whose own note records the same measurement.
    //
    // ⚠ `canStart`, NOT `allowance > 0`. This walk restarts at offset 0 every
    // run, so a partial walk spends datapoints AND leaves the table capped at
    // the offset reached (an abort at offset 20000 once did exactly that). The
    // lane therefore DECLINES TO START unless it can finish — 880,000 datapoints
    // (`dune_budget_allocation.min_start_datapoints`, verified live 2026-08-22;
    // the comment said 600,000, and a reader who trusts it sizes the wrong gate)
    // — rather than buying a fraction of a walk. Caps and reservations live in the DB: changing the pace is one
    // UPDATE, not a deploy.
    const budget = await readDuneBudget(PIPELINE_NAME);
    let dpAllowance = budget.datapointsAllowedNow;
    let rowsAllowance = budget.rowsAllowedNow;
    if (!budget.canStart) {
      await logDuneBudgetStop({
        pipeline: PIPELINE_NAME,
        startedAt,
        budget,
        extra: { query_id: queryId },
      });
      return;
    }

    try {
      // Freshness phase: /results returns the query's LAST cached execution, so
      // trigger a fresh Dune run and poll it to completion before walking. On any
      // failure (incl. an un-upgraded worker returning 404 on /execute) fall
      // through and read the last cached results — stale but valid, never empty.
      // OPTIONAL incremental backfill mode. Inert unless env DUNE_OWNERSHIP_INCREMENTAL
      // is set AND the Dune query has a {{set_ids}} parameter. When on, pull the next
      // batch of uncovered TopShot sets from get_ownership_backfill_targets (cheapest-
      // first) and pass them as the set_ids execute parameter so each run ingests a
      // BOUNDED slice; the idempotent nft_id upsert advances coverage over successive
      // runs. When off (default today), executeBody stays undefined and the execute
      // call is byte-identical to the current full-refresh.
      if (process.env.DUNE_OWNERSHIP_INCREMENTAL) {
        const batchN = Math.max(1, Math.min(50, Number(process.env.DUNE_OWNERSHIP_BATCH_SETS ?? "10")));
        try {
          // p_max_datapoints caps the CUMULATIVE estimate of the batch. Without it
          // the walk eventually reaches a set larger than a whole cycle (Base Set S4
          // alone is ~91,979,724 datapoints), truncates at the allowance, restarts at
          // offset 0 next run, and burns the reservation every cycle without ever
          // finishing that set. Verified live 2026-08-22: the function signature is
          // (p_limit integer, p_max_datapoints bigint DEFAULT NULL).
          const { data: targets } = await supabaseAdmin.rpc("get_ownership_backfill_targets", {
            p_limit: batchN,
            p_max_datapoints: dpAllowance,
          });
          batchSets = Array.isArray(targets)
            ? (targets as Array<{ set_id_onchain: number }>).map((t) => Number(t.set_id_onchain)).filter((n) => Number.isFinite(n))
            : [];
        } catch (e) {
          refreshNote = `backfill-targets: ${e instanceof Error ? e.message : String(e)}`;
        }
        if (batchSets.length > 0) {
          executeBody = JSON.stringify({ query_parameters: { set_ids: batchSets.join(",") } });
        } else {
          // 🚨 Incremental mode ON with nothing to fetch. Falling through here would
          // send an /execute with NO query_parameters — which is the FULL walk,
          // 876,600 datapoints, 87.7% of the cycle — i.e. the exact opposite of what
          // "no targets" means. Two ways to land here and both are skips, not walks:
          // the backfill is complete, or the targets RPC threw (see refreshNote, whose
          // catch above swallows the error and falls straight through).
          //
          // ok:true is right — nothing was owed and nothing was spent. `skipped` is
          // already a key this pipeline emits (`dune_not_configured`), so
          // extra_key_counts in pipeline_runs_daily counts it with no other change.
          await supabaseAdmin.rpc("log_pipeline_run", {
            p_pipeline: PIPELINE_NAME,
            p_started_at: startedAt,
            p_rows_found: 0,
            p_rows_written: 0,
            p_rows_skipped: 0,
            p_ok: true,
            p_error: null,
            p_extra: {
              skipped: "no_incremental_targets",
              query_id: queryId,
              refresh_note: refreshNote,
              budget_datapoints_allowed: budget.datapointsAllowedNow,
            },
          });
          return;
        }
      }

      const skipRefresh = new URL(req.url).searchParams.get("norefresh") === "1";
      if (!skipRefresh) {
        refreshAttempted = true;
        try {
          const exRes = await fetch(`${proxyUrl}/execute?query_id=${encodeURIComponent(queryId)}`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${proxySecret}`,
              ...(executeBody ? { "Content-Type": "application/json" } : {}),
            },
            ...(executeBody ? { body: executeBody } : {}),
            cache: "no-store",
          });
          // An /execute buys no rows, so `rows` stays NULL — but it is the call
          // that fails with 402 when the cycle is spent, and the ledger is where
          // that will be read back from.
          await recordDuneUsage({
            pipeline: PIPELINE_NAME,
            endpoint: "execute",
            queryId,
            httpStatus: exRes.status,
            note: executeBody ? "incremental refresh" : "full refresh",
          });
          if (exRes.ok) {
            const execId = ((await exRes.json()) as { execution_id?: string }).execution_id;
            if (execId) {
              const deadline = startedMs + REFRESH_BUDGET_MS;
              while (Date.now() < deadline) {
                await sleep(REFRESH_POLL_MS);
                const stRes = await fetch(`${proxyUrl}/status?execution_id=${encodeURIComponent(execId)}`, {
                  headers: { Authorization: `Bearer ${proxySecret}` },
                  cache: "no-store",
                });
                if (!stRes.ok) { refreshNote = `status HTTP ${stRes.status}`; break; }
                const state = ((await stRes.json()) as { state?: string }).state ?? "";
                if (state === "QUERY_STATE_COMPLETED") { refreshed = true; break; }
                if (state === "QUERY_STATE_FAILED" || state === "QUERY_STATE_CANCELLED" || state === "QUERY_STATE_EXPIRED") {
                  refreshNote = `execution ${state}`;
                  break;
                }
              }
              if (!refreshed && !refreshNote) refreshNote = "execution poll timed out";
            } else {
              refreshNote = "no execution_id in execute response";
            }
          } else {
            refreshStatus = exRes.status;
            refreshNote = `execute HTTP ${exRes.status}`;
          }
        } catch (e) {
          refreshNote = `refresh threw: ${e instanceof Error ? e.message : String(e)}`;
        }
      } else {
        refreshNote = "skipped (norefresh=1)";
      }

      // ── The stale-cache walk, which bought nothing (2026-08-22) ───────────
      // ⚠ MEASURED WASTE, not a hypothesis. When the refresh does not complete,
      // /results necessarily returns the SAME execution as last time — and this
      // route walked all ~114k rows of it anyway. `rows_written` is byte
      // identical (114,083) on the 2026-08-03 success AND on both the 08-10 and
      // 08-17 `HTTP 402` failures: two of every three weekly runs in a cycle
      // re-bought a table we already held, at the moment the cycle was already
      // exhausted.
      //
      // The skip must not be able to strand a TRUNCATED ingest, so it is decided
      // by evidence rather than assumption — one `limit=1` probe reads the cached
      // execution's total row count and it is compared against the dune-sourced
      // rows we hold:
      //   hold 0                    -> walk (bootstrap; an empty table can never
      //                                match, so the first run is structurally safe)
      //   hold < cached total       -> walk (the last ingest was cut short)
      //   anything else, incl. any  -> skip (cannot prove the walk would add a
      //   unknown                      single row, so refuse to spend for it)
      // `?forcewalk=1` is the operator override.
      const stale = refreshAttempted && !refreshed;
      const forceWalk = new URL(req.url).searchParams.get("forcewalk") === "1";
      if (stale && !forceWalk) {
        // ⚠ supabase-js RETURNS errors rather than throwing, so `count` is null
        // on a failed read. `?? 0` here would read as "table empty" and
        // authorise the entire walk — the fabricated-number shape, aimed at the
        // budget.
        const { count, error: cntErr } = await supabaseAdmin
          .from("topshot_ownership")
          .select("nft_id", { count: "exact", head: true })
          .eq("source", "dune");
        duneRowsHeld = cntErr || typeof count !== "number" ? null : count;

        if (duneRowsHeld === null) {
          walkSkip = "stale_cache_row_count_unreadable";
        } else if (duneRowsHeld > 0) {
          try {
            const probeRes = await fetch(
              `${proxyUrl}/results?query_id=${encodeURIComponent(queryId)}&limit=1&offset=0`,
              { headers: { Authorization: `Bearer ${proxySecret}` }, cache: "no-store" }
            );
            if (probeRes.ok) {
              const pj = (await probeRes.json()) as {
                result?: {
                  rows?: Array<Record<string, unknown>>;
                  metadata?: Record<string, unknown>;
                };
              };
              const probeRows = pj.result?.rows ?? [];
              rowsAllowance -= probeRows.length;
              dpAllowance -= probeRows.length * columnCount(probeRows);
              await recordDuneUsage({
                pipeline: PIPELINE_NAME,
                endpoint: "results",
                queryId,
                rows: probeRows.length,
                columns: columnCount(probeRows),
                httpStatus: probeRes.status,
                note: "stale-cache size probe",
              });
              // ⚠ `total_row_count` ONLY. Dune also returns `row_count`, which
              // is the rows in THIS page — 1 on a limit=1 probe — so accepting
              // it as a fallback would make "held >= total" true for any
              // non-empty table and skip a genuinely truncated ingest. An
              // absent total is an unknown, and an unknown skips (below).
              const total = Number(pj.result?.metadata?.total_row_count);
              cachedTotalRows = Number.isFinite(total) ? total : null;
            }
          } catch {
            cachedTotalRows = null;
          }
          walkSkip =
            cachedTotalRows === null
              ? "stale_cache_size_unknown"
              : duneRowsHeld >= cachedTotalRows
                ? "stale_cache_already_ingested"
                : null;
        }
      }

      // Walk the Dune result set page by page, upserting as we go.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (walkSkip) break;
        // Out of allowance mid-walk: stop cleanly with the offset recorded
        // rather than paging on until Dune refuses. Reaching here at all means
        // the pre-flight `canStart` was satisfied and something else (a
        // concurrent lane, or a walk larger than the reservation) consumed the
        // difference — so it is a real event worth seeing in `extra`.
        if (dpAllowance <= 0 || rowsAllowance <= 0) {
          budgetStopped = true;
          break;
        }
        if (Date.now() - startedMs > HARD_BUDGET_MS) break;

        const url = `${proxyUrl}/results?query_id=${encodeURIComponent(queryId)}&limit=${PAGE_LIMIT}&offset=${offset}`;
        // Fetch one page, retrying with backoff on 429 (Dune per-minute rate cap).
        let res: Response | null = null;
        for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
          res = await fetch(url, {
            headers: { Authorization: `Bearer ${proxySecret}` },
            cache: "no-store",
          });
          if (res.status !== 429) break;
          if (attempt === MAX_429_RETRIES) break; // exhausted retries -> abort below
          const retryAfter = Number(res.headers.get("retry-after"));
          const waitMs =
            Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter * 1000
              : BACKOFF_BASE_MS * 2 ** attempt;
          if (Date.now() - startedMs + waitMs > HARD_BUDGET_MS) break; // no budget to wait
          await sleep(waitMs);
        }
        if (!res || !res.ok) {
          ok = false;
          errMsg = `dune proxy HTTP ${res?.status ?? "no-response"} at offset ${offset}`;
          break;
        }
        const j = (await res.json()) as {
          result?: { rows?: Array<Record<string, unknown>> };
          next_offset?: number | null;
        };
        const rows = j.result?.rows ?? [];
        found += rows.length;
        rowsAllowance -= rows.length;
        dpAllowance -= rows.length * columnCount(rows);
        // Per PAGE, not per run: a run killed at maxDuration has still spent
        // every datapoint it bought, and a ledger written only at the end would
        // under-count exactly the runs that overspent.
        await recordDuneUsage({
          pipeline: PIPELINE_NAME,
          endpoint: "results",
          queryId,
          rows: rows.length,
          columns: columnCount(rows),
          httpStatus: res.status,
        });

        const mapped: OwnershipRow[] = [];
        for (const r of rows) {
          const m = mapDuneRow(r);
          if (m) mapped.push(m);
          else skipped++;
        }

        for (let i = 0; i < mapped.length; i += UPSERT_CHUNK) {
          const chunk = mapped.slice(i, i + UPSERT_CHUNK);
          const { error } = await supabaseAdmin
            .from("topshot_ownership")
            .upsert(chunk, { onConflict: "nft_id" });
          if (error) {
            ok = false;
            errMsg = `upsert: ${error.message}`;
            break;
          }
          written += chunk.length;
        }
        if (!ok) break;

        // Dune returns next_offset while more rows remain; a short page also
        // signals the end.
        if (rows.length < PAGE_LIMIT || j.next_offset == null) {
          exhausted = true;
          break;
        }
        offset = Number(j.next_offset);
        await sleep(INTER_PAGE_MS); // pace under Dune's per-minute rate cap
      }
    } catch (e) {
      ok = false;
      errMsg = `${errMsg ? errMsg + "; " : ""}threw: ${e instanceof Error ? e.message : String(e)}`;
    }

    // Honesty gate. The walk above deliberately falls through to the LAST cached
    // execution when the refresh fails, so the table is never emptied — but the
    // run then re-ingests data identical to the previous run and accomplishes
    // nothing. Reporting ok=true for that is a knowingly-wrong success: it is the
    // only signal this pipeline has (there is no cadence-watchlist row for it), so
    // a starved run would otherwise be invisible. Credit exhaustion surfaces here
    // as `execute HTTP 402` and is the case this exists for; a walk error still
    // wins the message because it is the more specific failure.
    const staleCache = refreshAttempted && !refreshed;
    if (staleCache) {
      ok = false;
      errMsg = errMsg ?? `stale cache: refresh did not complete (${refreshNote ?? "unknown"})`;
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
          offset_reached: offset,
          exhausted,
          refreshed,
          refresh_note: refreshNote,
          // `stale_cache` marks a run that served the previous execution's rows;
          // `refresh_http_status` separates the causes at a glance (402 = Dune
          // credits exhausted, 404 = dune-proxy worker missing /execute).
          stale_cache: staleCache,
          refresh_http_status: refreshStatus,
          duration_ms: Date.now() - startedMs,
          query_id: queryId,
          incremental_sets: batchSets.length > 0 ? batchSets : null,
          // Spend telemetry. `walk_skipped` names WHY a stale run bought
          // nothing; `budget_stopped` marks a run cut short by the day/cycle
          // cap. Both are absent (not 0/false-by-default) on a normal run, so
          // `extra_key_counts` in pipeline_runs_daily counts them directly.
          budget_datapoints_allowed: budget.datapointsAllowedNow,
          budget_datapoints_left: dpAllowance,
          budget_rows_allowed: budget.rowsAllowedNow,
          ...(walkSkip ? { walk_skipped: walkSkip } : {}),
          ...(budgetStopped ? { budget_stopped: true } : {}),
          ...(duneRowsHeld !== null ? { dune_rows_held: duneRowsHeld } : {}),
          ...(cachedTotalRows !== null ? { cached_total_rows: cachedTotalRows } : {}),
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
