#!/usr/bin/env node
// scripts/resolve-allday-buyers.ts
//
// Companion to scripts/backfill-allday-editions.ts.
//
// The escrow-borrow approach in the sibling script has a 0% hit rate because
// every AllDay NFT has already been forwarded from the Flowty storefront
// escrow (0x3cdbb3d569211ff3) to the actual buyer. This script resolves the
// real buyer by fetching the on-chain transaction via the Flow REST API,
// extracting proposer / authorizer addresses (excluding well-known
// co-signer/escrow accounts), grouping unmapped nft_ids per buyer, and
// running the same Cadence borrow script against each buyer wallet.
//
// Strategy:
//   1. Page through unmapped_sales where collection_id = AllDay AND
//      resolved_at IS NULL AND transaction_hash IS NOT NULL, ordered by id
//      ascending so the cursor can resume deterministically.
//   2. For each row, GET https://rest-mainnet.onflow.org/v1/transactions/{hash}
//      and pull candidate addresses from proposal_key.address, authorizers,
//      and payer. Filter out the Flowty escrow (0x3cdbb3d569211ff3), the
//      Flowty fee payer (0x18eb4ee6b3c026d2), and the Dapper co-signer
//      (0xead892083b3e2c6c). Whatever remains is the buyer wallet.
//   3. Bucket nft_ids by buyer address, then run the AllDay borrow script
//      once per bucket (1 owner × N ids). Upsert resolved rows into
//      nft_edition_map ON CONFLICT DO NOTHING.
//   4. After all buckets finish, call promote_unmapped_sales(AllDay) and
//      print the result.
//
// Resumable via backfill_state(id='allday_buyer_resolve') — tracks the last
// unmapped_sales.id processed so retries skip work already attempted.
//
// Usage:  npx tsx scripts/resolve-allday-buyers.ts
// Env:    SUPABASE_URL (optional), SUPABASE_SERVICE_ROLE_KEY (required)
//         ALLDAY_BUYER_BATCH_SIZE  (default 25, tx fetches per round)
//         ALLDAY_BUYER_RESET       (set to "1" to start from scratch)

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://bxcqstmqfzmuolpuynti.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const FLOW_REST = "https://rest-mainnet.onflow.org";
const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070";
const BATCH_SIZE = Number(process.env.ALLDAY_BUYER_BATCH_SIZE ?? 25);
const STATE_ID = "allday_buyer_resolve";

// Addresses that appear in every Flowty purchase envelope but are never
// the buyer. Compared case-insensitively with 0x-normalised values.
const EXCLUDED_ADDRESSES = new Set<string>([
  "0x3cdbb3d569211ff3", // Flowty storefront escrow / seller
  "0x18eb4ee6b3c026d2", // Flowty fee payer
  "0xead892083b3e2c6c", // Dapper DUC co-signer
]);

if (!SERVICE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY not set");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const BORROW_SCRIPT = `
import AllDay from 0xe4cf4bdc1751c65d
import NonFungibleToken from 0x1d7e57aa55817448

access(all) fun main(owners: [Address], ids: [UInt64]): {UInt64: [UInt64]} {
  let out: {UInt64: [UInt64]} = {}
  for id in ids {
    for owner in owners {
      let ref = getAccount(owner).capabilities
        .borrow<&{NonFungibleToken.Collection}>(/public/AllDayNFTCollection)
      if ref == nil { continue }
      let nft = ref!.borrowNFT(id)
      if nft == nil { continue }
      let ad = nft! as! &AllDay.NFT
      out[id] = [ad.editionID, ad.serialNumber]
      break
    }
  }
  return out
}
`.trim();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeAddress(raw: string): string {
  const hex = raw.trim().toLowerCase().replace(/^0x/, "");
  return `0x${hex.padStart(16, "0")}`;
}

interface UnmappedRow {
  id: string;
  nft_id: string;
  transaction_hash: string;
}

async function loadUnresolved(afterId: string | null): Promise<UnmappedRow[]> {
  const rows: UnmappedRow[] = [];
  const pageSize = 500;
  let cursor = afterId;
  for (;;) {
    let q = supabase
      .from("unmapped_sales")
      .select("id,nft_id,transaction_hash")
      .eq("collection_id", ALLDAY_COLLECTION_ID)
      .is("resolved_at", null)
      .not("transaction_hash", "is", null)
      .order("id", { ascending: true })
      .limit(pageSize);
    if (cursor) q = q.gt("id", cursor);
    const { data, error } = await q;
    if (error) throw new Error(`unmapped_sales: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data as UnmappedRow[]) {
      if (row.nft_id && row.transaction_hash) rows.push(row);
    }
    if (data.length < pageSize) break;
    cursor = data[data.length - 1].id;
  }
  return rows;
}

