"use client";

// app/dashboard/alerts/page.tsx
//
// Per-user FMV alert management. Lists active + inactive alerts, lets the
// user toggle active/delete each row, and create new ones via a modal.
//
// Quota: POST /api/alerts gates on check_feature_quota(wallet,
// 'custom_alerts_max'). Free plan returns 402; we surface "Upgrade to Pro"
// with a /pricing link. Pro plan = 25 alerts/wallet.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { getOwnerKey, onOwnerKeyChange } from "@/lib/owner-key";

interface Alert {
  id: number | string;
  owner_key: string;
  edition_key: string;
  player_name: string | null;
  set_name: string | null;
  alert_type: "below_price" | "below_fmv_pct";
  threshold: number;
  channel: "email" | "telegram" | "both";
  notification_email: string | null;
  active: boolean;
  last_triggered_at: string | null;
  created_at: string;
  fmv?: number | null;
  low_ask?: number | null;
  current_discount_pct?: number | null;
  currently_triggered?: boolean;
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null || isNaN(Number(n))) return "—";
  const v = Number(n);
  if (Math.abs(v) >= 1000) return `$${Math.round(v).toLocaleString("en-US")}`;
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function describeAlert(type: Alert["alert_type"], threshold: number): string {
  if (type === "below_price") return `Lowest ask ≤ ${fmtUsd(threshold)}`;
  if (type === "below_fmv_pct") return `Discount vs FMV ≥ ${threshold}%`;
  return `${type} @ ${threshold}`;
}

