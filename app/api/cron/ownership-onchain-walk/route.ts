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

export const dynamic = "force-dynamic"
export const maxDuration = 800

const PIPELINE = "ownership-onchain-walk"
const WALLETS_PER_RUN = 800; // stalest-verified holder wallets per run (cycles the herd over a few runs)
const CONCURRENCY = 6; // parallel Flow REST reads — modest, to stay under public-node rate limits
const UPSERT_CHUNK = 500;
const BUDGET_MS = 720_000; // stop before the 800s lambda ceiling

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
      const { data: walletRows, error: wErr } = await supabaseAdmin.rpc(
        "get_stale_ownership_wallets",
        { p_limit: WALLETS_PER_RUN }
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

        // This wallet's Dune-attributed rookie rows (avg ~23/wallet, well under
        // PostgREST's 1000-row cap).
        const { data: rows, error: rErr } = await supabaseAdmin
          .from("topshot_ownership")
          .select("nft_id, edition_external_id, serial_number")
          .eq("owner_address", wallet);
        if (rErr) {
          walletErrors++;
          return;
        }
        for (const r of (rows ?? []) as Array<{
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
