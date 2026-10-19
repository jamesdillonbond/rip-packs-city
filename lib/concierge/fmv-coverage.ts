// lib/concierge/fmv-coverage.ts
//
// LIVE FMV coverage per collection for the concierge system prompt.
//
// The prompt used to carry hardcoded lines — "LaLiga Golazos: 12.9% (75/581)",
// "Disney Pinnacle: 86% (367/425)" — written months ago and quoted to users as
// current. Every figure in this repo is a dated sample (CLAUDE.md), and the
// concierge is the one surface that speaks them out loud, so it reads them.
//
// Source: `edition_fmv_current` (the per-edition latest-snapshot table, ~21k
// rows, one indexed head-count per collection per metric — measured 2026-09-13:
// 909 buffers for the whole-table aggregate, so a handful of index counts is
// cheap) plus `pinnacle_catalog`, which prices per render on its own pipeline.
// ⚠ Its comment says "for ORDERING and bulk aggregation only — never the
// displayed price". A coverage SHARE is bulk aggregation; no price is read.
//
// The headline metric is the share of editions priced at HIGH or MEDIUM
// confidence — the roadmap's accuracy gate — because "has an FMV row" is ~100%
// everywhere (every edition gets a snapshot, many at LOW / ASK_ONLY / NO_DATA)
// and would tell a collector nothing about how much to trust the number.
//
// ⚠ HONESTY: a failed count is `null`, never 0 (supabase-js RETURNS errors, so
// `{ count: null, error }` is the failure shape and `?? 0` would publish a
// measured zero). A collection whose read failed renders as "coverage read
// failed" and the prompt tells the model not to quote a figure for it.
//
// Cached in module scope for COVERAGE_TTL_MS — the numbers move on a pipeline
// cadence of hours, and a per-request read would be the concierge's own load.

import { publishedCollections } from "@/lib/collections";

export type CoverageRow = {
  collection: string;
  editions: number | null;
  /** Editions with a numeric FMV (any confidence). */
  priced: number | null;
  /** Editions at HIGH or MEDIUM confidence. */
  high_med: number | null;
  high_med_pct: number | null;
  read_failed: boolean;
};

export type CoverageResult = {
  status: "ok" | "error";
  measured_at: string;
  rows: CoverageRow[];
};

export const COVERAGE_TTL_MS = 30 * 60 * 1000;

// Collections priced through edition_fmv_current: every PUBLISHED registry entry
// with a DB uuid, except Disney Pinnacle, which prices per render on
// pinnacle_catalog (readPinnacle below).
// ⚠ 2026-10-18 (Cowork QA): this was a hand list of four Flow collections beside
// the registry, so Candy MLB (published 09-08) and Panini (published 09-25) were
// never measured — and the model, given no figure, told a collector "Candy MLB FMV
// coverage is at LOW confidence across the board" while 61 of its 125 editions
// were HIGH/MEDIUM. A hardcoded allowlist beside a registry goes stale silently
// (CLAUDE.md); resolve through the registry instead.
const PINNACLE_UUID = "7dd9dd11-e8b6-45c4-ac99-71331f959714";
export function snapshotCollections(): Array<{ label: string; uuid: string }> {
  return publishedCollections()
    .filter((c) => !!c.supabaseCollectionId && c.supabaseCollectionId !== PINNACLE_UUID)
    .map((c) => ({ label: c.label, uuid: c.supabaseCollectionId as string }));
}

type CountResult = PromiseLike<{ count: number | null; error: { message: string } | null }>;
type CountQuery = CountResult & {
  eq: (col: string, v: string) => CountQuery;
  not: (col: string, op: string, v: null) => CountQuery;
  in: (col: string, v: string[]) => CountQuery;
};
type Sb = { from: (t: string) => { select: (cols: string, opts: { count: "exact"; head: true }) => CountQuery } };

async function headCount(build: () => CountResult): Promise<number | null> {
  try {
    const { count, error } = await build();
    if (error) return null;
    return typeof count === "number" ? count : null;
  } catch {
    return null;
  }
}

