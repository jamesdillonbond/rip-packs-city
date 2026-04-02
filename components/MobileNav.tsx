"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import { getLastCollection } from "@/lib/active-collection";
import { getCollection } from "@/lib/collections";

export default function MobileNav() {
  const pathname = usePathname();
  const [collectionId, setCollectionId] = useState("nba-top-shot");

  useEffect(() => {
    setCollectionId(getLastCollection());
  }, []);

  const collection = getCollection(collectionId);
  const pages = collection?.pages ?? [];

  // Build dynamic tabs
  const tabs: { label: string; icon: string; href: string }[] = [
    { label: "HOME", icon: "🏠", href: "/" },
    { label: "WALLET", icon: "◈", href: `/${collectionId}/collection` },
    { label: "SNIPER", icon: "⚡", href: `/${collectionId}/sniper` },
  ];

  // Badges tab — only if collection has badges; otherwise try sets
  if (pages.includes("badges")) {
    tabs.push({ label: "BADGES", icon: "⭐", href: `/${collectionId}/badges` });
  } else if (pages.includes("sets")) {
    tabs.push({ label: "SETS", icon: "📋", href: `/${collectionId}/sets` });
  }

  tabs.push({ label: "PROFILE", icon: "👤", href: "/profile" });

  return (
    <nav
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 200,
        background: "var(--rpc-surface)",
        borderTop: "1px solid var(--rpc-red-border)",
        height: 60,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-around",
        fontFamily: "var(--font-mono)",
      }}
      className="rpc-mobile-nav"
    >
      {tabs.map((tab) => {
        const isActive = pathname === tab.href || pathname.startsWith(tab.href + "/");
        return (
          <Link
            key={tab.href}
            href={tab.href}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 2,
              textDecoration: "none",
              color: isActive ? "var(--rpc-red)" : "var(--rpc-text-ghost)",
              fontSize: 18,
              transition: "color var(--transition-fast)",
            }}
          >
            <span>{tab.icon}</span>
            <span
              style={{
                fontSize: 8,
                letterSpacing: "0.12em",
                fontWeight: isActive ? 700 : 400,
              }}
            >
              {tab.label}
            </span>
          </Link>
        );
      })}

      {/* Only visible below 768px — hide on desktop via CSS */}
      <style>{`
        .rpc-mobile-nav { display: none !important; }
        @media (max-width: 768px) {
          .rpc-mobile-nav { display: flex !important; }
        }
      `}</style>
    </nav>
  );
}
