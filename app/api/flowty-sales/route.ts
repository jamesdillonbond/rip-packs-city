// app/api/flowty-sales/route.ts
//
// Ingests completed Top Shot sales from Flowty's open Firestore events collection.
// Flowty writes STOREFRONT_PURCHASED events for all NFTStorefrontV2 sales on Flow —
// including Rarible and Flowverse listings — making this a cross-marketplace sales feed.
//
// Edition lookup strategy (in order):
//   1. moments table — fastest, already cached from prior lookups
//   2. sales.nft_id — for moments that traded on Top Shot native marketplace
//   3. getMintedMoment GraphQL — authoritative, one-time per nftID, result cached to moments
//
// GET /api/flowty-sales?limit=100&dry=1   — dry run, no DB writes
// GET /api/flowty-sales?limit=100          — live run

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const FIRESTORE_BASE =
  "https://firestore.googleapis.com/v1/projects/flowty-prod/databases/(default)";
const TOPSHOT_GQL = "https://public-api.nbatopshot.com/graphql";
const TOPSHOT_NFT_TYPE = "A.0b2a3299cc857e29.TopShot.NFT";

const DUC_VAULTS = new Set([
  "A.ead892083b3e2c6c.DapperUtilityCoin.Vault",
  "A.82ec283f88a62e65.DapperUtilityCoin.Vault",
]);
const FLOW_VAULTS = new Set([
  "A.1654653399040a61.FlowToken.Vault",
  "A.82ec283f88a62e65.FlowUtilityToken.Vault",
]);

// GraphQL query — resolves a Flow NFT ID to its setID:playID edition key
const GET_MINTED_MOMENT = `
  query GetMintedMoment($flowId: ID!) {
    getMintedMoment(flowId: $flowId) {
      data {
        play { id }
        set { id }
        parallelSetPlay { setID playID }
        flowSerialNumber
      }
    }
  }
`;

