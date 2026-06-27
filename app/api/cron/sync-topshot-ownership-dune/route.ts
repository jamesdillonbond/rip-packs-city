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
// Auth: Bearer ${INGEST_SECRET_TOKEN} or ${CRON_SECRET}. Method: POST or GET.
// Cron-job.org: daily, off the :00 rush, www domain.

import { NextRequest, NextResponse, after } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 800; // Pro hard cap; the walk is bounded by HARD_BUDGET_MS below.

const PIPELINE_NAME = "ownership-sync-dune";
const PAGE_LIMIT = 1000; // dune-proxy / Dune results page cap
const UPSERT_CHUNK = 1000;
const HARD_BUDGET_MS = 750_000; // stop walking before the 800s lambda ceiling

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

    try {
      // Walk the Dune result set page by page, upserting as we go.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (Date.now() - startedMs > HARD_BUDGET_MS) break;

        const url = `${proxyUrl}/results?query_id=${encodeURIComponent(queryId)}&limit=${PAGE_LIMIT}&offset=${offset}`;
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${proxySecret}` },
          cache: "no-store",
        });
        if (!res.ok) {
          ok = false;
          errMsg = `dune proxy HTTP ${res.status} at offset ${offset}`;
          break;
        }
        const j = (await res.json()) as {
          result?: { rows?: Array<Record<string, unknown>> };
          next_offset?: number | null;
        };
        const rows = j.result?.rows ?? [];
        found += rows.length;

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
      }
    } catch (e) {
      ok = false;
      errMsg = `${errMsg ? errMsg + "; " : ""}threw: ${e instanceof Error ? e.message : String(e)}`;
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
          duration_ms: Date.now() - startedMs,
          query_id: queryId,
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
