/**
 * app/api/bots/milestone/route.ts
 *
 * Milestone Bot — tweets when an edition's FMV crosses a notable price threshold.
 * Compares latest vs second-latest fmv_snapshots per edition. If old and new FMV
 * straddle a threshold (25, 50, 100, 250, 500, 1000, 2500, 5000), tweet it.
 *
 * Auth: Bearer ${INGEST_SECRET_TOKEN}
 * Called by: .github/workflows/rpc-pipeline.yml (every 20 min, last step)
 */

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { postTweet } from "@/lib/twitter/post";

const INGEST_TOKEN = process.env.INGEST_SECRET_TOKEN!;

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const THRESHOLDS = [25, 50, 100, 250, 500, 1000, 2500, 5000];

const TIER_EMOJI: Record<string, string> = {
  ULTIMATE: "🔱",
  LEGENDARY: "🟡",
  RARE: "🔵",
  FANDOM: "🟣",
  COMMON: "⚪",
  MOMENT_TIER_ULTIMATE: "🔱",
  MOMENT_TIER_LEGENDARY: "🟡",
  MOMENT_TIER_RARE: "🔵",
  MOMENT_TIER_FANDOM: "🟣",
  MOMENT_TIER_COMMON: "⚪",
};

interface MilestoneCrossing {
  edition_id: string;
  old_fmv: number;
  new_fmv: number;
  milestone_type: "crossed_above" | "crossed_below";
  milestone_value: number;
  player_name: string;
  set_name: string;
  tier: string;
  circulation_count: number;
}

// ── Step 1: Find milestone crossings ─────────────────────────────────────────

async function findMilestoneCrossings(): Promise<MilestoneCrossing[]> {
  // Get the two most recent snapshots per edition using window functions
  // We fetch all recent snapshots and deduplicate in JS to avoid needing
  // a Postgres function or raw SQL via Supabase
  const { data: latestRows, error: latestErr } = await supabase
    .from("fmv_snapshots")
    .select("edition_id, fmv_usd, computed_at")
    .gte("fmv_usd", 5)
    .order("computed_at", { ascending: false })
    .limit(2000);

  if (latestErr || !latestRows?.length) {
    console.log(`[milestone] No snapshots found: ${latestErr?.message ?? "empty"}`);
    return [];
  }

  // Group by edition_id, keep top 2 per edition
  const editionSnapshots = new Map<string, { latest: number; previous: number }>();
  const editionOrder = new Map<string, number>(); // track how many we've seen

  for (const row of latestRows as { edition_id: string; fmv_usd: number }[]) {
    const count = editionOrder.get(row.edition_id) ?? 0;
    if (count === 0) {
      editionSnapshots.set(row.edition_id, { latest: row.fmv_usd, previous: 0 });
      editionOrder.set(row.edition_id, 1);
    } else if (count === 1) {
      const entry = editionSnapshots.get(row.edition_id)!;
      entry.previous = row.fmv_usd;
      editionOrder.set(row.edition_id, 2);
    }
    // Skip count >= 2
  }

  // Find threshold crossings
  const crossings: { edition_id: string; old_fmv: number; new_fmv: number; milestone_type: "crossed_above" | "crossed_below"; milestone_value: number }[] = [];

  for (const [editionId, snap] of editionSnapshots) {
    if (snap.previous === 0) continue; // Need at least 2 snapshots

    for (const threshold of THRESHOLDS) {
      if (snap.previous < threshold && snap.latest >= threshold) {
        crossings.push({
          edition_id: editionId,
          old_fmv: snap.previous,
          new_fmv: snap.latest,
          milestone_type: "crossed_above",
          milestone_value: threshold,
        });
      } else if (snap.previous >= threshold && snap.latest < threshold) {
        crossings.push({
          edition_id: editionId,
          old_fmv: snap.previous,
          new_fmv: snap.latest,
          milestone_type: "crossed_below",
          milestone_value: threshold,
        });
      }
    }
  }

  if (crossings.length === 0) return [];

  // Check which have already been posted
  const { data: alreadyPosted } = await supabase
    .from("posted_milestones")
    .select("edition_id, milestone_type, milestone_value")
    .in("edition_id", crossings.map((c) => c.edition_id));

  const postedSet = new Set(
    (alreadyPosted ?? []).map(
      (r: any) => `${r.edition_id}:${r.milestone_type}:${r.milestone_value}`
    )
  );

  const newCrossings = crossings.filter(
    (c) => !postedSet.has(`${c.edition_id}:${c.milestone_type}:${c.milestone_value}`)
  );

  // Limit to 3 per run
  return await enrichCrossings(newCrossings.slice(0, 3));
}

// ── Step 2: Enrich with player data ──────────────────────────────────────────

