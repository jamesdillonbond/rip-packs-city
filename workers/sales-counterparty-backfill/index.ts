// workers/sales-counterparty-backfill/index.ts
//
// SALES-COUNTERPARTY-BACKFILL runner (2026-07-18).
//
// WHY THIS EXISTS
// `public.sales` carries buyer/seller only for rows the on-chain indexers
// ingested. The bulk of history came from `ts_history_backfill_v1` and the
// studio-platform imports, which carry price/edition/serial but NO wallet
// addresses. Measured 2026-07-18: 2,344,322 of 2,962,790 NBA Top Shot sales
// (79%) have a NULL seller. That makes every wallet-scoped "sold" view a
// severe undercount — the founder's own wallet showed 7 lifetime sales.
//
// WHAT IT DOES, PER TICK
//   1. claim_sales_counterparty_batch(N)  -> newest-first NULL-seller rows
//      that carry a valid 64-hex Flow tx hash, bounded by a watermark cursor
//   2. decode each tx via Flow REST. The moment leaves its owner via a
//      <Contract>.Withdraw event whose `.from` is the SELLER; the collection is
//      inferred from which contract fired (a sale tx is single-collection):
//        A.0b2a3299cc857e29.TopShot.Withdraw .from       -> seller (Top Shot)
//        A.e4cf4bdc1751c65d.AllDay.Withdraw  .from        -> seller (NFL All Day)
//        A.329feb3ab062d289.UFC_NFT.Withdraw .from        -> seller (UFC Strike)
//        A.c1e4f4f4c4257510.TopShotMarketV3.MomentPurchased.seller (corroborates)
//      BUYER: only Top Shot's Deposit.to reaches the real buyer in-tx. AllDay/
//      UFC deposit to a constant Dapper intermediate (e.g. 0xddfbe848a81b2236
//      for AllDay) that re-forwards to the end buyer in a LATER tx, so for those
//      we fill SELLER ONLY and leave buyer NULL rather than write the custodian.
//      (Golazos secondary "sales" reference ListingAvailable txs with no moment
//      transfer, so they are not claimed — see the claim RPC scope.)
//   3. apply_sales_counterparty(rows) -> FILL-ONLY update + audit row
//
// SAFETY (enforced in the DB fns, not here — see the migrations):
//   * fill-only: COALESCE + IS NULL guard, can never overwrite an indexer
//     value; replaying a batch is a no-op (verified with a poisoned payload)
//   * no INSERT/DELETE on `sales`, so the destructive-op circuit-breaker is
//     never engaged
//   * every written value mirrored to sales_counterparty_recovered => the
//     whole job is attributable and revertible
//   * monotonic cursor: the walk only ever moves newest -> oldest
//
// Sampling showed ~11/12 rows recover BOTH sides; the residual is transient
// Flow REST timeouts, which are simply retried on a later pass because the
// row stays NULL and the cursor only advances past rows we actually saw.

import { createClient } from "@supabase/supabase-js";

interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  INGEST_SECRET_TOKEN: string;
}

