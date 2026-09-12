// app/api/profile/collection-stats/route.ts
//
// Returns per-collection stats for a single wallet.
//
// ⭐ CACHE-FIRST since 2026-09-12, and that is a correctness fix, not a speed
// tweak. The live path — `get_wallet_collection_stats`, which aggregates
// `wallet_moments_cache` in real time — CANNOT COMPLETE for a large wallet:
// it carries `statement_timeout=20s` and its first CTE alone measures 43.5 s on
// 0xbd94cade097e50ac (19,520 Moments). Production returned `503 stats_timeout`
// at `elapsed_ms 20135` on every single call, so the dashboard's only source of
// portfolio numbers was a route that always failed.
//
// ⛔ AND IT IS NOT AN INDEXING PROBLEM — do not "fix" it with an index. The
// covering index already exists and the planner already picks it:
//     Index Only Scan using idx_wmc_wallet_coll_ek_fmv … Heap Fetches: 6066
//     Buffers: shared hit=11466 read=4653 … Execution Time: 26306 ms
// 4,653 cold blocks in 26 s is ~1.4 MB/s, and the table is NOT bloated (1.3%
// dead tuples, autovacuumed 14 minutes before that reading). That is the
// Small-compute IO budget CLAUDE.md warns about; another index only adds write
// amplification to the thing that is already the bottleneck.
//
// So we read what has ALREADY been computed. `aggregate_saved_wallet_stats`
// produces the same figures — including the STALE split — at ~335 ms, and
// writes them to `saved_wallets.cached_*` hourly via
// `reconcile_all_saved_wallet_stats` (pg_cron job 259). Those columns were
// correct the whole time the dashboard was rendering "$0": measured 2026-09-12,
// cached counts matched `wallet_moments_cache` to within ~0.1%.
//
// THE CACHE IS LATE, NOT WRONG — so the answer carries `cache_updated_at` and
// the caller stamps it. A number with an "as of" is honest; the same number
// presented as live is not.
//
// The live RPC stays as the fallback for a wallet with NO cached row yet (a
// wallet saved moments ago, before the reconciler has reached it). Those are
// small by definition — the reconciler warms them within the hour — so the
// timeout that makes the live path useless for whales does not bite here.
//
// ⚠ `covered_collection_ids` is load-bearing and is the reason this route does
// not zero-fill. A cached read only covers collections the wallet has a
// `saved_wallets` row for, and a MISSING row is not a zero: measured the same
// day, six wallets had no `ufc_strike` row at all (they predate UFC joining
// SEED_SLUGS) while three of them held 247, 61 and 18 UFC Moments. Zero-filling
// would have published "0 Moments" about a $1,547 collection. The caller renders
// an uncovered collection as unknown, never as empty.
//
// Public read by design: collection holdings are not sensitive and the profile
// page calls this once per saved wallet on every load. No user_id is returned.

import { NextRequest, NextResponse } from "next/server";
import { safeApiError, statusForSafeError } from "@/lib/api-error";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { normalizeAddress } from "@/lib/address";

export const dynamic = "force-dynamic";
// MUST stay above the RPC's own statement_timeout (20s as of
// audit_20260806_get_wallet_collection_stats_drop_fmv_current_scan) or the lambda
// dies first on a cold whale wallet and the caller never sees the 57014 -> 503.
export const maxDuration = 30;

