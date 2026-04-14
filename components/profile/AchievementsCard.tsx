"use client";

import React, { useState, useEffect } from "react";
import { monoFont, condensedFont, labelStyle } from "./_shared";

interface Achievement {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  earned: boolean;
  unlocked_at: string | null;
}

function relTimeShort(iso: string | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return mins + "m ago";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  const days = Math.floor(hrs / 24);
  if (days < 30) return days + "d ago";
  const months = Math.floor(days / 30);
  if (months < 12) return months + "mo ago";
  return Math.floor(months / 12) + "y ago";
}

export default function AchievementsCard(props: { ownerKey: string }) {
  const [items, setItems] = useState<Achievement[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(function() {
    if (!props.ownerKey) return;
    setLoading(true);
    fetch("/api/profile/achievements?ownerKey=" + encodeURIComponent(props.ownerKey))
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(d) { if (d?.achievements) setItems(d.achievements); })
      .catch(function() {})
      .finally(function() { setLoading(false); });
  }, [props.ownerKey]);

  return (
    <section style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 10, padding: "16px 18px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <span style={labelStyle}>★ Achievements</span>
        {!loading && items.length > 0 && (
          <span style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.3)" }}>
            {items.filter(function(a) { return a.earned; }).length + " / " + items.length}
          </span>
        )}
      </div>
      {loading ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {[0, 1, 2, 3, 4, 5].map(function(i) {
            return (
              <div
                key={i}
                style={{
                  width: 88,
                  height: 32,
                  background: "rgba(255,255,255,0.04)",
                  borderRadius: 999,
                  animation: "pulse 1.6s ease-in-out infinite",
                }}
              />
            );
          })}
        </div>
      ) : items.length === 0 ? (
        <div style={{ fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.3)", padding: "6px 0" }}>
          No achievements yet.
        </div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {items.map(function(a) {
            const earned = a.earned;
            const tip = earned
              ? a.name + " — " + a.description + "\nUnlocked " + relTimeShort(a.unlocked_at)
              : a.name + " — " + a.description;
            return (
              <div
                key={a.id}
                title={tip}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "6px 12px",
                  background: earned ? "rgba(224,58,47,0.08)" : "rgba(255,255,255,0.02)",
                  border: earned
                    ? "1px solid rgba(224,58,47,0.4)"
                    : "1px solid rgba(255,255,255,0.07)",
                  borderRadius: 999,
                  opacity: earned ? 1 : 0.25,
                  filter: earned ? "none" : "grayscale(1)",
                  boxShadow: earned ? "0 0 8px rgba(245,158,11,0.15)" : "none",
                  cursor: "default",
                  transition: "all var(--transition-fast)",
                }}
              >
                <span style={{ fontSize: 14, lineHeight: 1 }}>{a.icon}</span>
                <span
                  style={{
                    fontFamily: condensedFont,
                    fontWeight: 700,
                    fontSize: 11,
                    color: earned ? "#fff" : "rgba(255,255,255,0.5)",
                    letterSpacing: "0.04em",
                    textTransform: "uppercase",
                    whiteSpace: "nowrap",
                  }}
                >
                  {a.name}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
