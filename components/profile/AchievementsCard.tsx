"use client";

import React, { useState, useEffect, useCallback } from "react";
import { monoFont, condensedFont, labelStyle, btnBase } from "./_shared";
import { ACHIEVEMENT_DEFS, getTierColor, getHighestTierLabel } from "@/lib/achievements";

export interface ProfileAchievement {
  achievement_key: string;
  tier: string;
  progress: Record<string, unknown>;
  unlocked_at: string;
}

type AchievementMap = Record<string, { tier: string; progress: Record<string, number> }>;

function progressHint(key: string, progress: Record<string, unknown>): string {
  const num = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  switch (key) {
    case "pack_hunter":
      return num(progress.count).toLocaleString() + " packs";
    case "big_spender":
      return "$" + num(progress.amount).toLocaleString() + " spent";
    case "serial_sniper":
      return num(progress.serial10) + " × #≤10";
    case "series_collector":
      return num(progress.count) + " series";
    case "trophy_curator":
      return num(progress.count) + " / 6";
    case "challenge_accepted":
      return num(progress.count) + " challenges";
    case "diamond_hands":
      return num(progress.count) + " Legendaries";
    default:
      return "";
  }
}

export default function AchievementsCard(props: { ownerKey: string }) {
  const [items, setItems] = useState<AchievementMap>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [updated, setUpdated] = useState(false);

  const load = useCallback(function () {
    if (!props.ownerKey) return;
    return fetch("/api/profile/achievements?ownerKey=" + encodeURIComponent(props.ownerKey))
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (d) {
        if (!d?.achievements) return;
        const map: AchievementMap = {};
        for (const a of d.achievements as ProfileAchievement[]) {
          map[a.achievement_key] = {
            tier: a.tier,
            progress: (a.progress ?? {}) as Record<string, number>,
          };
        }
        setItems(map);
      })
      .catch(function () {});
  }, [props.ownerKey]);

  useEffect(function () {
    setLoading(true);
    Promise.resolve(load()).finally(function () {
      setLoading(false);
    });
  }, [load]);

  function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    setUpdated(false);
    fetch("/api/profile/achievements", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ownerKey: props.ownerKey }),
    })
      .catch(function () {})
      .finally(function () {
        window.setTimeout(function () {
          Promise.resolve(load()).finally(function () {
            setRefreshing(false);
            setUpdated(true);
            window.setTimeout(function () {
              setUpdated(false);
            }, 2000);
          });
        }, 2000);
      });
  }

  const unlockedCount = Object.keys(items).length;
  const defKeys = Object.keys(ACHIEVEMENT_DEFS);

  return (
    <section
      style={{
        background: "rgba(255,255,255,0.02)",
        border: "1px solid rgba(255,255,255,0.07)",
        borderRadius: 10,
        padding: "16px 18px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 14,
          gap: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={labelStyle}>★ Achievements</span>
          {!loading && (
            <span
              style={{
                fontSize: 8,
                fontFamily: monoFont,
                background: "rgba(245,158,11,0.15)",
                color: "#F59E0B",
                border: "1px solid rgba(245,158,11,0.35)",
                padding: "2px 7px",
                borderRadius: 999,
                letterSpacing: "0.1em",
                fontWeight: 700,
              }}
            >
              {unlockedCount + " / " + defKeys.length}
            </span>
          )}
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          style={Object.assign({}, btnBase, {
            fontSize: 9,
            opacity: refreshing ? 0.55 : 1,
            cursor: refreshing ? "default" : "pointer",
          })}
        >
          {refreshing ? "Refreshing…" : updated ? "✓ Updated" : "↻ Refresh"}
        </button>
      </div>

      {loading ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {[0, 1, 2, 3, 4, 5, 6].map(function (i) {
            return (
              <div
                key={i}
                className="rpc-skeleton"
                style={{ width: 120, height: 32, borderRadius: 999 }}
              />
            );
          })}
        </div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {defKeys.map(function (key) {
            const def = ACHIEVEMENT_DEFS[key];
            const earned = items[key];
            if (earned) {
              const tc = getTierColor(earned.tier);
              const tierLabel = getHighestTierLabel(def, earned.tier);
              const hint = progressHint(key, earned.progress);
              return (
                <div
                  key={key}
                  title={def.name + " — " + def.description}
                  style={{
                    background: tc + "15",
                    border: "1px solid " + tc + "40",
                    borderRadius: 999,
                    padding: "6px 12px",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <span style={{ fontSize: 16, lineHeight: 1 }}>{def.emoji}</span>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      lineHeight: 1.1,
                    }}
                  >
                    <span
                      style={{
                        fontFamily: condensedFont,
                        fontWeight: 700,
                        fontSize: 12,
                        color: "#fff",
                      }}
                    >
                      {def.name}
                    </span>
                    {hint && (
                      <span
                        style={{
                          fontFamily: monoFont,
                          fontSize: 9,
                          color: "rgba(255,255,255,0.4)",
                          marginTop: 2,
                        }}
                      >
                        {hint}
                      </span>
                    )}
                  </div>
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
            }

            const nextTier = def.tiers[0];
            return (
              <div
                key={key}
                title={def.name + " — " + def.description}
                style={{
                  opacity: 0.35,
                  border: "1px solid rgba(255,255,255,0.08)",
                  background: "transparent",
                  borderRadius: 999,
                  padding: "6px 12px",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span style={{ fontSize: 16, lineHeight: 1, opacity: 0.4 }}>{def.emoji}</span>
                <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1 }}>
                  <span
                    style={{
                      fontFamily: condensedFont,
                      fontWeight: 700,
                      fontSize: 12,
                      color: "rgba(255,255,255,0.5)",
                    }}
                  >
                    {def.name}
                  </span>
                  {nextTier && (
                    <span
                      style={{
                        fontFamily: monoFont,
                        fontSize: 9,
                        color: "rgba(255,255,255,0.5)",
                        marginTop: 2,
                        opacity: 0.7,
                      }}
                    >
                      {nextTier.desc}
                    </span>
                  )}
                </div>
                <span style={{ fontSize: 9, opacity: 0.4 }}>🔒</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
