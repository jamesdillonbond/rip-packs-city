// compute-achievements — recompute a collector's profile_achievements.
//
// Callers: cron-job.org "RPC Compute Achievements" (weekly, Mon 15:00 UTC, no
// body = every owner that already has achievement rows) and
// /api/profile/achievements POST ({ owner_key }, ownership-gated there).
//
// 2026-10-17: first committed source (it ran from an uncommitted April deploy;
// R21 staging copy). That build had been a silent no-op since spring and was
// destructive when targeted:
//   * it read `saved_wallets.owner_key` and `trophy_moments.owner_key` — neither
//     column exists — and every read did `count ?? 0` without reading `error`.
//     The weekly run therefore found ZERO owners and answered ok:true (last row
//     written 2026-04-20), and a targeted run turned each failed read into a
//     zero and each zero into deleteAchievement: a failed read was a DELETE.
//   * usernames were resolved through public-api.nbatopshot.com (dead since 08-28).
//   * series_collector / big_spender read raw rows unpaged (PostgREST caps 1000).
//   * diamond_hands matched tier 'Legendary'; wallet_moments_cache.tier is
//     UPPERCASE ('LEGENDARY'), so it could never be awarded.
// Now: owners resolve through profile_bio / saved_wallets by user_id (the
// canonical profile keying); every read checks its error; a failed read SKIPS
// its achievement (the row stays as it was) instead of deleting it; row reads
// page by id; every write is checked; any error makes the response 500.
//
// The weekly run covers owners ALREADY in profile_achievements, not every user:
// the public achievements UI is parked until rewards ship
// (app/profile/[username]/ProfileClient.tsx), so minting badges for every saved
// wallet is a product decision, not this fix's.

