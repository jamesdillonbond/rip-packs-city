#!/usr/bin/env node
// scripts/smoke-replace-topshot-moments-batch-concurrency.mjs
//
// Fires 4 concurrent calls of replace_topshot_moments_batch with the same
// (edition_id, serial_number) pair but different (nft_id, owner_address)
// payloads to confirm the 2026-05-17 race-safe rewrite holds. Expectation:
// all 4 calls return without throwing 23505 on either moments_nft_id_key
// or moments_edition_id_serial_number_key, and the final row in moments
// for the test (edition_id, serial_number) matches ONE of the payloads.
//
// Requires .env.local with NEXT_PUBLIC_SUPABASE_URL +
// SUPABASE_SERVICE_ROLE_KEY (or env-injected at runtime). Run via:
//   node scripts/smoke-replace-topshot-moments-batch-concurrency.mjs

import { createClient } from "@supabase/supabase-js";
import { config as loadDotenv } from "dotenv";

loadDotenv({ path: ".env.local" });
loadDotenv({ path: ".env" });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error("missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd";

async function pickRealEdition() {
  // Pick any real TopShot edition so the FK to editions(id) holds.
  const { data, error } = await sb
    .from("editions")
    .select("id")
    .eq("collection_id", TOPSHOT_COLLECTION_ID)
    .limit(1);
  if (error) throw new Error(`pick edition: ${error.message}`);
  if (!data || data.length === 0) throw new Error("no TopShot editions found");
  return data[0].id;
}

async function cleanup(editionId, serial) {
  // Clear any test rows we created in prior runs.
  const { error } = await sb
    .from("moments")
    .delete()
    .eq("collection_id", TOPSHOT_COLLECTION_ID)
    .eq("edition_id", editionId)
    .eq("serial_number", serial);
  if (error) console.warn(`cleanup warn: ${error.message}`);
}

async function fireOnce(label, editionId, serial) {
  // Each call ships a DIFFERENT nft_id but the SAME (edition_id, serial).
  // The race-safe rewrite must resolve to a single winning row without
  // 23505 on either unique constraint.
  const payload = [{
    nft_id: `smoke-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    edition_id: editionId,
    serial_number: serial,
    owner_address: `0x_smoke_${label}`,
  }];
  const t0 = Date.now();
  const { data, error } = await sb.rpc("replace_topshot_moments_batch", { payload });
  return {
    label,
    nft_id: payload[0].nft_id,
    elapsed_ms: Date.now() - t0,
    rpc_result: data,
    error: error?.message ?? null,
  };
}

async function main() {
  const editionId = await pickRealEdition();
  const serial = 999_888_777; // wildly OOB; almost certainly unused
  console.log(`edition_id=${editionId} serial=${serial}`);

  await cleanup(editionId, serial);

  const promises = [0, 1, 2, 3].map((i) => fireOnce(`call_${i}`, editionId, serial));
  const results = await Promise.all(promises);

  const failures = results.filter((r) => r.error);
  for (const r of results) {
    console.log(`  ${r.label}: elapsed=${r.elapsed_ms}ms err=${r.error ?? "ok"} nft=${r.nft_id}`);
  }

  // Verify the final state — exactly ONE row exists for (edition_id, serial),
  // with an nft_id that matches one of the four payloads.
  const { data: rows, error: rdErr } = await sb
    .from("moments")
    .select("nft_id, owner_address, updated_at")
    .eq("collection_id", TOPSHOT_COLLECTION_ID)
    .eq("edition_id", editionId)
    .eq("serial_number", serial);
  if (rdErr) {
    console.error(`post-check read err: ${rdErr.message}`);
    process.exit(2);
  }
  console.log(`final row count for (${editionId}, ${serial}): ${rows.length}`);
  for (const row of rows) console.log(`  -> ${row.nft_id} | ${row.owner_address} | ${row.updated_at}`);

  await cleanup(editionId, serial);

  if (failures.length > 0) {
    console.error(`FAIL: ${failures.length}/4 calls returned an error`);
    process.exit(3);
  }
  if (rows.length !== 1) {
    console.error(`FAIL: expected exactly 1 row, got ${rows.length}`);
    process.exit(4);
  }
  const acceptedNftIds = new Set(results.map((r) => r.nft_id));
  if (!acceptedNftIds.has(rows[0].nft_id)) {
    console.error(`FAIL: final nft_id ${rows[0].nft_id} did not match any payload`);
    process.exit(5);
  }
  console.log("PASS: all 4 concurrent calls succeeded, exactly 1 final row, nft_id matches a payload");
}

main().catch((err) => {
  console.error(err);
  process.exit(99);
});
