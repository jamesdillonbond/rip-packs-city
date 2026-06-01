// NEXT_STEPS — Cron janitor that fires the §3e reclaim_expired.cdc Cadence
// transaction for any trade_chain_state row whose expiry has passed but
// whose status is still open. submitReclaimExpired is stubbed at
// lib/trade-escrow/fcl-submit.ts. Hits via cron-job.org with either a
// `Authorization: Bearer $RPC_ADMIN_TOKEN` header or a `?token=` query.

import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { supabaseAdmin } from "@/lib/supabase";
import { verifyAdminRequest, adminUnauthorizedResponse } from "@/lib/admin-auth";
import { submitReclaimExpired } from "@/lib/trade-escrow/fcl-submit";
import type { TradeChainState } from "@/lib/trade-escrow/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const OPEN_STATUSES = ["proposed", "partial_a", "partial_b", "ready"] as const;

export async function POST(req: NextRequest) {
  if (!verifyAdminRequest(req)) return adminUnauthorizedResponse();
  return run();
}

// cron-job.org GET probes are common in this repo — accept GET too so the
// janitor can be wired without forcing a POST-capable scheduler.
export async function GET(req: NextRequest) {
  if (!verifyAdminRequest(req)) return adminUnauthorizedResponse();
  return run();
}

async function run() {
  if (!process.env.RPC_TRADE_ESCROW_ADDRESS) {
    return NextResponse.json({ error: "Trade Hub is not available yet." }, { status: 503 });
  }
  const startedAt = Date.now();
  try {
    const nowIso = new Date().toISOString();
    const { data: rows, error } = await (supabaseAdmin as any)
      .from("trade_chain_state")
      .select("*")
      .in("status", OPEN_STATUSES as unknown as string[])
      .lt("expires_at", nowIso)
      .limit(500);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    const expired = (rows ?? []) as TradeChainState[];
    if (expired.length === 0) {
      return NextResponse.json({ ok: true, reclaimed: 0, duration_ms: Date.now() - startedAt });
    }

    let reclaimed = 0;
    const failures: Array<{ id: string; error: string }> = [];
    for (const row of expired) {
      try {
        const submitted = await submitReclaimExpired({
          chain_trade_id: String(row.chain_trade_id ?? 0),
        });
        const { error: upErr } = await (supabaseAdmin as any)
          .from("trade_chain_state")
          .update({
            status: "expired",
            cancel_tx_id: submitted.tx_id,
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id);
        if (upErr) {
          failures.push({ id: row.id, error: upErr.message });
          continue;
        }
        reclaimed += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push({ id: row.id, error: msg });
        Sentry.captureException(err);
      }
    }

    return NextResponse.json({
      ok: true,
      reclaimed,
      candidates: expired.length,
      failures,
      duration_ms: Date.now() - startedAt,
    });
  } catch (err) {
    Sentry.captureException(err);
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[admin/reclaim-expired-trades] fatal: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
