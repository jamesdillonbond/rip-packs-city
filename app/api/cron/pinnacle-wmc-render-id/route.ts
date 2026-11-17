// app/api/cron/pinnacle-wmc-render-id/route.ts
//
// Keeps wallet_moments_cache Pinnacle rows resolved to their true per-pin
// render_id. New pins enter wmc via the wallet-backfill Cadence walk keyed on
// the set-level edition_key (which collapses distinct characters); this route
// names them by NFT id (= wmc.moment_id), then derives character/set/mint/image
// from pinnacle_catalog.
//
// ⭐ 2026-11-08 (handoff pinnacle-wmc-render-gap): the lookup is now
// lib/pinnacle/render-lookup.ts — RPC's OWN mint records (pinnacle_mint_events,
// nft_id → render_id from the chain's PinNFTMinted events) FIRST, Dapper's
// studio-platform search only for pins our mint index lacks. Before, only the
// search was asked, it answered nothing for a backlog of pins, and the lane
// logged ok:true every hour while resolving 0 of 972 (rows_found 972 /
// rows_written 0). It now reports per-source counts and the ids neither source
// could name, and a BACKLOG that resolves nothing fails the run (see
// STUCK_BACKLOG) instead of reading as a quiet success.
//
// Targets rows where render_id IS NULL (newly-acquired pins). The 2026-06-06
// bulk re-key was done by scripts/remap-pinnacle-wmc.mjs.
//
// Bearer auth on INGEST_SECRET_TOKEN. Cron: hourly (cron-job.org).
//
// 2026-06-10 (DBSAT residual fix): previously this ran fully synchronously and
// the FIRST thing it did was the candidate `.select(... limit 2000)`. Under
// connection-pool saturation that select hit the 8s authenticator
// statement_timeout and the route returned HTTP 500 BEFORE log_pipeline_run —
// so pipeline_runs went blind (no row since 09:37Z) even though the cron fired
// fine. It also did up to ~8 GQL chunks × 20s of work under a 60s maxDuration,
// overrunning cron-job.org's 30s client cap. Now: auth stays sync, we return
// 202 immediately, ALL work (incl. the candidate select) runs in after() with
// a wider maxDuration, and log_pipeline_run fires on EVERY path — including the
// candidate-query error path, where it logs the real PG error (mirrors the
// d4b058f fmv-recalc step3 observability pattern).

