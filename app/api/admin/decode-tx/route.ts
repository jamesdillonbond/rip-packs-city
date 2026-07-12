// app/api/admin/decode-tx/route.ts
//
// Admin diagnostic: decode any Flow mainnet transaction to its Cadence script,
// signer roles, and event-type summary. Built to answer the one open question
// from the bulk-purchasing (Quick Buy) reverse-engineering — which on-chain
// purchase path a given Quick-Buy tx actually uses (TopShotMarketV3.purchase vs
// an NFTStorefrontV2 storefront) — for any tx hash, on demand.
//
// Flow REST (rest-mainnet.onflow.org) is reachable from Vercel egress (the same
// path lib/chains/flow/dapper-v1-tx-decode.ts already uses); it is NOT reachable
// from the dev sandbox, which is why this lives as a route rather than a script.
//
// Auth: Bearer RPC_ADMIN_TOKEN | INGEST_SECRET_TOKEN | CRON_SECRET (or ?token=).
// GET /api/admin/decode-tx?tx=<hash>[&script=1]
//   script=1 includes the full decoded Cadence source (can be large).

import { NextRequest, NextResponse } from "next/server";
import { verifyAdminRequest, adminUnauthorizedResponse } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const FLOW_REST = "https://rest-mainnet.onflow.org";

// Purchase / payment event signatures worth flagging explicitly.
const KNOWN = {
  topshotMarketV3Purchased: "A.c1e4f4f4c4257510.TopShotMarketV3.MomentPurchased",
  storefrontV2Completed: "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted",
  storefrontV1Completed: "A.4eb8a10cb9f87357.NFTStorefront.ListingCompleted",
  topshotDeposit: "A.0b2a3299cc857e29.TopShot.Deposit",
  topshotWithdraw: "A.0b2a3299cc857e29.TopShot.Withdraw",
  ducWithdrawn: "A.ead892083b3e2c6c.DapperUtilityCoin.TokensWithdrawn",
} as const;

function normHex(a: string | undefined | null): string | null {
  if (!a) return null;
  return "0x" + a.trim().toLowerCase().replace(/^0x/, "");
}

export async function GET(req: NextRequest) {
  if (!verifyAdminRequest(req)) return adminUnauthorizedResponse();

  const tx = (req.nextUrl.searchParams.get("tx") ?? "").trim().replace(/^0x/, "");
  const includeScript = req.nextUrl.searchParams.get("script") === "1";
  if (!/^[0-9a-f]{64}$/i.test(tx)) {
    return NextResponse.json({ error: "tx must be a 64-hex transaction id" }, { status: 400 });
  }

  try {
    const res = await fetch(`${FLOW_REST}/v1/transactions/${tx}?expand=result`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `Flow REST ${res.status}`, hint: "pre-current-spork txs (pre ~late-2024) aren't served here" },
        { status: 502 }
      );
    }
    const json = (await res.json()) as {
      script?: string;
      arguments?: unknown[];
      payer?: string;
      proposal_key?: { address?: string };
      authorizers?: string[];
      result?: { events?: Array<{ type: string }> };
    };

    const scriptText = json.script ? Buffer.from(json.script, "base64").toString("utf8") : "";
    const events = json.result?.events ?? [];

    // Event-type histogram.
    const counts: Record<string, number> = {};
    for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
    const eventSummary = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => ({ type, count }));

    // First contract import in the script hints at the purchase path used.
    const importLines = scriptText
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("import "));

    const payer = normHex(json.payer);
    const proposer = normHex(json.proposal_key?.address);

    return NextResponse.json({
      tx,
      payer,
      proposer,
      authorizers: (json.authorizers ?? []).map(normHex),
      // The Dapper Quick-Buy fingerprint: payer 0x18eb4ee6b3c026d2, proposer
      // 0xead892083b3e2c6c (DUC account). True when the tx was co-signed by Dapper.
      isDapperCoSigned: payer === "0x18eb4ee6b3c026d2" && proposer === "0xead892083b3e2c6c",
      argCount: Array.isArray(json.arguments) ? json.arguments.length : 0,
      purchasePath: {
        topshotMarketV3: (counts[KNOWN.topshotMarketV3Purchased] ?? 0) > 0,
        storefrontV2: (counts[KNOWN.storefrontV2Completed] ?? 0) > 0,
        storefrontV1: (counts[KNOWN.storefrontV1Completed] ?? 0) > 0,
      },
      scriptImports: importLines,
      scriptChars: scriptText.length,
      eventCount: events.length,
      eventSummary,
      ...(includeScript ? { script: scriptText } : {}),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
