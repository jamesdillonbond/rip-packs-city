"use client";

import Link from "next/link";
import { publishedCollections } from "@/lib/collections";

interface CollectionSwitcherProps {
  activeCollectionId: string;
}

export default function CollectionSwitcher({ activeCollectionId }: CollectionSwitcherProps) {
  const collections = publishedCollections();

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
          return (
            <Link
              key={col.id}
              href={`/${col.id}/overview`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                padding: "4px 10px",
                borderRadius: 20,
                border: isActive ? `1px solid ${col.accent}` : "1px solid rgba(255,255,255,0.08)",
                background: isActive ? `${col.accent}18` : "transparent",
                color: isActive ? col.accent : "rgba(255,255,255,0.4)",
                fontFamily: "'Barlow Condensed', sans-serif",
                fontWeight: 700,
                fontSize: 11,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                textDecoration: "none",
                whiteSpace: "nowrap",
                flexShrink: 0,
                transition: "all 0.15s ease",
              }}
            >
              <span style={{ fontSize: 13 }}>{col.icon}</span>
              {col.shortLabel}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
