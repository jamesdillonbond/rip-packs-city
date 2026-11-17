import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const INGEST_SECRET = Deno.env.get('INGEST_SECRET_TOKEN');
if (!INGEST_SECRET) {
  throw new Error('INGEST_SECRET_TOKEN env var is required');
}
const TS_GQL = 'https://public-api.nbatopshot.com/graphql';

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// ─── Tier helpers ────────────────────────────────
function highestTier(thresholds: { tier: string; min: number }[], count: number): string | null {
  let best: string | null = null;
  for (const t of thresholds) {
    if (count >= t.min) best = t.tier;
  }
  return best;
}

// ─── Resolve username → 0x address ──────────────────
async function resolveWallet(walletAddr: string): Promise<string | null> {
  if (walletAddr.startsWith('0x')) return walletAddr;
  try {
    const res = await fetch(TS_GQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query($username:String!){getUserProfileByUsername(input:{username:$username}){publicInfo{flowAddress}}}`,
        variables: { username: walletAddr },
      }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const addr = json?.data?.getUserProfileByUsername?.publicInfo?.flowAddress ?? null;
    if (!addr) return null;
    return addr.startsWith('0x') ? addr : '0x' + addr;
  } catch {
    return null;
  }
}

// ─── Compute achievements for one owner_key ──────────────
async function computeForUser(ownerKey: string): Promise<{ computed: number; errors: string[] }> {
  const errors: string[] = [];
  let computed = 0;

  // Resolve all wallet addresses for this owner
  const { data: walletRows } = await supabase
    .from('saved_wallets')
    .select('wallet_addr')
    .eq('owner_key', ownerKey);

  const wallets: string[] = [];
  for (const row of (walletRows ?? [])) {
    const addr = await resolveWallet(row.wallet_addr);
    if (addr) wallets.push(addr);
  }

  // ── 1. pack_hunter ──────────────────────────────────
  try {
    let packCount = 0;
    if (wallets.length > 0) {
      const { count } = await supabase
        .from('moment_acquisitions')
        .select('*', { count: 'exact', head: true })
        .in('wallet', wallets)
        .eq('acquisition_method', 'pack_pull');
      packCount = count ?? 0;
    }
    const tier = highestTier([
      { tier: 'bronze', min: 10 },
      { tier: 'silver', min: 50 },
      { tier: 'gold', min: 200 },
      { tier: 'platinum', min: 500 },
    ], packCount);
    if (tier) {
      await upsertAchievement(ownerKey, 'pack_hunter', tier, { count: packCount });
      computed++;
    } else {
      await deleteAchievement(ownerKey, 'pack_hunter');
    }
  } catch (e) { errors.push('pack_hunter: ' + String(e)); }

  // ── 2. diamond_hands ───────────────────────────────
  try {
    let legCount = 0;
    if (wallets.length > 0) {
      const { count } = await supabase
        .from('wallet_moments_cache')
        .select('*', { count: 'exact', head: true })
        .in('wallet_address', wallets)
        .eq('tier', 'Legendary')
        .lt('acquired_at', new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString());
      legCount = count ?? 0;
    }
    if (legCount >= 1) {
      await upsertAchievement(ownerKey, 'diamond_hands', 'gold', { count: legCount });
      computed++;
    } else {
      await deleteAchievement(ownerKey, 'diamond_hands');
    }
  } catch (e) { errors.push('diamond_hands: ' + String(e)); }

  // ── 3. serial_sniper ───────────────────────────────
  try {
    let serial10 = 0;
    let serial100 = 0;
    if (wallets.length > 0) {
      const { count: c10 } = await supabase
        .from('wallet_moments_cache')
        .select('*', { count: 'exact', head: true })
        .in('wallet_address', wallets)
        .gt('serial_number', 0)
        .lte('serial_number', 10);
      serial10 = c10 ?? 0;

      const { count: c100 } = await supabase
        .from('wallet_moments_cache')
        .select('*', { count: 'exact', head: true })
        .in('wallet_address', wallets)
        .gt('serial_number', 0)
        .lte('serial_number', 100);
      serial100 = c100 ?? 0;
    }
    const tier = highestTier([
      { tier: 'bronze', min: 1 },   // ≥1 serial ≤100
      { tier: 'silver', min: 1 },   // ≥1 serial ≤10 (checked via serial10)
      { tier: 'gold', min: 3 },     // ≥3 serial ≤10
    ], serial100 > 0 ? (serial10 >= 3 ? 3 : serial10 >= 1 ? 1 : 0) : 0);

    // Recalculate properly
    let snipeTier: string | null = null;
    if (serial10 >= 3) snipeTier = 'gold';
    else if (serial10 >= 1) snipeTier = 'silver';
    else if (serial100 >= 1) snipeTier = 'bronze';

    if (snipeTier) {
      await upsertAchievement(ownerKey, 'serial_sniper', snipeTier, { serial10, serial100 });
      computed++;
    } else {
      await deleteAchievement(ownerKey, 'serial_sniper');
    }
  } catch (e) { errors.push('serial_sniper: ' + String(e)); }

  // ── 4. trophy_curator ───────────────────────────────
  try {
    const { count: trophyCount } = await supabase
      .from('trophy_moments')
      .select('*', { count: 'exact', head: true })
      .eq('owner_key', ownerKey);
    const tc = trophyCount ?? 0;
    const tier = highestTier([
      { tier: 'bronze', min: 1 },
      { tier: 'silver', min: 3 },
      { tier: 'gold', min: 6 },
    ], tc);
    if (tier) {
      await upsertAchievement(ownerKey, 'trophy_curator', tier, { count: tc });
      computed++;
    } else {
      await deleteAchievement(ownerKey, 'trophy_curator');
    }
  } catch (e) { errors.push('trophy_curator: ' + String(e)); }

  // ── 5. challenge_accepted ──────────────────────────────────
  try {
    let challengeCount = 0;
    if (wallets.length > 0) {
      const { count } = await supabase
        .from('moment_acquisitions')
        .select('*', { count: 'exact', head: true })
        .in('wallet', wallets)
        .eq('acquisition_method', 'challenge_reward');
      challengeCount = count ?? 0;
    }
    if (challengeCount >= 1) {
      await upsertAchievement(ownerKey, 'challenge_accepted', 'gold', { count: challengeCount });
      computed++;
    } else {
      await deleteAchievement(ownerKey, 'challenge_accepted');
    }
  } catch (e) { errors.push('challenge_accepted: ' + String(e)); }

  // ── 6. series_collector ───────────────────────────────────
  try {
    let distinctSeries = 0;
    if (wallets.length > 0) {
      const { data: seriesRows } = await supabase
        .from('wallet_moments_cache')
        .select('series_number')
        .in('wallet_address', wallets)
        .not('series_number', 'is', null);
      const distinct = new Set((seriesRows ?? []).map((r: { series_number: number }) => r.series_number));
      distinctSeries = distinct.size;
    }
    const tier = highestTier([
      { tier: 'bronze', min: 3 },
      { tier: 'silver', min: 5 },
      { tier: 'gold', min: 7 },
    ], distinctSeries);
    if (tier) {
      await upsertAchievement(ownerKey, 'series_collector', tier, { count: distinctSeries });
      computed++;
    } else {
      await deleteAchievement(ownerKey, 'series_collector');
    }
  } catch (e) { errors.push('series_collector: ' + String(e)); }

  // ── 7. big_spender ──────────────────────────────────────
  try {
    let totalSpend = 0;
    if (wallets.length > 0) {
      const { data: spendRows } = await supabase
        .from('moment_acquisitions')
        .select('buy_price')
        .in('wallet', wallets)
        .eq('acquisition_method', 'marketplace')
        .gt('buy_price', 0);
      totalSpend = (spendRows ?? []).reduce((sum: number, r: { buy_price: number }) => sum + Number(r.buy_price), 0);
    }
    const tier = highestTier([
      { tier: 'bronze', min: 100 },
      { tier: 'silver', min: 1000 },
      { tier: 'gold', min: 10000 },
    ], totalSpend);
    if (tier) {
      await upsertAchievement(ownerKey, 'big_spender', tier, { amount: Math.round(totalSpend) });
      computed++;
    } else {
      await deleteAchievement(ownerKey, 'big_spender');
    }
  } catch (e) { errors.push('big_spender: ' + String(e)); }

  return { computed, errors };
}

// ─── Upsert helper ─────────────────────────────────
async function upsertAchievement(ownerKey: string, key: string, tier: string, progress: Record<string, unknown>) {
  // Check if already exists to preserve unlocked_at
  const { data: existing } = await supabase
    .from('profile_achievements')
    .select('unlocked_at')
    .eq('owner_key', ownerKey)
    .eq('achievement_key', key)
    .maybeSingle();

  await supabase.from('profile_achievements').upsert({
    owner_key: ownerKey,
    achievement_key: key,
    tier,
    progress,
    unlocked_at: existing?.unlocked_at ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'owner_key,achievement_key' });
}

async function deleteAchievement(ownerKey: string, key: string) {
  await supabase.from('profile_achievements')
    .delete()
    .eq('owner_key', ownerKey)
    .eq('achievement_key', key);
}

// ─── Main handler ──────────────────────────────────
Deno.serve(async (req: Request) => {
  // Auth check
  const auth = req.headers.get('authorization') ?? '';
  const token = auth.replace('Bearer ', '').trim();
  if (token !== SERVICE_ROLE_KEY && token !== INGEST_SECRET) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  try {
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const targetKey: string | undefined = body?.owner_key;

    const results: Record<string, { computed: number; errors: string[] }> = {};

    if (targetKey) {
      results[targetKey] = await computeForUser(targetKey);
    } else {
      // Compute for all distinct owner_keys
      const { data: owners } = await supabase
        .from('saved_wallets')
        .select('owner_key');
      const keys = [...new Set((owners ?? []).map((r: { owner_key: string }) => r.owner_key))];
      for (const key of keys) {
        results[key] = await computeForUser(key);
        // Small delay between users to avoid rate limiting
        await new Promise(r => setTimeout(r, 200));
      }
    }

    const totalComputed = Object.values(results).reduce((s, r) => s + r.computed, 0);
    const allErrors = Object.entries(results).flatMap(([k, r]) => r.errors.map(e => k + ' / ' + e));

    return new Response(JSON.stringify({ ok: true, users: Object.keys(results).length, computed: totalComputed, errors: allErrors }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[compute-achievements]', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
