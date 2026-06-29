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
  "User-Agent": "RipPacksCity/1.0 (www.rippackscity.com)",
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

function buildRow(distId: string, node: PackNode) {
  const d = node.distribution ?? {};

  // Catalog metadata only. We deliberately DO NOT send total_minted/total_opened:
  // the seed_topshot_pack_distributions RPC leaves those columns untouched on
  // conflict (they are durable — owned by topshot_pack_supply + the open/rip
  // pipelines). The Studio Platform API does not surface mint/open counts here
  // anyway (searchPackNftAggregation returns one edge per distribution, so any
  // per-edge counter is stuck at 1); GQL supply lives in topshot_pack_supply.
  // total_sealed/depletion_pct are GENERATED ALWAYS columns — never written.
  // first_seen_at/updated_at are handled by column defaults / the RPC.
  return {
    collection_id: TOPSHOT_COLLECTION_ID,
    dist_id: distId,
    title: d.title?.value ?? null,
    nft_type: "TopShot",
    image_url: d.image_urls?.value?.[0] ?? null,
    metadata: {
      uuid: d.uuid?.value ?? null,
      tier: d.tier?.value ?? null,
      pack_type: d.pack_type?.value ?? null,
      retail_price_usd: d.price?.value ?? null,
      number_of_pack_slots: d.number_of_pack_slots?.value ? parseInt(d.number_of_pack_slots.value, 10) : null,
      start_time: d.start_time?.value ?? null,
    },
  };
}

// The full seed: GQL pagination (up to 20 pages × 30s) + chunked upserts.
// Routinely exceeds 30s, so it runs in the background (see handler) rather
// than blocking the HTTP response and tripping cron-job.org's 30s client cap.
async function runSeed(): Promise<void> {
  const startedAt = Date.now();
  try {
    const nodesByDist = new Map<string, PackNode>();
    let cursor: string | null = null;
    let hasNext = true;
    let page = 0;

    while (hasNext && page < 20) {
      const { nodes, hasNextPage, endCursor } = await fetchPage(cursor);
      for (const n of nodes) {
        const distId = n?.dist_id?.value;
        if (!distId) continue;
        if (!nodesByDist.has(distId)) nodesByDist.set(distId, n);
      }
      hasNext = hasNextPage;
      cursor = endCursor;
      page++;
    }

    const rows = Array.from(nodesByDist.entries()).map(([distId, node]) =>
      buildRow(distId, node),
    );

    if (rows.length === 0) {
      console.log(`${LOG_PREFIX} no distributions found`);
      return;
    }

    // Non-destructive upsert via RPC. seed_topshot_pack_distributions() does an
    // ON CONFLICT DO UPDATE that preserves total_minted/total_opened and MERGES
    // metadata (existing || incoming) — unlike a raw .upsert(), which reset
    // supply to 0 and replaced metadata on every catalog re-seed.
    let upserted = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error } = await supabase.rpc("seed_topshot_pack_distributions", {
        p_rows: chunk,
      });
      if (error) {
        console.error(`${LOG_PREFIX} seed rpc failed:`, error.message);
        throw error;
      }
      upserted += chunk.length;
    }

    const elapsed = Date.now() - startedAt;
    console.log(`${LOG_PREFIX} upserted=${upserted} in ${elapsed}ms pages=${page}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${LOG_PREFIX} failed:`, msg);
  }
}

export default function handler(req: Request): Response {
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

  // Ack immediately and run the seed in the background. EdgeRuntime.waitUntil
  // keeps the worker alive until the promise settles after the response is
  // sent (the Supabase edge-runtime equivalent of Next.js `after()`); we fall
  // back to fire-and-forget if it's somehow unavailable.
  const work = runSeed();
  // deno-lint-ignore no-explicit-any
  const er = (globalThis as any).EdgeRuntime;
  if (er && typeof er.waitUntil === "function") {
    er.waitUntil(work);
  } else {
    work.catch((e) => console.error(`${LOG_PREFIX} bg work failed:`, e));
  }

  return new Response(JSON.stringify({ accepted: true }), {
    status: 202,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(handler);
