#!/usr/bin/env node
/**
 * update-allday-from-json.mjs (v2 - fixed)
 *
 * Reads allday-moments.json (downloaded from browser console script)
 * and updates wallet_moments_cache in Supabase with real editionID + serialNumber.
 *
 * Usage:
 *   $env:NEXT_PUBLIC_SUPABASE_URL="https://bxcqstmqfzmuolpuynti.supabase.co"
 *   $env:SUPABASE_SERVICE_ROLE_KEY="YOUR_KEY"
 *   node scripts/update-allday-from-json.mjs
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('Missing env vars'); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const AD_COLLECTION_ID = 'dee28451-5d62-409e-a1ad-a83f763ac070';

// Read the JSON file
let allMoments;
try {
  const raw = readFileSync('scripts/allday-moments.json', 'utf-8');
  allMoments = JSON.parse(raw);
  console.log(`Loaded ${allMoments.length} moments from allday-moments.json`);
} catch (e) {
  console.error('Failed to read scripts/allday-moments.json:', e.message);
  console.error('Make sure the file exists in the scripts/ directory');
  process.exit(1);
}

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  ALL DAY SUPABASE UPDATER (v2 - fixed)');
  console.log('═══════════════════════════════════════════\n');

  let updated = 0;
  let inserted = 0;
  let errors = 0;

  for (let i = 0; i < allMoments.length; i += 50) {
    const batch = allMoments.slice(i, i + 50);

    for (const m of batch) {
      // Try to update existing locked record first
      const { data: existing } = await supabase
        .from('wallet_moments_cache')
        .select('moment_id')
        .eq('moment_id', m.nftId)
        .eq('collection_id', AD_COLLECTION_ID)
        .limit(1);

      if (existing && existing.length > 0) {
        // Update existing record with real edition data
        // NOTE: wallet_moments_cache does NOT have team_name column
        const { error } = await supabase
          .from('wallet_moments_cache')
          .update({
            edition_key: m.editionId,
            serial_number: m.serialNumber,
            player_name: m.playerName,
            set_name: m.setName,
            tier: m.tier,
          })
          .eq('moment_id', m.nftId)
          .eq('collection_id', AD_COLLECTION_ID);
        if (error) { errors++; console.error(`Update error for ${m.nftId}:`, error.message); } else { updated++; }
      } else {
        // Insert new record (moments not previously discovered by scanner)
        const { error } = await supabase
          .from('wallet_moments_cache')
          .upsert({
            moment_id: m.nftId,
            collection_id: AD_COLLECTION_ID,
            wallet_address: '0xbd94cade097e50ac',
            edition_key: m.editionId,
            serial_number: m.serialNumber,
            player_name: m.playerName,
            set_name: m.setName,
            tier: m.tier,
          }, { onConflict: 'wallet_address,moment_id' });
        if (error) { errors++; console.error(`Insert error for ${m.nftId}:`, error.message); } else { inserted++; }
      }
    }

    if ((i + 50) % 500 === 0 || i + 50 >= allMoments.length) {
      console.log(`  Progress: ${Math.min(i + 50, allMoments.length)}/${allMoments.length} — updated: ${updated}, inserted: ${inserted}, errors: ${errors}`);
    }
  }

  console.log('\n═══════════════════════════════════════════');
  console.log(`  DONE! Updated: ${updated}, Inserted: ${inserted}, Errors: ${errors}`);
  console.log('═══════════════════════════════════════════');

  // Verify results
  const { count } = await supabase
    .from('wallet_moments_cache')
    .select('*', { count: 'exact', head: true })
    .eq('collection_id', AD_COLLECTION_ID);
  console.log(`\n  All Day moments in wallet_moments_cache: ${count}`);

  const { count: lockedCount } = await supabase
    .from('wallet_moments_cache')
    .select('*', { count: 'exact', head: true })
    .eq('collection_id', AD_COLLECTION_ID)
    .like('edition_key', 'locked_%');
  console.log(`  Still locked (unresolved): ${lockedCount}`);
  console.log(`  Resolved: ${(count || 0) - (lockedCount || 0)}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
