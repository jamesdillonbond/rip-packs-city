#!/usr/bin/env node
/**
 * resolve-allday-editions.mjs
 * 
 * Scans Flow blockchain MomentNFTMinted events to map locked NFT IDs → editionID + serialNumber.
 * Runs locally on your machine — no Cloudflare blocking.
 * 
 * Usage:
 *   $env:NEXT_PUBLIC_SUPABASE_URL="https://bxcqstmqfzmuolpuynti.supabase.co"
 *   $env:SUPABASE_SERVICE_ROLE_KEY="<your key>"
 *   node scripts/resolve-allday-editions.mjs
 * 
 * Resumes automatically from last checkpoint. Run multiple times until complete.
 */

import { createClient } from '@supabase/supabase-js';

const FLOW_API = 'https://rest-mainnet.onflow.org/v1';
const EVENT_TYPE = 'A.e4cf4bdc1751c65d.AllDay.MomentNFTMinted';
const AD_COLLECTION_ID = 'dee28451-5d62-409e-a1ad-a83f763ac070';
const BLOCK_CHUNK = 249; // Flow max: 250 per event query
const CALLS_PER_BATCH = 200; // API calls per run before pausing for progress report

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Load locked IDs needing resolution ───
async function loadUnresolved() {
  const { data, error } = await supabase
    .from('wallet_moments_cache')
    .select('moment_id')
    .eq('collection_id', AD_COLLECTION_ID)
    .like('edition_key', 'locked_%')
    .limit(10000);
  if (error) throw new Error('Supabase: ' + error.message);
  return new Set(data.map(r => parseInt(r.moment_id)));
}

// ─── Load or create checkpoint ───
async function loadCheckpoint() {
  const { data } = await supabase
    .from('collection_config')
    .select('metadata')
    .eq('collection_id', AD_COLLECTION_ID)
    .single();
  return data?.metadata?.event_scan_block || null;
}

async function saveCheckpoint(block) {
  // Store in collection_config metadata
  const { data: existing } = await supabase
    .from('collection_config')
    .select('metadata')
    .eq('collection_id', AD_COLLECTION_ID)
    .single();
  const meta = existing?.metadata || {};
  meta.event_scan_block = block;
  await supabase
    .from('collection_config')
    .update({ metadata: meta })
    .eq('collection_id', AD_COLLECTION_ID);
}

// ─── Query Flow events ───
async function queryEvents(startHeight, endHeight) {
  const url = `${FLOW_API}/events?type=${encodeURIComponent(EVENT_TYPE)}&start_height=${startHeight}&end_height=${endHeight}`;
  const res = await fetch(url);
  if (!res.ok) {
    const status = res.status;
    if (status === 400) return []; // invalid range
    if (status === 429) {
      console.log('  Rate limited, waiting 5s...');
      await new Promise(r => setTimeout(r, 5000));
      return queryEvents(startHeight, endHeight); // retry
    }
    throw new Error(`Flow ${status}`);
  }
  const data = await res.json();
  const events = [];
  for (const block of data) {
    for (const ev of (block.events || [])) {
      try {
        const payload = JSON.parse(Buffer.from(ev.payload, 'base64').toString());
        const fields = payload.value?.fields || [];
        const id = parseInt(fields.find(f => f.name === 'id')?.value?.value || '0');
        const editionID = parseInt(fields.find(f => f.name === 'editionID')?.value?.value || '0');
        const serialNumber = parseInt(fields.find(f => f.name === 'serialNumber')?.value?.value || '0');
        if (id > 0) events.push({ id, editionID, serialNumber });
      } catch {}
    }
  }
  return events;
}

// ─── Update Supabase with resolved editions ───
async function resolveMatches(matches, lockedIds) {
  // Also look up edition metadata
  const editionKeys = [...new Set(matches.map(m => String(m.editionID)))];
  const { data: editions } = await supabase
    .from('editions')
    .select('external_id, player_name, set_name, tier, series')
    .eq('collection_id', AD_COLLECTION_ID)
    .in('external_id', editionKeys);
  
  const edMap = new Map();
  for (const ed of (editions || [])) edMap.set(ed.external_id, ed);

  let resolved = 0;
  for (const m of matches) {
    const ed = edMap.get(String(m.editionID));
    const update = {
      edition_key: String(m.editionID),
      serial_number: m.serialNumber,
    };
    if (ed) {
      update.player_name = ed.player_name;
      update.set_name = ed.set_name;
      update.tier = ed.tier;
      update.series_number = ed.series;
    }

    const { error } = await supabase
      .from('wallet_moments_cache')
      .update(update)
      .eq('moment_id', String(m.id))
      .eq('collection_id', AD_COLLECTION_ID);

    if (!error) {
      lockedIds.delete(m.id);
      resolved++;
    }
  }
  return resolved;
}

