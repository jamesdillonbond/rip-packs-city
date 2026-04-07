// app/api/flowty-listings/route.ts
//
// Reads STOREFRONT_LISTING_CREATED and STOREFRONT_LISTING_CANCELLED events
// from Flowty's open Firestore and upserts/deletes cached_listings so the
// sniper cache stays fresh between the 20-min listing-cache cron cycles.
//
// Also purges stale rows older than 6 hours as a TTL safety net.
//
// Edition lookup: nftID → getMintedMoment → editions.external_id → fmv_snapshots
//
// GET /api/flowty-listings              — live run (upserts to cached_listings)
// GET /api/flowty-listings?dry=1        — dry run, no DB writes
// GET /api/flowty-listings?limit=50     — limit Firestore fetch (default 200)

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const FIRESTORE_BASE =
  "https://firestore.googleapis.com/v1/projects/flowty-prod/databases/(default)";
const TOPSHOT_GQL = "https://public-api.nbatopshot.com/graphql";
const TOPSHOT_NFT_TYPE = "A.0b2a3299cc857e29.TopShot.NFT";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FirestoreFields = Record<string, any>;

const GET_MINTED_MOMENT = `
  query GetMintedMoment($momentId: ID!) {
    getMintedMoment(momentId: $momentId) {
      data {
        play { id }
        set { id }
        parallelSetPlay { setID playID }
        flowSerialNumber
        flowRetired
      }
    }
  }
`;

function getStr(f: FirestoreFields, key: string): string {
  return f[key]?.stringValue ?? f[key]?.integerValue ?? "";
}

function getNum(f: FirestoreFields, key: string): number {
  const v = f[key];
  if (!v) return 0;
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.integerValue !== undefined) return parseFloat(v.integerValue);
  return 0;
}

// Resolve Flow NFT ID → setID:playID via Top Shot GraphQL
async function getMintedMomentEditionKey(
  flowId: string
): Promise<{ externalId: string | null; serialNumber: number | null; flowRetired: boolean }> {
  try {
    const res = await fetch(TOPSHOT_GQL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: GET_MINTED_MOMENT, variables: { momentId: flowId } }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return { externalId: null, serialNumber: null, flowRetired: false };
    const json = await res.json();
    const raw = json?.data?.getMintedMoment;
    const data = raw?.data ?? raw;
    if (!data) return { externalId: null, serialNumber: null, flowRetired: false };

    const psp = data.parallelSetPlay;
    const setId = psp?.setID ?? data.set?.id;
    const playId = psp?.playID ?? data.play?.id;
    const serialNumber = data.flowSerialNumber ? parseInt(data.flowSerialNumber, 10) : null;
    const flowRetired = data.flowRetired === true;

    if (!setId || !playId) return { externalId: null, serialNumber: null, flowRetired };
    return { externalId: `${setId}:${playId}`, serialNumber, flowRetired };
  } catch {
    return { externalId: null, serialNumber: null, flowRetired: false };
  }
}

