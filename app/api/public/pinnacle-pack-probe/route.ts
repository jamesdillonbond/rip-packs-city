// TEMPORARY discovery probe (2026-07-01): pages searchDistributions on the Dapper studio-platform
// GQL (direct, no proxy/secret) and captures the first Pinnacle-typename distributions with their
// FULL odds/price/slots/supply — to prove Pinnacle Pack EV data is populated. Read-only, no DB,
// no secrets. DELETE after one call.
import { NextResponse } from "next/server";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

const GQL = "https://api.production.studio-platform.dapperlabs.com/graphql";
const PIN = "A.edf9df96c92f4595.PackNFT.NFT";
const Q =
  "query($after:String){searchDistributions(input:{first:40,after:$after,sortBy:CREATED_AT_ASC}){pageInfo{endCursor hasNextPage}edges{node{uuid title packNftTypename distributionType numberOfPackSlots totalSupply availableSupply price{value currency} packOdds{tier value displayValue} editionIds}}}}";

export async function GET() {
  const pinSamples: unknown[] = [];
  let after: string | null = null;
  let pages = 0;
  let hasNext = true;
  try {
    while (hasNext && pages < 60 && pinSamples.length < 3) {
      const res = await fetch(GQL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://disneypinnacle.com", "User-Agent": "rpc-probe" },
        body: JSON.stringify({ query: Q, variables: { after } }),
        signal: AbortSignal.timeout(15000),
      });
      const j = (await res.json()) as { data?: { searchDistributions?: { pageInfo: { endCursor: string | null; hasNextPage: boolean }; edges: Array<{ node: { packNftTypename: string | null; editionIds?: number[] | null } & Record<string, unknown> } > } } };
      const conn = j?.data?.searchDistributions;
      if (!conn) break;
      for (const e of conn.edges ?? []) {
        if (e?.node?.packNftTypename === PIN && pinSamples.length < 3) {
          const n = { ...e.node } as Record<string, unknown>;
          const eids = (n.editionIds as number[] | null) ?? [];
          n.editionIdCount = Array.isArray(eids) ? eids.length : 0;
          n.editionIdsSample = Array.isArray(eids) ? eids.slice(0, 8) : [];
          delete n.editionIds;
          pinSamples.push(n);
        }
      }
      pages++;
      after = conn.pageInfo?.endCursor ?? null;
      hasNext = Boolean(conn.pageInfo?.hasNextPage);
      await new Promise((r) => setTimeout(r, 20));
    }
    return NextResponse.json({ pagesWalked: pages, pinnacleSamples: pinSamples }, { status: 200 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e), pagesWalked: pages, pinnacleSamples: pinSamples }, { status: 200 });
  }
}
