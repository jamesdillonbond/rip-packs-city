"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { publishedCollections, type CollectionPage } from "@/lib/collections";

interface CollectionSwitcherProps {
  activeCollectionId: string;
}

const KNOWN_PAGES: readonly CollectionPage[] = [
  "overview",
  "collection",
  "packs",
  "sniper",
  "badges",
  "sets",
  "vault",
  "market",
  "analytics",
];

function isCollectionPage(value: string): value is CollectionPage {
  return (KNOWN_PAGES as readonly string[]).includes(value);
}

function derivePageType(pathname: string | null): CollectionPage {
  // pathname looks like "/nba-top-shot/sniper"; we want the second segment.
  if (!pathname) return "overview";
  const parts = pathname.split("/").filter(Boolean);
  const candidate = parts[1] ?? "";
  return isCollectionPage(candidate) ? candidate : "overview";
}

export default function CollectionSwitcher({ activeCollectionId }: CollectionSwitcherProps) {
  const collections = publishedCollections();
  const pathname = usePathname();
  const pageType = derivePageType(pathname);

  return (
    <div
      style={{
        display: "flex",
        gap: 6,
        overflowX: "auto",
        padding: "8px 0 4px",
        scrollbarWidth: "none",
        msOverflowStyle: "none",
      }}
    >
      <style>{`
        .rpc-switcher-row::-webkit-scrollbar { display: none; }
      `}</style>
      <div className="rpc-switcher-row" style={{ display: "flex", gap: 6, overflowX: "auto", scrollbarWidth: "none" }}>
        {collections.map((col) => {
          const isActive = col.id === activeCollectionId;
          const supportsPage = col.pages.includes(pageType);
          const targetPath = `/${col.id}/${pageType}`;

          const chipStyle = {
            display: "flex",
            alignItems: "center",
            gap: 5,
            padding: "4px 10px",
            borderRadius: 20,
            border: isActive ? `1px solid ${col.accent}` : "1px solid rgba(255,255,255,0.08)",
            background: isActive ? `${col.accent}18` : "transparent",
            color: isActive
              ? col.accent
              : supportsPage
                ? "rgba(255,255,255,0.4)"
                : "rgba(255,255,255,0.2)",
            fontFamily: "'Barlow Condensed', sans-serif",
            fontWeight: 700 as const,
            fontSize: 11,
            letterSpacing: "0.06em",
            textTransform: "uppercase" as const,
            textDecoration: "none",
            whiteSpace: "nowrap" as const,
            flexShrink: 0,
            transition: "all 0.15s ease",
            opacity: supportsPage ? 1 : 0.4,
            cursor: supportsPage ? "pointer" : "not-allowed",
          };

          if (!supportsPage) {
            return (
              <span
                key={col.id}
                aria-disabled="true"
                title={`${col.shortLabel} doesn't have a ${pageType} page`}
                style={chipStyle}
              >
                <span style={{ fontSize: 13 }}>{col.icon}</span>
                {col.shortLabel}
              </span>
            );
          }

          return (
            <Link key={col.id} href={targetPath} style={chipStyle}>
              <span style={{ fontSize: 13 }}>{col.icon}</span>
              {col.shortLabel}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
