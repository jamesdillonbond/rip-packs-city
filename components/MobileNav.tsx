"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useSyncExternalStore } from "react";
import { readRecordedLastCollection, subscribeLastCollection } from "@/lib/active-collection";
import { getCollection, type CollectionPage } from "@/lib/collections";
import { accentText } from "@/lib/accent-text";
import { IA_GROUPS, MOBILE_GROUP_IDS, type IaGroupId } from "@/lib/ia";

const NAV_HEIGHT = 60;
const ICON_SIZE = 22;

// ⭐ RE-SLOTTED 2026-09-28 (Trevor's call): HOME · MY BINDER · MARKET · SNIPER.
//
// Was HOME · SEARCH · SNIPER · MY STUFF · COLLECTIONS (2026-09-12). Two of those
// five were not destinations but SHEETS, and both duplicated chrome the page
// already carries:
//   * SEARCH — the site header's GlobalSearch. The header now mounts on the
//     account surfaces and /insights too (it was missing there, which is the
//     other half of this change), and the home header carries the same box, so
//     search is one tap away at the top of every page.
//   * COLLECTIONS — every collection page renders CollectionSwitcher and
//     CollectionTabBar, which is how you move between collections and their
//     pages. The sheet was a third copy of that.
// What is left is four places a collector actually goes.
//
// Icons were emoji (🏠 🔍 ⚡ 👤 🗂). An emoji ignores `color`, so the active
// state reached only the 10px caption — the glyph above it never changed. They
// are one family of stroke SVGs now, drawn in `currentColor`, so the whole tab
// turns red.

// Which tab owns the current route — by DESTINATION, not by string coincidence.
//
// ⚠ The pre-09-12 rule was `segments[1] === key`, and it (a) lit nothing on most
// of the app and (b) on /dashboard/packs lit a Packs tab whose href was the
// MARKET page, so tapping the active tab left. Every rule below maps a route to
// the tab whose href actually lands there (or its sub-toggle), and returns null
// for a route no tab leads to — an honest "none", not a guess.
// ⚠ MY BINDER IS THE WALLET PAGE (`/{collection}/collection`), not the account
// dashboard (Trevor, 2026-09-28): the binder is a wallet's holdings. Account
// surfaces (/dashboard, /profile, /alerts) are reached through the header's
// sign-in pill and light no tab — no tab leads there any more.
// ⭐ RE-SLOTTED 2026-11-07 (Trevor): HOME · MY BINDER · MARKET · PACKS · INSIGHTS
// — the one personal page a phone visitor goes to most, second, then the
// header's first groups in the header's order.
// ⭐ RE-SLOTTED 2026-11-06 (IA Phase 2, Trevor's call): HOME · MARKET · PACKS ·
// INSIGHTS · MY BINDER — the header's first groups, in the header's order, plus
// the one personal page a phone visitor goes to most. Was HOME · MY BINDER ·
// MARKET · SNIPER (2026-09-28). SNIPER is the Market group's second item (the
// /market hub carries the Market/Sniper toggle); PACKS and INSIGHTS, two of the
// site's five pillars, had no bottom-bar entry at all.
// docs/strategy/features/information-architecture-2026-11-06.md
const BINDER_PAGES = new Set(["collection"]);
// Which collection pages each group OWNS — the same memberships lib/ia.ts gives
// the header (Sniper and Hot Floors are Market; Pack Sniper is Packs).
const MARKET_PAGES = new Set(["market", "sniper", "hot-floors"]);
const PACKS_PAGES = new Set(["packs", "pack-sniper"]);

export type MobileTab = "home" | "market" | "packs" | "insights" | "binder";

/** A registry group the bar renders as a tab (MOBILE_GROUP_IDS; Trade is not one). */
type MobileGroupTab = Extract<MobileTab, IaGroupId>;

