// Candy MLB ICONs — public insights surface. LIVE since 2026-07-31 (CANDY_MLB_PUBLIC = true).
//
// The go-live mechanism is the SINGLE compile-time flag CANDY_MLB_PUBLIC in lib/launch-flags.ts, which
// fans out to all five consumers at once (the proxy.ts route wall, the sitemap slug, the /insights hub
// card, this surface's layout robots, and the smoke-test public list). Flipping it back to false is the
// complete rollback. The old instruction that lived here — "remove the proxy line, add the sitemap slug,
// drop robots:noindex" — is SUPERSEDED and would now be actively wrong: proxy.ts reads the flag, so
// hand-editing it half-ships the surface. Reads Candy DIRECTLY (candy_mlb stays
// is_active=false — no shared-plane flip needed). All backing views are anon/authenticated-REVOKED and read
// via supabaseAdmin (service_role) — route-gating is NOT data-gating.
//
// PUBLIC-BOARD-CACHING (nc1, 2026-08-09): this is the board with MEASURED production
// timeouts (six simultaneous 57014s in one render), so the 10-view assembly now lives
// in lib/insights/candy-board.ts and is served through the snapshot cache — fresh
// snapshot when a background cron warmed a fully-healthy board, else live, else the
// last-good snapshot (so a saturation spike serves the cached board instead of a wall
// of degraded sections). The degraded roll-up still travels in the payload, so a
// live/stale render stays honest.
import CandyBoardClient from "./CandyBoardClient";
import { readBoardOrLive } from "@/lib/insights/board-cache";
import { fetchCandyMlbDefault } from "@/lib/insights/candy-board";
import type { DegradedSummary } from "@/lib/insights/board-status";
import { degradedFromSource } from "@/lib/insights/board-status";

export const revalidate = 300;

export default async function CandyMlbPage() {
  const { payload, source } = await readBoardOrLive("candy-mlb", () => fetchCandyMlbDefault());
  return (
    <CandyBoardClient
      initialRows={(payload.initialRows as any[]) ?? []}
      packEv={(payload.packEv as any) ?? null}
      packMarket={(payload.packMarket as any) ?? null}
      deals={(payload.deals as any[]) ?? []}
      spreads={(payload.spreads as any[]) ?? []}
      serials={(payload.serials as any[]) ?? []}
      scarcity={(payload.scarcity as any[]) ?? []}
      holders={(payload.holders as any[]) ?? []}
      players={(payload.players as any[]) ?? []}
      parallel={(payload.parallel as any[]) ?? []}
      degraded={(payload.degraded as DegradedSummary | null) ?? degradedFromSource(source, "Candy MLB board")}
      fetchedAt={(payload.fetchedAt as string | null) ?? null}
    />
  );
}
