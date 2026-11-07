"use client";

// components/dashboard/DashboardTabs.tsx — the one tab row every dashboard
// surface renders (IA Phase 1, 2026-11-06). On /dashboard the three panel tabs
// switch panels in place (`onSelect`); on /dashboard/packs and
// /dashboard/history they are links back to the panel, and the page's own tab
// is marked current. Without this, Packs and History were tabs you could leave
// from but not see yourself on — two orphan pages with a "← Dashboard" button.

import Link from "next/link";
import type { CSSProperties } from "react";
import { DASH_TABS, panelHref, type DashPanel, type DashTab } from "@/lib/dashboard-tabs";
import { onTablistKeyDown } from "@/lib/a11y/tablist-keys"

const condensedFont = "var(--font-display)";

function tabStyle(active: boolean): CSSProperties {
  return {
    fontFamily: condensedFont,
    fontWeight: 800,
    fontSize: 12,
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    padding: "10px 14px",
    minHeight: 44,
    borderRadius: 8,
    border: `1px solid ${active ? "var(--rpc-red-border)" : "var(--rpc-border)"}`,
    background: active ? "var(--rpc-surface-raised)" : "transparent",
    color: active ? "var(--rpc-text-primary)" : "var(--rpc-text-secondary)",
    textDecoration: "none",
    whiteSpace: "nowrap",
    cursor: "pointer",
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center",
  };
}

export default function DashboardTabs({
  active,
  onSelect,
}: {
  active: DashTab;
  /** Present on /dashboard itself: panel tabs switch in place instead of navigating. */
  onSelect?: (panel: DashPanel) => void;
}) {
  return (
    <div
      aria-label="Dashboard sections"
      role={onSelect ? "tablist" : "navigation"} onKeyDown={onTablistKeyDown} tabIndex={-1}
      className="rpc-dash-tabs"
      style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 2 }}
    >
      {DASH_TABS.map((t) => {
        const isActive = active === t.id;
        if (t.kind === "panel" && onSelect) {
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              // Only the selected panel is in the DOM — aria-controls on the
              // others pointed at an id that did not exist (2026-11-07 review).
              aria-controls={isActive ? `dash-panel-${t.id}` : undefined}
              className="rpc-dash-tab"
              style={tabStyle(isActive)}
              onClick={() => onSelect(t.id)}
            >
              {t.label}
            </button>
          );
        }
        const href = t.kind === "page" ? t.href : panelHref(t.id);
        return (
          <Link
            key={t.id}
            href={href}
            // Inside the /dashboard tablist every child must be a tab
            // (axe aria-required-children); the page tabs are tabs that navigate.
            // On the two page surfaces the row is a plain navigation.
            {...(onSelect ? { role: "tab", "aria-selected": false } : {})}
            aria-current={isActive ? "page" : undefined}
            className="rpc-dash-tab"
            style={tabStyle(isActive)}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
