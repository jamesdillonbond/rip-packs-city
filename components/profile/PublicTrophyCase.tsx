"use client";

import React from "react";
import { monoFont, condensedFont, labelStyle, TIER_COLORS, TrophyMoment } from "./_shared";

export default function PublicTrophyCase(props: { trophies: (TrophyMoment | null)[] }) {
  const slots: (TrophyMoment | null)[] = [];
  for (let i = 0; i < 6; i++) {
    slots.push(props.trophies[i] ?? null);
  }

  return (
    <section style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 10, padding: "16px 18px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <span style={labelStyle}>🏆 Trophy Case</span>
        <span style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.3)" }}>
          {slots.filter(function(t) { return !!t; }).length + " / 6"}
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
        {slots.map(function(t, i) {
          if (!t) {
            return (
              <div
                key={"empty-" + i}
                style={{
                  background: "rgba(255,255,255,0.02)",
                  border: "1px dashed rgba(255,255,255,0.08)",
                  borderRadius: 8,
                  aspectRatio: "1 / 1",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 9,
                  fontFamily: monoFont,
                  color: "rgba(255,255,255,0.2)",
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                }}
              >
                Empty slot
              </div>
            );
          }
          const thumb = t.thumbnail_url ?? t.video_url ?? null;
          const tierColor = (t.tier && TIER_COLORS[t.tier]) || "#6B7280";
          return (
            <div
              key={t.moment_id + "-" + i}
              style={{
                background: "rgba(255,255,255,0.02)",
                border: "1px solid rgba(255,255,255,0.07)",
                borderRadius: 8,
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
              }}
            >
              <div style={{ position: "relative", aspectRatio: "1 / 1", background: "rgba(255,255,255,0.03)" }}>
                {thumb ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={thumb}
                    alt={t.player_name ?? "Moment"}
                    style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                  />
                ) : (
                  <div style={{ width: "100%", height: "100%", background: "rgba(255,255,255,0.04)" }} />
                )}
                {t.tier && (
                  <span
                    style={{
                      position: "absolute",
                      top: 6,
                      left: 6,
                      background: "rgba(0,0,0,0.65)",
                      border: "1px solid " + tierColor,
                      color: tierColor,
                      fontSize: 8,
                      fontFamily: monoFont,
                      padding: "2px 6px",
                      borderRadius: 3,
                      letterSpacing: "0.12em",
                      textTransform: "uppercase",
                    }}
                  >
                    {t.tier}
                  </span>
                )}
              </div>
              <div style={{ padding: "8px 10px" }}>
                <div
                  style={{
                    fontFamily: condensedFont,
                    fontWeight: 700,
                    fontSize: 12,
                    color: "#fff",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {t.player_name ?? "Unknown"}
                </div>
                <div
                  style={{
                    fontSize: 9,
                    fontFamily: monoFont,
                    color: "rgba(255,255,255,0.45)",
                    marginTop: 2,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {t.set_name ?? ""}
                </div>
                {t.serial_number != null && (
                  <div
                    style={{
                      fontSize: 9,
                      fontFamily: monoFont,
                      color: "rgba(255,255,255,0.6)",
                      marginTop: 4,
                    }}
                  >
                    #{t.serial_number}
                    {t.circulation_count != null ? " / " + t.circulation_count : ""}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
