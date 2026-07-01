// TEMPORARY one-shot discovery probe (2026-07-01): pages ALL searchDistributions on the Dapper
// studio-platform GQL (direct, no proxy/secret) and returns the distinct packNftTypename ->
// {count, sampleTitle} map — to determine whether Disney Pinnacle has Dapper pack distributions
// and, if so, its exact pack typename. Read-only, no DB, no secrets. DELETE after one call.
import { NextResponse } from "next/server";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

const GQL = "https://api.production.studio-platform.dapperlabs.com/graphql";
const Q =
  "query($after:String){searchDistributions(input:{first:40,after:$after,sortBy:CREATED_AT_ASC}){totalCount pageInfo{endCursor hasNextPage}edges{node{title packNftTypename}}}}";

export async function GET() {
  const seen: Record<string, { count: number; sample: string }> = {};
  let after: string | null = null;
  let pages = 0;
  let total = 0;
  let hasNext = true;
  try {
    while (hasNext && pages < 260) {
      const res = await fetch(GQL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://disneypinnacle.com", "User-Agent": "rpc-probe" },
        body: JSON.stringify({ query: Q, variables: { after } }),
        signal: AbortSignal.timeout(15000),
      });
      const j = (await res.json()) as {
        data?: { searchDistributions?: { totalCount: number; pageInfo: { endCursor: string | null; hasNextPage: boolean }; edges: Array<{ node: { title: string | null; packNftTypename: string | null } }> } };
      };
      const conn = j?.data?.searchDistributions;
      if (!conn) break;
      total = conn.totalCount;
      for (const e of conn.edges ?? []) {
        const tn = e?.node?.packNftTypename ?? "(null)";
        if (!seen[tn]) seen[tn] = { count: 0, sample: e?.node?.title ?? "" };
        seen[tn].count++;
      }
      pages++;
      after = conn.pageInfo?.endCursor ?? null;
      hasNext = Boolean(conn.pageInfo?.hasNextPage);
      await new Promise((r) => setTimeout(r, 20));
    }
    return NextResponse.json({ totalCount: total, pagesWalked: pages, distinctTypenames: seen }, { status: 200 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e), pagesWalked: pages, distinctTypenames: seen }, { status: 200 });
  }
}
