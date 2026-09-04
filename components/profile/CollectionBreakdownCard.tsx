"use client";

import { useState, useEffect } from "react";
import { monoFont, condensedFont, labelStyle, fmtDollars } from "./_shared";
import { fetchJson } from "@/lib/analytics/fetch-json";

interface CollectionBreakdownRow {
  collection_id: string;
  collection_name: string;
  moment_count: number;
  total_fmv: number;
  // STALE-confidence slice of total_fmv (route ≥ 2026-09-03). Rows render
  // total − stale with the stale part as a caption, the SAME split the
  // profile headline and the dashboard's saved-wallet cards use — before
  // this the breakdown summed to ~2× the headline directly above it.
  stale_fmv?: number | null;
  stale_count?: number | null;
  color: string;
}

/** Live (non-stale) FMV of a row — what the headline calls PORTFOLIO FMV. */
function liveFmv(r: CollectionBreakdownRow): number {
  return Math.max(0, (Number(r.total_fmv) || 0) - (Number(r.stale_fmv) || 0));
}

export default function CollectionBreakdownCard(props: { ownerKey: string }) {
  const [rows, setRows] = useState<CollectionBreakdownRow[]>([]);
  const [loading, setLoading] = useState(true);
  // Both the copy AND the header count are claims about the viewer's own
  // holdings; a failed read used to render "No collection data yet." beside
  // "0 moments" for a collector who owns thousands.
  const [failed, setFailed] = useState(false);

  useEffect(function() {
    if (!props.ownerKey) return;
    setLoading(true);
    fetchJson<{ collections?: CollectionBreakdownRow[] }>("/api/profile/collection-breakdown?ownerKey=" + encodeURIComponent(props.ownerKey))
      .then(function(res) {
        setFailed(!res.ok);
        if (res.ok) setRows(res.json?.collections ?? []);
      })
      .catch(function() {})
      .finally(function() { setLoading(false); });
  }, [props.ownerKey]);

  const totalFmv = rows.reduce(function(s, r) { return s + liveFmv(r); }, 0);
  const totalMoments = rows.reduce(function(s, r) { return s + (Number(r.moment_count) || 0); }, 0);
  const showFmv = totalFmv > 0 || rows.some(function(r) { return (Number(r.stale_fmv) || 0) > 0; });

  return (
    <section style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 8, padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <span style={labelStyle}>🎯 Collection Breakdown</span>
        <span style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.35)" }}>
          {failed || loading ? "—" : totalMoments + " moments"}
        </span>
      </div>
      {loading ? (
        <div style={{ fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.3)", padding: "18px 0", textAlign: "center" }}>Loading…</div>
      ) : failed ? (
        <div style={{ fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.25)", textAlign: "center", padding: "20px 0" }}>Couldn&apos;t load your collection breakdown right now.</div>
      ) : rows.length === 0 ? (
        <div style={{ fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.25)", textAlign: "center", padding: "20px 0" }}>No collection data yet.</div>
      ) : (
        <div>
          {showFmv && (
            <div style={{ display: "flex", width: "100%", height: 8, borderRadius: 4, overflow: "hidden", background: "rgba(255,255,255,0.04)", marginBottom: 14 }}>
              {rows.map(function(r) {
                const pct = totalFmv > 0 ? (liveFmv(r) / totalFmv) * 100 : 0;
                if (pct <= 0) return null;
                return <div key={r.collection_id} style={{ width: pct + "%", background: r.color }} title={r.collection_name + " " + pct.toFixed(1) + "%"} />;
              })}
            </div>
          )}
          <div style={{ display: "grid", gap: 8 }}>
            {rows.map(function(r) {
              return (
                <div key={r.collection_id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: r.color, flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontFamily: condensedFont, fontWeight: 700, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {r.collection_name}
                  </span>
                  <span style={{ fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.5)" }}>
                    {r.moment_count}
                  </span>
                  {showFmv && (
                    <span style={{ minWidth: 64, textAlign: "right" }}>
                      <span style={{ display: "block", fontSize: 11, fontFamily: monoFont, color: "#fff" }}>
                        {fmtDollars(liveFmv(r))}
                      </span>
                      {(Number(r.stale_fmv) || 0) > 0 && (
                        <span
                          data-stale-caption
                          style={{ display: "block", fontSize: 8, fontFamily: monoFont, color: "rgba(255,255,255,0.3)", letterSpacing: "0.06em", whiteSpace: "nowrap" }}
                        >
                          + {fmtDollars(Number(r.stale_fmv) || 0)} stale{(Number(r.stale_count) || 0) > 0 ? " · " + Number(r.stale_count).toLocaleString() : ""}
                        </span>
                      )}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
