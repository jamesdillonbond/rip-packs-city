// app/api/cron/ownership-onchain-walk/route.ts
//
// Pipeline B — on-chain VERIFICATION walk for the TopShot ownership index.
//
// The Dune pipeline (Pipeline A, sync-topshot-ownership-dune) discovers the full
// rookie holder graph via event replay. This route independently CONFIRMS it on
// chain: for the stalest-verified holder wallets, it reads the wallet's current
// TopShot moment-ID set from Flow REST (one cheap call per wallet — no per-moment
// metadata, since we already hold the metadata from Dune) and re-stamps every
// Dune-attributed rookie NFT the wallet STILL holds as source='onchain_walk' with
// a fresh observed_at. NFTs attributed to the wallet but no longer on chain are
// counted as `vanished` (stale Dune attribution — the wallet sold/moved them);
// they are left untouched so their aging observed_at flags the staleness, and
// Pipeline A's weekly re-execution re-discovers where they went.
//
// Reconciliation: both pipelines upsert on nft_id; on-chain confirmation wins
// (fresher observed_at). Flow public REST is free, so this can run daily at no
// Dune-credit cost. It reuses ONLY the contract-verified getOwnedMomentIds script
// from app/api/wallet-backfill/route.ts — no new/unverified Cadence.
//
// Auth: Bearer INGEST_SECRET_TOKEN | CRON_SECRET. after()-wrapped, budgeted,
// logs pipeline_runs('ownership-onchain-walk'). Cron: daily (operator-wired).

import { NextRequest, NextResponse, after } from "next/server"
import fcl from "@/lib/chains/flow/flow"
import * as t from "@onflow/types"
import { supabaseAdmin } from "@/lib/supabase"
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat";
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"

export const dynamic = "force-dynamic"
export const maxDuration = 800

const PIPELINE = "ownership-onchain-walk"
const WALLETS_PER_RUN = 800; // stalest-verified holder wallets per run (cycles the herd over a few runs)
const CONCURRENCY = 6; // parallel Flow REST reads — modest, to stay under public-node rate limits
const UPSERT_CHUNK = 500;
const BUDGET_MS = 720_000; // stop before the 800s lambda ceiling

// Retry budget for the ONE query that gates the whole run (get_stale_ownership_wallets).
//
// Why this is deliberately far longer than rpc-with-retry's page-render default
// (3 attempts / ~250ms of backoff): that default is tuned for a request a human is
// waiting on, where a long retry trades a 500 for a 20s hang. Nobody is waiting on
// a daily cron. On 2026-08-15 and 08-16 this route died at ~72s with
// "Timed out acquiring connection from connection pool" on this exact call —
// wallets_walked 0, rows_written 0, budget_hit false — so it burned a whole day's
// tick without touching its own 720s budget. Retrying costs one cheap read; NOT
// retrying costs a day of ownership freshness.
//
// Sized to stay well inside BUDGET_MS: worst case ~5 min here still leaves ~7 min
// to walk, and the walk loop's own `Date.now() - startedMs > BUDGET_MS` check already
// accounts for time spent here, so a slow fetch degrades to PARTIAL progress rather
// than an overrun. Partial is real progress — the queue is oldest-observed_at-first
// and resumable, so the next tick picks up where this one stopped.
//
// ⚠ This is a mitigation, NOT a proven fix: if the pool is saturated for longer than
// WALLET_FETCH_BUDGET_MS the run still fails, exactly as before. It converts a
// guaranteed total loss into a likely recovery. Judge it by wallets_walked on the
// next few ticks, not by this comment.
const WALLET_FETCH_ATTEMPTS = 3;
const WALLET_FETCH_BASE_DELAY_MS = 20_000;
const WALLET_FETCH_BUDGET_MS = 300_000;

type OwnershipRow = {
  nft_id: string;
  edition_external_id: string;
  owner_address: string;
  serial_number: number | null;
  source: string;
  observed_at: string;
};

function authed(req: NextRequest): boolean {
  const auth = req.headers.get("authorization");
  return (
    auth === `Bearer ${process.env.INGEST_SECRET_TOKEN}` ||
    auth === `Bearer ${process.env.CRON_SECRET}`
  );
}

// Verbatim from app/api/wallet-backfill/route.ts — a wallet's held TopShot moment
// IDs in one Flow REST call. Contract-verified in production; not modified here.
async function getOwnedMomentIds(wallet: string): Promise<string[]> {
  const cadence = `
    import TopShot from 0x0b2a3299cc857e29
    access(all)
    fun main(address: Address): [UInt64] {
      let acct = getAccount(address)
      let col = acct.capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
      if col == nil { return [] }
      return col!.getIDs()
    }
  `;
  const result = await fcl.query({ cadence, args: (arg: any) => [arg(wallet, t.Address)] });
  return Array.isArray(result) ? (result as unknown[]).map((x) => String(x)) : [];
}

