#!/usr/bin/env node
// scripts/backfill-allday-editions.ts
//
// One-off backfill that resolves NFL All Day nft_id → (editionID, serialNumber)
// by executing a Cadence script against the Flow Access Node, then populates
// nft_edition_map so promote_unmapped_sales() can auto-promote the unmapped
// AllDay sales sitting in unmapped_sales.
//
// Strategy:
//   1. Pull every distinct nft_id from unmapped_sales where
//      collection_id = AllDay AND resolved_at IS NULL.
//   2. In batches of 50, POST to /v1/scripts with a Cadence script that
//      iterates a list of candidate owner addresses and tries to borrow
//      the AllDay.NFT resource. When a borrow succeeds the script returns
//      {nft_id: [editionID, serialNumber]}. Unresolved ids are simply
//      absent from the returned dictionary.
//      (AllDay has no contract-level read for NFT resource fields —
//      editionID lives on the resource itself, so a borrow is required.
//      Primary candidate is the Flowty storefront escrow
//      0x3cdbb3d569211ff3, the buyer_address on every unmapped AllDay
//      sale. Most NFTs will have been forwarded out, but a few usually
//      remain, and callers may extend CANDIDATE_OWNERS later.)
//   3. Upsert resolved rows into nft_edition_map
//      ON CONFLICT (collection_id, nft_id) DO NOTHING.
//   4. Call promote_unmapped_sales(ALLDAY_COLLECTION_ID) and print the
//      returned promoted / still-unresolved counts.
//
// Resumable — progress persists to backfill_state(id='allday_edition_map')
// so re-runs pick up from the next unprocessed id instead of re-hitting
// the Access Node for ids that already succeeded or already failed in a
// prior run.
//
// Usage:  npx tsx scripts/backfill-allday-editions.ts
// Env:    SUPABASE_URL (optional), SUPABASE_SERVICE_ROLE_KEY (required)
//         ALLDAY_BATCH_SIZE       (default 50)
//         ALLDAY_OWNER_ADDRESSES  (comma-separated, extends default list)
//         ALLDAY_RESET_CURSOR     (set to "1" to start from scratch)

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://bxcqstmqfzmuolpuynti.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const FLOW_REST = "https://rest-mainnet.onflow.org";
const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070";
const BATCH_SIZE = Number(process.env.ALLDAY_BATCH_SIZE ?? 50);
const STATE_ID = "allday_edition_map";
const FLOWTY_ESCROW = "0x3cdbb3d569211ff3";