function pct(part: number | null, whole: number | null): number | null {
  if (part == null || whole == null || whole <= 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}

async function readSnapshotCollection(supabase: Sb, label: string, uuid: string): Promise<CoverageRow> {
  // Denominator is the snapshot table itself (every edition gets a row; a
  // missing one means "not yet refreshed" per its comment) rather than
  // `editions`, so this read shares no table with the price tools' own reads.
  const [editions, priced, highMed] = await Promise.all([
    headCount(() => supabase.from("edition_fmv_current").select("edition_id", { count: "exact", head: true }).eq("collection_id", uuid)),
    headCount(() =>
      supabase.from("edition_fmv_current").select("edition_id", { count: "exact", head: true }).eq("collection_id", uuid).not("fmv_usd", "is", null),
    ),
    headCount(() =>
      supabase.from("edition_fmv_current").select("edition_id", { count: "exact", head: true }).eq("collection_id", uuid).in("confidence", ["HIGH", "MEDIUM"]),
    ),
  ]);
  return {
    collection: label,
    editions,
    priced,
    high_med: highMed,
    high_med_pct: pct(highMed, editions),
    read_failed: editions == null || priced == null || highMed == null,
  };
}

async function readPinnacle(supabase: Sb): Promise<CoverageRow> {
  const [renders, priced, highMed] = await Promise.all([
    headCount(() => supabase.from("pinnacle_catalog").select("render_id", { count: "exact", head: true })),
    headCount(() => supabase.from("pinnacle_catalog").select("render_id", { count: "exact", head: true }).not("fmv_usd", "is", null)),
    headCount(() => supabase.from("pinnacle_catalog").select("render_id", { count: "exact", head: true }).in("fmv_confidence", ["HIGH", "MEDIUM"])),
  ]);
  return {
    collection: "Disney Pinnacle (per render)",
    editions: renders,
    priced,
    high_med: highMed,
    high_med_pct: pct(highMed, renders),
    read_failed: renders == null || priced == null || highMed == null,
  };
}

/** Uncached read. Prefer readFmvCoverageCached in request paths. */
export async function readFmvCoverage(supabase: Sb): Promise<CoverageResult> {
  const rows = await Promise.all([
    ...snapshotCollections().map((c) => readSnapshotCollection(supabase, c.label, c.uuid)),
    readPinnacle(supabase),
  ]);
  const allFailed = rows.every((r) => r.read_failed);
  return { status: allFailed ? "error" : "ok", measured_at: new Date().toISOString(), rows };
}

let cache: { at: number; result: CoverageResult } | null = null;
let inflight: Promise<CoverageResult> | null = null;

export function _resetCoverageCacheForTests(): void {
  cache = null;
  inflight = null;
}

/**
 * Cached read with a hard time budget. A slow DB must never delay a chat turn:
 * past `budgetMs` the caller gets `null` (and the prompt says coverage was not
 * measured this turn) while the read keeps running to warm the cache.
 * A fully-failed read is NOT cached — the next turn retries.
 */
export async function readFmvCoverageCached(
  supabase: Sb,
  opts: { now?: number; budgetMs?: number; ttlMs?: number } = {},
): Promise<CoverageResult | null> {
  const now = opts.now ?? Date.now();
  const ttl = opts.ttlMs ?? COVERAGE_TTL_MS;
  if (cache && now - cache.at < ttl) return cache.result;
  if (!inflight) {
    inflight = readFmvCoverage(supabase)
      .then((r) => {
        if (r.status === "ok") cache = { at: Date.now(), result: r };
        return r;
      })
      .finally(() => {
        inflight = null;
      });
  }
  const budget = opts.budgetMs ?? 2500;
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), budget));
  return Promise.race([inflight, timeout]);
}

function fmtInt(n: number | null): string {
  return n == null ? "?" : n.toLocaleString("en-US");
}

/** The prompt block. Pure — testable without a client. */
export function formatCoverageForPrompt(result: CoverageResult | null, nowMs: number = Date.now()): string {
  const head = "\n## Live FMV coverage (measured from the database";
  if (!result || result.status === "error") {
    return `${head} — READ FAILED this turn)\nCoverage could not be measured. Do NOT quote a coverage percentage for any collection; answer from the confidence on each tool row instead.`;
  }
  const ageMin = Math.max(0, Math.round((nowMs - new Date(result.measured_at).getTime()) / 60000));
  const lines = result.rows.map((r) => {
    if (r.read_failed) return `- ${r.collection}: coverage read failed — do not quote a figure for this collection.`;
    return `- ${r.collection}: ${fmtInt(r.editions)} editions, ${fmtInt(r.priced)} carry an FMV, ${r.high_med_pct ?? "?"}% (${fmtInt(r.high_med)}) at HIGH/MEDIUM confidence`;
  });
  return `${head}, ${ageMin} min ago)\n${lines.join("\n")}\nThese are the ONLY coverage figures you may quote, and quote them as "as of this reading". The HIGH/MEDIUM share is what "coverage" means on RPC — an edition can carry an FMV row at LOW / ASK_ONLY / NO_DATA that is directional at best. Where the HIGH/MEDIUM share is under 50%, proactively note the limitation and lean on floor + recent-sales context.`;
}