async function loadCursor(): Promise<string | null> {
  if (process.env.ALLDAY_BUYER_RESET === "1") return null;
  const { data } = await supabase
    .from("backfill_state")
    .select("cursor")
    .eq("id", STATE_ID)
    .maybeSingle();
  return data?.cursor ? String(data.cursor) : null;
}

async function saveCursor(
  cursor: string | null,
  totalResolved: number,
  status: string,
  notes: string | null,
) {
  const { error } = await supabase.from("backfill_state").upsert({
    id: STATE_ID,
    cursor,
    total_ingested: totalResolved,
    last_run_at: new Date().toISOString(),
    status,
    notes,
  });
  if (error)
    console.log(`[buyer-resolve] saveCursor err: ${error.message}`);
}

interface FlowTxResponse {
  proposal_key?: { address?: string };
  authorizers?: string[];
  payer?: string;
}

async function fetchTxBuyers(
  txHash: string,
): Promise<string[]> {
  const clean = txHash.replace(/^0x/, "");
  const res = await fetch(`${FLOW_REST}/v1/transactions/${clean}`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    if (res.status === 404) return [];
    throw new Error(`tx ${clean} HTTP ${res.status}`);
  }
  const j = (await res.json()) as FlowTxResponse;
  const candidates = new Set<string>();
  if (j.proposal_key?.address) candidates.add(normalizeAddress(j.proposal_key.address));
  for (const a of j.authorizers ?? []) candidates.add(normalizeAddress(a));
  if (j.payer) candidates.add(normalizeAddress(j.payer));
  return Array.from(candidates).filter((a) => !EXCLUDED_ADDRESSES.has(a));
}

interface CdcValue {
  type: string;
  value: unknown;
}
interface CdcKeyValue {
  key: CdcValue;
  value: CdcValue;
}

