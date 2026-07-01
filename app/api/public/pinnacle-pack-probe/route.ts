// TEMPORARY read-only discovery probe for the Pinnacle Pack EV build (2026-07-01).
// Introspects the Dapper studio-platform GraphQL — the SAME endpoint + Origin header the
// pinnacle-catalog-backfill already uses, reachable unauthenticated from our egress (NO proxy,
// NO secret). Returns the query-type field names (+ args) so we can find the Pinnacle
// pack-distribution/odds query shape (the TS analogue is getPackListing.packEditionsV3).
// Read-only, hardcoded query, no DB writes, no secrets. DELETE after discovery.
import { NextResponse } from "next/server";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

const GQL = "https://api.production.studio-platform.dapperlabs.com/graphql";

// Names + args of every top-level query the studio-platform GQL exposes.
const INTROSPECT =
  "query Probe { __schema { queryType { fields { name args { name type { kind name ofType { kind name } } } } } } }";

export async function GET() {
  try {
    const res = await fetch(GQL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://disneypinnacle.com",
        "User-Agent": "rip-packs-city/pinnacle-pack-probe",
      },
      body: JSON.stringify({ query: INTROSPECT }),
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 2000) };
    }
    let allQueryNames: string[] = [];
    let packQueries: unknown[] = [];
    try {
      const fields = (json as { data?: { __schema?: { queryType?: { fields?: Array<{ name: string; args?: unknown }> } } } })
        ?.data?.__schema?.queryType?.fields ?? [];
      allQueryNames = fields.map((f) => f.name).sort();
      packQueries = fields.filter((f) => /pack|distribution|drop/i.test(f.name));
    } catch {
      /* ignore */
    }
    return NextResponse.json(
      { status: res.status, packQueries, allQueryNames, introspectionOk: allQueryNames.length > 0 },
      { status: 200 }
    );
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 200 });
  }
}