export function activeTabFor(pathname: string, pageSegment: string, isCollectionRoute: boolean): MobileTab | null {
  if (pathname === "/") return "home";
  if (pathname === "/sniper" || pathname === "/market") return "market";
  if (pathname === "/insights" || pathname.startsWith("/insights/")) return "insights";
  if (!isCollectionRoute) return null;
  if (BINDER_PAGES.has(pageSegment)) return "binder";
  if (PACKS_PAGES.has(pageSegment)) return "packs";
  if (MARKET_PAGES.has(pageSegment)) return "market";
  return null;
}

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function TabIcon({ tab }: { tab: MobileTab }) {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...stroke}>
      {tab === "home" && <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />}
      {tab === "binder" && (
        <>
          <rect x="6" y="3" width="14" height="18" rx="2" />
          <path d="M10 3v18M4 7.5h4M4 12h4M4 16.5h4" />
        </>
      )}
      {tab === "market" && <path d="M3 3v18h18M7 15l4-4 3 3 6-6M16 8h4v4" />}
      {tab === "packs" && (
        <>
          <path d="M3 8.5 12 4l9 4.5-9 4.5-9-4.5z" />
          <path d="M3 8.5V16l9 4.5 9-4.5V8.5M12 13v7.5" />
        </>
      )}
      {tab === "insights" && (
        <>
          <path d="M9 18h6M10 21h4" />
          <path d="M12 3a6.5 6.5 0 0 0-4 11.6c.7.6 1 1.4 1 2.4h6c0-1 .3-1.8 1-2.4A6.5 6.5 0 0 0 12 3z" />
        </>
      )}
    </svg>
  );
}

