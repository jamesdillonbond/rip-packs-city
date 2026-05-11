#!/usr/bin/env node
/**
 * scripts/detect-duplicate-cron-pipelines.mjs
 *
 * Diagnostic one-shot. Flags pipeline_runs entries that look like they're
 * being fired by two independent cron sources on offset schedules (e.g. one
 * legacy cron pointing at a deprecated Supabase edge function URL and a
 * second cron pointing at the current Vercel route). Both succeed; the
 * second one always finds zero rows because the first drained them. Pattern
 * surfaced 2026-05-11 around wmc-fmv-populate after a route migration.
 *
 * Does NOT mutate anything. Output-only. Trevor reviews the markdown table
 * and decides what to disable in cron-job.org.
 *
 * Usage:
 *   node scripts/detect-duplicate-cron-pipelines.mjs           # 4hr window
 *   node scripts/detect-duplicate-cron-pipelines.mjs --hours=8 # custom window
 *   node scripts/detect-duplicate-cron-pipelines.mjs --verbose # include all
 *                                                              # pipelines incl
 *                                                              # uniform cadence
 *
 * Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local or env.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

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
const verbose = args.includes("--verbose");
const hoursArg = args.find((a) => a.startsWith("--hours="));
const hours = hoursArg ? Number(hoursArg.slice("--hours=".length)) : 4;
if (!Number.isFinite(hours) || hours <= 0 || hours > 168) {
  console.error("--hours must be a positive number <= 168");
  process.exit(2);
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

// Fan-out tolerance. wallet-backfill-* pipelines fire ~240 rows in a ~5s
// burst from seed-wallet-refresh. Treat any rows within FAN_OUT_WINDOW_MS of
// each other as a single tick for cadence analysis.
const FAN_OUT_WINDOW_MS = 60_000;
// A pipeline needs at least this many distinct ticks in the window to be
// worth analyzing — fewer is too little signal to call bimodal.
const MIN_TICKS = 4;

async function fetchRuns(hours) {
  // PostgREST caps at 1000 rows. Use query_sql RPC for unbounded read.
  const { data, error } = await supabase.rpc("query_sql", {
    query: `
      SELECT pipeline, EXTRACT(EPOCH FROM started_at)::bigint AS ts
      FROM pipeline_runs
      WHERE started_at >= NOW() - INTERVAL '${hours} hours'
      ORDER BY pipeline, started_at
    `,
  });
  if (error) throw new Error(`query_sql failed: ${error.message}`);
  return data ?? [];
}

function clusterIntoTicks(epochs) {
  // Collapse rows within FAN_OUT_WINDOW_MS into a single tick keyed by the
  // first row's timestamp. Returns sorted array of tick-start epochs (sec).
  if (epochs.length === 0) return [];
  const sorted = [...epochs].sort((a, b) => a - b);
  const ticks = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if ((sorted[i] - ticks[ticks.length - 1]) * 1000 > FAN_OUT_WINDOW_MS) {
      ticks.push(sorted[i]);
    }
  }
  return ticks;
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stddev(arr) {
  const m = mean(arr);
  const v = arr.reduce((acc, x) => acc + (x - m) ** 2, 0) / arr.length;
  return Math.sqrt(v);
}

function classifyCadence(gaps) {
  // gaps[] in seconds. Looking for:
  //   - uniform: low CV, no two-mode structure
  //   - bimodal-suspect: two distinct gap clusters that alternate (likely
  //     duplicate cron offset from the primary). Detected by splitting gaps
  //     into "short" (<= median) and "long" (> median), checking that each
  //     half is tight (CV < 0.25), and that they sum to a coherent
  //     "implied cadence" close to the long-gap distance.
  //   - irregular: high CV but no clean two-mode structure (e.g. one-off
  //     jitter, manual retries).
  if (gaps.length < 3) return { kind: "insufficient", details: "<3 gaps" };

  const m = mean(gaps);
  const sd = stddev(gaps);
  const cv = m > 0 ? sd / m : 0;

  if (cv < 0.15) {
    return {
      kind: "uniform",
      details: `cadence≈${Math.round(m)}s, cv=${cv.toFixed(2)}`,
      implied_cadence_s: Math.round(m),
    };
  }

  const med = median(gaps);
  const shortHalf = gaps.filter((g) => g <= med);
  const longHalf = gaps.filter((g) => g > med);
  if (shortHalf.length < 2 || longHalf.length < 2) {
    return { kind: "irregular", details: `cv=${cv.toFixed(2)} insufficient split` };
  }

  const shortMean = mean(shortHalf);
  const longMean = mean(longHalf);
  const shortCv = mean(shortHalf) > 0 ? stddev(shortHalf) / mean(shortHalf) : 0;
  const longCv = mean(longHalf) > 0 ? stddev(longHalf) / mean(longHalf) : 0;
  const ratio = longMean / shortMean;

  // Bimodal signature: short + long gaps cluster tight in their own halves
  // and the ratio is roughly 2:1..4:1 (a duplicate cron offset by some
  // fraction of the parent cadence). This excludes uniform jitter (small
  // ratio) and pure noise (high CV within halves).
  if (shortCv < 0.25 && longCv < 0.25 && ratio >= 1.6 && ratio <= 4.5) {
    return {
      kind: "bimodal-suspect",
      details:
        `short≈${Math.round(shortMean)}s (${shortHalf.length} gaps, cv=${shortCv.toFixed(2)}), ` +
        `long≈${Math.round(longMean)}s (${longHalf.length} gaps, cv=${longCv.toFixed(2)}), ` +
        `ratio=${ratio.toFixed(2)}, implied_parent_cadence≈${Math.round(shortMean + longMean)}s`,
      implied_cadence_s: Math.round(shortMean + longMean),
    };
  }

  return { kind: "irregular", details: `cv=${cv.toFixed(2)} no clean bimodal split` };
}

function fmtCadence(seconds) {
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

async function main() {
  console.log(`# Duplicate-cron pipeline detection`);
  console.log(``);
  console.log(`- Window: past ${hours}h`);
  console.log(`- Fan-out clustering tolerance: ${FAN_OUT_WINDOW_MS / 1000}s`);
  console.log(`- Min ticks per pipeline: ${MIN_TICKS}`);
  console.log(``);

  const rows = await fetchRuns(hours);

  // Group by pipeline → array of epoch-seconds
  const byPipeline = new Map();
  for (const r of rows) {
    if (!byPipeline.has(r.pipeline)) byPipeline.set(r.pipeline, []);
    byPipeline.get(r.pipeline).push(Number(r.ts));
  }

  const results = [];
  for (const [pipeline, epochs] of byPipeline.entries()) {
    const ticks = clusterIntoTicks(epochs);
    if (ticks.length < MIN_TICKS) continue;
    const gaps = [];
    for (let i = 1; i < ticks.length; i++) gaps.push(ticks[i] - ticks[i - 1]);
    const klass = classifyCadence(gaps);
    results.push({
      pipeline,
      raw_runs: epochs.length,
      ticks: ticks.length,
      gaps,
      ...klass,
    });
  }

  results.sort((a, b) => {
    const order = { "bimodal-suspect": 0, irregular: 1, uniform: 2, insufficient: 3 };
    return (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || b.raw_runs - a.raw_runs;
  });

  const suspects = results.filter((r) => r.kind === "bimodal-suspect");

  console.log(`## Suspects (bimodal cadence — likely duplicate cron)`);
  console.log(``);
  if (suspects.length === 0) {
    console.log(`_None._ All analyzed pipelines fire on a uniform cadence or show only irregular jitter.`);
  } else {
    console.log(`| Pipeline | Runs | Ticks | Short gap | Long gap | Implied parent cadence |`);
    console.log(`|---|---:|---:|---|---|---|`);
    for (const s of suspects) {
      const med = median(s.gaps);
      const shortHalf = s.gaps.filter((g) => g <= med);
      const longHalf = s.gaps.filter((g) => g > med);
      console.log(
        `| \`${s.pipeline}\` | ${s.raw_runs} | ${s.ticks} | ` +
          `${fmtCadence(Math.round(mean(shortHalf)))} | ` +
          `${fmtCadence(Math.round(mean(longHalf)))} | ` +
          `${fmtCadence(s.implied_cadence_s)} |`
      );
    }
    console.log(``);
    console.log(`### Diagnostic detail`);
    console.log(``);
    for (const s of suspects) {
      console.log(`- **${s.pipeline}** — ${s.details}`);
    }
  }
  console.log(``);

  console.log(`## All analyzed pipelines`);
  console.log(``);
  console.log(`| Pipeline | Cadence kind | Runs | Ticks | Details |`);
  console.log(`|---|---|---:|---:|---|`);
  for (const r of results) {
    if (!verbose && r.kind === "uniform") continue;
    console.log(`| \`${r.pipeline}\` | ${r.kind} | ${r.raw_runs} | ${r.ticks} | ${r.details} |`);
  }
  if (!verbose) {
    const uniformCount = results.filter((r) => r.kind === "uniform").length;
    if (uniformCount > 0) {
      console.log(``);
      console.log(`_${uniformCount} uniform-cadence pipeline(s) suppressed. Pass \`--verbose\` to include._`);
    }
  }
  console.log(``);
  console.log(`## Notes`);
  console.log(``);
  console.log(`- Fan-out pipelines (e.g. \`wallet-backfill-*\`) that fire many rows in a <${FAN_OUT_WINDOW_MS / 1000}s burst per tick are collapsed into a single tick before cadence analysis. The "Runs" column is raw row count; "Ticks" is the deduplicated tick count.`);
  console.log(`- Bimodal-suspect is a *signal*, not a verdict. Confirm by checking cron-job.org for duplicate entries pointing at the same pipeline (e.g. legacy Supabase edge function URL + current Vercel route).`);
  console.log(`- Uniform cadence with no fan-out is the expected shape for most pipelines.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