async function enrichCrossings(
  crossings: { edition_id: string; old_fmv: number; new_fmv: number; milestone_type: "crossed_above" | "crossed_below"; milestone_value: number }[]
): Promise<MilestoneCrossing[]> {
  if (crossings.length === 0) return [];

  const editionIds = crossings.map((c) => c.edition_id);

  // Get editions to find external_id
  const { data: editions } = await supabase
    .from("editions")
    .select("id, external_id, tier, circulation_count")
    .in("id", editionIds);

  const editionMap = new Map<string, { external_id: string; tier: string; circulation_count: number }>();
  for (const e of (editions ?? []) as any[]) {
    editionMap.set(e.id, {
      external_id: e.external_id,
      tier: e.tier ?? "COMMON",
      circulation_count: e.circulation_count ?? 0,
    });
  }

  // Get badge_editions data for player_name and set_name
  // badge_editions.id format: "setId+playId", editions.external_id format: "setId:playId"
  const { data: badgeRows } = await supabase
    .from("badge_editions")
    .select("id, player_name, set_name, tier, circulation_count, parallel_id")
    .eq("parallel_id", 0);

  const badgeMap = new Map<string, { player_name: string; set_name: string; tier: string; circulation_count: number }>();
  for (const row of (badgeRows ?? []) as any[]) {
    const parts = (row.id as string).split("+");
    if (parts.length >= 2) {
      const extKey = `${parts[0]}:${parts[1]}`;
      badgeMap.set(extKey, {
        player_name: row.player_name,
        set_name: row.set_name,
        tier: row.tier,
        circulation_count: row.circulation_count,
      });
    }
  }

  return crossings.map((c) => {
    const edition = editionMap.get(c.edition_id);
    const badge = edition ? badgeMap.get(edition.external_id) : null;

    return {
      ...c,
      player_name: badge?.player_name ?? "Unknown",
      set_name: badge?.set_name ?? "",
      tier: badge?.tier ?? edition?.tier ?? "COMMON",
      circulation_count: badge?.circulation_count ?? edition?.circulation_count ?? 0,
    };
  });
}

// ── Step 3: Build tweet ──────────────────────────────────────────────────────

function buildMilestoneTweet(m: MilestoneCrossing): string {
  const emoji = TIER_EMOJI[m.tier?.toUpperCase()] ?? "⚪";
  const setName = m.set_name?.length > 30
    ? m.set_name.slice(0, 27) + "..."
    : (m.set_name ?? "");
  const isAbove = m.milestone_type === "crossed_above";

  const lines: string[] = [];
  lines.push(`${emoji} ${m.player_name}`);
  lines.push(setName);
  lines.push(isAbove
    ? `📈 FMV crossed $${m.milestone_value}`
    : `👀 FMV dropped below $${m.milestone_value}`
  );
  lines.push(`Was $${m.old_fmv.toFixed(2)} → Now $${m.new_fmv.toFixed(2)}`);
  lines.push(`Serial circ: /${m.circulation_count.toLocaleString()}`);
  lines.push("");
  lines.push("→ rip-packs-city.vercel.app/nba-top-shot/sniper");
  lines.push("");
  lines.push("#NBATopShot #RipPacksCity");

  let tweet = lines.join("\n").trim();
  if (tweet.length > 280) {
    tweet = tweet.slice(0, 277) + "...";
  }
  return tweet;
}

// ── Step 4: Post and log ─────────────────────────────────────────────────────

export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  if (!INGEST_TOKEN || auth !== `Bearer ${INGEST_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const milestones = await findMilestoneCrossings();

    if (milestones.length === 0) {
      console.log("[milestone] No new milestone crossings found");
      return NextResponse.json({ posted: 0, milestones: [], errors: [] });
    }

    console.log(`[milestone] Found ${milestones.length} milestone crossings to tweet`);

    const posted: { player_name: string; milestone_value: number }[] = [];
    const errors: string[] = [];

    for (const m of milestones) {
      try {
        const tweetText = buildMilestoneTweet(m);
        console.log(`[milestone] Tweeting: ${m.player_name} ${m.milestone_type} $${m.milestone_value}`);

        const result = await postTweet("rpc", tweetText);
        const tweetId = result?.data?.id ?? null;

        // Log to posted_milestones
        await supabase.from("posted_milestones").insert({
          edition_id: m.edition_id,
          milestone_type: m.milestone_type,
          milestone_value: m.milestone_value,
          old_fmv: m.old_fmv,
          new_fmv: m.new_fmv,
          tweet_id: tweetId,
          player_name: m.player_name,
          set_name: m.set_name,
          tier: m.tier,
        });

        // Log to posted_tweets
        await supabase.from("posted_tweets").insert({
          brand: "rpc",
          bot_name: "milestone",
          tweet_text: tweetText,
          tweet_id: tweetId,
          media_url: null,
          metadata: {
            milestone_type: m.milestone_type,
            milestone_value: m.milestone_value,
            player_name: m.player_name,
          },
        });

        posted.push({ player_name: m.player_name, milestone_value: m.milestone_value });
      } catch (err: any) {
        console.error(`[milestone] Failed to tweet ${m.player_name}: ${err.message}`);
        errors.push(`${m.player_name}: ${err.message}`);
      }
    }

    console.log(`[milestone] Done: posted=${posted.length} errors=${errors.length}`);

    return NextResponse.json({
      posted: posted.length,
      milestones: posted,
      errors,
    });
  } catch (e: any) {
    console.error("[milestone] Fatal error:", e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    message: "Milestone Bot. POST with Authorization: Bearer <token> to trigger.",
    thresholds: THRESHOLDS,
  });
}
