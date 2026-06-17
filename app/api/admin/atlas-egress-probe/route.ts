// app/api/admin/atlas-egress-probe/route.ts
//
// TEMPORARY diagnostic. Settles whether a real Vercel function can reach the
// public Dapper Atlas API (api.production.atlas.dapperlabs.com) directly, or
// whether the underpriced-serials ingest needs a Cloudflare Worker proxy.
//
// Finding (2026-06-16, local): Atlas's WAF returns 403 "block" to Node/undici
// `fetch` but 200 to curl/browser — same IP, same headers — i.e. a TLS/HTTP
// fingerprint block. Vercel's runtime is undici, so this route tests the exact
// listings call the ingest would make, from a real Vercel function:
//   - "minimal": the two Connect headers + Origin/Referer/UA (the handoff set)
//   - "enriched": minimal + browser Accept/Accept-Language/sec-fetch-* headers
//     (HTTP-header enrichment cannot change the TLS fingerprint, but rules out a
//      header-based block).
//
// 200 on either => Vercel egress works, no Worker needed.
// 403 on both   => undici is blocked on Vercel too => build a Worker proxy.
//
// Auth: Bearer RPC_ADMIN_TOKEN (or ?token=). Method: GET. Remove after the call.

import { NextRequest, NextResponse } from "next/server";
import { verifyAdminRequest, adminUnauthorizedResponse } from "@/lib/admin-auth";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

const ATLAS_URL =
  "https://api.production.atlas.dapperlabs.com/public/atlas.v1.MarketplaceService/SearchMarketplaceTransactions";

// The exact production call: the perfect-serial boundary query for a high-listing
// edition (Base Set S2 LeBron, Atlas editionId 2017 — ~2,796 listed).
const ATLAS_BODY = JSON.stringify({
  product: "nba",
  completed: false,
  editionId: "2017",
  sortByOption: "SERIAL_NUMBER",
  sortByDirection: "DESC",
  limit: "1",
  offset: "0",
  offers: false,
});

const MINIMAL_HEADERS: Record<string, string> = {
  "connect-protocol-version": "1",
  "content-type": "application/json",
  Origin: "https://dapper.market",
  Referer: "https://dapper.market/",
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

const ENRICHED_HEADERS: Record<string, string> = {
  ...MINIMAL_HEADERS,
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "cross-site",
};

async function probe(headers: Record<string, string>) {
  try {
    const res = await fetch(ATLAS_URL, {
      method: "POST",
      headers,
      body: ATLAS_BODY,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let serial: string | null = null;
    let parsedOk = false;
    if (text.trimStart().startsWith("{")) {
      parsedOk = true;
      try {
        const j = JSON.parse(text);
        serial = j?.transactions?.[0]?.serialNumber ?? null;
      } catch {
        parsedOk = false;
      }
    }
    return {
      status: res.status,
      ok: res.ok,
      blocked: !parsedOk, // non-JSON body == WAF block/throttle page
      serial,
      preview: text.slice(0, 120),
    };
  } catch (e) {
    return { status: 0, ok: false, blocked: true, serial: null, preview: String(e).slice(0, 120) };
  }
}

export async function GET(req: NextRequest) {
  if (!verifyAdminRequest(req)) return adminUnauthorizedResponse();

  const minimal = await probe(MINIMAL_HEADERS);
  const enriched = await probe(ENRICHED_HEADERS);

  const vercelReachable = minimal.ok || enriched.ok;
  return NextResponse.json({
    vercelReachable,
    verdict: vercelReachable
      ? "Vercel egress works — ingest can fetch Atlas directly (no Worker needed)."
      : "Vercel egress BLOCKED (undici WAF 403) — ingest needs a Cloudflare Worker proxy.",
    minimal,
    enriched,
    runtime: process.env.VERCEL_REGION ?? null,
  });
}