// ─── Get latest sealed block ───
async function getLatestBlock() {
  const res = await fetch(`${FLOW_API}/blocks?height=sealed`);
  const data = await res.json();
  return parseInt(data[0]?.header?.height || '0');
}

// ─── Main ───
async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  ALL DAY EDITION RESOLVER');
  console.log('  Scanning MomentNFTMinted events on Flow');
  console.log('═══════════════════════════════════════════');

  const lockedIds = await loadUnresolved();
  console.log(`\n  Unresolved locked moments: ${lockedIds.size}`);
  
  if (lockedIds.size === 0) {
    console.log('  All editions already resolved!');
    return;
  }

  // Determine scan range
  const latestBlock = await getLatestBlock();
  const checkpoint = await loadCheckpoint();
  
  // Scan backwards from latest. If checkpoint exists, resume from there.
  let scanFrom = checkpoint || latestBlock;
  
  // AllDay launched ~2021. Flow mainnet block ~20M at that time.
  // Scan down to block 15M to cover all AllDay history.
  const scanTo = 15_000_000;
  
  console.log(`  Latest block: ${latestBlock}`);
  console.log(`  Scanning from: ${scanFrom} down to ${scanTo}`);
  console.log(`  Estimated API calls: ${Math.ceil((scanFrom - scanTo) / BLOCK_CHUNK)}`);
  console.log('');

  let totalResolved = 0;
  let totalEvents = 0;
  let callCount = 0;
  const startTime = Date.now();

  for (let end = scanFrom; end > scanTo; end -= BLOCK_CHUNK) {
    const start = Math.max(end - BLOCK_CHUNK, scanTo);
    callCount++;

    try {
      const events = await queryEvents(start, end);
      totalEvents += events.length;

      if (events.length > 0) {
        // Filter for our locked IDs
        const matches = events.filter(e => lockedIds.has(e.id));
        if (matches.length > 0) {
          const resolved = await resolveMatches(matches, lockedIds);
          totalResolved += resolved;
          const names = matches.slice(0, 3).map(m => `NFT ${m.id}→ed${m.editionID}/#${m.serialNumber}`);
          console.log(`  ✓ Block ${start}: ${events.length} mints, ${matches.length} matches → ${names.join(', ')}${matches.length > 3 ? '...' : ''}`);
        }
      }

      // Progress report every 100 calls
      if (callCount % 100 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const blocksScanned = scanFrom - end;
        const pct = ((blocksScanned / (scanFrom - scanTo)) * 100).toFixed(1);
        console.log(`  [${callCount} calls, ${elapsed}s] ${pct}% scanned, ${totalEvents} events, ${totalResolved} resolved, ${lockedIds.size} remaining`);
        
        // Save checkpoint
        await saveCheckpoint(end);
      }

      // Stop if all resolved
      if (lockedIds.size === 0) {
        console.log('\n  🎉 ALL LOCKED EDITIONS RESOLVED!');
        break;
      }

      // Pause every N calls to avoid rate limits
      if (callCount % CALLS_PER_BATCH === 0) {
        await saveCheckpoint(end);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        console.log(`\n  ── Checkpoint at block ${end} (${elapsed}s elapsed) ──`);
        console.log(`  Resolved: ${totalResolved}, Remaining: ${lockedIds.size}`);
        console.log(`  Run again to continue from this point.\n`);
      }

    } catch (e) {
      console.error(`  Error at block ${start}: ${e.message}`);
      await new Promise(r => setTimeout(r, 2000));
    }

    await new Promise(r => setTimeout(r, 30)); // Rate limit: ~30 calls/sec
  }

  // Final save
  await saveCheckpoint(scanTo);
  
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log('\n═══════════════════════════════════════════');
  console.log(`  DONE in ${elapsed}s`);
  console.log(`  Total events seen: ${totalEvents}`);
  console.log(`  Editions resolved: ${totalResolved}`);
  console.log(`  Still unresolved: ${lockedIds.size}`);
  console.log('═══════════════════════════════════════════');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
