"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect, useMemo } from "react";
import { getLastCollection } from "@/lib/active-collection";
import { getCollection } from "@/lib/collections";

const ICON_SIZE = 22;

function IconHome({ color }: { color: string }) {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H4a1 1 0 01-1-1V9.5z" />
      <path d="M9 21V12h6v9" />
    </svg>
  );
}

function IconWallet({ color }: { color: string }) {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="6" width="20" height="14" rx="2" />
      <path d="M2 10h20" />
      <circle cx="17" cy="15" r="1.5" fill={color} stroke="none" />
    </svg>
  );
}

function IconSniper({ color }: { color: string }) {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="3" />
      <line x1="12" y1="2" x2="12" y2="5" />
      <line x1="12" y1="19" x2="12" y2="22" />
      <line x1="2" y1="12" x2="5" y2="12" />
      <line x1="19" y1="12" x2="22" y2="12" />
    </svg>
  );
}

function IconSets({ color }: { color: string }) {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function IconBadges({ color }: { color: string }) {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15 9 22 9.5 17 14.5 18.5 22 12 18 5.5 22 7 14.5 2 9.5 9 9 12 2" />
    </svg>
  );
}

function IconAnalytics({ color }: { color: string }) {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <line x1="3" y1="21" x2="21" y2="21" />
      <rect x="5" y="12" width="3" height="7" />
      <rect x="10.5" y="7" width="3" height="12" />
      <rect x="16" y="14" width="3" height="5" />
    </svg>
  );
}

function IconProfile({ color }: { color: string }) {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-1a6 6 0 0112 0v1" />
    </svg>
  );
}

const ICON_COMPONENTS = {
  home: IconHome,
  wallet: IconWallet,
  sniper: IconSniper,
  sets: IconSets,
  badges: IconBadges,
  analytics: IconAnalytics,
  profile: IconProfile,
} as const;

type IconKey = keyof typeof ICON_COMPONENTS;

function thirdTabFor(collection: string): { label: string; iconKey: IconKey; href: string } {
  if (collection === "nfl-all-day") {
    return { label: "BADGES", iconKey: "badges", href: `/${collection}/badges` };
  }
  if (collection === "disney-pinnacle" || collection === "laliga-golazos" || collection === "ufc") {
    return { label: "ANALYTICS", iconKey: "analytics", href: `/${collection}/analytics` };
  }
  return { label: "SETS", iconKey: "sets", href: `/${collection}/sets` };
}

export default function MobileNav() {
  const pathname = usePathname() ?? "/";
  const [fallbackCollection, setFallbackCollection] = useState("nba-top-shot");

  useEffect(() => {
    setFallbackCollection(getLastCollection());
  }, []);

  const collection = useMemo(() => {
    const seg = pathname.split("/").filter(Boolean)[0] ?? "";
    return getCollection(seg) ? seg : fallbackCollection;
  }, [pathname, fallbackCollection]);

  const accent = getCollection(collection)?.accent ?? "#E03A2F";

  const tabs: { label: string; iconKey: IconKey; href: string }[] = [
    { label: "HOME", iconKey: "home", href: "/" },
    { label: "COLLECTION", iconKey: "wallet", href: `/${collection}/collection` },
    { label: "SNIPER", iconKey: "sniper", href: `/${collection}/sniper` },
    thirdTabFor(collection),
    { label: "PROFILE", iconKey: "profile", href: "/profile" },
  ];

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
        const isActive =
          tab.href === "/"
            ? pathname === "/"
            : pathname === tab.href || pathname.startsWith(tab.href + "/");
        const color = isActive ? accent : "var(--rpc-text-ghost)";
        const Icon = ICON_COMPONENTS[tab.iconKey];
        return (
          <Link
            key={tab.label}
            href={tab.href}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 2,
              textDecoration: "none",
              color,
              transition: "color var(--transition-fast)",
            }}
          >
            <Icon color={color} />
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
