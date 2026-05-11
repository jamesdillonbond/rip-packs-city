#!/usr/bin/env node
/**
 * scripts/cleanup-wmc-int-orphans.mjs
 *
 * One-shot drain of wallet_moments_cache rows whose edition_key still
 * carries the legacy "set:play" integer format. Calls the SECDEF RPC
 * wmc_edition_key_drain_v3(p_limit=5000) in a loop until rows_migrated=0.
 *
 * Usage:
 *   node scripts/cleanup-wmc-int-orphans.mjs              # full drain
 *   node scripts/cleanup-wmc-int-orphans.mjs --dry-run    # report-only, no writes
 *
 * Why this exists:
 *   The migrate-wmc-edition-keys Vercel route still works (it wraps the same
 *   RPC) but the cron-job.org schedule that calls it has been Inactive since
 *   2026-05-10 ~05:30. While Trevor re-enables the cron entry on his side,
 *   this script is the manual one-shot path to drain the queue from a
 *   workstation without re-deploying.
 *
 * Logs the run to pipeline_runs as 'wmc-int-orphan-final-cleanup' so
 * pipeline_cadence_watchlist sees the action.
 *
 * Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local OR from
 * process.env when run from a CI/Docker context.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

// ── Self-parse .env.local ───────────────────────────────────────────────────
try {
  const raw = readFileSync(".env.local", "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
} catch {}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const BATCH_SIZE = 5000;
const MAX_ITERATIONS = 100; // safety bound — even 1M orphans cap at 200 iters

async function getRemainingCount() {
  const { data, error } = await supabase.rpc("query_sql", {
    query: `SELECT COUNT(*)::bigint AS cnt FROM wallet_moments_cache WHERE edition_key ~ '^[0-9]+:[0-9]+$'`,
  });
  if (error) throw new Error(`count query failed: ${error.message}`);
  return Number(data?.[0]?.cnt ?? 0);
}

async function main() {
  const startedAtMs = Date.now();
  const startedAtIso = new Date(startedAtMs).toISOString();
  const startingCount = await getRemainingCount();
  console.log(`[cleanup-wmc-int-orphans] starting count: ${startingCount}${dryRun ? " (DRY RUN — no writes)" : ""}`);

  if (dryRun) {
    console.log("[cleanup-wmc-int-orphans] dry-run — exiting without invoking the drain RPC.");
    return;
  }

  if (startingCount === 0) {
    console.log("[cleanup-wmc-int-orphans] queue already empty — nothing to do.");
    return;
  }

  let totalMigrated = 0;
  let iter = 0;
  let lastRemaining = startingCount;
  while (iter < MAX_ITERATIONS) {
    iter++;
    const { data, error } = await supabase.rpc("wmc_edition_key_drain_v3", { p_limit: BATCH_SIZE });
    if (error) throw new Error(`drain RPC failed iter=${iter}: ${error.message}`);
    const migrated = Number(data?.rows_migrated ?? 0);
    const remaining = Number(data?.wmc_int_remaining_orphans ?? 0);
    totalMigrated += migrated;
    lastRemaining = remaining;
    console.log(`[cleanup-wmc-int-orphans] iter=${iter} migrated=${migrated} remaining=${remaining}`);
    if (migrated === 0) break;
  }

  if (iter >= MAX_ITERATIONS) {
    console.warn(`[cleanup-wmc-int-orphans] hit MAX_ITERATIONS=${MAX_ITERATIONS} with remaining=${lastRemaining}`);
  }

  // Log to pipeline_runs (best-effort).
  try {
    await supabase.rpc("log_pipeline_run", {
      p_pipeline: "wmc-int-orphan-final-cleanup",
      p_started_at: startedAtIso,
      p_rows_found: startingCount,
      p_rows_written: totalMigrated,
      p_rows_skipped: lastRemaining,
      p_ok: lastRemaining === 0,
      p_error: lastRemaining === 0 ? null : `${lastRemaining} orphans still in queue after ${iter} iters`,
      p_collection_slug: "nba_top_shot",
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: {
        mode: "one_shot_script",
        algo_version: "drain-v3-external-id",
        iterations: iter,
        wmc_int_remaining_orphans: lastRemaining,
        duration_ms: Date.now() - startedAtMs,
      },
    });
  } catch (err) {
    console.warn(`[cleanup-wmc-int-orphans] log_pipeline_run failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log(
    `[cleanup-wmc-int-orphans] done. starting=${startingCount} migrated=${totalMigrated} remaining=${lastRemaining} iters=${iter} duration_ms=${Date.now() - startedAtMs}`
  );
}

main().catch((err) => {
  console.error(`[cleanup-wmc-int-orphans] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
