"use client";

import React, { useEffect, useState } from "react";
import { ACHIEVEMENT_DEFS, getTierColor, getHighestTierLabel } from "@/lib/achievements";
import type { ProfileAchievement } from "./AchievementsCard";

const monoFont = "'Share Tech Mono', monospace";
const condensedFont = "'Barlow Condensed', sans-serif";

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontFamily: monoFont,
  letterSpacing: "0.2em",
  color: "rgba(255,255,255,0.5)",
  textTransform: "uppercase",
};

export default function PublicAchievements(props: { ownerKey: string }) {
  const [items, setItems] = useState<ProfileAchievement[] | null>(null);

  useEffect(function () {
    if (!props.ownerKey) return;
    fetch("/api/profile/achievements?ownerKey=" + encodeURIComponent(props.ownerKey))
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (d) {
        setItems((d?.achievements ?? []) as ProfileAchievement[]);
      })
      .catch(function () {
        setItems([]);
      });
  }, [props.ownerKey]);

  if (items == null || items.length === 0) return null;

  return (
    <div style={{ marginBottom: 24, textAlign: "center" }}>
      <div style={Object.assign({}, labelStyle, { marginBottom: 10 })}>
        {"★ Achievements · " + items.length + " unlocked"}
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          justifyContent: "center",
        }}
      >
        {items.map(function (a) {
          const def = ACHIEVEMENT_DEFS[a.achievement_key];
          if (!def) return null;
          const tc = getTierColor(a.tier);
          const tierLabel = getHighestTierLabel(def, a.tier);
          return (
            <div
              key={a.achievement_key}
              title={def.name + " — " + def.description}
              style={{
                background: tc + "15",
                border: "1px solid " + tc + "40",
                borderRadius: 999,
                padding: "5px 11px",
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
                transition: "box-shadow 0.18s ease",
              }}
              onMouseEnter={function (e) {
                e.currentTarget.style.boxShadow = "0 0 12px " + tc + "33";
              }}
              onMouseLeave={function (e) {
                e.currentTarget.style.boxShadow = "none";
              }}
            >
              <span style={{ fontSize: 14, lineHeight: 1 }}>{def.emoji}</span>
              <span
                style={{
                  fontFamily: condensedFont,
                  fontWeight: 700,
                  fontSize: 11,
                  color: "#fff",
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                  whiteSpace: "nowrap",
                }}
              >
                {def.name}
              </span>
              <span
                style={{
                  background: tc + "30",
                  color: tc,
                  fontSize: 8,
                  padding: "1px 6px",
                  borderRadius: 999,
                  fontFamily: monoFont,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  fontWeight: 700,
                }}
              >
                {tierLabel}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