interface MomentInfo {
  edition_id: string;
  collection_id: string;
  serial_number: number | null;
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

// Resolve a Flow NFT ID → external_id (setUUID:playUUID) via Top Shot GraphQL
async function getMintedMomentEditionKey(
  flowId: string,
  debug = false
): Promise<{ externalId: string | null; serialNumber: number | null; rawDebug?: object }> {
  try {
    const res = await fetch(TOPSHOT_GQL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: GET_MINTED_MOMENT, variables: { flowId } }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      const rawDebug = debug ? { status: res.status, flowId } : undefined;
      return { externalId: null, serialNumber: null, rawDebug };
    }
    const json = await res.json();
    // Try both response shapes: with .data wrapper and without
    const raw = json?.data?.getMintedMoment;
    const data = raw?.data ?? raw;
    const rawDebug = debug ? {
      flowId,
      dataKeys: json?.data ? Object.keys(json.data) : [],
      errors: json?.errors?.map((e: any) => e.message) ?? [],
      raw: JSON.stringify(raw).slice(0, 400),
    } : undefined;
    if (!data) return { externalId: null, serialNumber: null, rawDebug };

    const psp = data.parallelSetPlay;
    const setId = psp?.setID ?? data.set?.id;
    const playId = psp?.playID ?? data.play?.id;
    const serialNumber = data.flowSerialNumber ? parseInt(data.flowSerialNumber, 10) : null;

    if (!setId || !playId) return { externalId: null, serialNumber: null, rawDebug };
    return { externalId: `${setId}:${playId}`, serialNumber };
  } catch (err) {
    const rawDebug = debug ? { flowId, error: String(err) } : undefined;
    return { externalId: null, serialNumber: null, rawDebug };
  }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "100"), 500);
  const after = url.searchParams.get("after");
  const dryRun = url.searchParams.get("dry") === "1";
  const debugMode = url.searchParams.get("debug") === "1";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  ) as any;

  // ── 1. Fetch from Firestore ─────────────────────────────────────────────────
  const filters: object[] = [
    { fieldFilter: { field: { fieldPath: "type" }, op: "EQUAL", value: { stringValue: "STOREFRONT_PURCHASED" } } },
  ];
  if (after) {
    filters.push({
      fieldFilter: { field: { fieldPath: "blockTimestamp" }, op: "GREATER_THAN", value: { timestampValue: after } },
    });
  }

  let queryResults: { document?: { name: string; fields: Record<string, any>; createTime: string } }[];
  try {
    const res = await fetch(`${FIRESTORE_BASE}/documents:runQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "events" }],
          where: filters.length === 1 ? filters[0] : { compositeFilter: { op: "AND", filters } },
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

  // ── 3. Dedup by transaction_hash ─────────────────────────────────────────────
  const txHashes = topShotSales
    .map((d) => d.fields.transactionId?.stringValue)
    .filter(Boolean) as string[];

  const { data: existingRows } = await supabase
    .from("sales")
    .select("transaction_hash")
    .in("transaction_hash", txHashes);

  const existingHashes = new Set((existingRows ?? []).map((r: any) => r.transaction_hash));

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

  // ── 4. Collect unique nftIDs ─────────────────────────────────────────────────
  const nftIds = [...new Set(newSales.map((doc) => {
    const f = doc.fields.data?.mapValue?.fields;
    return String(f?.nftID?.stringValue ?? f?.nftID?.integerValue ?? "");
  }).filter(Boolean))];

  // ── 5. Layer 1: check moments table (fastest — cached from prior lookups) ────
  const momentMap = new Map<string, MomentInfo>();

  const { data: momentRows } = await supabase
    .from("moments")
    .select("nft_id, edition_id, collection_id, serial_number")
    .in("nft_id", nftIds);

  for (const row of (momentRows ?? [])) {
    if (row.nft_id && row.edition_id && row.collection_id) {
      momentMap.set(String(row.nft_id), {
        edition_id: row.edition_id,
        collection_id: row.collection_id,
        serial_number: row.serial_number ?? null,
      });
    }
  }

  // ── 6. Layer 2: check sales.nft_id for any remaining ────────────────────────
  const stillMissing = nftIds.filter((id) => !momentMap.has(id));

  if (stillMissing.length > 0) {
    const { data: salesRows } = await supabase
      .from("sales")
      .select("nft_id, edition_id, collection_id, serial_number")
      .in("nft_id", stillMissing)
      .not("nft_id", "is", null);

    for (const row of (salesRows ?? [])) {
      if (row.nft_id && !momentMap.has(String(row.nft_id))) {
        momentMap.set(String(row.nft_id), {
          edition_id: row.edition_id,
          collection_id: row.collection_id,
          serial_number: row.serial_number ?? null,
        });
      }
    }
  }

  // ── 7. Layer 3: getMintedMoment for anything still missing ───────────────────
  // One GraphQL call per unique nftID. Results cached to moments table.
  // Uses public-api.nbatopshot.com/graphql — same endpoint as ingest, no Cloudflare block.
  const stillMissing2 = nftIds.filter((id) => !momentMap.has(id));
  let gqlLookups = 0;
  let gqlHits = 0;
  let gqlResolved = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let firstRawDebug: any = null;

  if (stillMissing2.length > 0) {
    // Get NBA Top Shot collection_id from DB
    const { data: col } = await supabase
      .from("collections")
      .select("id")
      .eq("slug", "nba_top_shot")
      .single();
    const collectionId = col?.id ?? null;

    // Look up editions by external_id batch after resolving keys
    const resolvedKeys: { nftId: string; externalId: string; serialNumber: number | null }[] = [];

    // Resolve keys in parallel (up to 10 at a time to avoid hammering)
    const BATCH = 10;
    for (let i = 0; i < stillMissing2.length; i += BATCH) {
      const batch = stillMissing2.slice(i, i + BATCH);
      const results = await Promise.all(
        batch.map(async (nftId) => {
          gqlLookups++;
          const { externalId, serialNumber, rawDebug } = await getMintedMomentEditionKey(nftId, debugMode && i === 0 && gqlLookups <= 1);
          if (rawDebug && !firstRawDebug) firstRawDebug = rawDebug;
          return { nftId, externalId, serialNumber };
        })
      );
      const resolved = results.filter((r): r is typeof r & { externalId: string } => r.externalId !== null);
      resolvedKeys.push(...resolved);
      gqlResolved += resolved.length;
    }

    // Batch look up edition UUIDs from external_ids
    if (resolvedKeys.length > 0 && collectionId) {
      const externalIds = resolvedKeys.map((r) => r.externalId);
      const { data: editionRows } = await supabase
        .from("editions")
        .select("id, external_id")
        .in("external_id", externalIds);

      const editionByKey = new Map<string, string>();
      for (const row of (editionRows ?? [])) {
        if (row.external_id && row.id) editionByKey.set(row.external_id, row.id);
      }

      // Insert minimal edition stubs for external_ids not yet in DB.
      // editions table has ~3k rows vs 100k+ moments in existence.
      // Ingest pipeline enriches name/tier/series/player_id on next run.
      const missingExternalIds = externalIds.filter((id) => !editionByKey.has(id));
      if (missingExternalIds.length > 0) {
        const stubRows = missingExternalIds.map((extId) => ({
          external_id: extId,
          collection_id: collectionId,
        }));
        const { data: insertedEditions } = await supabase
          .from("editions")
          .upsert(stubRows, { onConflict: "external_id", ignoreDuplicates: false })
          .select("id, external_id");
        for (const row of (insertedEditions ?? [])) {
          if (row.external_id && row.id) editionByKey.set(row.external_id, row.id);
        }
        console.log(`[flowty-sales] Upserted ${insertedEditions?.length ?? 0} edition stubs for ${missingExternalIds.length} unknown editions`);
      }

      // Build momentMap entries and cache to moments table
      const newMomentRows: object[] = [];
      for (const { nftId, externalId, serialNumber } of resolvedKeys) {
        const editionId = editionByKey.get(externalId);
        if (!editionId) continue;

        gqlHits++;
        momentMap.set(nftId, { edition_id: editionId, collection_id: collectionId, serial_number: serialNumber });

        if (serialNumber !== null) {
          newMomentRows.push({
            nft_id: nftId,
            edition_id: editionId,
            collection_id: collectionId,
            serial_number: serialNumber,
          });
        }
      }

      // Cache resolved moments for future calls
      if (newMomentRows.length > 0 && !dryRun) {
        await supabase
          .from("moments")
          .upsert(newMomentRows, { onConflict: "nft_id", ignoreDuplicates: true });
      }
    }
  }

  // ── 8. Get FLOW/USD rate if needed ───────────────────────────────────────────
  const needsFlowPrice = newSales.some((doc) => {
    const vault = doc.fields.data?.mapValue?.fields?.salePaymentVaultType?.stringValue ?? "";
    return FLOW_VAULTS.has(vault);
  });
  const flowUsd = needsFlowPrice ? await getFlowUsd() : 0;

  // ── 9. Build sale rows ────────────────────────────────────────────────────────
  const saleRows: object[] = [];
  let skipped = 0;

  for (const doc of newSales) {
    const f = doc.fields.data?.mapValue?.fields;
    if (!f) { skipped++; continue; }

    const nftId = String(f.nftID?.stringValue ?? f.nftID?.integerValue ?? "");
    if (!nftId) { skipped++; continue; }

    const momentInfo = momentMap.get(nftId);
    if (!momentInfo?.edition_id) { skipped++; continue; }
    if (!momentInfo.collection_id) { skipped++; continue; }

    const rawPrice = f.salePrice?.doubleValue ?? parseFloat(f.salePrice?.integerValue ?? "0");
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
      skipped++;
      continue;
    }

    if (priceUsd === null) { skipped++; continue; }

    const seller = f.storefrontAddress?.stringValue ?? doc.fields.accountAddress?.stringValue ?? null;
    const buyer = f.buyer?.stringValue ?? null;
    const customId = f.customID?.stringValue ?? null;
    const marketplace = customId ? customId.toLowerCase().replace(/[^a-z0-9_]/g, "_") : "flowty";
    const soldAt = doc.fields.blockTimestamp?.timestampValue ?? doc.createTime;
    const txHash = doc.fields.transactionId?.stringValue ?? null;

    saleRows.push({
      edition_id: momentInfo.edition_id,
      collection_id: momentInfo.collection_id,
      serial_number: momentInfo.serial_number ?? 0,
      price_usd: priceUsd,
      price_native: priceNative,
      currency,
      seller_address: seller,
      buyer_address: buyer,
      marketplace,
      transaction_hash: txHash,
      sold_at: soldAt,
      nft_id: nftId,
    });
  }

  if (dryRun) {
    return NextResponse.json({
      dry: true,
      firestoreFetched: topShotSales.length,
      alreadyIngested: existingHashes.size,
      toInsert: saleRows.length,
      skipped,
      momentsCached: momentMap.size,
      gqlLookups,
      gqlResolved: gqlResolved,
      gqlHits,
      debugGqlRaw: firstRawDebug,
      sample: saleRows.slice(0, 3),
    });
  }

  // ── 10. Insert ────────────────────────────────────────────────────────────────
  let inserted = 0;
  let duplicates = 0;

  for (let i = 0; i < saleRows.length; i += 50) {
    const batch = saleRows.slice(i, i + 50);
    const { error } = await supabase.from("sales").insert(batch);
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

  return NextResponse.json({
    processed: topShotSales.length,
    newThisRun: newSales.length,
    inserted,
    duplicates,
    skipped,
    momentsCached: momentMap.size,
    gqlLookups,
    gqlHits,
    latestTimestamp: topShotSales[0]?.fields?.blockTimestamp?.timestampValue ?? null,
    flowUsd: flowUsd > 0 ? flowUsd : null,
  });
}