// app/api/flowty-sales/route.ts
//
// Ingests completed Top Shot sales from Flowty's open Firestore events collection.
// Flowty writes STOREFRONT_PURCHASED events for all NFTStorefrontV2 sales on Flow —
// including Rarible and Flowverse listings — making this a cross-marketplace sales feed.
//
// Schema alignment (confirmed from Supabase):
//   sales: edition_id NOT NULL, collection_id NOT NULL, serial_number NOT NULL,
//          price_usd NOT NULL, sold_at NOT NULL — no unique constraint on tx_hash
//   editions: id, external_id, collection_id (NOT NULL), + metadata columns
//   moments: nft_id, edition_id, serial_number, owner_address
//
// Dedup strategy: plain .insert() — catch error code 23505 (duplicate PK) and skip.
//   The PK is a UUID generated per row, so actual dedup is via transaction_hash check.
//
// GET /api/flowty-sales?limit=100&dry=1   — dry run, no DB writes
// GET /api/flowty-sales?limit=100          — live run

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const FIRESTORE_BASE =
  "https://firestore.googleapis.com/v1/projects/flowty-prod/databases/(default)";

const TOPSHOT_NFT_TYPE = "A.0b2a3299cc857e29.TopShot.NFT";

// DUC = Dapper Utility Coin = USD value directly
// FLOW / FUT = need conversion
const DUC_VAULTS = new Set([
  "A.ead892083b3e2c6c.DapperUtilityCoin.Vault",
  "A.82ec283f88a62e65.DapperUtilityCoin.Vault",
]);
const FLOW_VAULTS = new Set([
  "A.1654653399040a61.FlowToken.Vault",
  "A.82ec283f88a62e65.FlowUtilityToken.Vault",
]);

interface FirestoreFields {
  type?: { stringValue: string };
  blockTimestamp?: { timestampValue: string };
  transactionId?: { stringValue: string };
  accountAddress?: { stringValue: string };
  data?: {
    mapValue: {
      fields: {
        nftID?: { stringValue: string; integerValue?: string };
        nftType?: { stringValue: string };
        salePrice?: { doubleValue?: number; integerValue?: string };
        salePaymentVaultType?: { stringValue: string };
        storefrontAddress?: { stringValue: string };
        buyer?: { stringValue: string };
        customID?: { stringValue?: string; nullValue?: null };
      };
    };
  };
}

interface FirestoreDoc {
  name: string;
  fields: FirestoreFields;
  createTime: string;
}

interface QueryResult {
  document?: FirestoreDoc;
  readTime: string;
}

