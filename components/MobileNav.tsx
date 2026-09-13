"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useEffect, useMemo } from "react";
import { getLastCollection } from "@/lib/active-collection";
import ThemeToggle from "@/components/ThemeToggle";
import GlobalSearch from "@/components/search/GlobalSearch";
import { useModalA11y } from "@/lib/hooks/useModalA11y";
import {
  PAGE_LABELS,
  getCollection,
  publishedCollections,
  tabBarPages,
  type CollectionPage,
} from "@/lib/collections";

// Sheet renders these page chips per collection — order matters and the set
// is fixed (fast-break / road-to-the-ring / vault are deliberately omitted).
// "collection" surfaces as "Wallet" to match the bottom-tab vocabulary.
// Post-2026-07-18 IA reorg: the folded pages (packs/pack-sniper/hot-floors/
// challenges) are filtered out per-collection via tabBarPages() below — Packs
// is reached through the Market/Sniper sub-toggle, Challenges through Play.
const SHEET_PAGES: { key: CollectionPage; label: string }[] = [
  { key: "overview", label: PAGE_LABELS.overview },
  { key: "sniper", label: PAGE_LABELS.sniper },
  { key: "collection", label: "Wallet" },
  { key: "market", label: PAGE_LABELS.market },
  { key: "play", label: PAGE_LABELS.play },
  { key: "sets", label: PAGE_LABELS.sets },
  { key: "analytics", label: PAGE_LABELS.analytics },
];

const TAB_ICON_FONT = 18;
const NAV_HEIGHT = 60;

// Which tab owns the current route.
//
// ⚠ THE OLD RULE WAS `segments[1] === key`, PLUS `startsWith("/profile")` for one
// tab, and it produced two measured defects (2026-09-12).
//
//   (a) NO TAB WAS ACTIVE ON MOST OF THE APP. Neither form matches `/dashboard`,
//       `/dashboard/packs`, a collection's own `/overview` landing tab,
//       `/alerts`, `/rewards`, `/my-teams`, `/insights/*` or `/`. Confirmed live
//       on `/nba-top-shot/overview`: five identical glyphs, none active — on the
//       most common entry point in the product.
//   (b) ON `/dashboard/packs` THE PACKS TAB LIT UP POINTING SOMEWHERE ELSE,
//       because `segments[1]` is "packs" there while the tab's href is
//       `/{collection}/packs`, the market page. Tapping the active tab left.
//
// So the map is by DESTINATION, not by string coincidence. Every account surface
// belongs to Profile — that is the tab they are all reached through — and a
// collection page only lights a tab when that tab is where it lives.
const ACCOUNT_PREFIXES = ["/profile", "/dashboard", "/alerts", "/rewards", "/my-teams"];

export function activeTabFor(pathname: string, pageSegment: string, isCollectionRoute: boolean): string | null {
  if (pathname === "/") return "home";
  if (ACCOUNT_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) return "mystuff";
  if (!isCollectionRoute) return null;
  if (pageSegment === "sniper") return "sniper";
  // ⭐ 2026-09-12 re-slot: every OTHER page of a collection belongs to the
  // Collections sheet, which is how you move between them. Before this, a
  // collection's own `/overview` — the most common entry point in the product —
  // lit nothing at all, because Overview was not one of the five tabs and never
  // could be. Owning it here is what closes that gap rather than adding a sixth.
  return "collections";
}