const FLOW_REST = "https://rest-mainnet.onflow.org/v1/transaction_results";
const PIPELINE = "sales-counterparty-backfill";
const BATCH_LIMIT = 120;
// CONCURRENCY 6 was too aggressive: live ticks degraded from 100% recovery to
// an erratic 0.8%-88% (cumulative 91% -> 62%) within ~45 min, which is the
// signature of Flow REST throttling us, not of undecodable data. Because the
// cursor advances past a batch's failures, every throttled row is SKIPPED for
// the rest of the pass — so a greedy worker permanently loses more than it
// gains. Slower + a retry is strictly faster in recovered-rows-per-pass.
const CONCURRENCY = 3;
const CHUNK_PAUSE_MS = 300;
const RETRY_DELAY_MS = 1_200;
const TX_TIMEOUT_MS = 12_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// pipeline_runs telemetry.
//
// MUST call the FULL 11-arg overload. `log_pipeline_run` is overloaded
// (3-arg and 11-arg); PostgREST cannot disambiguate from a partial argument
// set, so the 3-arg shape silently fails to resolve and NO row is written —
// which is how the first live ticks ran invisibly on 2026-07-18. Errors are
// logged, never swallowed: a telemetry call that fails quietly is worse than
// none, because the job then looks absent rather than broken.
async function logRun(
  sb: any,
  args: { startedAtIso: string; rowsFound: number; rowsWritten: number; ok: boolean; error: string | null; extra: unknown },
): Promise<void> {
  try {
    const { error } = await sb.rpc("log_pipeline_run", {
      p_pipeline: PIPELINE,
      p_started_at: args.startedAtIso,
      p_rows_found: args.rowsFound,
      p_rows_written: args.rowsWritten,
      p_rows_skipped: Math.max(args.rowsFound - args.rowsWritten, 0),
      p_ok: args.ok,
      p_error: args.error,
      p_collection_slug: "nba_top_shot",
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: args.extra,
    });
    if (error) console.log(`[${PIPELINE}] log_pipeline_run err: ${error.message}`);
  } catch (err) {
    console.log(`[${PIPELINE}] log_pipeline_run threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}

type Claimed = { sale_id: string; tx_hash: string; sold_at: string };
type Decoded = { sale_id: string; seller: string | null; buyer: string | null; sold_at: string };

function decodePayload(ev: { payload: string }): unknown {
  try {
    // atob is available in Workers; payloads are base64 JSON-CDC.
    return JSON.parse(atob(ev.payload));
  } catch {
    return null;
  }
}

// JSON-CDC composite -> flat {fieldName: value}
function fields(cdc: any): Record<string, any> {
  const out: Record<string, any> = {};
  for (const f of cdc?.value?.fields ?? []) out[f.name] = f.value?.value ?? f.value;
  return out;
}

async function decodeOne(row: Claimed): Promise<Decoded> {
  const base: Decoded = { sale_id: row.sale_id, seller: null, buyer: null, sold_at: row.sold_at };
  try {
    const res = await fetch(`${FLOW_REST}/${row.tx_hash}`, {
      signal: AbortSignal.timeout(TX_TIMEOUT_MS),
    });
    if (!res.ok) return base;
    const body: any = await res.json();
    // SELLER: the moment leaves its owner via <MomentContract>.Withdraw. The
    // collection is inferred from which contract fires (a sale tx is single-
    // collection), so one allowlisted regex covers all claimed collections. The
    // `$` anchor keeps this off the standard NonFungibleToken.Withdrawn and the
    // *FungibleToken*.Withdrawn money legs (verified live across TopShot/AllDay/
    // UFC samples). BUYER: only Top Shot deposits reach the real buyer in-tx;
    // AllDay/UFC deposit to a Dapper custodian, so we collect ONLY TopShot
    // deposits and leave buyer NULL elsewhere (never write the intermediate).
    const withdraws: string[] = [];
    const tsDeposits: string[] = [];
    let purchaseSeller: string | null = null;
    for (const ev of body?.events ?? []) {
      const t: string = ev.type ?? "";
      if (/\.(TopShot|AllDay|UFC_NFT)\.Withdraw$/.test(t)) {
        const v = fields(decodePayload(ev)).from?.value;
        if (v) withdraws.push(v);
      }
      if (/\.TopShot\.Deposit$/.test(t)) {
        const v = fields(decodePayload(ev)).to?.value;
        if (v) tsDeposits.push(v);
      }
      if (/MomentPurchased$/.test(t)) {
        purchaseSeller = fields(decodePayload(ev)).seller?.value ?? purchaseSeller;
      }
    }

    // MULTI-MOMENT GUARD. `claim` gives us a sale_id but not its nft_id, so we
    // cannot tell WHICH moment in a multi-moment tx this row refers to. Today
    // that never happens — Top Shot's Quick Buy fires N independent
    // single-moment txs (see docs/research/topshot-bulk-purchasing-*), and
    // sampled AllDay/UFC/TopShot sale txs each carried exactly 1 moment
    // Withdraw. So taking the single value is correct in practice. But if a
    // genuine multi-moment tx ever appears, "first value wins" would silently
    // attach the WRONG counterparty to this sale. Prefer leaving the row NULL
    // (it gets retried, and the cursor-reset sweep revisits it) over writing a
    // plausible-looking lie into `sales`. To lift this guard, thread nft_id
    // through claim and match on it.
    if (withdraws.length > 1 || tsDeposits.length > 1) return base;

    return { ...base, seller: purchaseSeller ?? withdraws[0] ?? null, buyer: tsDeposits[0] ?? null };
  } catch {
    // Transient (timeout / edge hiccup). Row stays NULL and is retried later.
    return base;
  }
}

async function runTick(env: Env, limit: number) {
  const started = Date.now();
  const startedAtIso = new Date().toISOString();
  const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { data: claimed, error: claimErr } = await sb.rpc("claim_sales_counterparty_batch", {
    p_limit: limit,
  });
  if (claimErr) throw new Error(`claim failed: ${claimErr.message}`);

  const rows = (claimed ?? []) as Claimed[];
  if (rows.length === 0) {
    await logRun(sb, {
      startedAtIso,
      rowsFound: 0,
      rowsWritten: 0,
      ok: true,
      error: null,
      extra: { note: "drained", batch: 0, duration_ms: Date.now() - started },
    });
    return { batch: 0, applied: 0, drained: true };
  }

  const decoded: Decoded[] = [];
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    decoded.push(...(await Promise.all(rows.slice(i, i + CONCURRENCY).map(decodeOne))));
    if (i + CONCURRENCY < rows.length) await sleep(CHUNK_PAUSE_MS);
  }

  // One retry pass over the misses. A throttled/timed-out row is indistinguish-
  // able from a genuinely undecodable one at this layer, and the cursor is about
  // to move past both — so it is worth one more attempt, serially and after a
  // pause, before we lose the row for this pass.
  const missIdx = decoded.map((d, i) => (!d.seller && !d.buyer ? i : -1)).filter((i) => i >= 0);
  if (missIdx.length > 0) {
    await sleep(RETRY_DELAY_MS);
    for (const i of missIdx) {
      const again = await decodeOne(rows[i]);
      if (again.seller || again.buyer) decoded[i] = again;
      await sleep(CHUNK_PAUSE_MS);
    }
  }

  const { data: applyRes, error: applyErr } = await sb.rpc("apply_sales_counterparty", {
    p_rows: decoded,
  });
  if (applyErr) throw new Error(`apply failed: ${applyErr.message}`);

  const recovered = decoded.filter((d) => d.seller || d.buyer).length;
  const result = {
    batch: rows.length,
    recovered,
    applied: (applyRes as any)?.applied ?? null,
    cursor_sold_at: (applyRes as any)?.cursor_sold_at ?? null,
    duration_ms: Date.now() - started,
  };

  await logRun(sb, {
    startedAtIso,
    rowsFound: rows.length,
    rowsWritten: (applyRes as any)?.applied ?? 0,
    ok: true,
    error: null,
    extra: result,
  });

  return result;
}

export default {
  // Cloudflare Cron Trigger — not externally reachable, so no auth here.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const startedAtIso = new Date().toISOString();
    ctx.waitUntil(
      runTick(env, BATCH_LIMIT).catch(async (err) => {
        const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
          auth: { persistSession: false },
        });
        await logRun(sb, {
          startedAtIso,
          rowsFound: 0,
          rowsWritten: 0,
          ok: false,
          error: String(err).slice(0, 400),
          extra: { phase: "scheduled" },
        });
      }),
    );
  },

  // Manual/ad-hoc tick. Bearer-gated so it can't be used to hammer Flow REST.
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, worker: "sales-counterparty-backfill" });
    }

    const auth = request.headers.get("Authorization") ?? "";
    if (!env.INGEST_SECRET_TOKEN || auth !== `Bearer ${env.INGEST_SECRET_TOKEN}`) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      return Response.json({ error: "supabase env not configured" }, { status: 500 });
    }

    const limitRaw = parseInt(url.searchParams.get("limit") ?? "", 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : BATCH_LIMIT;

    try {
      return Response.json(await runTick(env, limit));
    } catch (err) {
      return Response.json({ error: String(err).slice(0, 400) }, { status: 500 });
    }
  },
};
