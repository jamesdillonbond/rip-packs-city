// lib/dashboard-tabs.ts — the dashboard's five tabs (IA Phase 1, 2026-11-06),
// shared by the dashboard's own panels and by the two tabs that are pages of
// their own (/dashboard/packs, /dashboard/history), so the row reads the same
// on all five. docs/strategy/features/information-architecture-2026-11-06.md
//
// Overview · Trophy Cases · Settings are panels inside DashboardClient (deep
// link: ?tab=); Packs · History are their own routes.

export type DashPanel = "overview" | "trophy" | "settings"
export type DashTab = DashPanel | "packs" | "history"

export const DASH_TABS: ReadonlyArray<
  | { id: DashPanel; label: string; kind: "panel" }
  | { id: "packs" | "history"; label: string; kind: "page"; href: string }
> = [
  { id: "overview", label: "Overview", kind: "panel" },
  { id: "trophy", label: "Trophy Cases", kind: "panel" },
  { id: "packs", label: "Packs", kind: "page", href: "/dashboard/packs" },
  { id: "history", label: "History", kind: "page", href: "/dashboard/history" },
  { id: "settings", label: "Settings", kind: "panel" },
]

/** The URL that opens a panel from anywhere. */
export function panelHref(id: DashPanel): string {
  return id === "overview" ? "/dashboard" : `/dashboard?tab=${id}`
}

export function parseDashTab(raw: string | null | undefined): DashPanel {
  return raw === "trophy" || raw === "settings" ? raw : "overview"
}

/** Which panel holds a first-run-tour anchor, so the tour can open it. */
export const DASH_TAB_FOR_ANCHOR: Record<string, DashPanel> = {
  "portfolio-stats": "overview",
  "saved-wallets-card": "overview",
  "sniper-nav-link": "overview",
  "trophy-case": "trophy",
}

export const RPC_TOUR_STEP_EVENT = "rpc:tour-step"