async function getFlowUsd(): Promise<number> {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=flow&vs_currencies=usd",
      { signal: AbortSignal.timeout(3000) }
    );
    const data = await res.json();
    return Number(data?.flow?.usd) || 0;
  } catch {
    return 0;
  }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "100"), 500);
  const after = url.searchParams.get("after"); // ISO timestamp cursor
  const dryRun = url.searchParams.get("dry") === "1";

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // ── 1. Fetch from Firestore ─────────────────────────────────────────────────
  const filters: object[] = [
    {
      fieldFilter: {
        field: { fieldPath: "type" },
        op: "EQUAL",
        value: { stringValue: "STOREFRONT_PURCHASED" },
      },
    },
  ];

  if (after) {
    filters.push({
      fieldFilter: {
        field: { fieldPath: "blockTimestamp" },
        op: "GREATER_THAN",
        value: { timestampValue: after },
      },
    });
  }

  let queryResults: QueryResult[];
  try {
    const res = await fetch(`${FIRESTORE_BASE}/documents:runQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "events" }],
          where: filters.length === 1
            ? filters[0]
            : { compositeFilter: { op: "AND", filters } },
          orderBy: [{ field: { fieldPath: "blockTimestamp" }, direction: "DESCENDING" }],
          limit,
        },
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const err = await res.text();
      return NextResponse.json({ error: `Firestore ${res.status}`, detail: err }, { status: 502 });
    }
    queryResults = await res.json();
  } catch (err) {
    return NextResponse.json({ error: "Firestore fetch failed", detail: String(err) }, { status: 502 });
  }

  // ── 2. Filter to TopShot ─────────────────────────────────────────────────────
  const topShotSales = queryResults
    .filter((r) => r.document)
    .map((r) => r.document!)
    .filter((doc) => {
      const nftType = doc.fields.data?.mapValue?.fields?.nftType?.stringValue ?? "";
      return nftType === TOPSHOT_NFT_TYPE;
    });

  if (topShotSales.length === 0) {
    return NextResponse.json({ processed: 0, matched: 0, skipped: 0 });
  }

  // ── 3. Deduplicate by transaction_hash against existing sales ───────────────
  // Avoids wasted DB inserts without needing a unique constraint
  const txHashes = topShotSales
    .map((d) => d.fields.transactionId?.stringValue)
    .filter(Boolean) as string[];

  const { data: existingRows } = await supabase
    .from("sales")
    .select("transaction_hash")
    .in("transaction_hash", txHashes);

  const existingHashes = new Set((existingRows ?? []).map((r) => r.transaction_hash));

  const newSales = topShotSales.filter((doc) => {
    const txHash = doc.fields.transactionId?.stringValue;
    return txHash && !existingHashes.has(txHash);
  });

  if (newSales.length === 0) {
    return NextResponse.json({
      processed: topShotSales.length,
      matched: 0,
      skipped: topShotSales.length,
      reason: "all already ingested",
    });
  }

  // ── 4. Look up nftID → edition_id + collection_id + serial_number ──────────
  // Use sales.nft_id (new column) rather than moments table.
  // sales has far more coverage — every ingest run writes nft_id to sales,
  // while moments only gets rows from new ingest cycles going forward.
  // One row per nft_id is enough since edition_id is the same for all sales
  // of the same NFT.
  const nftIds = [...new Set(newSales.map((doc) => {
    const f = doc.fields.data?.mapValue?.fields;
    return f?.nftID?.stringValue ?? f?.nftID?.integerValue ?? "";
  }).filter(Boolean))];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: salesRows } = await (supabase as any)
    .from("sales")
    .select("nft_id, edition_id, collection_id, serial_number")
    .in("nft_id", nftIds)
    .not("nft_id", "is", null);

  // Deduplicate — keep first occurrence per nft_id
  const momentMap = new Map<string, { edition_id: string; collection_id: string; serial_number: number | null }>();
  for (const row of (salesRows ?? [])) {
    if (row.nft_id && !momentMap.has(String(row.nft_id))) {
      momentMap.set(String(row.nft_id), {
        edition_id: row.edition_id,
        collection_id: row.collection_id,
        serial_number: row.serial_number ?? null,
      });
    }
  }

  // collection_id comes directly from sales row — no editions join needed
  const editionCollectionMap = new Map<string, string>();
  for (const [, info] of momentMap) {
    if (info.edition_id && info.collection_id) {
      editionCollectionMap.set(info.edition_id, info.collection_id);
    }
  }

  // ── 5. Get FLOW/USD once if needed ──────────────────────────────────────────
  const needsFlowPrice = newSales.some((doc) => {
    const vault = doc.fields.data?.mapValue?.fields?.salePaymentVaultType?.stringValue ?? "";
    return FLOW_VAULTS.has(vault);
  });
  const flowUsd = needsFlowPrice ? await getFlowUsd() : 0;

  // ── 6. Build sale rows ────────────────────────────────────────────────────────
  const saleRows: object[] = [];
  let skipped = 0;

  for (const doc of newSales) {
    const f = doc.fields.data?.mapValue?.fields;
    if (!f) { skipped++; continue; }

    const nftId = String(f.nftID?.stringValue ?? f.nftID?.integerValue ?? "");
    if (!nftId) { skipped++; continue; }

    const momentInfo = momentMap.get(nftId);
    if (!momentInfo?.edition_id) {
      // Not in sales table yet — will populate as ingest runs
      skipped++;
      continue;
    }

    const collectionId = momentInfo.collection_id;
    if (!collectionId) {
      skipped++;
      continue;
    }

    // Price
    const rawPrice =
      f.salePrice?.doubleValue ??
      parseFloat(f.salePrice?.integerValue ?? "0");
    if (!rawPrice || rawPrice <= 0) { skipped++; continue; }

    const vault = f.salePaymentVaultType?.stringValue ?? "";
    let priceUsd: number | null = null;
    let priceNative: number | null = null;
    let currency = "UNKNOWN";

    if (DUC_VAULTS.has(vault)) {
      priceUsd = rawPrice;
      currency = "DUC";
    } else if (FLOW_VAULTS.has(vault)) {
      priceNative = rawPrice;
      currency = "FLOW";
      if (flowUsd > 0) priceUsd = rawPrice * flowUsd;
    } else {
      // Unknown vault — skip (can't store null price_usd with NOT NULL constraint)
      skipped++;
      continue;
    }

    // price_usd is NOT NULL — skip if we can't determine USD value
    if (priceUsd === null) { skipped++; continue; }

    const seller = f.storefrontAddress?.stringValue ?? doc.fields.accountAddress?.stringValue ?? null;
    const buyer = f.buyer?.stringValue ?? null;
    const customId = f.customID?.stringValue ?? null;
    const marketplace = customId ? customId.toLowerCase().replace(/[^a-z0-9_]/g, "_") : "flowty";
    const soldAt = doc.fields.blockTimestamp?.timestampValue ?? doc.createTime;
    const txHash = doc.fields.transactionId?.stringValue ?? null;

    saleRows.push({
      edition_id: momentInfo.edition_id,
      collection_id: collectionId,
      serial_number: momentInfo.serial_number ?? 0, // NOT NULL, 0 as fallback matching ingest pattern
      price_usd: priceUsd,
      price_native: priceNative,
      currency,
      seller_address: seller,
      buyer_address: buyer,
      marketplace,
      transaction_hash: txHash,
      sold_at: soldAt,
    });
  }

  if (dryRun) {
    return NextResponse.json({
      dry: true,
      firestoreFetched: topShotSales.length,
      alreadyIngested: existingHashes.size,
      toInsert: saleRows.length,
      skipped,
      salesMapSize: momentMap.size,
      sample: saleRows.slice(0, 3),
    });
  }

  // ── 7. Insert (not upsert — partitioned table, no unique constraint) ─────────
  let inserted = 0;
  let duplicates = 0;

  // Insert in batches of 50 to stay within Supabase limits
  for (let i = 0; i < saleRows.length; i += 50) {
    const batch = saleRows.slice(i, i + 50);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).from("sales").insert(batch);
    if (error) {
      if (error.code === "23505" || error.message?.includes("duplicate")) {
        duplicates += batch.length;
      } else {
        console.error("[flowty-sales] Insert error:", error.message);
      }
    } else {
      inserted += batch.length;
    }
  }

  const latestTimestamp =
    topShotSales[0]?.fields?.blockTimestamp?.timestampValue ?? null;

  return NextResponse.json({
    processed: topShotSales.length,
    newThisRun: newSales.length,
    inserted,
    duplicates,
    skipped,
    latestTimestamp,
    flowUsd: flowUsd > 0 ? flowUsd : null,
    salesMapSize: momentMap.size,
  });
}