interface StatRow {
  collection_id: string;
  collection_slug: string;
  collection_label: string;
  moment_count: number;
  fmv_total: number;
  fmv_stale_total: number;
  stale_count: number;
  fmv_max: number;
  priced_count: number;
  locked_count: number;
  top_tier: string | null;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export async function GET(req: NextRequest) {
  const started = Date.now();
  const walletAddrRaw = req.nextUrl.searchParams.get("wallet_addr");
  if (!walletAddrRaw) {
    return NextResponse.json({ error: "wallet_addr required" }, { status: 400 });
  }
  // normalizeAddress, NOT toLowerCase — base58 is case-sensitive, so
  // lowercasing a Candy (Solana) address makes it match no stored row.
  const walletAddr = normalizeAddress(walletAddrRaw);

  // ── 1. The precomputed answer ────────────────────────────────────────────
  // A failure here is NOT fatal: fall through to the live RPC rather than fail
  // the request, so a hiccup on this read degrades to "slower" and not to "no
  // numbers at all".
  let cached: StatRow[] | null = null;
  let cacheStamp: string | null = null;
  try {
    const { data: rows, error } = await supabase
      .from("saved_wallets")
      .select(
        "collection_id, cached_moment_count, cached_fmv_usd, cached_fmv_stale_usd, cached_stale_count, cached_top_tier, cache_updated_at, collections(slug, name)"
      )
      .eq("wallet_addr", walletAddr)
      .not("cache_updated_at", "is", null);

    if (error) {
      console.warn(
        "[profile/collection-stats] cache_read_failed wallet=" + walletAddr +
          " msg=" + (error.message ?? "").slice(0, 200)
      );
    } else if (rows && rows.length > 0) {
      // The same wallet can be saved by more than one account, so there can be
      // several rows per collection. Keep the freshest; they are computed from
      // the wallet, not the account, so they only differ by staleness.
      const byCollection = new Map<string, StatRow>();
      let oldest: string | null = null;
      for (const r of rows as unknown as Record<string, any>[]) {
        const id = String(r.collection_id);
        const stamp: string | null = r.cache_updated_at ?? null;
        const existing = byCollection.get(id);
        const prevStamp = existing ? (existing as any).__stamp : null;
        if (existing && prevStamp && stamp && prevStamp >= stamp) continue;

        const coll = Array.isArray(r.collections) ? r.collections[0] : r.collections;
        // `cached_fmv_usd` is the TOTAL including stale-priced Moments; the
        // dashboard headline excludes them. The 2026-09-02 migration that added
        // the split states this contract explicitly: headline = total - stale.
        const total = num(r.cached_fmv_usd);
        const stale = num(r.cached_fmv_stale_usd);
        const row = {
          collection_id: id,
          collection_slug: String(coll?.slug ?? ""),
          collection_label: String(coll?.name ?? ""),
          moment_count: num(r.cached_moment_count),
          fmv_total: Math.max(0, total - stale),
          fmv_stale_total: stale,
          stale_count: num(r.cached_stale_count),
          // ⚠ NOT CACHED, and 0 is the honest value for these three rather than
          // a guess: the card only renders "Top $X" / "🔒 N" when they are > 0,
          // so a zero suppresses the line instead of publishing a wrong one.
          fmv_max: 0,
          priced_count: 0,
          locked_count: 0,
          top_tier: r.cached_top_tier ?? null,
          __stamp: stamp,
        } as StatRow & { __stamp: string | null };
        byCollection.set(id, row);
        if (stamp && (oldest === null || stamp < oldest)) oldest = stamp;
      }
      cached = [...byCollection.values()].map((r) => {
        const { ...rest } = r as StatRow & { __stamp?: string | null };
        delete (rest as Record<string, unknown>).__stamp;
        return rest as StatRow;
      });
      cacheStamp = oldest;
    }
  } catch (err) {
    console.warn(
      "[profile/collection-stats] cache_read_threw wallet=" + walletAddr +
        " msg=" + (err instanceof Error ? err.message : String(err)).slice(0, 200)
    );
  }

  if (cached && cached.length > 0) {
    return NextResponse.json({
      wallet_addr: walletAddr,
      stats: cached,
      source: "cache",
      // ⚠ The OLDEST stamp across the returned rows, not the newest. The caller
      // renders one "as of" for the whole card, and the honest one is the age of
      // the least fresh number in it.
      cache_updated_at: cacheStamp,
      covered_collection_ids: cached.map((r) => r.collection_id),
      elapsed_ms: Date.now() - started,
    });
  }

  // ── 2. No cached row yet — compute it live ───────────────────────────────
  try {
    const { data, error } = await supabase.rpc("get_wallet_collection_stats", {
      p_wallet_addr: walletAddr,
    });

    const elapsedMs = Date.now() - started;

    if (error) {
      const code = (error as { code?: string }).code ?? null;
      const status = (error as { status?: number }).status ?? null;
      console.error(
        "[profile/collection-stats] rpc_error wallet=" + walletAddr +
          " code=" + code + " status=" + status +
          " elapsed_ms=" + elapsedMs +
          " msg=" + (error.message ?? "").slice(0, 300)
      );
      // Statement_timeout exhaustion shows up as code 57014 — surface as 503
      // so callers retry rather than treating it like a hard 500.
      if (code === "57014") {
        return NextResponse.json(
          { error: "stats_timeout", retry: true, wallet_addr: walletAddr, elapsed_ms: elapsedMs },
          { status: 503 }
        );
      }
      // The 57014 branch above is the good case: it already classifies. This
      // one published the driver message AND the raw SQLSTATE. Both are
      // internal detail — the full text is already in the console.error above,
      // which is where it belongs. `safe.code` is our own stable vocabulary
      // ("timeout" | "internal" | …), so the key survives for clients that
      // branch on it while the Postgres code stops being published.
      const safe = safeApiError(error);
      return NextResponse.json(
        { ...safe, wallet_addr: walletAddr, elapsed_ms: elapsedMs },
        { status: statusForSafeError(safe) }
      );
    }

    const stats = (data ?? []) as StatRow[];
    return NextResponse.json({
      wallet_addr: walletAddr,
      stats,
      source: "live",
      cache_updated_at: null,
      // The RPC left-joins every active collection, so a live answer covers all
      // of them — including the ones it counted as a genuine zero.
      covered_collection_ids: stats.map((r) => r.collection_id),
      elapsed_ms: elapsedMs,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const elapsedMs = Date.now() - started;
    console.error(
      "[profile/collection-stats] exception wallet=" + walletAddr +
        " elapsed_ms=" + elapsedMs +
        " msg=" + msg.slice(0, 300)
    );
    return NextResponse.json(
      { error: "internal_error", retry: true, message: msg, elapsed_ms: elapsedMs },
      { status: 503 }
    );
  }
}
