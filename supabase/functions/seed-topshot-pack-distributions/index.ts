import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ── Top Shot pack distribution seeder ────────────────────────────────────────
//
// Pulls the live catalog of NBA Top Shot pack distributions from the public
// Studio Platform GraphQL API and upserts them into `pack_distributions`.
// Mirrors the AllDay/Golazos seeder's shape (same table, same fields) but
// uses the Studio Platform searchPackNftAggregation endpoint since Top Shot
// does not use the PDS contract the Flow-native seeders walk.
//
// Auth: POST with Authorization: Bearer ${INGEST_SECRET_TOKEN}. No JWT
// verification required (same pattern as the other ingest functions).

const INGEST_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN");
if (!INGEST_TOKEN) {
  throw new Error("INGEST_SECRET_TOKEN env var is required");
}

const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd";
const TOPSHOT_GRAPHQL = "https://api.production.studio-platform.dapperlabs.com/graphql";
const LOG_PREFIX = "[pds-seed:topshot]";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const GRAPHQL_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "RipPacksCity/1.0 (rip-packs-city.vercel.app)",
  "Origin": "https://nbatopshot.com",
  "Referer": "https://nbatopshot.com/",
};

// Query every sealed DUC-denominated Top Shot pack listing. We only care
// about the distribution metadata and its dist_id; the listing count is a
// byproduct we use for depletion estimation.
const PACK_LISTINGS_QUERY = `
  query searchPackNftAggregation_searchPacks($after: String, $first: Int, $filters: [PackNftFilter!]) {
    searchPackNftAggregation(searchInput: {after: $after, first: $first, filters: $filters}) {
      pageInfo { endCursor hasNextPage }
      totalCount
      edges {
        node {
          dist_id { key value }
          listing { price { min } }
          distribution {
            id { value }
            uuid { value }
            image_urls { value }
            number_of_pack_slots { value }
            pack_type { value }
            price { value }
            start_time { value }
            tier { value }
            title { value }
          }
        }
      }
    }
  }
`;

const SEALED_FILTERS = [
  {
    status: { eq: "Sealed" },
    listing: {
      exists: true,
      ft_vault_type: { eq: "A.ead892083b3e2c6c.DapperUtilityCoin.Vault" },
    },
    owner_address: { ne: "0b2a3299cc857e29" },
    excludeReserved: { eq: true },
    type_name: { eq: "A.0b2a3299cc857e29.PackNFT.NFT" },
    distribution: {
      tier: { ignore_case: true, in: [] },
      series_ids: { contains: [], contains_type: "ANY" },
      title: { ignore_case: true, partial_match: true, in: [] },
    },
  },
];

interface PackNode {
  dist_id?: { key: string; value: string };
  listing?: { price?: { min?: string } };
  distribution?: {
    id?: { value: string };
    uuid?: { value: string };
    image_urls?: { value: string[] };
    number_of_pack_slots?: { value: string };
    pack_type?: { value: string | null };
    price?: { value: number };
    start_time?: { value: string };
    tier?: { value: string };
    title?: { value: string };
  };
}

async function fetchPage(cursor: string | null): Promise<{
  nodes: PackNode[];
  hasNextPage: boolean;
  endCursor: string | null;
}> {
  const res = await fetch(TOPSHOT_GRAPHQL, {
    method: "POST",
    headers: GRAPHQL_HEADERS,
    body: JSON.stringify({
      operationName: "searchPackNftAggregation_searchPacks",
      query: PACK_LISTINGS_QUERY,
      variables: { first: 2000, after: cursor, filters: SEALED_FILTERS },
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GraphQL HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = await res.json() as any;
  if (json.errors?.length) {
    throw new Error(json.errors[0]?.message ?? "GraphQL error");
  }

  const conn = json.data?.searchPackNftAggregation;
  return {
    nodes: (conn?.edges ?? []).map((e: { node: PackNode }) => e.node).filter(Boolean),
    hasNextPage: conn?.pageInfo?.hasNextPage === true,
    endCursor: conn?.pageInfo?.endCursor ?? null,
  };
}

function buildRow(distId: string, node: PackNode, listingCount: number) {
  const d = node.distribution ?? {};
  const now = new Date().toISOString();

  // The Studio Platform API does not surface total minted / opened counts
  // directly on the distribution. Seed with zeros and let downstream compute
  // jobs update them if/when they come online. The only thing we know for
  // sure here is how many sealed packs are currently listed, which we stash
  // in metadata rather than overloading total_sealed.
  return {
    collection_id: TOPSHOT_COLLECTION_ID,
    dist_id: distId,
    title: d.title?.value ?? null,
    nft_type: "TopShot",
    total_minted: 0,
    total_opened: 0,
    total_sealed: null,
    depletion_pct: null,
    image_url: d.image_urls?.value?.[0] ?? null,
    metadata: {
      uuid: d.uuid?.value ?? null,
      tier: d.tier?.value ?? null,
      pack_type: d.pack_type?.value ?? null,
      retail_price_usd: d.price?.value ?? null,
      number_of_pack_slots: d.number_of_pack_slots?.value ? parseInt(d.number_of_pack_slots.value, 10) : null,
      start_time: d.start_time?.value ?? null,
      sealed_listed_snapshot: listingCount,
      sealed_listed_snapshot_at: now,
    },
    first_seen_at: now,
    updated_at: now,
  };
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${INGEST_TOKEN}`) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const startedAt = Date.now();
  try {
    const nodesByDist = new Map<string, { node: PackNode; listingCount: number }>();
    let cursor: string | null = null;
    let hasNext = true;
    let page = 0;

    while (hasNext && page < 20) {
      const { nodes, hasNextPage, endCursor } = await fetchPage(cursor);
      for (const n of nodes) {
        const distId = n?.dist_id?.value;
        if (!distId) continue;
        const existing = nodesByDist.get(distId);
        if (existing) {
          existing.listingCount += 1;
        } else {
          nodesByDist.set(distId, { node: n, listingCount: 1 });
        }
      }
      hasNext = hasNextPage;
      cursor = endCursor;
      page++;
    }

    const rows = Array.from(nodesByDist.entries()).map(([distId, { node, listingCount }]) =>
      buildRow(distId, node, listingCount),
    );

    if (rows.length === 0) {
      console.log(`${LOG_PREFIX} no distributions found`);
      return new Response(JSON.stringify({ ok: true, upserts: 0 }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    let upserted = 0;
    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i + 100);
      const { error } = await supabase
        .from("pack_distributions")
        .upsert(chunk, { onConflict: "dist_id,collection_id" });
      if (error) {
        console.error(`${LOG_PREFIX} upsert failed:`, error.message);
        throw error;
      }
      upserted += chunk.length;
    }

    const elapsed = Date.now() - startedAt;
    console.log(`${LOG_PREFIX} upserted=${upserted} in ${elapsed}ms`);

    return new Response(
      JSON.stringify({ ok: true, upserts: upserted, elapsed_ms: elapsed, pages: page }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${LOG_PREFIX} failed:`, msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

Deno.serve(handler);
