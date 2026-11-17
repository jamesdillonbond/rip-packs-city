// Panini WC Prizm squeeze — public insights surface. LIVE (PANINI_PUBLIC = true).
//
// The go-live mechanism is the SINGLE compile-time flag PANINI_PUBLIC in lib/launch-flags.ts, which
// fans out to all five consumers at once (the proxy.ts route wall, the sitemap slug, the /insights hub
// card, this surface's layout robots, and the smoke-test public list). Flipping it back to false is the
// complete rollback. The old instruction that lived here — "remove the proxy line, add the sitemap slug,
// drop robots:noindex" — is SUPERSEDED and would now be actively wrong: proxy.ts reads the flag, so
// hand-editing it half-ships the surface (un-gated but still noindex, still missing from the sitemap).
import PaniniSqueezeClient from "./PaniniSqueezeClient";
import PaniniBoardsTabs, { type PaniniBoardsPayload } from "./PaniniBoardsTabs";
import { fetchPaniniMoreBoards } from "@/lib/insights/panini-more-boards";
import { readBoardOrLive } from "@/lib/insights/board-cache";
import { fetchPaniniSqueezeDefault } from "@/lib/insights/panini-board";
import type { DegradedSummary } from "@/lib/insights/board-status";
import { degradedFromSource } from "@/lib/insights/board-status";

export const revalidate = 300;

// PUBLIC-BOARD-CACHING (nc1, 2026-08-09): this board is the PAGINATED "sharper" failure
// case — a page-N timeout returns the top rows as though they were the whole ranking. The
// paginated assembly now lives in lib/insights/panini-board.ts and is served through the
// snapshot cache, warmed by the cron ONLY on a COMPLETE page-set, so a saturation spike
// serves a complete-but-slightly-stale ranking instead of a fresh-but-truncated one. The
// degraded roll-up still travels in the payload so a live/stale render stays honest.
export default async function PaniniSqueezePage() {
  // The four more boards (deals, pack EV, special serials, players) — Trevor,
  // 2026-09-25. Their own snapshot, warmed HOURLY by the cache cron because the
  // backing views are heavy (lib/insights/panini-more-boards.ts). Read in parallel;
  // a failure here never blocks the squeeze board above it.
  // Started first so both snapshot reads run concurrently; the squeeze read keeps
  // the `{ payload, source } = await readBoardOrLive` shape the degraded-wiring
  // guard pins.
  const morePromise = readBoardOrLive("panini-boards", () => fetchPaniniMoreBoards());
  const { payload, source } = await readBoardOrLive("panini-squeeze", () => fetchPaniniSqueezeDefault());
  const more = await morePromise;
  // No payload at all (nothing cached AND the live read produced nothing) renders
  // as a failed read, never as four empty boards.
  const moreData = more.payload && Object.keys(more.payload).length > 0 ? (more.payload as PaniniBoardsPayload) : null;
  return (
    <>
    <PaniniSqueezeClient
      initialRows={(payload.initialRows as any[]) ?? []}
      coverage={(payload.coverage as any) ?? null}
      totals={(payload.totals as any) ?? null}
      degraded={(payload.degraded as DegradedSummary | null) ?? degradedFromSource(source, "Panini squeeze board")}
      // ⚠ UNCOALESCED ON PURPOSE — was `?? new Date().toISOString()`. Materialized
      // 2026-08-22: dataAsOf is when the rows were computed, fetchedAt only when we asked.
      fetchedAt={(payload.dataAsOf as string | null) ?? null}
    />
    <div style={{ maxWidth: 1180, margin: "0 auto", padding: "0 16px 60px" }}>
      <PaniniBoardsTabs
        data={moreData}
        degraded={(more.payload?.degraded as DegradedSummary | null) ?? degradedFromSource(more.source, "Panini boards")}
      />
    </div>
    </>
  );
}
