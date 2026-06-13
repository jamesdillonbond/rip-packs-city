"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useEffect, useMemo } from "react";
import { getLastCollection } from "@/lib/active-collection";
import ThemeToggle from "@/components/ThemeToggle";
import {
  PAGE_LABELS,
  getCollection,
  publishedCollections,
  type CollectionPage,
} from "@/lib/collections";

// Sheet renders these page chips per collection — order matters and the set
// is fixed (fast-break / road-to-the-ring / vault are deliberately omitted).
// "collection" surfaces as "Wallet" to match the bottom-tab vocabulary.
const SHEET_PAGES: { key: CollectionPage; label: string }[] = [
  { key: "overview", label: PAGE_LABELS.overview },
  { key: "sniper", label: PAGE_LABELS.sniper },
  { key: "packs", label: PAGE_LABELS.packs },
  { key: "pack-sniper", label: PAGE_LABELS["pack-sniper"] },
  { key: "collection", label: "Wallet" },
  { key: "sets", label: PAGE_LABELS.sets },
  { key: "badges", label: PAGE_LABELS.badges },
  { key: "market", label: PAGE_LABELS.market },
  { key: "analytics", label: PAGE_LABELS.analytics },
];

const TAB_ICON_FONT = 18;
const NAV_HEIGHT = 60;

export default function MobileNav() {
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const [sheetOpen, setSheetOpen] = useState(false);
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

  const tabs = [
    {
      key: "profile",
      label: "PROFILE",
      icon: "\u{1F464}",
      href: "/profile",
      isActive: pathname.startsWith("/profile"),
      kind: "link" as const,
    },
    {
      key: "sniper",
      label: "SNIPER",
      icon: "⚡",
      href: `/${collection}/sniper`,
      isActive: pageSegment === "sniper",
      kind: "link" as const,
    },
    {
      key: "packs",
      label: "PACKS",
      icon: "▣",
      href: `/${collection}/packs`,
      isActive: pageSegment === "packs",
      kind: "link" as const,
    },
    {
      key: "wallet",
      label: "WALLET",
      icon: "◈",
      href: `/${collection}/collection`,
      isActive: pageSegment === "collection",
      kind: "link" as const,
    },
    {
      key: "collections",
      label: "COLLECTIONS",
      icon: "▦",
      href: "",
      isActive: sheetOpen,
      kind: "button" as const,
    },
  ];

  const closeSheet = () => setSheetOpen(false);

  const goTo = (href: string) => {
    closeSheet();
    router.push(href);
  };

  return (
    <>
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
            role="dialog"
            aria-label="Collections"
            style={{
              position: "fixed",
              bottom: NAV_HEIGHT,
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
                const pages = SHEET_PAGES.filter((p) => c.pages.includes(p.key));
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
          const color = tab.isActive ? "var(--rpc-red)" : "var(--rpc-text-ghost)";
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
                  fontSize: 8,
                  letterSpacing: "0.12em",
                  fontWeight: tab.isActive ? 700 : 400,
                  color,
                }}
              >
                {tab.label}
              </span>
            </>
          );

          const baseStyle: React.CSSProperties = {
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 2,
            textDecoration: "none",
            color,
            transition: "color var(--transition-fast)",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            padding: 0,
            fontFamily: "inherit",
          };

          if (tab.kind === "button") {
            return (
              <button
                key={tab.key}
                onClick={() => setSheetOpen((v) => !v)}
                aria-pressed={tab.isActive}
                style={baseStyle}
              >
                {inner}
              </button>
            );
          }

          return (
            <Link key={tab.key} href={tab.href} style={baseStyle}>
              {inner}
            </Link>
          );
        })}

        {/* Only visible below 768px — hide on desktop via CSS */}
        <style>{`
          .rpc-mobile-nav { display: none !important; }
          .rpc-mobile-sheet { display: none !important; }
          @media (max-width: 768px) {
            .rpc-mobile-nav { display: flex !important; }
            .rpc-mobile-sheet { display: block !important; }
          }
        `}</style>
      </nav>
    </>
  );
}