export default function MobileNav() {
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [fallbackCollection, setFallbackCollection] = useState("nba-top-shot");
  const [hoverChip, setHoverChip] = useState<string | null>(null);

  useEffect(() => {
    setFallbackCollection(getLastCollection());
  }, []);

  const segments = useMemo(
    () => pathname.split("/").filter(Boolean),
    [pathname]
  );

  // Resolve the active collection from the URL. If we're not in a collection
  // route (/profile, /admin, /login, /), fall back to the last-visited
  // collection from localStorage, then nba-top-shot.
  const collection = useMemo(() => {
    const seg = segments[0] ?? "";
    if (getCollection(seg)) return seg;
    if (getCollection(fallbackCollection)) return fallbackCollection;
    return "nba-top-shot";
  }, [segments, fallbackCollection]);

  const pageSegment = segments[1] ?? "";
  // A collection route is one whose FIRST segment names a collection. Without
  // this, `/dashboard/packs` looked like the Packs tab of a collection.
  const isCollectionRoute = !!getCollection(segments[0] ?? "");
  const activeTab = activeTabFor(pathname, pageSegment, isCollectionRoute);

  // ⭐ RE-SLOTTED 2026-09-12 (Trevor's call, after the audit).
  //
  // Was: PROFILE · SNIPER · PACKS · WALLET · COLLECTIONS — four of five slots
  // spent on one collection's sub-pages, with no way back to the homepage and no
  // entry to search at all, while the centre (best thumb position) went to Packs.
  //
  // Now: HOME · SEARCH · SNIPER · MY STUFF · COLLECTIONS. Packs and Wallet are
  // not lost — Wallet is a chip in the Collections sheet and Packs is reached
  // through Market, per the 2026-07-18 IA reorg that already folded it there.
  //
  // ⚠ MY STUFF MUST POINT AT `/profile`, NEVER `/dashboard`. `/dashboard` is
  // auth-gated, and this is the tab a first-run visitor scans first: the measured
  // chain used to be `/profile → 308 → /dashboard → 307 → /login?next=…`, two
  // hops into a login wall from the first tap. `app/profile/page.tsx` exists
  // specifically to end that (register R36) — it is PUBLIC (proxy.ts allows it
  // explicitly) and server-redirects a signed-in visitor onward. Re-pointing this
  // href at /dashboard silently reinstates the wall.
  //
  // Icons are one family now. The old set mixed emoji (👤 ⚡) with geometric
  // glyphs (▣ ◈ ▦), and ▣ vs ▦ were near-identical squares at 18px.
  const tabs = [
    {
      key: "home",
      label: "HOME",
      icon: "\u{1F3E0}",
      href: "/",
      isActive: activeTab === "home",
      kind: "link" as const,
    },
    {
      key: "search",
      label: "SEARCH",
      icon: "\u{1F50D}",
      href: "",
      isActive: searchOpen,
      kind: "search" as const,
    },
    {
      key: "sniper",
      label: "SNIPER",
      icon: "⚡",
      href: `/${collection}/sniper`,
      isActive: activeTab === "sniper",
      kind: "link" as const,
    },
    {
      key: "mystuff",
      label: "MY STUFF",
      icon: "\u{1F464}",
      href: "/profile",
      isActive: activeTab === "mystuff",
      kind: "link" as const,
    },
    {
      key: "collections",
      label: "COLLECTIONS",
      icon: "\u{1F5C2}",
      href: "",
      isActive: sheetOpen || activeTab === "collections",
      kind: "button" as const,
    },
  ];

  const closeSheet = () => setSheetOpen(false);
  const closeSearch = () => setSearchOpen(false);

  // Modal a11y for the collections bottom-sheet: Escape-to-close, focus into
  // the sheet on open, Tab/Shift+Tab trap, and focus restore to the trigger on
  // close. The sheet had a backdrop-click close + role="dialog" but no keyboard
  // or focus handling. Ref attaches to the sheet content container below.
  const sheetRef = useModalA11y<HTMLDivElement>(sheetOpen, closeSheet);
  // The search sheet gets the same treatment — Escape, focus-in, focus trap,
  // focus restore. `GlobalSearch` is reused rather than reimplemented: it is the
  // header's search box, already wired to /api/search with its own keyboard
  // handling, and it had NO entry point at all on a phone.
  const searchRef = useModalA11y<HTMLDivElement>(searchOpen, closeSearch);

  const goTo = (href: string) => {
    closeSheet();
    router.push(href);
  };

  return (
    <>
      {searchOpen && (
        <>
          <div
            onClick={closeSearch}
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 199 }}
            className="rpc-mobile-sheet"
            aria-hidden
          />
          <div
            ref={searchRef}
            role="dialog"
            aria-modal="true"
            aria-label="Search"
            style={{
              position: "fixed",
              bottom: `calc(${NAV_HEIGHT}px + env(safe-area-inset-bottom, 0px))`,
              left: 0,
              right: 0,
              background: "var(--rpc-surface)",
              borderTop: "1px solid var(--rpc-red-border)",
              zIndex: 201,
              maxHeight: "70vh",
              overflowY: "auto",
              fontFamily: "var(--font-mono)",
              padding: 14,
            }}
            className="rpc-mobile-sheet"
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 10,
              }}
            >
              <span
                style={{
                  fontFamily: "var(--font-display)",
                  fontWeight: 900,
                  fontSize: 14,
                  letterSpacing: "0.16em",
                  textTransform: "uppercase",
                  color: "var(--rpc-text-primary)",
                }}
              >
                SEARCH
              </span>
              <button
                onClick={closeSearch}
                aria-label="Close search"
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--rpc-text-secondary)",
                  fontSize: 20,
                  lineHeight: 1,
                  cursor: "pointer",
                  padding: 4,
                }}
              >
                ✕
              </button>
            </div>
            <GlobalSearch />
          </div>
        </>
      )}

      {sheetOpen && (
        <>
          <div
            onClick={closeSheet}
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.7)",
              zIndex: 199,
            }}
            className="rpc-mobile-sheet"
            aria-hidden
          />
          <div
            ref={sheetRef}
            role="dialog"
            aria-modal="true"
            aria-label="Collections"
            style={{
              position: "fixed",
              bottom: `calc(${NAV_HEIGHT}px + env(safe-area-inset-bottom, 0px))`,
              left: 0,
              right: 0,
              background: "var(--rpc-surface)",
              borderTop: "1px solid var(--rpc-red-border)",
              zIndex: 201,
              maxHeight: "70vh",
              overflowY: "auto",
              fontFamily: "var(--font-mono)",
            }}
            className="rpc-mobile-sheet"
          >
            <div
              style={{
                position: "sticky",
                top: 0,
                background: "var(--rpc-surface)",
                borderBottom: "1px solid var(--rpc-red-border)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "12px 16px",
              }}
            >
              <span
                style={{
                  fontFamily: "var(--font-display)",
                  fontWeight: 900,
                  fontSize: 14,
                  letterSpacing: "0.16em",
                  textTransform: "uppercase",
                  color: "var(--rpc-text-primary)",
                }}
              >
                COLLECTIONS
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <ThemeToggle />
                <button
                  onClick={closeSheet}
                  aria-label="Close collections"
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "var(--rpc-text-secondary)",
                    fontSize: 20,
                    lineHeight: 1,
                    cursor: "pointer",
                    padding: 4,
                  }}
                >
                  ✕
                </button>
              </div>
            </div>

            <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
              {publishedCollections().map((c) => {
                const allowed = new Set(tabBarPages(c));
                const pages = SHEET_PAGES.filter((p) => allowed.has(p.key));
                return (
                  <div
                    key={c.id}
                    style={{
                      borderLeft: `3px solid ${c.accent}`,
                      background: "var(--rpc-surface-raised)",
                      padding: "10px 12px",
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 18 }}>{c.icon}</span>
                      <span
                        style={{
                          fontFamily: "var(--font-display)",
                          fontWeight: 700,
                          fontSize: 14,
                          letterSpacing: "0.08em",
                          textTransform: "uppercase",
                          color: "var(--rpc-text-primary)",
                        }}
                      >
                        {c.label}
                      </span>
                    </div>

                    <div
                      style={{
                        display: "flex",
                        gap: 6,
                        overflowX: "auto",
                        paddingBottom: 2,
                        WebkitOverflowScrolling: "touch",
                      }}
                    >
                      {pages.map((p) => {
                        const chipKey = `${c.id}:${p.key}`;
                        const isHover = hoverChip === chipKey;
                        const href = `/${c.id}/${p.key}`;
                        return (
                          <button
                            key={p.key}
                            onClick={() => goTo(href)}
                            onMouseEnter={() => setHoverChip(chipKey)}
                            onMouseLeave={() => setHoverChip(null)}
                            style={{
                              flex: "0 0 auto",
                              padding: "6px 10px",
                              fontSize: 10,
                              fontFamily: "var(--font-display)",
                              fontWeight: 700,
                              letterSpacing: "0.1em",
                              textTransform: "uppercase",
                              color: isHover ? c.accent : "var(--rpc-text-secondary)",
                              background: "transparent",
                              border: `1px solid ${isHover ? c.accent : "var(--rpc-red-border)"}`,
                              borderRadius: 2,
                              cursor: "pointer",
                              transition: "color var(--transition-fast), border-color var(--transition-fast)",
                            }}
                          >
                            {p.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      <nav
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
          // ⚠ `--rpc-text-ghost` is rgba(255,255,255,0.2), which measures
          // **1.80 : 1** against the nav's own `--rpc-surface` (#0d0d0d) — on 8px
          // labels, on the product's most-tapped control set. WCAG AA wants
          // 4.5:1 for text. `--rpc-text-secondary` measures **6.25 : 1** on the
          // same ground and is theme-aware, so it holds in light mode too.
          // (`--rpc-text-muted` is 4.08 — under the floor. Do not "compromise"
          // on it.) This is the measured half of "the nav doesn't pop".
          const color = tab.isActive ? "var(--rpc-red)" : "var(--rpc-text-secondary)";
          const inner = (
            <>
              <span
                style={{
                  fontSize: TAB_ICON_FONT,
                  lineHeight: 1,
                  color,
                }}
              >
                {tab.icon}
              </span>
              <span
                style={{
                  // 8px was below the size at which the letter-spacing below is
                  // legible at all; 10 with a heavier resting weight reads at
                  // arm's length without changing the bar's height.
                  fontSize: 10,
                  letterSpacing: "0.1em",
                  fontWeight: tab.isActive ? 800 : 600,
                  color,
                }}
              >
                {tab.label}
              </span>
            </>
          );

          // ⚠ The tap target is the ELEMENT box, not the bar. With `padding: 0`
          // each tab was only as big as its glyph + 8px caption: MEASURED
          // 2026-08-22 in Chromium at 390x844, "PACKS" was **32x26px** and
          // SNIPER/WALLET 32x32 — under the 44px floor (§9, WCAG 2.5.5) in BOTH
          // axes, on the product's most-tapped control set, inside a bar that
          // was already 60px tall. 28px of that bar was dead space that looked
          // tappable and was not.
          //
          // Stretching to the bar's full height and padding out to a 44px floor
          // is a HIT-AREA change only: the content stays centered, so the nav
          // renders identically. Do not swap this back to a fixed height —
          // alignSelf:stretch keeps it correct if NAV_HEIGHT ever moves.
          const baseStyle: React.CSSProperties = {
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            alignSelf: "stretch",
            minWidth: 44,
            gap: 2,
            textDecoration: "none",
            color,
            transition: "color var(--transition-fast)",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            padding: "0 10px",
            fontFamily: "inherit",
          };

          if (tab.kind === "button" || tab.kind === "search") {
            const isSearch = tab.kind === "search";
            return (
              <button
                key={tab.key}
                onClick={() => {
                  if (isSearch) {
                    setSheetOpen(false);
                    setSearchOpen((v) => !v);
                  } else {
                    setSearchOpen(false);
                    setSheetOpen((v) => !v);
                  }
                }}
                aria-pressed={isSearch ? searchOpen : sheetOpen}
                style={baseStyle}
              >
                {inner}
              </button>
            );
          }

          // 2026-09-06: a tab the active collection does not HAVE (Candy MLB is
          // overview-only) renders inert rather than linking to a page that
          // does not exist — the proxy would redirect it to the overview, but a
          // tap that silently goes nowhere reads as a broken app.
          const tabPage = tab.key === "wallet" ? "collection" : tab.key;
          const activeCollection = getCollection(collection);
          const isCollectionTab = tab.href.startsWith(`/${collection}/`);
          const missing = isCollectionTab && !!activeCollection && !activeCollection.pages.includes(tabPage as never);
          if (missing) {
            return (
              <span
                key={tab.key}
                aria-disabled="true"
                title={`${activeCollection!.shortLabel} does not have a ${tab.label.toLowerCase()} page yet`}
                style={{ ...baseStyle, opacity: 0.35, cursor: "default" }}
              >
                {inner}
              </span>
            );
          }

          return (
            <Link key={tab.key} href={tab.href} style={baseStyle}>
              {inner}
            </Link>
          );
        })}

        {/* Only visible below 768px — hide on desktop via CSS.
            The body padding reserves the nav's height so the footer stays reachable:
            the fixed nav covered the last NAV_HEIGHT px of every page (the FMV
            disclaimer was cut mid-sentence at 390px on /, pack, edition, sniper, packs —
            main pads its own bottom, the footer sits outside main). Keep the CSS text
            free of dates/dashes: jsdom folds <style> text into body.textContent and a
            component test asserts no "-<digit>" renders. */}
        <style>{`
          /* ⚠ The BAR itself had no safe-area padding — only body did. On a
             device with a home indicator the icons and captions were centred
             inside a 60px box whose lower strip is the indicator. content-box
             keeps the 60px content height and puts the inset BELOW it, so
             nothing moves on a device without one.
             This lives here rather than inline because jsdom's CSS parser drops
             an inline env() value, which makes it unassertable. */
          .rpc-mobile-nav { padding-bottom: env(safe-area-inset-bottom, 0px); box-sizing: content-box; }
          .rpc-mobile-nav { display: none !important; }
          .rpc-mobile-sheet { display: none !important; }
          @media (max-width: 768px) {
            .rpc-mobile-nav { display: flex !important; }
            .rpc-mobile-sheet { display: block !important; }
            body { padding-bottom: calc(${NAV_HEIGHT}px + env(safe-area-inset-bottom, 0px)) !important; }
          }
        `}</style>
      </nav>
    </>
  );
}