export default function MobileNav() {
  const pathname = usePathname() ?? "/";
  // 2026-11-07 review: the SAME memory TopNav reads, through the same store
  // (lib/active-collection — "one memory, two renderers"). The bar read it once
  // at mount, so / → /ufc/overview → /insights left PACKS and MY BINDER on the
  // mount-time collection while the header's chip said UFC. TopNav records the
  // URL collection; this re-renders on that notification.
  const recorded = useSyncExternalStore(subscribeLastCollection, readRecordedLastCollection, () => null);
  const fallbackCollection = recorded ?? "nba-top-shot";

  const segments = useMemo(() => pathname.split("/").filter(Boolean), [pathname]);

  // Resolve the active collection from the URL. Off a collection route (/profile,
  // /insights, /) fall back to the last-visited collection, then Top Shot.
  const collection = useMemo(() => {
    const seg = segments[0] ?? "";
    if (getCollection(seg)) return seg;
    // /pinnacle/moment/<render_id> is a Disney Pinnacle pin page, but "pinnacle"
    // is not a collection id — the Sniper tab fell back to the last-visited
    // collection or Top Shot there (2026-09-27 live sweep).
    if (seg === "pinnacle" && segments[1] === "moment") return "disney-pinnacle";
    if (getCollection(fallbackCollection)) return fallbackCollection;
    return "nba-top-shot";
  }, [segments, fallbackCollection]);

  // A collection route is one whose FIRST segment names a collection. Without
  // this, `/dashboard/packs` looked like the Packs page of a collection.
  const isCollectionRoute = !!getCollection(segments[0] ?? "");
  const activeTab = activeTabFor(pathname, segments[1] ?? "", isCollectionRoute);
  const activeCollection = getCollection(collection);

  // My Binder opens the binder page with NO `?wallet=`: the page re-opens the
  // wallet this device last looked up (rpc_last_wallet, chain-checked there),
  // else the signed-in reader's saved wallet for that collection
  // (AutoSearchReader), and shows the lookup box only to a visitor with neither. It is PUBLIC —
  // never point a tab at auth-gated /dashboard (a login wall from the first
  // tap, R36).
  const tabs: { key: MobileTab; label: string; href: string; page?: CollectionPage }[] = [
    { key: "home", label: "HOME", href: "/" },
    // ⭐ 2026-11-07 (Trevor, 8:01 AM PT): MY BINDER sits second, between HOME and
    // MARKET — the personal page first, then the header's groups in header order.
    { key: "binder", label: "MY BINDER", href: `/${collection}/collection`, page: "collection" },
    // 2026-11-07 (handoff 11-06 item 27 residue): the group tabs come FROM the
    // registry (lib/ia.ts MOBILE_GROUP_IDS → IA_GROUPS), in its order, with the
    // group's own label and hub — MARKET → /market, PACKS → /{collection}/packs,
    // INSIGHTS → /insights. ⚠ `{collection}` is substituted LITERALLY, never via
    // resolveHref(): resolveHref falls back to Top Shot for a collection that
    // lacks the page (right for a global menu), and the bar's rule is the
    // opposite — a collection with no packs page (UFC) gets an INERT tab below,
    // never another collection's packs (substitution answers the wrong subject).
    ...MOBILE_GROUP_IDS.map((id) => {
      const g = IA_GROUPS.find((x) => x.id === id);
      if (!g) throw new Error(`MobileNav: MOBILE_GROUP_IDS names unknown group ${id}`);
      return {
        key: id as MobileGroupTab,
        label: g.label.toUpperCase(),
        href: g.href.replace("{collection}", collection),
        ...(g.href.includes("{collection}") && g.page ? { page: g.page } : {}),
      };
    }),
  ];

  return (
    <nav
      aria-label="Primary"
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 200,
        background: "var(--rpc-surface)",
        borderTop: "1px solid var(--rpc-red-border)",
        height: NAV_HEIGHT,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-around",
        fontFamily: "var(--font-mono)",
      }}
      className="rpc-mobile-nav"
    >
      {tabs.map((tab) => {
        const isActive = activeTab === tab.key;
        // ⚠ Never `--rpc-text-ghost` here: it measures 1.80 : 1 against the
        // nav's `--rpc-surface`. `--rpc-text-secondary` measures 6.25 : 1 and is
        // theme-aware. (`--rpc-text-muted` is 4.08 — under the 4.5 floor.)
        const color = isActive ? "var(--rpc-red)" : "var(--rpc-text-secondary)";
        const inner = (
          <>
            <TabIcon tab={tab.key} />
            <span
              style={{
                fontSize: 10,
                letterSpacing: "0.06em",
                fontWeight: isActive ? 800 : 600,
                whiteSpace: "nowrap",
              }}
            >
              {tab.label}
            </span>
          </>
        );

        // ⚠ The tap target is the ELEMENT box, not the bar. Measured 2026-08-22
        // at 390x844, tabs hugging their glyph were as small as 26x32 — under
        // the 44px floor (WCAG 2.5.5) in both axes. Stretch to the bar's height,
        // share its width, and keep a 44px minimum. Do not swap to a fixed
        // height — alignSelf:stretch stays correct if NAV_HEIGHT moves.
        const baseStyle: React.CSSProperties = {
          flex: "1 1 0",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          alignSelf: "stretch",
          minWidth: 44,
          gap: 3,
          textDecoration: "none",
          color: accentText(color),
          transition: "color var(--transition-fast)",
          padding: "0 6px",
        };

        // A collection-scoped tab (MY BINDER, PACKS) whose
        // collection lacks that page renders inert rather than linking to a page that does not
        // exist — a tap that silently redirects reads as a broken app. It never
        // substitutes another collection's page: that would answer with the
        // wrong subject.
        if (tab.page && activeCollection && !activeCollection.pages.includes(tab.page)) {
          return (
            <span
              key={tab.key}
              aria-disabled="true"
              title={`${activeCollection.shortLabel} does not have a ${tab.label.toLowerCase()} page yet`}
              style={{ ...baseStyle, opacity: 0.35, cursor: "default" }}
            >
              {inner}
              {/* `title` never reaches a touch screen or a screen reader; the
                  reason rides along as sr-only text (2026-11-07). */}
              <span className="sr-only"> — not available for {activeCollection.shortLabel}</span>
            </span>
          );
        }

        return (
          <Link
            key={tab.key}
            href={tab.href}
            // Colour alone is invisible to a screen reader and to anyone who
            // cannot separate #e03a2f from 55% white.
            aria-current={isActive ? "page" : undefined}
            style={baseStyle}
          >
            {inner}
          </Link>
        );
      })}

      {/* Only visible below 768px — hidden on desktop via CSS. The body padding
          reserves the nav's height so the footer stays reachable. Keep the CSS
          text free of dates/dashes: jsdom folds <style> text into
          body.textContent and a component test asserts no "-<digit>" renders. */}
      <style>{`
        /* The BAR carries the safe-area inset itself, below its 60px content box,
           so the icons are not centred over a home indicator. This lives here
           rather than inline because jsdom drops an inline env() value. */
        .rpc-mobile-nav { padding-bottom: env(safe-area-inset-bottom, 0px); box-sizing: content-box; }
        .rpc-mobile-nav { display: none !important; }
        @media (max-width: 768px) {
          .rpc-mobile-nav { display: flex !important; }
          body { padding-bottom: calc(${NAV_HEIGHT}px + env(safe-area-inset-bottom, 0px)) !important; }
        }
      `}</style>
    </nav>
  );
}
