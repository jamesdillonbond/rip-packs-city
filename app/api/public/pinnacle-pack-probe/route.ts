// TEMPORARY read-only discovery probe for the Pinnacle Pack EV build (2026-07-01).
// Runs a caller-supplied read GQL query (?q=) against the Dapper studio-platform GQL — the
// SAME direct endpoint + Origin header pinnacle-catalog-backfill uses (NO proxy, NO secret).
// Default = query-field introspection. Read-only (queries only; no mutations), no DB writes,
// no secrets, response capped. Short-lived discovery tool for #5 — DELETE after.
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

const GQL = "https://api.production.studio-platform.dapperlabs.com/graphql";
const DEFAULT_Q =
  "query Probe { __schema { queryType { fields { name } } } }";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q") || DEFAULT_Q;
  // Safety: read-only. Reject anything that looks like a mutation/subscription.
  if (/\bmutation\b|\bsubscription\b/i.test(q)) {
    return NextResponse.json({ error: "read-only probe" }, { status: 200 });
  }
  try {
    const res = await fetch(GQL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://disneypinnacle.com",
        "User-Agent": "rip-packs-city/pinnacle-pack-probe",
      },
      body: JSON.stringify({ query: q }),
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    const capped = text.length > 60000 ? text.slice(0, 60000) + "…[truncated]" : text;
    let json: unknown;
    try {
      json = JSON.parse(capped);
    } catch {
      json = { raw: capped };
    }
    return NextResponse.json({ status: res.status, data: json }, { status: 200 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 200 });
  }
}