import { createClient } from '@supabase/supabase-js';
import {
  anyTier,
  BIG_SPENDER,
  classifyOwnerKey,
  decide,
  highestTier,
  holdingsWalletKey,
  PACK_HUNTER,
  SERIES_COLLECTOR,
  serialSniperTier,
  type Tier,
  TROPHY_CURATOR,
} from '../_shared/achievements.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const INGEST_SECRET = Deno.env.get('INGEST_SECRET_TOKEN');
if (!INGEST_SECRET) {
  throw new Error('INGEST_SECRET_TOKEN env var is required');
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const PAGE = 1000;
const MAX_PAGES = 100;

type Read<T> = { ok: true; value: T } | { ok: false; error: string };

// deno-lint-ignore no-explicit-any
async function countOf(query: any): Promise<Read<number>> {
  const { count, error } = await query;
  if (error) return { ok: false, error: error.message ?? String(error) };
  if (typeof count !== 'number') return { ok: false, error: 'count missing from response' };
  return { ok: true, value: count };
}

// Every row of `table` matching `filter`, paged by the primary key. A page error
// or the page cap fails the whole read — a partial list is never returned.
async function allRows<T>(
  table: string,
  columns: string,
  // deno-lint-ignore no-explicit-any
  filter: (q: any) => any,
): Promise<Read<T[]>> {
  const out: T[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await filter(supabase.from(table).select(columns))
      .order('id', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) return { ok: false, error: `${table} page ${page}: ${error.message ?? String(error)}` };
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return { ok: true, value: out };
  }
  return { ok: false, error: `${table}: more than ${MAX_PAGES * PAGE} rows` };
}

type Owner = { userId: string | null; wallets: Read<string[]> };

// owner_key -> the wallets (and user id) behind it. A wallet list is only `ok`
// when every saved wallet resolved: one that cannot be keyed would make an empty
// holding look like a real one.
async function resolveOwner(ownerKey: string): Promise<Owner> {
  const kind = classifyOwnerKey(ownerKey);
  let userId: string | null = null;

  if (kind === 'flow_address') {
    const addr = ownerKey.trim().toLowerCase();
    const { data, error } = await supabase.from('saved_wallets').select('user_id').ilike('wallet_addr', addr);
    if (!error) {
      const ids = [...new Set((data ?? []).map((r: { user_id: string | null }) => r.user_id).filter(Boolean))];
      if (ids.length === 1) userId = ids[0] as string;
    }
    return { userId, wallets: { ok: true, value: [addr] } };
  }

  if (kind === 'user_id') {
    userId = ownerKey.trim();
  } else {
    const escaped = ownerKey.trim().replace(/[\\%_]/g, (c) => `\\${c}`);
    const { data, error } = await supabase.from('profile_bio').select('user_id').ilike('username', escaped).limit(2);
    if (error) return { userId: null, wallets: { ok: false, error: `profile_bio: ${error.message}` } };
    if (!data || data.length !== 1) {
      return { userId: null, wallets: { ok: false, error: `owner_key resolves to ${data?.length ?? 0} profiles` } };
    }
    userId = data[0].user_id as string;
  }

  const { data, error } = await supabase.from('saved_wallets').select('wallet_addr').eq('user_id', userId);
  if (error) return { userId, wallets: { ok: false, error: `saved_wallets: ${error.message}` } };
  const keys = (data ?? []).map((r: { wallet_addr: string }) => holdingsWalletKey(r.wallet_addr));
  const unresolved = keys.filter((k) => k === null).length;
  if (unresolved > 0) {
    return { userId, wallets: { ok: false, error: `${unresolved} saved wallet(s) cannot be keyed` } };
  }
  return { userId, wallets: { ok: true, value: [...new Set(keys as string[])] } };
}

async function applyAchievement(
  ownerKey: string,
  key: string,
  read: { ok: true; tier: Tier | null; progress: Record<string, unknown> } | { ok: false; error: string },
  errors: string[],
): Promise<boolean> {
  const action = decide(read.ok ? { ok: true, tier: read.tier } : read);
  if (action.kind === 'skip') {
    errors.push(`${key}: read failed, row left unchanged (${action.reason})`);
    return false;
  }
  if (action.kind === 'delete') {
    const { error } = await supabase.from('profile_achievements').delete()
      .eq('owner_key', ownerKey).eq('achievement_key', key);
    if (error) errors.push(`${key}: delete failed (${error.message})`);
    return false;
  }
  const { data: existing, error: readErr } = await supabase.from('profile_achievements')
    .select('unlocked_at').eq('owner_key', ownerKey).eq('achievement_key', key).maybeSingle();
  if (readErr) {
    errors.push(`${key}: existing-row read failed, row left unchanged (${readErr.message})`);
    return false;
  }
  const now = new Date().toISOString();
  const { error } = await supabase.from('profile_achievements').upsert({
    owner_key: ownerKey,
    achievement_key: key,
    tier: action.tier,
    progress: read.ok ? read.progress : {},
    unlocked_at: existing?.unlocked_at ?? now,
    updated_at: now,
  }, { onConflict: 'owner_key,achievement_key' });
  if (error) {
    errors.push(`${key}: upsert failed (${error.message})`);
    return false;
  }
  return true;
}

async function computeForUser(ownerKey: string): Promise<{ computed: number; errors: string[] }> {
  const errors: string[] = [];
  let computed = 0;
  const owner = await resolveOwner(ownerKey);
  const w = owner.wallets;
  const walletFail = (key: string) => ({ ok: false as const, error: w.ok ? '' : `${key}: ${w.error}` });

  // 1. pack_hunter
  if (!w.ok) await applyAchievement(ownerKey, 'pack_hunter', walletFail('wallets'), errors);
  else {
    const c = w.value.length === 0 ? { ok: true as const, value: 0 } : await countOf(
      supabase.from('moment_acquisitions').select('*', { count: 'exact', head: true })
        .in('wallet', w.value).eq('acquisition_method', 'pack_pull'),
    );
    if (await applyAchievement(ownerKey, 'pack_hunter', c.ok
      ? { ok: true, tier: highestTier(PACK_HUNTER, c.value), progress: { count: c.value } }
      : c, errors)) computed++;
  }

  // 2. diamond_hands — a Legendary held 180+ days
  if (!w.ok) await applyAchievement(ownerKey, 'diamond_hands', walletFail('wallets'), errors);
  else {
    const c = w.value.length === 0 ? { ok: true as const, value: 0 } : await countOf(
      supabase.from('wallet_moments_cache').select('*', { count: 'exact', head: true })
        .in('wallet_address', w.value).eq('tier', 'LEGENDARY')
        .lt('acquired_at', new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString()),
    );
    if (await applyAchievement(ownerKey, 'diamond_hands', c.ok
      ? { ok: true, tier: anyTier(c.value), progress: { count: c.value } }
      : c, errors)) computed++;
  }

  // 3. serial_sniper — low serials held
  if (!w.ok) await applyAchievement(ownerKey, 'serial_sniper', walletFail('wallets'), errors);
  else {
    const zero = { ok: true as const, value: 0 };
    const lowSerials = (max: number) => countOf(
      supabase.from('wallet_moments_cache').select('*', { count: 'exact', head: true })
        .in('wallet_address', w.value).gt('serial_number', 0).lte('serial_number', max),
    );
    const c10 = w.value.length === 0 ? zero : await lowSerials(10);
    const c100 = w.value.length === 0 ? zero : await lowSerials(100);
    if (await applyAchievement(ownerKey, 'serial_sniper', c10.ok && c100.ok
      ? { ok: true, tier: serialSniperTier(c10.value, c100.value), progress: { serial10: c10.value, serial100: c100.value } }
      : { ok: false, error: (!c10.ok ? c10.error : '') || (!c100.ok ? c100.error : '') }, errors)) computed++;
  }

  // 4. trophy_curator — trophy_moments is keyed by user_id
  if (!owner.userId) {
    await applyAchievement(ownerKey, 'trophy_curator', { ok: false, error: 'owner_key has no single user_id' }, errors);
  } else {
    const c = await countOf(
      supabase.from('trophy_moments').select('*', { count: 'exact', head: true }).eq('user_id', owner.userId),
    );
    if (await applyAchievement(ownerKey, 'trophy_curator', c.ok
      ? { ok: true, tier: highestTier(TROPHY_CURATOR, c.value), progress: { count: c.value } }
      : c, errors)) computed++;
  }

  // 5. challenge_accepted
  if (!w.ok) await applyAchievement(ownerKey, 'challenge_accepted', walletFail('wallets'), errors);
  else {
    const c = w.value.length === 0 ? { ok: true as const, value: 0 } : await countOf(
      supabase.from('moment_acquisitions').select('*', { count: 'exact', head: true })
        .in('wallet', w.value).eq('acquisition_method', 'challenge_reward'),
    );
    if (await applyAchievement(ownerKey, 'challenge_accepted', c.ok
      ? { ok: true, tier: anyTier(c.value), progress: { count: c.value } }
      : c, errors)) computed++;
  }

  // 6. series_collector — distinct series held (every row, paged)
  if (!w.ok) await applyAchievement(ownerKey, 'series_collector', walletFail('wallets'), errors);
  else {
    const rows = w.value.length === 0 ? { ok: true as const, value: [] as { series_number: number }[] }
      : await allRows<{ series_number: number }>('wallet_moments_cache', 'series_number',
        (q) => q.in('wallet_address', w.value).not('series_number', 'is', null));
    const n = rows.ok ? new Set(rows.value.map((r) => r.series_number)).size : 0;
    if (await applyAchievement(ownerKey, 'series_collector', rows.ok
      ? { ok: true, tier: highestTier(SERIES_COLLECTOR, n), progress: { count: n } }
      : rows, errors)) computed++;
  }

  // 7. big_spender — marketplace spend (every row, paged)
  if (!w.ok) await applyAchievement(ownerKey, 'big_spender', walletFail('wallets'), errors);
  else {
    const rows = w.value.length === 0 ? { ok: true as const, value: [] as { buy_price: number }[] }
      : await allRows<{ buy_price: number }>('moment_acquisitions', 'buy_price',
        (q) => q.in('wallet', w.value).eq('acquisition_method', 'marketplace').gt('buy_price', 0));
    const spend = rows.ok ? rows.value.reduce((s, r) => s + Number(r.buy_price), 0) : 0;
    if (await applyAchievement(ownerKey, 'big_spender', rows.ok
      ? { ok: true, tier: highestTier(BIG_SPENDER, spend), progress: { amount: Math.round(spend) } }
      : rows, errors)) computed++;
  }

  return { computed, errors };
}

Deno.serve(async (req: Request) => {
  const auth = req.headers.get('authorization') ?? '';
  const token = auth.replace('Bearer ', '').trim();
  if (token !== SERVICE_ROLE_KEY && token !== INGEST_SECRET) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  try {
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const targetKey: string | undefined = body?.owner_key;

    let keys: string[];
    if (targetKey) {
      keys = [targetKey];
    } else {
      const owners = await allRows<{ owner_key: string }>('profile_achievements', 'owner_key', (q) => q);
      if (!owners.ok) {
        return new Response(JSON.stringify({ ok: false, error: owners.error }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      keys = [...new Set(owners.value.map((r) => r.owner_key))];
    }

    const results: Record<string, { computed: number; errors: string[] }> = {};
    for (const key of keys) {
      results[key] = await computeForUser(key);
      await new Promise((r) => setTimeout(r, 200));
    }

    const totalComputed = Object.values(results).reduce((s, r) => s + r.computed, 0);
    const allErrors = Object.entries(results).flatMap(([k, r]) => r.errors.map((e) => k + ' / ' + e));
    const ok = allErrors.length === 0;
    return new Response(JSON.stringify({ ok, users: keys.length, computed: totalComputed, errors: allErrors }), {
      status: ok ? 200 : 500,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[compute-achievements]', err);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500 });
  }
});