export default function AlertsPage() {
  const [ownerKey, setOwnerKey] = useState<string>("");
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [paywall, setPaywall] = useState<string | null>(null);

  useEffect(() => {
    setOwnerKey(getOwnerKey());
    const unsubscribe = onOwnerKeyChange((k) => setOwnerKey(k));
    return unsubscribe;
  }, []);

  const load = useCallback(async () => {
    if (!ownerKey) {
      setAlerts(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/alerts?owner_key=${encodeURIComponent(ownerKey)}&include_inactive=1`,
        { credentials: "include", cache: "no-store" }
      );
      const j = await res.json();
      if (!res.ok) {
        setErr(j?.error ?? `HTTP ${res.status}`);
        setAlerts([]);
      } else {
        setAlerts(Array.isArray(j) ? j : []);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setAlerts([]);
    } finally {
      setLoading(false);
    }
  }, [ownerKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleActive = async (a: Alert) => {
    const res = await fetch("/api/alerts", {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: a.id, owner_key: a.owner_key, active: !a.active }),
    });
    if (res.ok) void load();
    else {
      const j = await res.json().catch(() => ({}));
      setErr(j?.error ?? `HTTP ${res.status}`);
    }
  };

  const deleteAlert = async (a: Alert) => {
    if (!confirm(`Delete alert for ${a.player_name ?? a.edition_key}?`)) return;
    const url = `/api/alerts?id=${encodeURIComponent(String(a.id))}&owner_key=${encodeURIComponent(a.owner_key)}`;
    const res = await fetch(url, { method: "DELETE", credentials: "include" });
    if (res.ok) void load();
    else {
      const j = await res.json().catch(() => ({}));
      setErr(j?.error ?? `HTTP ${res.status}`);
    }
  };

  const onCreated = (alert: Alert | null, paywallMessage: string | null) => {
    setPaywall(paywallMessage);
    setShowCreate(false);
    if (alert) void load();
  };

  return (
    <main style={S.page}>
      <style>{CSS}</style>

      <header className="rpc-al-header">
        <div>
          <div className="rpc-al-eyebrow">Rip Packs City</div>
          <h1 className="rpc-al-h1">Custom Alerts</h1>
          <p className="rpc-al-lede">
            Fire alerts when listings drop below your target price, or when the
            discount vs FMV reaches a threshold. Emails go to your saved
            address; Telegram delivery is available too.
          </p>
        </div>
        <div className="rpc-al-actions">
          <button
            type="button"
            onClick={() => {
              setPaywall(null);
              setShowCreate(true);
            }}
            className="rpc-al-cta"
            disabled={!ownerKey}
          >
            + Create Alert
          </button>
          <Link href="/dashboard" className="rpc-al-cta-link">← Back to dashboard</Link>
        </div>
      </header>

      {!ownerKey && (
        <div className="rpc-al-empty">
          Connect a Flow wallet on the dashboard before creating alerts.
        </div>
      )}

      {paywall && (
        <div className="rpc-al-paywall">
          <div className="rpc-al-paywall-title">Upgrade to Pro</div>
          <div className="rpc-al-paywall-body">{paywall}</div>
          <Link href="/pricing" className="rpc-al-cta" style={{ display: "inline-block", marginTop: 8 }}>
            See Pro plans →
          </Link>
        </div>
      )}

      {err && <div className="rpc-al-err">{err}</div>}

      {ownerKey && loading && !alerts && (
        <div className="rpc-al-empty">Loading…</div>
      )}

      {ownerKey && alerts && alerts.length === 0 && (
        <div className="rpc-al-empty">
          No alerts yet. Click <strong>+ Create Alert</strong> to set your first one.
        </div>
      )}

      {ownerKey && alerts && alerts.length > 0 && (
        <div className="rpc-al-table-wrap">
          <table className="rpc-al-table">
            <thead>
              <tr>
                <th>Edition</th>
                <th>Condition</th>
                <th style={{ textAlign: "right" }}>Threshold</th>
                <th style={{ textAlign: "right" }}>Current</th>
                <th>Status</th>
                <th style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((a) => {
                const triggered = a.currently_triggered === true;
                const currentDisplay =
                  a.alert_type === "below_price"
                    ? fmtUsd(a.low_ask)
                    : a.current_discount_pct != null
                    ? `${a.current_discount_pct}%`
                    : "—";
                return (
                  <tr key={String(a.id)} className={a.active ? "" : "rpc-al-row-inactive"}>
                    <td>
                      <div className="rpc-al-edition-name">{a.player_name ?? "—"}</div>
                      <div className="rpc-al-edition-set">{a.set_name ?? a.edition_key}</div>
                    </td>
                    <td>{describeAlert(a.alert_type, Number(a.threshold))}</td>
                    <td style={{ textAlign: "right" }}>
                      {a.alert_type === "below_price" ? fmtUsd(a.threshold) : `${a.threshold}%`}
                    </td>
                    <td style={{ textAlign: "right" }}>{currentDisplay}</td>
                    <td>
                      {!a.active ? (
                        <span className="rpc-al-pill rpc-al-pill-off">Paused</span>
                      ) : triggered ? (
                        <span className="rpc-al-pill rpc-al-pill-hot">Triggered</span>
                      ) : (
                        <span className="rpc-al-pill rpc-al-pill-on">Active</span>
                      )}
                      {a.last_triggered_at && (
                        <div className="rpc-al-last-fired">
                          Last fired {new Date(a.last_triggered_at).toLocaleDateString("en-US")}
                        </div>
                      )}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button className="rpc-al-iconbtn" onClick={() => toggleActive(a)}>
                        {a.active ? "Pause" : "Resume"}
                      </button>
                      <button className="rpc-al-iconbtn rpc-al-iconbtn-danger" onClick={() => deleteAlert(a)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && ownerKey && (
        <CreateAlertModal ownerKey={ownerKey} onClose={(alert, paywallMsg) => onCreated(alert, paywallMsg)} />
      )}
    </main>
  );
}

// ─── Create-Alert Modal ───────────────────────────────────────────────────

interface EditionMatch {
  edition_id: string;
  edition_key: string;
  player_name: string | null;
  set_name: string | null;
  collection_slug?: string | null;
  fmv?: number | null;
}

function CreateAlertModal({
  ownerKey,
  onClose,
}: {
  ownerKey: string;
  onClose: (alert: Alert | null, paywallMessage: string | null) => void;
}) {
  const [step, setStep] = useState<"search" | "config">("search");
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<EditionMatch[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<EditionMatch | null>(null);

  const [alertType, setAlertType] = useState<"below_price" | "below_fmv_pct">("below_price");
  const [threshold, setThreshold] = useState<string>("");
  const [channel, setChannel] = useState<"email" | "telegram" | "both">("email");
  const [email, setEmail] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const runSearch = async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setErr(null);
    try {
      const url = `/api/search-editions?q=${encodeURIComponent(q)}&limit=20`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setErr(j?.error ?? `HTTP ${res.status}`);
        setMatches([]);
        return;
      }
      const j = await res.json();
      const rows = Array.isArray(j?.editions) ? j.editions : Array.isArray(j) ? j : [];
      setMatches(rows as EditionMatch[]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setMatches([]);
    } finally {
      setSearching(false);
    }
  };

  const submit = async () => {
    if (!picked) return;
    const thr = Number(threshold);
    if (isNaN(thr) || thr <= 0) {
      setErr("Threshold must be a positive number");
      return;
    }
    if ((channel === "email" || channel === "both") && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setErr("Enter a valid notification email");
      return;
    }
    setSubmitting(true);
    setErr(null);
    try {
      const res = await fetch("/api/alerts", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner_key: ownerKey,
          edition_key: picked.edition_key,
          player_name: picked.player_name,
          set_name: picked.set_name,
          alert_type: alertType,
          threshold: thr,
          channel,
          notification_email: channel === "telegram" ? null : email,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.status === 402) {
        onClose(null, j?.message ?? "Custom alerts are a Pro feature.");
        return;
      }
      if (!res.ok) {
        setErr(j?.error ?? `HTTP ${res.status}`);
        return;
      }
      onClose(j as Alert, null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rpc-al-modal-backdrop" role="dialog" aria-modal="true" onClick={() => onClose(null, null)}>
      <div className="rpc-al-modal" onClick={(e) => e.stopPropagation()}>
        <div className="rpc-al-modal-header">
          <div className="rpc-al-modal-title">New Alert</div>
          <button className="rpc-al-iconbtn" onClick={() => onClose(null, null)}>✕</button>
        </div>

        {step === "search" && (
          <div className="rpc-al-modal-body">
            <div className="rpc-al-label">Find a moment</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") runSearch();
                }}
                placeholder="Player name, set name, or edition key"
                autoFocus
                className="rpc-al-input"
                style={{ flex: 1 }}
              />
              <button onClick={runSearch} disabled={searching} className="rpc-al-cta">
                {searching ? "…" : "Search"}
              </button>
            </div>

            {matches && matches.length === 0 && (
              <div className="rpc-al-empty" style={{ padding: 12 }}>No matches.</div>
            )}
            {matches && matches.length > 0 && (
              <div className="rpc-al-match-list">
                {matches.map((m) => (
                  <button
                    key={m.edition_key}
                    onClick={() => {
                      setPicked(m);
                      setStep("config");
                    }}
                    className="rpc-al-match-row"
                  >
                    <div className="rpc-al-edition-name">{m.player_name ?? "—"}</div>
                    <div className="rpc-al-edition-set">{m.set_name ?? m.edition_key}</div>
                  </button>
                ))}
              </div>
            )}

            {err && <div className="rpc-al-err" style={{ marginTop: 10 }}>{err}</div>}
          </div>
        )}

        {step === "config" && picked && (
          <div className="rpc-al-modal-body">
            <div className="rpc-al-picked-row">
              <div>
                <div className="rpc-al-edition-name">{picked.player_name ?? "—"}</div>
                <div className="rpc-al-edition-set">{picked.set_name ?? picked.edition_key}</div>
              </div>
              <button
                className="rpc-al-iconbtn"
                onClick={() => {
                  setStep("search");
                  setPicked(null);
                }}
              >
                Change
              </button>
            </div>

            <div className="rpc-al-label">Alert type</div>
            <div className="rpc-al-radio-row">
              <label className="rpc-al-radio">
                <input
                  type="radio"
                  checked={alertType === "below_price"}
                  onChange={() => setAlertType("below_price")}
                />
                Lowest ask drops to or below
              </label>
              <label className="rpc-al-radio">
                <input
                  type="radio"
                  checked={alertType === "below_fmv_pct"}
                  onChange={() => setAlertType("below_fmv_pct")}
                />
                Discount vs FMV reaches
              </label>
            </div>

            <div className="rpc-al-label">Threshold</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="number"
                step="0.01"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                placeholder={alertType === "below_price" ? "10.00" : "20"}
                className="rpc-al-input"
                style={{ flex: 1 }}
              />
              <span style={{ fontFamily: "var(--font-mono)", color: "var(--rpc-text-muted)", fontSize: 12 }}>
                {alertType === "below_price" ? "USD" : "%"}
              </span>
            </div>

            <div className="rpc-al-label" style={{ marginTop: 14 }}>Channel</div>
            <div className="rpc-al-radio-row">
              {(["email", "telegram", "both"] as const).map((c) => (
                <label key={c} className="rpc-al-radio">
                  <input
                    type="radio"
                    checked={channel === c}
                    onChange={() => setChannel(c)}
                  />
                  {c}
                </label>
              ))}
            </div>

            {(channel === "email" || channel === "both") && (
              <>
                <div className="rpc-al-label" style={{ marginTop: 12 }}>Notification email</div>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="rpc-al-input"
                  style={{ width: "100%" }}
                />
              </>
            )}

            {err && <div className="rpc-al-err" style={{ marginTop: 12 }}>{err}</div>}

            <div style={{ display: "flex", gap: 8, marginTop: 18, justifyContent: "flex-end" }}>
              <button className="rpc-al-iconbtn" onClick={() => onClose(null, null)} disabled={submitting}>
                Cancel
              </button>
              <button className="rpc-al-cta" onClick={submit} disabled={submitting || !threshold}>
                {submitting ? "Saving…" : "Create alert"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────

const S: { page: React.CSSProperties } = {
  page: {
    maxWidth: 1080,
    margin: "0 auto",
    padding: "32px 20px 80px",
    color: "var(--rpc-text-primary)",
  },
};

const CSS = `
  .rpc-al-header {
    display: flex; justify-content: space-between; align-items: flex-start;
    gap: 16px; flex-wrap: wrap; margin-bottom: 24px;
  }
  .rpc-al-eyebrow {
    font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.18em;
    text-transform: uppercase; color: var(--rpc-red, #E03A2F);
  }
  .rpc-al-h1 {
    font-family: 'Barlow Condensed', sans-serif; font-weight: 900;
    font-size: 36px; letter-spacing: 0.02em; text-transform: uppercase;
    margin: 4px 0 8px; color: var(--rpc-text-primary);
  }
  .rpc-al-lede {
    font-family: var(--font-mono); font-size: 13px; color: var(--rpc-text-secondary);
    line-height: 1.6; max-width: 580px; margin: 0;
  }
  .rpc-al-actions { display: flex; flex-direction: column; gap: 8px; align-items: flex-end; }
  .rpc-al-cta {
    display: inline-flex; align-items: center; justify-content: center;
    background: var(--rpc-red, #E03A2F); color: #fff; border: none;
    padding: 10px 18px; border-radius: var(--radius-sm, 6px);
    font-family: 'Barlow Condensed', sans-serif; font-weight: 800;
    font-size: 13px; letter-spacing: 0.14em; text-transform: uppercase;
    cursor: pointer;
  }
  .rpc-al-cta:disabled { opacity: 0.5; cursor: not-allowed; }
  .rpc-al-cta-link {
    font-family: var(--font-mono); font-size: 11px; color: var(--rpc-text-muted);
    text-decoration: none;
  }
  .rpc-al-empty {
    background: var(--rpc-surface); border: 1px solid var(--rpc-border);
    border-radius: var(--radius-md, 8px); padding: 24px; text-align: center;
    font-family: var(--font-mono); font-size: 13px; color: var(--rpc-text-secondary);
  }
  .rpc-al-paywall {
    background: rgba(224, 58, 47, 0.08);
    border: 1px solid rgba(224, 58, 47, 0.35);
    border-radius: var(--radius-md, 8px); padding: 16px;
    font-family: var(--font-mono); font-size: 13px; color: var(--rpc-text-secondary);
    margin-bottom: 18px;
  }
  .rpc-al-paywall-title {
    font-family: 'Barlow Condensed', sans-serif; font-weight: 800;
    font-size: 16px; letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--rpc-red, #E03A2F); margin-bottom: 6px;
  }
  .rpc-al-paywall-body { line-height: 1.55; }
  .rpc-al-err {
    background: rgba(248, 113, 113, 0.08);
    border: 1px solid rgba(248, 113, 113, 0.35);
    border-radius: var(--radius-md, 8px); padding: 10px 12px;
    font-family: var(--font-mono); font-size: 12px; color: #F87171;
    margin-bottom: 12px;
  }
  .rpc-al-table-wrap {
    overflow-x: auto; background: var(--rpc-surface);
    border: 1px solid var(--rpc-border); border-radius: var(--radius-md, 8px);
  }
  .rpc-al-table {
    width: 100%; border-collapse: collapse;
    font-family: var(--font-mono); font-size: 12px;
  }
  .rpc-al-table th {
    text-align: left; padding: 10px 12px; color: var(--rpc-text-muted);
    font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase;
    font-weight: 600; border-bottom: 1px solid var(--rpc-border);
  }
  .rpc-al-table td {
    padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.04);
    color: var(--rpc-text-primary); vertical-align: top;
  }
  .rpc-al-row-inactive td { opacity: 0.45; }
  .rpc-al-edition-name {
    font-family: 'Barlow Condensed', sans-serif; font-weight: 700;
    font-size: 14px; letter-spacing: 0.02em; color: var(--rpc-text-primary);
  }
  .rpc-al-edition-set { color: var(--rpc-text-muted); font-size: 11px; }
  .rpc-al-pill {
    display: inline-block; padding: 2px 8px; border-radius: 999px;
    font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase;
    font-weight: 600;
  }
  .rpc-al-pill-on { background: rgba(52, 211, 153, 0.15); color: #34D399; }
  .rpc-al-pill-off { background: rgba(255,255,255,0.06); color: var(--rpc-text-muted); }
  .rpc-al-pill-hot { background: rgba(224, 58, 47, 0.15); color: var(--rpc-red, #E03A2F); }
  .rpc-al-last-fired {
    font-size: 10px; color: var(--rpc-text-muted); margin-top: 4px;
  }
  .rpc-al-iconbtn {
    background: transparent; border: 1px solid var(--rpc-border);
    color: var(--rpc-text-primary); padding: 6px 10px; border-radius: 4px;
    font-family: var(--font-mono); font-size: 11px; cursor: pointer;
    margin-left: 6px;
  }
  .rpc-al-iconbtn:hover { background: rgba(255,255,255,0.04); }
  .rpc-al-iconbtn-danger { color: #F87171; border-color: rgba(248, 113, 113, 0.3); }
  .rpc-al-iconbtn-danger:hover { background: rgba(248, 113, 113, 0.08); }

  /* modal */
  .rpc-al-modal-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.65);
    display: flex; align-items: center; justify-content: center;
    z-index: 1000; padding: 20px;
  }
  .rpc-al-modal {
    background: var(--rpc-surface); border: 1px solid var(--rpc-border);
    border-radius: var(--radius-md, 8px);
    width: 100%; max-width: 520px; max-height: 90vh; overflow-y: auto;
  }
  .rpc-al-modal-header {
    display: flex; justify-content: space-between; align-items: center;
    padding: 14px 18px; border-bottom: 1px solid var(--rpc-border);
  }
  .rpc-al-modal-title {
    font-family: 'Barlow Condensed', sans-serif; font-weight: 800;
    font-size: 18px; letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--rpc-text-primary);
  }
  .rpc-al-modal-body { padding: 16px 18px; }
  .rpc-al-label {
    font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.12em;
    text-transform: uppercase; color: var(--rpc-text-muted);
    margin-bottom: 6px;
  }
  .rpc-al-input {
    background: #0d0d0d; border: 1px solid var(--rpc-border);
    padding: 8px 10px; border-radius: 4px; color: var(--rpc-text-primary);
    font-family: var(--font-mono); font-size: 13px;
  }
  .rpc-al-radio-row { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
  .rpc-al-radio {
    display: flex; align-items: center; gap: 6px; cursor: pointer;
    font-family: var(--font-mono); font-size: 12px; color: var(--rpc-text-secondary);
  }
  .rpc-al-match-list {
    display: flex; flex-direction: column; gap: 4px; max-height: 320px;
    overflow-y: auto;
  }
  .rpc-al-match-row {
    text-align: left; padding: 10px 12px; background: transparent;
    border: 1px solid var(--rpc-border); border-radius: 4px; cursor: pointer;
    color: var(--rpc-text-primary);
  }
  .rpc-al-match-row:hover { background: rgba(255,255,255,0.04); }
  .rpc-al-picked-row {
    display: flex; justify-content: space-between; align-items: center;
    background: rgba(224, 58, 47, 0.08);
    border: 1px solid rgba(224, 58, 47, 0.25);
    border-radius: 4px; padding: 10px 12px; margin-bottom: 16px;
  }
`;
