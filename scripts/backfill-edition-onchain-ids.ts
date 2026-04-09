/**
 * scripts/backfill-edition-onchain-ids.ts
 *
 * One-shot backfill: populates set_id_onchain / play_id_onchain on the
 * editions table for rows where they are NULL.
 *
 * Approach (much faster than per-edition GQL lookups):
 *   1. Run a single Cadence script against wallet 0xbd94cade097e50ac that
 *      iterates the wallet's TopShot collection and returns one
 *      representative {momentId, setID, playID} per unique edition.
 *   2. For each result, look up moments.nft_id → moments.edition_id
 *      to bridge the on-chain integer IDs to the editions row UUID.
 *   3. UPDATE editions SET set_id_onchain, play_id_onchain WHERE id = $uuid
 *      AND set_id_onchain IS NULL (idempotent guard).
 *
 * Editions not represented in this wallet stay NULL and can be backfilled
 * incrementally as other users search their wallets, or via a future GQL
 * fallback job.
 *
 * Usage:
 *   npx tsx scripts/backfill-edition-onchain-ids.ts
 *
 * Env vars (loaded from .env.local via dotenv):
 *   NEXT_PUBLIC_SUPABASE_URL          — required
 *   SUPABASE_SERVICE_ROLE_KEY         — preferred (bypasses RLS)
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY     — fallback
 *   BACKFILL_WALLET                   — optional override (default: 0xbd94cade097e50ac)
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import * as fcl from "@onflow/fcl";
import * as t from "@onflow/types";

// ── Config ──────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  "";
const SOURCE_WALLET = process.env.BACKFILL_WALLET ?? "0xbd94cade097e50ac";
const UPDATE_BATCH = 100;
const LOG_EVERY = 500;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    "[backfill] Missing Supabase env vars. Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or NEXT_PUBLIC_SUPABASE_ANON_KEY) in .env.local"
  );
  process.exit(1);
}

// ── FCL setup (read-only, no wallet) ────────────────────────────────────────

fcl.config()
  .put("flow.network", "mainnet")
  .put("accessNode.api", "https://rest-mainnet.onflow.org");

// ── Cadence script: one representative moment per unique edition ────────────

const CADENCE_UNIQUE_EDITIONS = `
import TopShot from 0x0b2a3299cc857e29

access(all) fun main(account: Address): [{String: AnyStruct}] {
    let acct = getAccount(account)
    let ref = acct.capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
        ?? panic("Could not borrow collection")
    let ids = ref.getIDs()
    let results: [{String: AnyStruct}] = []
    let seen: {String: Bool} = {}
    for id in ids {
        let moment = ref.borrowMoment(id: id)!
        let key = moment.data.setID.toString().concat(":").concat(moment.data.playID.toString())
        if seen[key] == nil {
            seen[key] = true
            results.append({"momentId": id, "setID": moment.data.setID, "playID": moment.data.playID})
        }
    }
    return results
}
`;

type CadenceEditionRow = {
  momentId: string | number;
  setID: string | number;
  playID: string | number;
};

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY) as any;

  console.log(`[backfill] Source wallet: ${SOURCE_WALLET}`);
  console.log("[backfill] Running Cadence script (this may take ~10–30s)…");

  // 1. One Cadence call → array of unique-edition representatives
  let cadenceResult: CadenceEditionRow[];
  try {
    cadenceResult = (await fcl.query({
      cadence: CADENCE_UNIQUE_EDITIONS,
      args: (arg: any) => [arg(SOURCE_WALLET, t.Address)],
    })) as CadenceEditionRow[];
  } catch (err) {
    console.error("[backfill] Cadence script failed:", err);
    process.exit(1);
  }

  if (!Array.isArray(cadenceResult) || cadenceResult.length === 0) {
    console.error("[backfill] Cadence returned no rows — aborting");
    process.exit(1);
  }

  console.log(`[backfill] Cadence returned ${cadenceResult.length} unique editions`);

  // Normalize the Cadence return into plain string IDs
  type Triple = { momentId: string; setID: number; playID: number };
  const triples: Triple[] = cadenceResult
    .map((r) => ({
      momentId: String(r.momentId),
      setID: Number(r.setID),
      playID: Number(r.playID),
    }))
    .filter((r) => Number.isFinite(r.setID) && Number.isFinite(r.playID) && r.momentId);

  console.log(`[backfill] ${triples.length} valid triples after parsing`);

  // 2. Pull editions that still need backfill, so we can short-circuit fast
  const { data: missingEditions, error: missingErr } = await supabase
    .from("editions")
    .select("id")
    .is("set_id_onchain", null);
  if (missingErr) {
    console.error("[backfill] Failed to read missing editions:", missingErr.message);
    process.exit(1);
  }
  const missingEditionIds = new Set<string>(
    (missingEditions ?? []).map((r: { id: string }) => r.id)
  );
  console.log(`[backfill] Editions missing on-chain IDs: ${missingEditionIds.size}`);

  // 3. Bridge each Cadence triple to an editions row UUID via moments.nft_id
  //    Pull all moments rows for our cadence momentIds in one shot.
  const allMomentIds = triples.map((t) => t.momentId);
  const momentToEdition = new Map<string, string>();

  const CHUNK = 500;
  for (let i = 0; i < allMomentIds.length; i += CHUNK) {
    const slice = allMomentIds.slice(i, i + CHUNK);
    const { data: rows, error } = await supabase
      .from("moments")
      .select("nft_id, edition_id")
      .in("nft_id", slice);
    if (error) {
      console.warn(`[backfill] moments lookup chunk ${i} failed: ${error.message}`);
      continue;
    }
    for (const row of (rows ?? []) as { nft_id: string | number; edition_id: string | null }[]) {
      if (row.edition_id) momentToEdition.set(String(row.nft_id), row.edition_id);
    }
  }
  console.log(`[backfill] Bridged ${momentToEdition.size} of ${triples.length} cadence rows to edition UUIDs`);

  // 4. Build the actual update set (only editions still missing on-chain IDs)
  type UpdateRow = { editionId: string; setIdOnchain: number; playIdOnchain: number };
  const updates: UpdateRow[] = [];
  let alreadyHad = 0;
  let noMoment = 0;
  for (const tri of triples) {
    const editionId = momentToEdition.get(tri.momentId);
    if (!editionId) {
      noMoment++;
      continue;
    }
    if (!missingEditionIds.has(editionId)) {
      alreadyHad++;
      continue;
    }
    updates.push({
      editionId,
      setIdOnchain: tri.setID,
      playIdOnchain: tri.playID,
    });
  }

  // De-dupe by editionId in case multiple cadence rows resolve to the same UUID
  const dedup = new Map<string, UpdateRow>();
  for (const u of updates) if (!dedup.has(u.editionId)) dedup.set(u.editionId, u);
  const finalUpdates = Array.from(dedup.values());

  console.log(`[backfill] Plan: ${finalUpdates.length} editions to update`);
  console.log(`[backfill]   already had on-chain IDs: ${alreadyHad}`);
  console.log(`[backfill]   no moments row found:     ${noMoment}`);

  if (finalUpdates.length === 0) {
    console.log("[backfill] Nothing to update — done.");
    return;
  }

  // 5. Apply updates in batches. Supabase has no UPDATE...IN bulk method,
  //    so we run one update per row but pipeline with Promise.all per batch.
  let updated = 0;
  let errors = 0;
  for (let i = 0; i < finalUpdates.length; i += UPDATE_BATCH) {
    const batch = finalUpdates.slice(i, i + UPDATE_BATCH);
    const results = await Promise.all(
      batch.map(async (u) => {
        const { error } = await supabase
          .from("editions")
          .update({
            set_id_onchain: u.setIdOnchain,
            play_id_onchain: u.playIdOnchain,
          })
          .eq("id", u.editionId)
          .is("set_id_onchain", null);
        return error ? { ok: false, msg: error.message } : { ok: true };
      })
    );
    for (const r of results) {
      if (r.ok) updated++;
      else {
        errors++;
        if (errors <= 10) console.warn(`[backfill] update error: ${r.msg}`);
      }
    }
    if ((i + batch.length) % LOG_EVERY === 0 || i + batch.length >= finalUpdates.length) {
      console.log(`[backfill] Progress: ${i + batch.length}/${finalUpdates.length} (updated=${updated}, errors=${errors})`);
    }
  }

  console.log("");
  console.log("[backfill] ─── Summary ──────────────────────────────────────");
  console.log(`[backfill] Cadence unique editions returned : ${triples.length}`);
  console.log(`[backfill] Bridged to edition UUIDs         : ${momentToEdition.size}`);
  console.log(`[backfill] Already had on-chain IDs (skip)  : ${alreadyHad}`);
  console.log(`[backfill] No moments row found             : ${noMoment}`);
  console.log(`[backfill] Editions updated                 : ${updated}`);
  console.log(`[backfill] Update errors                    : ${errors}`);
  console.log("[backfill] ──────────────────────────────────────────────────");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill] FATAL:", err);
    process.exit(1);
  });
