#!/usr/bin/env node
/**
 * fetch-allday-collection.mjs
 *
 * Fetches moments from the nflallday.com GQL API using a browser session, then
 * updates wallet_moments_cache with real editionID + serialNumber.
 *
 * ⚠ CREDENTIALS COME FROM THE ENVIRONMENT — NEVER PASTE A LIVE SESSION IN HERE.
 * This repo is PUBLIC. An earlier revision of this file hardcoded live
 * `cf_clearance` / `nfl_session` cookies and an RS256 id-token containing a real
 * email, legal name and Flow account id; on 2026-08-03 the whole file had to be
 * purged from git history with `git filter-repo` and force-pushed, which
 * invalidated every `git revert <sha>` path recorded in the ledger. Do not
 * recreate that. Grab the values from a devtools cURL and export them:
 *
 *   export ALLDAY_COOKIES="..."   # the full Cookie header
 *   export ALLDAY_ID_TOKEN="..."  # the Authorization bearer token
 *   export NEXT_PUBLIC_SUPABASE_URL="..." SUPABASE_SERVICE_ROLE_KEY="..."
 *   node scripts/fetch-allday-collection.mjs
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const COOKIES = process.env.ALLDAY_COOKIES;
const ID_TOKEN = process.env.ALLDAY_ID_TOKEN;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}
if (!COOKIES || !ID_TOKEN) {
  console.error('Missing ALLDAY_COOKIES / ALLDAY_ID_TOKEN. See the header comment.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const AD_COLLECTION_ID = 'dee28451-5d62-409e-a1ad-a83f763ac070';

console.log('Configured. Restore the walk/upsert body from git history before use:');
console.log('  git log --all --oneline -- scripts/  # find the pre-purge revision');
console.log(`  supabase=${!!supabase} collection=${AD_COLLECTION_ID}`);