// Bounded-concurrency map (verbatim shape from wallet-backfill).
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function runWorker() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => runWorker())
  );
  return results;
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
  // `${PIPELINE}-heartbeat` row with no matching terminal row. Never throws.
  await writeInvocationHeartbeat({
    pipeline: PIPELINE,
    startedAtMs: Date.parse(startedAt),
  });


  after(async () => {
    const startedMs = Date.now();
    const nowIso = new Date().toISOString();
    let ok = true;
    let errMsg: string | null = null;
    let walletsWalked = 0;
    let confirmed = 0;
    let vanished = 0;
    let walletErrors = 0;
    let budgetHit = false;

    try {
      const { data: walletRows, error: wErr } = await rpcWithRetry<
        Array<{ owner_address: string }>
      >(
        supabaseAdmin as never,
        "get_stale_ownership_wallets",
        { p_limit: WALLETS_PER_RUN },
        {
          attempts: WALLET_FETCH_ATTEMPTS,
          baseDelayMs: WALLET_FETCH_BASE_DELAY_MS,
          timeoutMs: WALLET_FETCH_BUDGET_MS,
        }
      );
      if (wErr) throw new Error(`stale-wallets: ${wErr.message}`);
      const wallets = ((walletRows ?? []) as Array<{ owner_address: string }>).map(
        (r) => r.owner_address
      );

      const upsertBuf: OwnershipRow[] = [];

      await mapWithConcurrency(wallets, CONCURRENCY, async (wallet) => {
        if (Date.now() - startedMs > BUDGET_MS) {
          budgetHit = true;
          return;
        }
        let heldIds: Set<string>;
        try {
          heldIds = new Set(await getOwnedMomentIds(wallet));
        } catch {
          walletErrors++;
          return;
        }
        walletsWalked++;

        // This wallet's Dune-attributed rookie rows.
        //
        // 🚨 THE OLD JUSTIFICATION WAS AN AVERAGE USED AS A BOUND: "avg ~23/wallet,
        // well under PostgREST's 1000-row cap". An average says nothing about the
        // tail, and the tail is exactly who this walk exists for. Measured live
        // 2026-09-02: 270,424 rows over 7,903 owners (avg 34), but the MAX is
        // 26,737 and **21 owners hold more than 1,000** — for each of those the
        // read returned 1,000 rows with no error and no short page, so the walk
        // silently confirmed a fraction of their holdings and left the rest
        // looking unconfirmed.
        //
        // Keyset on nft_id, which is this table's primary key.
        const rows: Array<{ nft_id: string; edition_external_id: string; serial_number: number | null }> = [];
        {
          const PAGE = 1000;
          const MAX_PAGES = 100;
          let cursor = "";
          let readErr = false;
          for (let page = 0; page < MAX_PAGES; page++) {
            let q = (supabaseAdmin as any)
              .from("topshot_ownership")
              .select("nft_id, edition_external_id, serial_number")
              .eq("owner_address", wallet)
              .order("nft_id", { ascending: true })
              .limit(PAGE);
            if (cursor) q = q.gt("nft_id", cursor);
            const { data, error } = await q;
            if (error) { readErr = true; break; }
            const pageRows = (data ?? []) as typeof rows;
            rows.push(...pageRows);
            if (pageRows.length < PAGE) break;
            const next = pageRows[pageRows.length - 1]?.nft_id;
            // No cursor means no progress — stop rather than re-read page 0.
            if (!next || next === cursor) break;
            cursor = next;
          }
          if (readErr) {
            walletErrors++;
            return;
          }
        }
        for (const r of rows as Array<{
          nft_id: string;
          edition_external_id: string;
          serial_number: number | null;
        }>) {
          if (heldIds.has(String(r.nft_id))) {
            confirmed++;
            upsertBuf.push({
              nft_id: String(r.nft_id),
              edition_external_id: r.edition_external_id,
              owner_address: wallet,
              serial_number: r.serial_number,
              source: "onchain_walk",
              observed_at: nowIso,
            });
          } else {
            vanished++;
          }
        }
      });

      for (let i = 0; i < upsertBuf.length; i += UPSERT_CHUNK) {
        const chunk = upsertBuf.slice(i, i + UPSERT_CHUNK);
        const { error } = await supabaseAdmin
          .from("topshot_ownership")
          .upsert(chunk, { onConflict: "nft_id" });
        if (error) {
          ok = false;
          errMsg = `upsert: ${error.message}`;
          break;
        }
      }
    } catch (e) {
      ok = false;
      errMsg = `${errMsg ? errMsg + "; " : ""}threw: ${e instanceof Error ? e.message : String(e)}`;
    }

    try {
      await (supabaseAdmin as any).rpc("log_pipeline_run", {
        p_pipeline: PIPELINE,
        p_started_at: startedAt,
        p_rows_found: confirmed + vanished,
        p_rows_written: confirmed,
        p_rows_skipped: vanished,
        p_ok: ok,
        p_error: errMsg,
        p_extra: {
          wallets_walked: walletsWalked,
          confirmed,
          vanished,
          wallet_errors: walletErrors,
          budget_hit: budgetHit,
          duration_ms: Date.now() - startedMs,
        },
      });
    } catch (logErr) {
      console.log(
        `[${PIPELINE}] log_pipeline_run err: ${logErr instanceof Error ? logErr.message : String(logErr)}`
      );
    }
  });

  return NextResponse.json({ ok: true, accepted: true, pipeline: PIPELINE }, { status: 202 });
}