async function runBorrowScript(
  owners: string[],
  ids: string[],
): Promise<Map<string, { editionID: string; serialNumber: string }>> {
  const body = {
    script: Buffer.from(BORROW_SCRIPT, "utf8").toString("base64"),
    arguments: [
      Buffer.from(
        JSON.stringify({
          type: "Array",
          value: owners.map((a) => ({ type: "Address", value: a })),
        }),
      ).toString("base64"),
      Buffer.from(
        JSON.stringify({
          type: "Array",
          value: ids.map((v) => ({ type: "UInt64", value: v })),
        }),
      ).toString("base64"),
    ],
  };

  const res = await fetch(`${FLOW_REST}/v1/scripts?block_height=sealed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`script HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const raw = (await res.text()).trim().replace(/^"|"$/g, "");
  const decoded = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as CdcValue;
  const out = new Map<string, { editionID: string; serialNumber: string }>();
  const entries = (decoded?.value as CdcKeyValue[] | undefined) ?? [];
  for (const entry of entries) {
    const nftId = String(entry.key?.value ?? "");
    const arr = (entry.value?.value as CdcValue[] | undefined) ?? [];
    if (!nftId || arr.length < 2) continue;
    const editionID = String(arr[0]?.value ?? "");
    const serialNumber = String(arr[1]?.value ?? "");
    if (!editionID) continue;
    out.set(nftId, { editionID, serialNumber });
  }
  return out;
}

async function upsertMap(
  rows: Array<{ nft_id: string; edition_external_id: string; serial_number: number }>,
): Promise<number> {
  if (rows.length === 0) return 0;
  const payload = rows.map((r) => ({
    collection_id: ALLDAY_COLLECTION_ID,
    nft_id: r.nft_id,
    edition_external_id: r.edition_external_id,
    serial_number: r.serial_number,
  }));
  const { error } = await supabase
    .from("nft_edition_map")
    .upsert(payload, { onConflict: "collection_id,nft_id", ignoreDuplicates: true });
  if (error) {
    console.log(`[buyer-resolve] upsert err: ${error.message}`);
    return 0;
  }
  return rows.length;
}

async function main() {
  console.log(`[buyer-resolve] starting batch=${BATCH_SIZE}`);

  const cursor = await loadCursor();
  console.log(`[buyer-resolve] cursor=${cursor ?? "<none>"}`);

  const rows = await loadUnresolved(cursor);
  console.log(`[buyer-resolve] ${rows.length} unresolved rows to process`);
  if (rows.length === 0) {
    console.log("nothing to do.");
    return;
  }

  let txFetched = 0;
  let txFailed = 0;
  let nftResolved = 0;
  let nftBorrowMiss = 0;
  let mapInserted = 0;
  let lastId: string | null = cursor;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const slice = rows.slice(i, i + BATCH_SIZE);
    // Parallel tx fetches with bounded concurrency.
    const ownersByNft = new Map<string, string[]>();
    await Promise.all(
      slice.map(async (r) => {
        try {
          const owners = await fetchTxBuyers(r.transaction_hash);
          ownersByNft.set(r.nft_id, owners);
          txFetched++;
        } catch (e) {
          txFailed++;
          console.log(
            `[buyer-resolve] tx ${r.transaction_hash.slice(0, 10)} err: ${(e as Error).message}`,
          );
        }
      }),
    );

    // Bucket nft_ids by owner address.
    const bucketsByOwner = new Map<string, Set<string>>();
    for (const r of slice) {
      const owners = ownersByNft.get(r.nft_id) ?? [];
      for (const o of owners) {
        let set = bucketsByOwner.get(o);
        if (!set) {
          set = new Set<string>();
          bucketsByOwner.set(o, set);
        }
        set.add(r.nft_id);
      }
    }

    const resolvedThisBatch = new Map<
      string,
      { editionID: string; serialNumber: string }
    >();
    for (const [owner, idSet] of bucketsByOwner) {
      const ids = Array.from(idSet).filter((id) => !resolvedThisBatch.has(id));
      if (ids.length === 0) continue;
      try {
        const matches = await runBorrowScript([owner], ids);
        for (const [id, v] of matches) resolvedThisBatch.set(id, v);
      } catch (e) {
        console.log(
          `[buyer-resolve] borrow err owner=${owner} ids=${ids.length}: ${(e as Error).message}`,
        );
      }
      await sleep(150);
    }

    const upsertRows: Array<{
      nft_id: string;
      edition_external_id: string;
      serial_number: number;
    }> = [];
    for (const r of slice) {
      const hit = resolvedThisBatch.get(r.nft_id);
      if (!hit) {
        if ((ownersByNft.get(r.nft_id) ?? []).length > 0) nftBorrowMiss++;
        continue;
      }
      const serial = Number(hit.serialNumber);
      upsertRows.push({
        nft_id: r.nft_id,
        edition_external_id: hit.editionID,
        serial_number: Number.isFinite(serial) ? serial : 0,
      });
      nftResolved++;
    }

    mapInserted += await upsertMap(upsertRows);

    lastId = slice[slice.length - 1].id;
    await saveCursor(
      lastId,
      mapInserted,
      "running",
      `tx_fetched=${txFetched} tx_failed=${txFailed} resolved=${nftResolved} borrow_miss=${nftBorrowMiss}`,
    );

    console.log(
      `[buyer-resolve] batch ${i}-${i + slice.length}: buckets=${bucketsByOwner.size} resolved=${upsertRows.length} totals tx=${txFetched}/${txFetched + txFailed} resolved=${nftResolved} miss=${nftBorrowMiss}`,
    );

    await sleep(200);
  }

  await saveCursor(
    lastId,
    mapInserted,
    "completed",
    `tx_fetched=${txFetched} tx_failed=${txFailed} resolved=${nftResolved} borrow_miss=${nftBorrowMiss}`,
  );

  console.log(`[buyer-resolve] calling promote_unmapped_sales(AllDay)`);
  const { data: promoted, error: promoteErr } = await supabase.rpc(
    "promote_unmapped_sales",
    { p_collection_id: ALLDAY_COLLECTION_ID },
  );
  if (promoteErr) {
    console.log(`[buyer-resolve] promote err: ${promoteErr.message}`);
  } else {
    console.log(`[buyer-resolve] promote result: ${JSON.stringify(promoted)}`);
  }

  console.log("");
  console.log("═══ buyer-resolve summary ═══");
  console.log(`  tx fetched:     ${txFetched}`);
  console.log(`  tx failed:      ${txFailed}`);
  console.log(`  nft resolved:   ${nftResolved}`);
  console.log(`  borrow miss:    ${nftBorrowMiss}`);
  console.log(`  map upserted:   ${mapInserted}`);
  console.log("═════════════════════════════");
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