const CANDIDATE_OWNERS: string[] = (() => {
  const base = [FLOWTY_ESCROW];
  const extra = (process.env.ALLDAY_OWNER_ADDRESSES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return Array.from(new Set([...base, ...extra]));
})();

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

async function loadTargetNftIds(): Promise<string[]> {
  const ids = new Set<string>();
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("unmapped_sales")
      .select("nft_id")
      .eq("collection_id", ALLDAY_COLLECTION_ID)
      .is("resolved_at", null)
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`unmapped_sales: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data as Array<{ nft_id: string }>) {
      if (row.nft_id) ids.add(String(row.nft_id));
    }
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return Array.from(ids).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
}

async function loadCursor(): Promise<string | null> {
  if (process.env.ALLDAY_RESET_CURSOR === "1") return null;
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
    cursor: cursor,
    total_ingested: totalResolved,
    last_run_at: new Date().toISOString(),
    status,
    notes,
  });
  if (error) console.log(`[allday-backfill] saveCursor err: ${error.message}`);
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
    console.log(`[allday-backfill] upsert err: ${error.message}`);
    return 0;
  }
  return rows.length;
}

async function main() {
  console.log(
    `[allday-backfill] starting batch=${BATCH_SIZE} owners=${CANDIDATE_OWNERS.join(",")}`,
  );

  const targets = await loadTargetNftIds();
  console.log(`[allday-backfill] ${targets.length} distinct unmapped nft_ids`);
  if (targets.length === 0) {
    console.log("nothing to do.");
    return;
  }

  const cursor = await loadCursor();
  const startIdx = cursor
    ? Math.max(
        0,
        targets.findIndex((id) => BigInt(id) > BigInt(cursor)),
      )
    : 0;
  const effectiveStart = startIdx < 0 ? targets.length : startIdx;
  const work = targets.slice(effectiveStart);
  console.log(
    `[allday-backfill] cursor=${cursor ?? "<none>"} resuming at index ${effectiveStart}/${targets.length} (${work.length} to process)`,
  );

  let queried = 0;
  let resolved = 0;
  let failed = 0;
  let mapInserted = 0;
  let lastId: string | null = cursor;

  for (let i = 0; i < work.length; i += BATCH_SIZE) {
    const batch = work.slice(i, i + BATCH_SIZE);
    queried += batch.length;

    let matches: Map<string, { editionID: string; serialNumber: string }>;
    try {
      matches = await runBorrowScript(CANDIDATE_OWNERS, batch);
    } catch (e) {
      console.log(
        `[allday-backfill] batch ${i}-${i + batch.length} script err: ${(e as Error).message}`,
      );
      failed += batch.length;
      await sleep(1000);
      continue;
    }

    const rows: Array<{
      nft_id: string;
      edition_external_id: string;
      serial_number: number;
    }> = [];
    for (const id of batch) {
      const hit = matches.get(id);
      if (!hit) {
        failed++;
        continue;
      }
      const serial = Number(hit.serialNumber);
      rows.push({
        nft_id: id,
        edition_external_id: hit.editionID,
        serial_number: Number.isFinite(serial) ? serial : 0,
      });
      resolved++;
    }

    mapInserted += await upsertMap(rows);

    lastId = batch[batch.length - 1] ?? lastId;
    await saveCursor(
      lastId,
      mapInserted,
      "running",
      `queried=${queried} resolved=${resolved} failed=${failed}`,
    );

    console.log(
      `[allday-backfill] batch ${i}-${i + batch.length}: resolved=${rows.length} running_totals queried=${queried} resolved=${resolved} failed=${failed}`,
    );

    // Gentle pacing on the Access Node.
    await sleep(150);
  }

  await saveCursor(
    lastId,
    mapInserted,
    "completed",
    `queried=${queried} resolved=${resolved} failed=${failed}`,
  );

  console.log(`[allday-backfill] calling promote_unmapped_sales(...)`);
  const { data: promoted, error: promoteErr } = await supabase.rpc(
    "promote_unmapped_sales",
    { p_collection_id: ALLDAY_COLLECTION_ID },
  );
  let promotedCount: number | null = null;
  let stillUnresolved: number | null = null;
  if (promoteErr) {
    console.log(`[allday-backfill] promote err: ${promoteErr.message}`);
  } else {
    const result = promoted as unknown;
    if (typeof result === "number") {
      promotedCount = result;
    } else if (Array.isArray(result) && result.length > 0) {
      const first = result[0] as { promoted?: number; still_unresolved?: number };
      promotedCount = first?.promoted ?? null;
      stillUnresolved = first?.still_unresolved ?? null;
    } else if (result && typeof result === "object") {
      const obj = result as { promoted?: number; still_unresolved?: number };
      promotedCount = obj.promoted ?? null;
      stillUnresolved = obj.still_unresolved ?? null;
    }
    console.log(`[allday-backfill] promote result: ${JSON.stringify(promoted)}`);
  }

  console.log("");
  console.log("═══ backfill summary ═══");
  console.log(`  queried:          ${queried}`);
  console.log(`  resolved:         ${resolved}`);
  console.log(`  failed:           ${failed}`);
  console.log(`  map upserted:     ${mapInserted}`);
  console.log(`  promoted:         ${promotedCount ?? "?"}`);
  console.log(`  still_unresolved: ${stillUnresolved ?? "?"}`);
  console.log("════════════════════════");
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
