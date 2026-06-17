"use client";

// components/alerts/WatchEditionButton.tsx
//
// "Watch this edition" control for the edition + moment pages. Expands into a
// small inline form that POSTs to /api/alerts. owner_key is resolved
// server-side from the session — the client never sends it. Renders for anon
// users too; on 401 it points them at /login.

import { useState } from "react";

type AlertType = "fmv_below" | "fmv_above" | "price_below" | "discount_above";

const TYPE_OPTIONS: { value: AlertType; label: string; unit: "$" | "%" }[] = [
  { value: "price_below", label: "Lowest ask drops to / below", unit: "$" },
  { value: "fmv_below", label: "FMV drops to / below", unit: "$" },
  { value: "fmv_above", label: "FMV rises to / above", unit: "$" },
  { value: "discount_above", label: "Ask is this % below FMV", unit: "%" },
];

const RED = "var(--rpc-red)";
const MONO = "var(--font-mono)";

export default function WatchEditionButton({
  editionKey,
  collectionId,
  playerName,
  setName,
  label = "Watch this edition",
}: {
  editionKey: string;
  collectionId: string;
  playerName?: string | null;
  setName?: string | null;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [alertType, setAlertType] = useState<AlertType>("price_below");
  const [threshold, setThreshold] = useState("");
  const [channel, setChannel] = useState<"email" | "telegram">("email");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err" | "auth"; text: string } | null>(null);

  const unit = TYPE_OPTIONS.find((t) => t.value === alertType)?.unit ?? "$";

  async function submit() {
    const thr = Number(threshold);
    if (!Number.isFinite(thr) || thr <= 0) {
      setMsg({ kind: "err", text: "Enter a positive number." });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          edition_key: editionKey,
          collection_id: collectionId,
          player_name: playerName ?? null,
          set_name: setName ?? null,
          alert_type: alertType,
          threshold: thr,
          channel,
        }),
      });
      if (res.status === 401) {
        setMsg({ kind: "auth", text: "Sign in to set an alert." });
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ kind: "err", text: data?.error ?? "Could not save the alert." });
        return;
      }
      setMsg({ kind: "ok", text: "Alert set. Manage it on the Alerts page." });
      setThreshold("");
    } catch {
      setMsg({ kind: "err", text: "Network error. Try again." });
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rpc-mono"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "8px 14px",
          border: `1px solid ${RED}`,
          background: "var(--rpc-red-bg, rgba(224,58,47,0.10))",
          color: RED,
          borderRadius: 6,
          fontSize: 12,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          fontWeight: 700,
          cursor: "pointer",
        }}
      >
        🔔 {label}
      </button>
    );
  }

  return (
    <div
      style={{
        marginTop: 4,
        padding: 14,
        border: "1px solid var(--rpc-border)",
        borderRadius: 8,
        background: "rgba(0,0,0,0.25)",
        maxWidth: 420,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <span
          className="rpc-mono"
          style={{ fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--rpc-text-secondary)", fontWeight: 700 }}
        >
          Alert me when…
        </span>
        <button
          type="button"
          onClick={() => { setOpen(false); setMsg(null); }}
          aria-label="Close"
          style={{ background: "none", border: "none", color: "var(--rpc-text-muted)", cursor: "pointer", fontSize: 16, lineHeight: 1 }}
        >
          ×
        </button>
      </div>

      <select
        value={alertType}
        onChange={(e) => setAlertType(e.target.value as AlertType)}
        className="rpc-mono"
        style={selectStyle}
      >
        {TYPE_OPTIONS.map((t) => (
          <option key={t.value} value={t.value}>{t.label}</option>
        ))}
      </select>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
        <span className="rpc-mono" style={{ color: "var(--rpc-text-secondary)", fontSize: 13, width: 16, textAlign: "center" }}>{unit}</span>
        <input
          type="number"
          min={0}
          step="any"
          value={threshold}
          onChange={(e) => setThreshold(e.target.value)}
          placeholder={unit === "%" ? "e.g. 25" : "e.g. 50"}
          className="rpc-mono"
          style={{ ...inputStyle, flex: 1 }}
        />
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        {(["email", "telegram"] as const).map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setChannel(c)}
            className="rpc-mono"
            style={{
              padding: "6px 12px",
              borderRadius: 999,
              border: `1px solid ${channel === c ? RED : "var(--rpc-border)"}`,
              background: channel === c ? "var(--rpc-red-bg, rgba(224,58,47,0.12))" : "transparent",
              color: channel === c ? "var(--rpc-text-primary)" : "var(--rpc-text-secondary)",
              fontSize: 12,
              textTransform: "capitalize",
              cursor: "pointer",
            }}
          >
            {c}
          </button>
        ))}
      </div>
      {channel === "telegram" && (
        <p className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)", marginTop: 6, lineHeight: 1.5 }}>
          Link Telegram on the <a href="/alerts" style={{ color: RED, textDecoration: "none" }}>Alerts page</a> to receive these.
        </p>
      )}

      <button
        type="button"
        onClick={submit}
        disabled={busy}
        className="rpc-mono"
        style={{
          marginTop: 12,
          width: "100%",
          padding: "9px 14px",
          background: RED,
          color: "#0a0a0a",
          border: "none",
          borderRadius: 6,
          fontWeight: 800,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          fontSize: 12,
          cursor: busy ? "default" : "pointer",
          opacity: busy ? 0.6 : 1,
        }}
      >
        {busy ? "Saving…" : "Set alert"}
      </button>

      {msg && (
        <p
          className="rpc-mono"
          style={{
            marginTop: 10,
            fontSize: 11,
            lineHeight: 1.5,
            color: msg.kind === "ok" ? "var(--rpc-success, #34d399)" : msg.kind === "auth" ? "var(--rpc-text-secondary)" : "var(--rpc-danger, #f87171)",
          }}
        >
          {msg.kind === "ok" && <>✓ {msg.text}</>}
          {msg.kind === "err" && <>{msg.text}</>}
          {msg.kind === "auth" && (
            <>
              {msg.text}{" "}
              <a
                href={`/login?next=${encodeURIComponent(typeof window !== "undefined" ? window.location.pathname : "/")}`}
                style={{ color: RED, textDecoration: "none" }}
              >
                Sign in →
              </a>
            </>
          )}
        </p>
      )}
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  width: "100%",
  padding: "9px 10px",
  background: "var(--rpc-black, #0a0a0a)",
  border: "1px solid var(--rpc-border)",
  borderRadius: 6,
  color: "var(--rpc-text-primary)",
  fontSize: 13,
  boxSizing: "border-box",
};
const inputStyle: React.CSSProperties = {
  padding: "9px 10px",
  background: "var(--rpc-black, #0a0a0a)",
  border: "1px solid var(--rpc-border)",
  borderRadius: 6,
  color: "var(--rpc-text-primary)",
  fontSize: 13,
  boxSizing: "border-box",
};