import { NextRequest, NextResponse, after } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { tokenMatches } from "@/lib/auth/bearer-secret"
import { resolvePinnacleRenderIds } from "@/lib/pinnacle/render-lookup"

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
) as any;

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? "";
const PIPELINE_NAME = "pinnacle-wmc-render-id";
const PINNACLE_COLLECTION_ID = "7dd9dd11-e8b6-45c4-ac99-71331f959714";
const USER_AGENT = "rip-packs-city/pinnacle-wmc-render-id";
// Candidate batch for the wmc render_id drain below.
//
// ⚠ WAS 2000, WHICH WAS NEVER A BOUND (corrected 2026-09-11). The read at the
// bottom of this file is a plain PostgREST select, and PostgREST CLAMPS an
// explicit .limit() above 1,000 down to 1,000 — silently, with nothing in the
// response distinguishing a complete result from a truncated one. So this
// constant claimed a batch the server would never return, and because it is a
// NAME rather than a literal, the tree-walking guard for that class
// (__tests__/postgrest-limit-above-the-cap-is-a-false-bound.test.ts) could not
// see it: its own header recorded "only literals can be judged statically".
// This was the live instance that closed that gap; the guard now resolves
// same-file numeric constants.
//
// ⭐ SIZED BEFORE CHANGING, because a site is not a defect: the candidate pool
// (disney_pinnacle wallet_moments_cache rows with render_id IS NULL) measured
// **5 rows out of 56,646** on 2026-09-11, and the lane runs 24x/day resolving
// 5-65 rows/day with zero failures. So the clamp has had NO effect and this is
// a truth-in-source fix, not a behaviour change — 1,000 is what the server was
// already returning. It also keeps ~200x headroom against the pool, and stays
// correct in the one scenario that could refill it (a bulk re-key like
// scripts/remap-pinnacle-wmc.mjs): 1,000/tick x 24 ticks drains 56,646 in
// ~2.4 days, where a paging rewrite would instead put 56k GQL lookups inside a
// single tick's maxDuration.
const CAP = 1000;
// Ongoing sales render_id drain (Q2): keep new pinnacle_sales rows from sitting
// unresolved more than a tick. The one-time bulk drain is the admin route
// /api/admin/backfill-pinnacle-sales-render-id; this just chases the trickle.
const SALES_CAP = 1000;
// A run that finds at least this many unresolved pins and names NONE of them is
// a stuck lane, not a quiet hour: it fails (2026-11-08, the 972/0 case). A few
// stragglers neither source knows stay visible in extra.unresolvable without
// turning the lane permanently red.
const STUCK_BACKLOG = 50;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const tokenQuery = req.nextUrl.searchParams.get("token") ?? "";
  if (!TOKEN || (!tokenMatches(bearer, "INGEST_SECRET_TOKEN") && !tokenMatches(tokenQuery, "INGEST_SECRET_TOKEN"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const started = Date.now();
  const startedAtIso = new Date(started).toISOString();

  // Always emit exactly one pipeline_runs row, even on the candidate-query
  // failure path that used to return a dead 500.
  async function logRun(args: {
    ok: boolean;
    error: string | null;
    rowsFound: number;
    resolved: number;
    extra: Record<string, unknown>;
  }) {
    try {
      await supabaseAdmin.rpc("log_pipeline_run", {
        p_pipeline: PIPELINE_NAME,
        p_started_at: startedAtIso,
        p_rows_found: args.rowsFound,
        p_rows_written: args.resolved,
        p_rows_skipped: 0,
        p_ok: args.ok,
        p_error: args.error,
        p_collection_slug: "disney_pinnacle",
        p_cursor_before: null,
        p_cursor_after: null,
        p_extra: { ...args.extra, duration_ms: Date.now() - started },
      });
    } catch {
      // best-effort
    }
  }

  after(async () => {
    // Pull unresolved Pinnacle wmc rows (new pins). This is the statement that
    // timed out under saturation; now its failure is logged, not swallowed
    // into a 500.
    const { data: rows, error } = await supabaseAdmin
      .from("wallet_moments_cache")
      .select("moment_id")
      .eq("collection_id", PINNACLE_COLLECTION_ID)
      .is("render_id", null)
      .limit(CAP);
    if (error) {
      await logRun({
        ok: false,
        error: `candidate_read: ${error.message}`,
        rowsFound: 0,
        resolved: 0,
        extra: { stage: "candidate_read", saturation_suspect: true },
      });
      console.warn(`[${PIPELINE_NAME}] candidate read failed: ${error.message}`);
      return;
    }
    const ids = [...new Set((rows ?? []).map((r: { moment_id: string }) => r.moment_id))] as string[];

    const look = await resolvePinnacleRenderIds(supabaseAdmin, ids, { userAgent: USER_AGENT });
    let gqlErrors = look.gqlErrors;

    let resolved = 0;
    // resolved counts rows the update LANDED on (.select), never rows attempted:
    // the update is fill-only (.is("render_id", null)), so a row a concurrent
    // writer already filled changes nothing and must not count (2026-09-26).
    let writeErrors = 0;
    let writeError: string | null = null;
    for (const [nftId, hit] of look.hits) {
      const { data: landed, error: upErr } = await supabaseAdmin
        .from("wallet_moments_cache")
        .update({
          render_id: hit.render_id,
          ...(hit.serial != null ? { serial_number: hit.serial } : {}),
        })
        .eq("collection_id", PINNACLE_COLLECTION_ID)
        .eq("moment_id", nftId)
        .is("render_id", null)
        .select("moment_id");
      if (upErr) {
        writeErrors++;
        writeError = writeError ?? upErr.message;
        continue;
      }
      resolved += Array.isArray(landed) ? landed.length : 0;
    }

    // Derive character/set/mint/image from the catalog for everything just resolved.
    // derived is the RPC's own row count, never `resolved` restated.
    let derived = 0;
    let deriveError: string | null = null;
    if (resolved > 0) {
      const { data: derCount, error: derErr } = await supabaseAdmin.rpc("derive_pinnacle_wmc_from_catalog");
      if (derErr) deriveError = derErr.message;
      else derived = typeof derCount === "number" ? derCount : 0;
    }

    // Q2 — drain a small batch of unresolved pinnacle_sales render_ids (same lookup).
    // It never STOPS the wmc work above, but a failed sales read or write is not
    // a success: it is recorded in sales_error and fails the run (2026-09-26 —
    // the RPC's error was never read, so a broken lane reported ok:true).
    let salesResolved = 0;
    let salesUpdated = 0;
    let salesFromMintRecords = 0;
    let salesError: string | null = null;
    let salesMintReadError: string | null = null;
    try {
      const { data: salesIdsData, error: salesReadErr } = await supabaseAdmin.rpc(
        "pinnacle_sales_unresolved_render_nft_ids",
        { p_limit: SALES_CAP },
      );
      if (salesReadErr) throw new Error(`read: ${salesReadErr.message}`);
      const salesIds = [...new Set(((salesIdsData ?? []) as string[]).filter(Boolean))];
      if (salesIds.length > 0) {
        const s = await resolvePinnacleRenderIds(supabaseAdmin, salesIds, { userAgent: USER_AGENT });
        gqlErrors += s.gqlErrors;
        salesMintReadError = s.mintReadError;
        salesFromMintRecords = s.fromMintRecords;
        const map: Record<string, string> = {};
        for (const [id, hit] of s.hits) map[id] = hit.render_id;
        const keys = Object.keys(map);
        salesResolved = keys.length;
        if (keys.length > 0) {
          const { data: cnt, error: setErr } = await supabaseAdmin.rpc("pinnacle_sales_set_render_ids", { p_map: map });
          if (setErr) salesError = `write: ${setErr.message}`;
          else salesUpdated = typeof cnt === "number" ? cnt : 0;
        }
      }
    } catch (e) {
      salesError = salesError ?? (e instanceof Error ? e.message : String(e));
    }

    const stuck = ids.length >= STUCK_BACKLOG && resolved === 0;
    const errors = [
      look.mintReadError ? `mint records read: ${look.mintReadError}` : null,
      salesMintReadError ? `sales mint records read: ${salesMintReadError}` : null,
      gqlErrors > 0 ? `${gqlErrors} gql chunk errors` : null,
      writeError ? `wmc write (${writeErrors}): ${writeError}` : null,
      deriveError ? `derive: ${deriveError}` : null,
      salesError ? `sales: ${salesError}` : null,
      stuck ? `stuck: ${ids.length} unresolved pins, 0 named (mint records ${look.fromMintRecords}, gql ${look.fromGql}, unresolvable ${look.unresolvable.length})` : null,
    ].filter(Boolean) as string[];

    await logRun({
      ok: errors.length === 0,
      error: errors.length ? errors.join(" | ") : null,
      rowsFound: ids.length,
      resolved,
      extra: {
        unresolved_found: ids.length,
        resolved,
        from_mint_records: look.fromMintRecords,
        from_gql: look.fromGql,
        unresolvable: look.unresolvable.length,
        unresolvable_sample: look.unresolvable.slice(0, 10),
        mint_read_error: look.mintReadError,
        stuck,
        write_errors: writeErrors,
        write_error: writeError,
        derived,
        derive_error: deriveError,
        sales_resolved: salesResolved,
        sales_from_mint_records: salesFromMintRecords,
        sales_updated: salesUpdated,
        sales_error: salesError,
        gql_errors: gqlErrors,
      },
    });
  });

  return NextResponse.json(
    { accepted: true, pipeline: PIPELINE_NAME, started_at: startedAtIso },
    { status: 202 },
  );
}
