import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TOPSHOT_GQL = 'https://public-api.nbatopshot.com/graphql';
const INGEST_SECRET = Deno.env.get('INGEST_SECRET_TOKEN');
if (!INGEST_SECRET) {
  throw new Error('INGEST_SECRET_TOKEN env var is required');
}

const GET_MINTED_MOMENT = `
  query GetMintedMoment($momentId: ID!) {
    getMintedMoment(momentId: $momentId) {
      data {
        play { stats { playerName } }
        set { flowName }
        tier
      }
    }
  }
`;

async function resolveMoment(momentId: string): Promise<{ playerName: string | null; setName: string | null; tier: string | null } | null> {
  try {
    const res = await fetch(TOPSHOT_GQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'sports-collectible-tool/0.1' },
      body: JSON.stringify({ query: GET_MINTED_MOMENT, variables: { momentId } }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const data = json?.data?.getMintedMoment?.data;
    if (!data) return null;
    return {
      playerName: data.play?.stats?.playerName ?? null,
      setName: data.set?.flowName ?? null,
      tier: data.tier ?? null,
    };
  } catch {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${INGEST_SECRET}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Get wallet moments with FMV, prioritize highest FMV first
  // Join wallet_moments_cache -> editions -> fmv_snapshots
  // Only process those missing from badge_editions
  const { data: candidates, error: fetchError } = await supabase
    .from('wallet_moments_cache')
    .select('moment_id, edition_key')
    .not('edition_key', 'is', null)
    .limit(1000);

  if (fetchError) {
    return new Response(JSON.stringify({ error: fetchError.message }), { status: 500 });
  }

  // Filter to numeric edition keys only
  const numericRows = (candidates ?? []).filter((r: any) => /^\d+:\d+$/.test(r.edition_key));
  
  // Deduplicate by edition_key
  const seen = new Set<string>();
  const unique = numericRows.filter((r: any) => {
    if (seen.has(r.edition_key)) return false;
    seen.add(r.edition_key);
    return true;
  });

  let processed = 0;
  let inserted = 0;
  let skipped = 0;
  let errors = 0;
  const limit = 50;

  for (const row of unique.slice(0, limit * 3)) {
    if (inserted >= limit) break;
    
    const [setId, playId] = row.edition_key.split(':');
    
    // Check if already in badge_editions
    const { data: existing } = await supabase
      .from('badge_editions')
      .select('id')
      .like('id', `${setId}+${playId}+%`)
      .limit(1);

    if (existing && existing.length > 0) {
      skipped++;
      continue;
    }

    const momentData = await resolveMoment(row.moment_id);
    processed++;

    if (!momentData?.playerName) {
      errors++;
      continue;
    }

    const badgeId = `${setId}+${playId}+0`;
    const { error: insertError } = await supabase
      .from('badge_editions')
      .upsert({
        id: badgeId,
        player_name: momentData.playerName,
        set_name: momentData.setName ?? '',
        tier: momentData.tier ?? 'MOMENT_TIER_COMMON',
        parallel_id: 0,
        series_number: 0,
        circulation_count: null,
        low_ask: null,
        flow_retired: false,
        play_tags: null,
      }, { onConflict: 'id' });

    if (!insertError) {
      inserted++;
    } else {
      errors++;
    }
  }

  return new Response(JSON.stringify({
    processed,
    inserted,
    skipped,
    errors,
    total_candidates: unique.length,
  }), { headers: { 'Content-Type': 'application/json' } });
});
