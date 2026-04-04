import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const TOPSHOT_GQL = "https://public-api.nbatopshot.com/graphql";
const GQL_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "sports-collectible-tool/0.1",
};

const SEARCH_TRANSACTIONS_QUERY = `
  query BackfillSales($input: SearchMarketplaceTransactionsInput!) {
    searchMarketplaceTransactions(input: $input) {
      data {
        searchSummary {
          pagination { rightCursor }
          data {
            ... on MarketplaceTransactions {
              size
              data {
                ... on MarketplaceTransaction {
                  id price updatedAt txHash
                  moment {
                    id flowId flowSerialNumber tier isLocked parallelID
                    set { id flowName flowSeriesNumber }
                    setPlay {
                      ID flowRetired
                      circulations { circulationCount forSaleByCollectors }
                    }
                    parallelSetPlay { setID playID parallelID }
                    play {
                      id
                      stats {
                        playerID playerName firstName lastName
                        jerseyNumber teamAtMoment playCategory dateOfMoment
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

interface SaleTransaction {
  id: string;
  price: number | string;
  updatedAt?: string;
  txHash?: string;
  moment?: {
    id: string;
    flowId: string;
    flowSerialNumber: string;
    tier?: string;
    isLocked?: boolean;
    parallelID?: number;
    set?: { id: string; flowName?: string; flowSeriesNumber?: number };
    setPlay?: {
      ID?: string;
      flowRetired?: boolean;
      circulations?: { circulationCount: number; forSaleByCollectors?: number };
    };
    parallelSetPlay?: { setID?: number; playID?: number; parallelID?: number };
    play?: {
      id: string;
      stats: {
        playerID?: string;
        playerName: string;
        firstName?: string;
        lastName?: string;
        jerseyNumber?: string;
        teamAtMoment?: string;
        playCategory?: string;
        dateOfMoment?: string;
      };
    };
  };
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchSalesPage(
  limit: number,
  cursor: string | null
): Promise<{ transactions: SaleTransaction[]; nextCursor: string | null }> {
  const res = await fetch(TOPSHOT_GQL, {
    method: "POST",
    headers: GQL_HEADERS,
    body: JSON.stringify({
      query: SEARCH_TRANSACTIONS_QUERY,
      variables: {
        input: {
          sortBy: "UPDATED_AT_ASC",
          searchInput: {
            pagination: {
              cursor: cursor ?? "",
              direction: "RIGHT",
              limit,
            },
          },
        },
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GQL ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json();
  const summary = json?.data?.searchMarketplaceTransactions?.data?.searchSummary;
  const nextCursor = summary?.pagination?.rightCursor ?? null;
  const transactions: SaleTransaction[] = [];
  const dataField = summary?.data;

  if (Array.isArray(dataField)) {
    for (const block of dataField) {
      if (Array.isArray(block?.data)) {
        transactions.push(...block.data);
      }
    }
  } else if (dataField && typeof dataField === "object") {
    const b = dataField as any;
    if (Array.isArray(b.data)) {
      transactions.push(...b.data);
    }
  }

  return { transactions, nextCursor };
}

async function upsertEdition(tx: SaleTransaction): Promise<string | null> {
  const m = tx.moment;
  if (!m) return null;

  const psp = m.parallelSetPlay;
  const setID = psp?.setID ?? null;
  const playID = psp?.playID ?? null;
  const externalId = setID != null && playID != null ? `${setID}:${playID}` : m.id;

  const { data: existing } = await supabase
    .from("editions")
    .select("id")
    .eq("external_id", externalId)
    .limit(1);

  if (existing && existing.length > 0) return existing[0].id;

  const { data: inserted, error } = await supabase
    .from("editions")
    .insert({ external_id: externalId })
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") {
      const { data: retry } = await supabase
        .from("editions")
        .select("id")
        .eq("external_id", externalId)
        .limit(1);
      return retry?.[0]?.id ?? null;
    }
    return null;
  }
  return inserted?.id ?? null;
}

export async function POST(req: NextRequest) {
  const startTime = Date.now();

  // Auth — Bearer token
  const authHeader = req.headers.get("authorization")
  const expectedToken = process.env.INGEST_SECRET_TOKEN
  if (expectedToken && authHeader !== `Bearer ${expectedToken}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { data: state } = await supabase
    .from("backfill_state")
    .select("*")
    .eq("id", "topshot_sales")
    .single();

  if (state?.status === "complete") {
    return NextResponse.json({
      ok: true,
      message: "Backfill already complete",
      totalIngested: state.total_ingested,
    });
  }

  let cursor = state?.cursor ?? null;
  let totalThisRun = 0;
  let duplicates = 0;
  let pages = 0;
  const maxPages = 4;
  const batchSize = 200;

  try {
    for (let page = 0; page < maxPages; page++) {
      pages++;
      const { transactions, nextCursor } = await fetchSalesPage(batchSize, cursor);

      if (transactions.length === 0) {
        await supabase
          .from("backfill_state")
          .update({
            status: "complete",
            last_run_at: new Date().toISOString(),
            notes: `Completed after ${(state?.total_ingested ?? 0) + totalThisRun} total sales`,
          })
          .eq("id", "topshot_sales");

        return NextResponse.json({
          ok: true,
          message: "Backfill complete - no more transactions",
          totalThisRun,
          duplicates,
          totalOverall: (state?.total_ingested ?? 0) + totalThisRun,
          elapsed: Date.now() - startTime,
        });
      }

      for (const tx of transactions) {
        const m = tx.moment;
        if (!m) continue;

        const editionId = await upsertEdition(tx);
        if (!editionId) continue;

        const price = typeof tx.price === "string" ? parseFloat(tx.price) : tx.price;
        if (!price || price <= 0) continue;

        const { error } = await supabase.from("sales").insert({
          edition_id: editionId,
          serial_number: toNum(m.flowSerialNumber),
          price_usd: price,
          currency: "DUC",
          seller_address: null,
          buyer_address: null,
          marketplace: "topshot",
          transaction_hash: tx.txHash ?? null,
          sold_at: tx.updatedAt ? new Date(tx.updatedAt).toISOString() : new Date().toISOString(),
          nft_id: m.flowId ?? null,
        });

        if (error) {
          if (error.code === "23505") {
            duplicates++;
          }
        } else {
          totalThisRun++;
        }
      }

      cursor = nextCursor;

      await supabase
        .from("backfill_state")
        .update({
          cursor,
          total_ingested: (state?.total_ingested ?? 0) + totalThisRun,
          last_run_at: new Date().toISOString(),
          status: "running",
        })
        .eq("id", "topshot_sales");

      if (!nextCursor) break;
    }
  } catch (e: any) {
    await supabase
      .from("backfill_state")
      .update({
        cursor,
        total_ingested: (state?.total_ingested ?? 0) + totalThisRun,
        last_run_at: new Date().toISOString(),
        status: "error",
        notes: e.message?.slice(0, 500),
      })
      .eq("id", "topshot_sales");

    return NextResponse.json({
      ok: false,
      error: e.message,
      totalThisRun,
      duplicates,
      pages,
      elapsed: Date.now() - startTime,
    });
  }

  return NextResponse.json({
    ok: true,
    totalThisRun,
    duplicates,
    pages,
    cursor: cursor ? "has_more" : "done",
    totalOverall: (state?.total_ingested ?? 0) + totalThisRun,
    elapsed: Date.now() - startTime,
  });
}
