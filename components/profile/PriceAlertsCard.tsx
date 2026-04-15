"use client";

import { useState, useEffect, useCallback } from "react";
import { monoFont, condensedFont, labelStyle, btnBase, fmtDollars } from "./_shared";

interface AlertRow {
  id: string;
  owner_key: string;
  edition_key: string;
  player_name: string | null;
  set_name: string | null;
  alert_type: string;
  threshold: number;
  channel: string;
  notification_email: string | null;
  active: boolean;
  last_triggered_at: string | null;
  created_at: string;
  fmv?: number | null;
  low_ask?: number | null;
  currently_triggered?: boolean;
}

function describe(alert_type: string, threshold: number): string {
  switch (alert_type) {
    case "below_price":
      return "Lowest ask drops to or below " + fmtDollars(Number(threshold));
    case "below_fmv_pct":
      return "Discount vs FMV exceeds " + threshold + "%";
    case "below_fmv":
      return "FMV drops below " + fmtDollars(Number(threshold));
    case "above_fmv":
      return "FMV rises above " + fmtDollars(Number(threshold));
    default:
      return alert_type + " ≥ " + threshold;
  }
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const day = 24 * 60 * 60 * 1000;
  if (diff < day) return "Today";
  if (diff < 2 * day) return "Yesterday";
  if (diff < 7 * day) return Math.floor(diff / day) + "d ago";
  return d.toLocaleDateString();
}

export default function PriceAlertsCard(props: { ownerKey: string }) {
  const [alerts, setAlerts] = useState<AlertRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async function () {
    if (!props.ownerKey) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/alerts?include_inactive=1&owner_key=" + encodeURIComponent(props.ownerKey));
      if (!res.ok) throw new Error("Failed to load alerts");
      const data = await res.json();
      setAlerts(Array.isArray(data) ? data : []);
    } catch (err: any) {
      setError(err?.message ?? "Failed to load");
      setAlerts([]);
    } finally {
      setLoading(false);
    }
  }, [props.ownerKey]);

  useEffect(function () { load(); }, [load]);

  async function toggleActive(a: AlertRow) {
    setBusyId(a.id);
    try {
      const res = await fetch("/api/alerts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: a.id, owner_key: props.ownerKey, active: !a.active }),
      });
      if (!res.ok) throw new Error("Failed to update");
      const updated = await res.json();
      setAlerts(function (prev) { return (prev ?? []).map((x) => x.id === a.id ? { ...x, active: updated.active } : x); });
    } catch (err: any) {
      alert(err?.message ?? "Failed to update alert");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(a: AlertRow) {
    if (!confirm("Delete this alert? This cannot be undone.")) return;
    setBusyId(a.id);
    try {
      const url = "/api/alerts?id=" + encodeURIComponent(a.id) + "&owner_key=" + encodeURIComponent(props.ownerKey);
      const res = await fetch(url, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete");
      setAlerts(function (prev) { return (prev ?? []).filter((x) => x.id !== a.id); });
    } catch (err: any) {
      alert(err?.message ?? "Failed to delete alert");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section style={{ background: "var(--rpc-surface)", border: "1px solid var(--rpc-border)", borderRadius: 12, padding: 20, marginTop: 24 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div>
          <div style={{ ...labelStyle }}>Price Alerts</div>
          <div className="rpc-heading" style={{ fontSize: 17, marginTop: 4 }}>🔔 Your Watch List</div>
        </div>
        <button onClick={load} style={{ ...btnBase }} disabled={loading}>
          {loading ? "…" : "Refresh"}
        </button>
      </div>

      {error && <div style={{ color: "#f87171", fontSize: 12, fontFamily: monoFont, marginBottom: 10 }}>{error}</div>}

      {alerts && alerts.length === 0 && (
        <div style={{ padding: "20px 16px", textAlign: "center", color: "var(--rpc-text-muted)", fontSize: 13, fontFamily: condensedFont }}>
          No price alerts set. Visit any collection page and tap the 🔔 icon on a moment to create one.
        </div>
      )}

      {alerts && alerts.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {alerts.map(function (a) {
            return (
              <div key={a.id} style={{
                display: "grid",
                gridTemplateColumns: "1fr auto",
                gap: 12,
                padding: "12px 14px",
                background: "var(--rpc-surface-raised)",
                border: "1px solid var(--rpc-border)",
                borderRadius: 8,
                opacity: a.active ? 1 : 0.6,
              }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span style={{
                      display: "inline-block",
                      width: 8, height: 8, borderRadius: "50%",
                      background: a.active ? "#22c55e" : "#6b7280",
                      flexShrink: 0,
                    }} />
                    <span className="rpc-heading" style={{ fontSize: 14, color: "var(--rpc-text-primary)" }}>
                      {a.player_name || "Unknown player"}
                    </span>
                    {a.currently_triggered && (
                      <span style={{ fontSize: 9, fontFamily: monoFont, letterSpacing: "0.12em", color: "#22c55e", textTransform: "uppercase", padding: "2px 6px", border: "1px solid #22c55e44", borderRadius: 4 }}>
                        Live
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--rpc-text-secondary)", fontFamily: condensedFont, marginBottom: 6 }}>
                    {a.set_name || "—"}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--rpc-text-primary)", fontFamily: monoFont }}>
                    {describe(a.alert_type, Number(a.threshold))}
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 6, fontSize: 11, color: "var(--rpc-text-muted)", fontFamily: monoFont }}>
                    {a.low_ask != null && <span>Ask: <span style={{ color: "var(--rpc-text-primary)" }}>{fmtDollars(a.low_ask)}</span></span>}
                    {a.fmv != null && <span>FMV: <span style={{ color: "var(--rpc-text-primary)" }}>{fmtDollars(a.fmv)}</span></span>}
                    <span>Last: {fmtWhen(a.last_triggered_at)}</span>
                    {a.notification_email && <span>→ {a.notification_email}</span>}
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
                  <button
                    onClick={function () { toggleActive(a); }}
                    disabled={busyId === a.id}
                    style={{ ...btnBase, minWidth: 70 }}
                    title={a.active ? "Pause this alert" : "Resume this alert"}
                  >
                    {a.active ? "Pause" : "Resume"}
                  </button>
                  <button
                    onClick={function () { remove(a); }}
                    disabled={busyId === a.id}
                    style={{ ...btnBase, minWidth: 70, color: "#f87171", borderColor: "#f8717144" }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
