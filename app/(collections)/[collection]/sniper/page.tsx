// app/(collections)/[collection]/sniper/page.tsx
//
// Thin server shell. The feed body lives in SniperClient.tsx, which the
// component coverage gate measures (`app/**/*Client.tsx`); a `page.tsx` matches
// NEITHER gate's include, which is the entire reason for the split.
//
// ⚠ THE SUSPENSE BOUNDARY IS HOISTED HERE DELIBERATELY. SniperClient calls
// `useSearchParams` (for the Moments|Packs sub-toggle), which Next.js requires
// be wrapped — but a boundary left INSIDE the client file moves it into the
// coverage gate without making it renderable by a test, because the test then
// mounts the fallback and asserts against a loading string.
//
// Panini (2026-09-28): its own arm. The shared client is a Flow feed (wallet
// ownership, badges, watchlist); Panini's deals are the hourly `panini-boards`
// snapshot the /insights/panini-squeeze Deals tab already serves, so the tab is
// server-seeded from it — no extra read per render.
// 2026-10-10: the tab shows `deals_all` (every walked product: soccer, NBA, NFL, WNBA,
// MLB). A snapshot written before that field existed carries only the WC `deals`; then
// the tab shows those AND says they are World Cup only (scope "wc"), never as all products.

import { Suspense } from "react"
import SniperClient from "./SniperClient"
import PaniniSniper, { type PaniniSniperData } from "@/components/collection/PaniniSniper"
import { fetchPaniniMoreBoards } from "@/lib/insights/panini-more-boards"
import { readBoardOrLive } from "@/lib/insights/board-cache"
import { degradedFromSource, type DegradedSummary } from "@/lib/insights/board-status"

// Panini's arm reads a snapshot that moves hourly; the other collections' shell is
// static, so ISR at the insights board's own cadence costs them nothing.
export const revalidate = 300

export default async function SniperPage(props: { params: Promise<{ collection: string }> }) {
  const { collection } = await props.params
  if (collection === "panini-blockchain") {
    const { payload, source } = await readBoardOrLive("panini-boards", () => fetchPaniniMoreBoards())
    const p = payload as Record<string, unknown>
    // No payload at all (nothing cached AND the live read produced nothing) is a
    // failed read, never "no deals".
    const data: PaniniSniperData | null =
      p && Object.keys(p).length > 0
        ? {
            ...("deals_all" in p
              ? {
                  scope: "all" as const,
                  deals: Array.isArray(p.deals_all) ? (p.deals_all as PaniniSniperData["deals"]) : null,
                  dealsError: p.deals_all_error === true,
                  dealsCapped: p.deals_all_capped === true,
                }
              : {
                  scope: "wc" as const,
                  deals: Array.isArray(p.deals) ? (p.deals as PaniniSniperData["deals"]) : null,
                  dealsError: p.deals_error === true,
                  dealsCapped: p.deals_capped === true,
                }),
            coverage: (p.coverage as PaniniSniperData["coverage"]) ?? null,
            computedAt: typeof p.fetchedAt === "string" ? p.fetchedAt : null,
          }
        : null
    return (
      <PaniniSniper
        data={data}
        degraded={(p?.degraded as DegradedSummary | null) ?? degradedFromSource(source, "Panini deals")}
      />
    )
  }
  return (
    <Suspense
      fallback={
        <div className="rpc-mono" style={{ padding: 24, color: "var(--rpc-text-muted)" }}>
          Loading sniper…
        </div>
      }
    >
      <SniperClient />
    </Suspense>
  )
}