// Fetch Firestore events by type (shared helper for created + cancelled)
async function fetchFirestoreEvents(
  type: string,
  pageLimit: number
): Promise<{ name: string; fields: FirestoreFields; createTime: string }[]> {
  const res = await fetch(`${FIRESTORE_BASE}/documents:runQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "events" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "type" },
            op: "EQUAL",
            value: { stringValue: type },
          },
        },
        orderBy: [{ field: { fieldPath: "blockTimestamp" }, direction: "DESCENDING" }],
        limit: pageLimit,
      },
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`Firestore ${res.status}: ${await res.text()}`);
  const results = await res.json();
  return results
    .filter((r: { document?: unknown }) => r.document)
    .map((r: { document: unknown }) => r.document);
}

interface ListingEvent {
  nftID: string;
  listingResourceID: string;
  price: number;
  storefrontAddress: string;
  seller: string;
  blockTimestamp: string;
  fmv: number | null;
}

export async function GET(req: NextRequest) {
  const startTime = Date.now();
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "200"), 500);
  const dryRun = url.searchParams.get("dry") === "1";

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) as any;

  // ── 1. Fetch CREATED + CANCELLED events from Firestore in parallel ─────────
  let createdDocs: { name: string; fields: FirestoreFields; createTime: string }[];
  let cancelledDocs: { name: string; fields: FirestoreFields; createTime: string }[];
  try {
    [createdDocs, cancelledDocs] = await Promise.all([
      fetchFirestoreEvents("STOREFRONT_LISTING_CREATED", limit),
      fetchFirestoreEvents("STOREFRONT_LISTING_CANCELLED", 200),
    ]);
  } catch (err) {
    return NextResponse.json({ error: "Firestore fetch failed", detail: String(err) }, { status: 502 });
  }

  // ── 1b. Process cancellations — delete from cached_listings ────────────────
  const cancelledListingIds: string[] = [];
  for (const doc of cancelledDocs) {
    const dataFields = doc.fields.data?.mapValue?.fields ?? {};
    const listingResourceID = getStr(dataFields, "listingResourceID");
    if (listingResourceID) cancelledListingIds.push(listingResourceID);
  }

  let cancelledDeleted = 0;
  if (cancelledListingIds.length > 0 && !dryRun) {
    const { count } = await supabase
      .from("cached_listings")
      .delete({ count: "exact" })
      .in("listing_resource_id", cancelledListingIds);
    cancelledDeleted = count ?? 0;
    console.log(`[flowty-listings] Deleted ${cancelledDeleted} cancelled listings from cache`);
  }

  // ── 1c. TTL safety net — purge stale rows older than 6 hours ──────────────
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  let staleDeleted = 0;
  if (!dryRun) {
    const { count } = await supabase
      .from("cached_listings")
      .delete({ count: "exact" })
      .eq("source", "flowty")
      .lt("cached_at", sixHoursAgo);
    staleDeleted = count ?? 0;
    if (staleDeleted > 0) {
      console.log(`[flowty-listings] TTL cleanup: purged ${staleDeleted} stale rows older than 6h`);
    }
  }

  // Count stale rows in dry mode
  let staleDryCount = 0;
  if (dryRun) {
    const { count } = await supabase
      .from("cached_listings")
      .select("id", { count: "exact", head: true })
      .eq("source", "flowty")
      .lt("cached_at", sixHoursAgo);
    staleDryCount = count ?? 0;
  }

  const docs = createdDocs;

  // ── 2. Filter to TopShot & extract listing events ──────────────────────────
  const events: ListingEvent[] = [];
  for (const doc of docs) {
    const dataFields = doc.fields.data?.mapValue?.fields ?? {};

    // TopShot only
    const nftType = getStr(dataFields, "nftType");
    if (nftType && nftType !== TOPSHOT_NFT_TYPE) continue;

    // nftID: try typeAndIDOffer.nftID first, then data.nftID
    const typeAndID = dataFields.typeAndIDOffer?.mapValue?.fields ?? {};
    const nftID =
      getStr(typeAndID, "nftID") ||
      getStr(dataFields, "nftID");
    if (!nftID) continue;

    const listingResourceID = getStr(dataFields, "listingResourceID");
    const storefrontAddress = getStr(dataFields, "storefrontAddress");
    const seller = getStr(dataFields, "seller") || storefrontAddress;
    const blockTimestamp = doc.fields.blockTimestamp?.timestampValue ?? doc.createTime;

    // Price: salePrice may be in USD or micro-units
    let price = getNum(dataFields, "salePrice");
    // If price looks like micro-units (> 1e6), divide by 1e8
    if (price > 1_000_000) price = price / 1e8;
    if (price <= 0) continue;

    // LiveToken FMV from valuations.blended.usdValue
    const blended = dataFields.valuations?.mapValue?.fields?.blended?.mapValue?.fields ?? {};
    const fmvRaw = blended.usdValue?.doubleValue ?? blended.usdValue?.integerValue ?? null;
    const fmv = fmvRaw !== null ? parseFloat(String(fmvRaw)) : null;

    events.push({ nftID, listingResourceID, price, storefrontAddress, seller, blockTimestamp, fmv });
  }

  if (events.length === 0) {
    return NextResponse.json({
      processed: docs.length,
      listings: 0,
      upserted: 0,
      cancelledFetched: cancelledListingIds.length,
      cancelledDeleted,
      staleDeleted: dryRun ? staleDryCount : staleDeleted,
    });
  }

  console.log(`[flowty-listings] Parsed ${events.length} listing events from ${docs.length} Firestore docs`);

  // ── 3. Resolve nftID → edition_id via moments table, then GraphQL fallback ─
  const uniqueNftIds = [...new Set(events.map((e) => e.nftID))];

  // Layer 1: moments table
  const momentMap = new Map<string, { edition_id: string; serial_number: number | null }>();
  const { data: momentRows } = await supabase
    .from("moments")
    .select("nft_id, edition_id, serial_number")
    .in("nft_id", uniqueNftIds);

  for (const row of momentRows ?? []) {
    if (row.nft_id && row.edition_id) {
      momentMap.set(String(row.nft_id), {
        edition_id: row.edition_id,
        serial_number: row.serial_number ?? null,
      });
    }
  }

  // Layer 2: GraphQL for missing nftIDs
  const missing = uniqueNftIds.filter((id) => !momentMap.has(id));
  let gqlLookups = 0;
  let retiredSkipped = 0;

  if (missing.length > 0) {
    // Get collection_id
    const { data: col } = await supabase
      .from("collections")
      .select("id")
      .eq("slug", "nba_top_shot")
      .single();
    const collectionId = col?.id ?? null;

    const BATCH = 10;
    const resolvedKeys: { nftId: string; externalId: string; serialNumber: number | null; flowRetired: boolean }[] = [];

    for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH);
      const results = await Promise.all(
        batch.map(async (nftId) => {
          gqlLookups++;
          const { externalId, serialNumber, flowRetired } = await getMintedMomentEditionKey(nftId);
          return { nftId, externalId, serialNumber, flowRetired };
        })
      );
      resolvedKeys.push(
        ...results.filter((r): r is typeof r & { externalId: string } => r.externalId !== null)
      );
    }

    if (resolvedKeys.length > 0 && collectionId) {
      const externalIds = resolvedKeys.map((r) => r.externalId);
      const { data: editionRows } = await supabase
        .from("editions")
        .select("id, external_id")
        .in("external_id", externalIds);

      const editionByKey = new Map<string, string>();
      for (const row of editionRows ?? []) {
        if (row.external_id && row.id) editionByKey.set(row.external_id, row.id);
      }

      // Insert stubs for unknown editions
      const missingExternalIds = externalIds.filter((id) => !editionByKey.has(id));
      if (missingExternalIds.length > 0 && !dryRun) {
        const stubRows = missingExternalIds.map((extId) => ({
          external_id: extId,
          collection_id: collectionId,
        }));
        const { data: insertedEditions } = await supabase
          .from("editions")
          .upsert(stubRows, { onConflict: "external_id", ignoreDuplicates: false })
          .select("id, external_id");
        for (const row of insertedEditions ?? []) {
          if (row.external_id && row.id) editionByKey.set(row.external_id, row.id);
        }
      }

      // Cache to moments table + build momentMap; track retired nft_ids
      const newMomentRows: object[] = [];
      const retiredNftIds = new Set<string>();
      for (const { nftId, externalId, serialNumber, flowRetired } of resolvedKeys) {
        const editionId = editionByKey.get(externalId);
        if (!editionId) continue;

        if (flowRetired) {
          retiredNftIds.add(nftId);
          retiredSkipped++;
        }

        momentMap.set(nftId, { edition_id: editionId, serial_number: serialNumber });
        if (serialNumber !== null) {
          newMomentRows.push({
            nft_id: nftId,
            edition_id: editionId,
            collection_id: collectionId,
            serial_number: serialNumber,
            retired: flowRetired,
          });
        }
      }
      if (newMomentRows.length > 0 && !dryRun) {
        await supabase
          .from("moments")
          .upsert(newMomentRows, { onConflict: "nft_id", ignoreDuplicates: false });
      }

      // Mark retired moments in DB
      if (retiredNftIds.size > 0 && !dryRun) {
        await supabase
          .from("moments")
          .update({ retired: true })
          .in("nft_id", [...retiredNftIds]);
        console.log(`[flowty-listings] Marked ${retiredNftIds.size} moments as retired`);
      }
    }
  }

  // ── 4. Look up FMV from fmv_snapshots ──────────────────────────────────────
  const editionIds = [...new Set(
    [...momentMap.values()].map((m) => m.edition_id).filter(Boolean)
  )];

  const fmvMap = new Map<string, number>();
  if (editionIds.length > 0) {
    const { data: fmvRows } = await supabase
      .from("fmv_snapshots")
      .select("edition_id, fmv_usd")
      .in("edition_id", editionIds)
      .order("computed_at", { ascending: false });

    // Keep only the latest FMV per edition
    for (const row of fmvRows ?? []) {
      if (row.edition_id && row.fmv_usd && !fmvMap.has(row.edition_id)) {
        fmvMap.set(row.edition_id, row.fmv_usd);
      }
    }
  }

  // ── 5. Build upsert rows for cached_listings ──────────────────────────────
  const upsertRows: object[] = [];
  for (const evt of events) {
    const moment = momentMap.get(evt.nftID);
    const editionId = moment?.edition_id;

    // Use DB FMV if available, fall back to Firestore LiveToken FMV
    const dbFmv = editionId ? fmvMap.get(editionId) ?? null : null;
    const fmv = dbFmv ?? evt.fmv;
    const discount = fmv && fmv > 0 ? ((fmv - evt.price) / fmv) * 100 : null;

    upsertRows.push({
      id: `flowty-${evt.nftID}-${evt.listingResourceID}`,
      flow_id: evt.nftID,
      ask_price: evt.price,
      fmv: fmv,
      adjusted_fmv: fmv,
      discount: discount !== null ? Math.round(discount * 100) / 100 : null,
      confidence: fmv ? "HIGH" : null,
      source: "flowty",
      buy_url: evt.nftID
        ? `https://www.flowty.io/asset/A.0b2a3299cc857e29.TopShot.NFT/${evt.nftID}`
        : null,
      listing_resource_id: evt.listingResourceID,
      storefront_address: evt.storefrontAddress,
      listed_at: evt.blockTimestamp ? new Date(evt.blockTimestamp).toISOString() : null,
      cached_at: new Date().toISOString(),
    });
  }

  if (dryRun) {
    return NextResponse.json({
      dry: true,
      firestoreFetched: docs.length,
      topShotFiltered: events.length,
      toUpsert: upsertRows.length,
      editionsResolved: momentMap.size,
      gqlLookups,
      fmvMatches: fmvMap.size,
      cancelledFetched: cancelledListingIds.length,
      cancelledDeleted: 0,
      staleDeleted: staleDryCount,
      retiredSkipped,
      sample: upsertRows.slice(0, 3),
      elapsed: Date.now() - startTime,
    });
  }

  // ── 6. Upsert into cached_listings ─────────────────────────────────────────
  let upserted = 0;
  let errors = 0;

  for (let i = 0; i < upsertRows.length; i += 25) {
    const chunk = upsertRows.slice(i, i + 25);
    const { error } = await supabase
      .from("cached_listings")
      .upsert(chunk, { onConflict: "id" });

    if (error) {
      console.error(`[flowty-listings] Upsert chunk ${i} error:`, error.message);
      errors++;
      // Fallback: try one-by-one
      for (const row of chunk) {
        const { error: singleErr } = await supabase
          .from("cached_listings")
          .upsert([row], { onConflict: "id" });
        if (singleErr) {
          console.error(`[flowty-listings] Single upsert error:`, singleErr.message);
        } else {
          upserted++;
        }
      }
    } else {
      upserted += chunk.length;
    }
  }

  console.log(`[flowty-listings] Done: ${upserted} upserted, ${errors} chunk errors`);

  return NextResponse.json({
    ok: true,
    firestoreFetched: docs.length,
    topShotFiltered: events.length,
    upserted,
    errors,
    editionsResolved: momentMap.size,
    gqlLookups,
    fmvMatches: fmvMap.size,
    cancelledFetched: cancelledListingIds.length,
    cancelledDeleted,
    staleDeleted,
    retiredSkipped,
    elapsed: Date.now() - startTime,
  });
}
