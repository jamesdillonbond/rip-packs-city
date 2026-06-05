"use client";

// app/admin/rewards/page.tsx
// Trevor-only rewards operations console — fulfill redemptions, refund, adjust
// balances, toggle catalog. Read-only economy view also lives as the Cowork
// artifact "rpc-rewards-console"; this page adds the ACTIONS.
//
// Bearer-gated via RPC_ADMIN_TOKEN against /api/admin/rewards. Token is pasted
// into a password input and cached in sessionStorage under "rpc_admin_token"
// (shared with the other admin dashboards) — never from a public env var.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

const TOKEN_KEY = "rpc_admin_token";
const DISPLAY = "var(--font-display, 'Barlow Condensed', sans-serif)";
const MONO = "var(--font-mono, 'Share Tech Mono', monospace)";
const RED = "var(--rpc-red, #E03A2F)";

interface Economy {
  total_issued_credits: number;
  total_spent_credits: number;
  outstanding_liability_credits: number;
  total_status_awarded: number;
  participants: number;
  redemptions_pending: number;
  redemptions_fulfilled: number;
  ledger_rows: number;
}
interface Balance {
  user_id: string;
  username: string | null;
  display_name: string | null;
  spendable: number;
  status: number;
  tier: string;
  lifetime_earned: number;
  lifetime_spent: number;
  last_activity: string | null;
}
interface Pending {
  id: number;
  user_id: string;
  shop_item_id: number;
  cost_credits: number;
  status: string;
  requested_at: string;
  item_name?: string;
  item_type?: string | null;
  username?: string | null;
}

function num(n: number | null | undefined): string {
  return (n ?? 0).toLocaleString("en-US");
}

export default function AdminRewardsPage() {
  const [token, setToken] = useState("");
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") {
      setAuthChecked(true);
      return;
    }
    const stored = window.sessionStorage.getItem(TOKEN_KEY);
    if (stored) setToken(stored);
    setAuthChecked(true);
  }, []);

  if (!authChecked) {
    return <div style={screen}>Loading…</div>;
  }
  if (!token) {
    return (
      <SignInGate
        onSignedIn={(t) => {
          if (typeof window !== "undefined") window.sessionStorage.setItem(TOKEN_KEY, t);
          setToken(t);
        }}
      />
    );
  }
  return (
    <Console
      token={token}
      onSignOut={() => {
        if (typeof window !== "undefined") window.sessionStorage.removeItem(TOKEN_KEY);
        setToken("");
      }}
    />
  );
}

function SignInGate({ onSignedIn }: { onSignedIn: (t: string) => void }) {
  const [input, setInput] = useState("");
  return (
    <div style={screen}>
      <div style={{ width: 360, maxWidth: "90vw", ...card }}>
        <h1 style={{ fontFamily: DISPLAY, textTransform: "uppercase", marginTop: 0 }}>
          Rewards <span style={{ color: RED }}>Console</span>
        </h1>
        <p style={{ color: "#9a9a9a", fontSize: 13 }}>Paste the RPC admin token.</p>
        <input
          type="password"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && input.trim()) onSignedIn(input.trim());
          }}
          placeholder="RPC_ADMIN_TOKEN"
          style={inputStyle}
        />
        <button
          type="button"
          disabled={!input.trim()}
          onClick={() => onSignedIn(input.trim())}
          style={{ ...btn, marginTop: 12, width: "100%", opacity: input.trim() ? 1 : 0.5 }}
        >
          Enter
        </button>
      </div>
    </div>
  );
}

function Console({ token, onSignOut }: { token: string; onSignOut: () => void }) {
  const [economy, setEconomy] = useState<Economy | null>(null);
  const [balances, setBalances] = useState<Balance[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  // adjust form
  const [adjUser, setAdjUser] = useState("");
  const [adjDelta, setAdjDelta] = useState("");
  const [adjStatus, setAdjStatus] = useState("");
  const [adjReason, setAdjReason] = useState("");

  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/rewards", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      if (res.status === 401) {
        setFlash({ kind: "err", msg: "Bad token." });
        onSignOut();
        return;
      }
      const data = await res.json();
      setEconomy(data.economy ?? null);
      setBalances(data.balances ?? []);
      setPending(data.pending ?? []);
    } catch {
      setFlash({ kind: "err", msg: "Load failed." });
    } finally {
      setLoading(false);
    }
  }, [token, onSignOut]);

  useEffect(() => {
    load();
  }, [load]);

  const act = useCallback(
    async (label: string, payload: Record<string, unknown>) => {
      setBusy(label);
      setFlash(null);
      try {
        const res = await fetch("/api/admin/rewards", {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (res.ok && data?.ok) {
          setFlash({ kind: "ok", msg: "Done." });
          await load();
        } else {
          setFlash({ kind: "err", msg: data?.error ?? "Action failed." });
        }
      } catch {
        setFlash({ kind: "err", msg: "Request failed." });
      } finally {
        setBusy(null);
      }
    },
    [headers, load]
  );

  const submitAdjust = () => {
    const delta = parseInt(adjDelta || "0", 10);
    const statusDelta = parseInt(adjStatus || "0", 10);
    if (!adjUser.trim() || !adjReason.trim()) {
      setFlash({ kind: "err", msg: "User id and reason are required." });
      return;
    }
    act("adjust", {
      action: "adjust",
      userId: adjUser.trim(),
      delta,
      statusDelta,
      reason: adjReason.trim(),
    }).then(() => {
      setAdjDelta("");
      setAdjStatus("");
      setAdjReason("");
    });
  };

  return (
    <div style={{ minHeight: "100vh", background: "#0a0a0a", color: "#e7e7e7" }}>
      <main style={{ maxWidth: 1100, margin: "0 auto", padding: "24px 16px 80px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h1 style={{ fontFamily: DISPLAY, textTransform: "uppercase", letterSpacing: "0.04em", fontSize: 34, margin: 0 }}>
            Rewards <span style={{ color: RED }}>Console</span>
          </h1>
          <div style={{ display: "flex", gap: 10 }}>
            <Link href="/admin/flowty-analytics" style={{ ...btnGhost }}>
              Admin
            </Link>
            <button type="button" onClick={load} style={btnGhost}>
              Refresh
            </button>
            <button type="button" onClick={onSignOut} style={btnGhost}>
              Sign out
            </button>
          </div>
        </div>

        {flash && (
          <div
            style={{
              margin: "16px 0",
              padding: "10px 14px",
              borderRadius: 8,
              border: `1px solid ${flash.kind === "ok" ? "#2e7d32" : RED}`,
              background: flash.kind === "ok" ? "rgba(46,125,50,0.12)" : "rgba(224,58,47,0.12)",
              fontFamily: MONO,
              fontSize: 13,
            }}
          >
            {flash.msg}
          </div>
        )}

        {loading ? (
          <p style={{ fontFamily: MONO, color: "#9a9a9a" }}>Loading…</p>
        ) : (
          <>
            {/* ECONOMY */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
                gap: 12,
                margin: "20px 0 28px",
              }}
            >
              <Kpi label="Participants" value={num(economy?.participants)} />
              <Kpi label="Credits issued" value={num(economy?.total_issued_credits)} />
              <Kpi label="Credits spent" value={num(economy?.total_spent_credits)} />
              <Kpi label="Outstanding liability" value={num(economy?.outstanding_liability_credits)} accent />
              <Kpi label="Status awarded" value={num(economy?.total_status_awarded)} />
              <Kpi label="Pending redemptions" value={num(economy?.redemptions_pending)} accent />
              <Kpi label="Fulfilled" value={num(economy?.redemptions_fulfilled)} />
              <Kpi label="Ledger rows" value={num(economy?.ledger_rows)} />
            </div>

            {/* PENDING REDEMPTIONS */}
            <H2>Pending redemptions</H2>
            {pending.length === 0 ? (
              <p style={{ fontFamily: MONO, color: "#7a7a7a" }}>Nothing waiting to ship.</p>
            ) : (
              <div style={{ ...card, padding: 0, overflow: "hidden", marginBottom: 28 }}>
                {pending.map((r, i) => (
                  <div
                    key={r.id}
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      padding: "12px 16px",
                      borderTop: i === 0 ? "none" : "1px solid #1c1c1c",
                    }}
                  >
                    <div style={{ minWidth: 220 }}>
                      <div style={{ fontSize: 14 }}>{r.item_name}</div>
                      <div style={{ fontFamily: MONO, fontSize: 11, color: "#7a7a7a" }}>
                        {r.username ?? r.user_id.slice(0, 8)} · {num(r.cost_credits)} cr ·{" "}
                        {new Date(r.requested_at).toLocaleDateString()}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => {
                          const tx = window.prompt("Fulfillment tx / note (optional):") ?? "";
                          act("fulfill", { action: "fulfill", redemptionId: r.id, note: tx });
                        }}
                        style={btn}
                      >
                        Fulfill
                      </button>
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => {
                          if (window.confirm(`Refund ${num(r.cost_credits)} credits and cancel?`)) {
                            act("cancel_refund", { action: "cancel_refund", redemptionId: r.id });
                          }
                        }}
                        style={btnGhost}
                      >
                        Refund
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* MANUAL ADJUST */}
            <H2>Manual adjust</H2>
            <div style={{ ...card, marginBottom: 28 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
                <Field label="User id (uuid)">
                  <input value={adjUser} onChange={(e) => setAdjUser(e.target.value)} style={inputStyle} placeholder="auth user id" />
                </Field>
                <Field label="Credits Δ (+/−)">
                  <input value={adjDelta} onChange={(e) => setAdjDelta(e.target.value)} style={inputStyle} placeholder="0" inputMode="numeric" />
                </Field>
                <Field label="Status Δ (+/−)">
                  <input value={adjStatus} onChange={(e) => setAdjStatus(e.target.value)} style={inputStyle} placeholder="0" inputMode="numeric" />
                </Field>
                <Field label="Reason">
                  <input value={adjReason} onChange={(e) => setAdjReason(e.target.value)} style={inputStyle} placeholder="comp / correction" />
                </Field>
              </div>
              <button type="button" disabled={busy === "adjust"} onClick={submitAdjust} style={{ ...btn, marginTop: 12 }}>
                {busy === "adjust" ? "…" : "Apply adjustment"}
              </button>
              <p style={{ fontFamily: MONO, fontSize: 11, color: "#7a7a7a", marginTop: 8 }}>
                Credits Δ moves spendable; Status Δ moves tier-status. Either can be 0.
              </p>
            </div>

            {/* BALANCES */}
            <H2>Top balances</H2>
            <div style={{ ...card, padding: 0, overflow: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: MONO, fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "#9a9a9a" }}>
                    <th style={th}>User</th>
                    <th style={th}>Tier</th>
                    <th style={{ ...th, textAlign: "right" }}>Status</th>
                    <th style={{ ...th, textAlign: "right" }}>Credits</th>
                    <th style={{ ...th, textAlign: "right" }}>Earned</th>
                    <th style={{ ...th, textAlign: "right" }}>Spent</th>
                  </tr>
                </thead>
                <tbody>
                  {balances.map((b) => (
                    <tr key={b.user_id} style={{ borderTop: "1px solid #1c1c1c" }}>
                      <td style={td} title={b.user_id}>
                        {b.username ?? b.display_name ?? b.user_id.slice(0, 8)}
                      </td>
                      <td style={td}>{b.tier}</td>
                      <td style={{ ...td, textAlign: "right" }}>{num(b.status)}</td>
                      <td style={{ ...td, textAlign: "right", color: RED }}>{num(b.spendable)}</td>
                      <td style={{ ...td, textAlign: "right" }}>{num(b.lifetime_earned)}</td>
                      <td style={{ ...td, textAlign: "right" }}>{num(b.lifetime_spent)}</td>
                    </tr>
                  ))}
                  {balances.length === 0 && (
                    <tr>
                      <td style={{ ...td, color: "#7a7a7a" }} colSpan={6}>
                        No participants yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function Kpi({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={card}>
      <div style={{ fontFamily: MONO, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "#9a9a9a" }}>
        {label}
      </div>
      <div style={{ fontFamily: MONO, fontSize: 22, marginTop: 6, color: accent ? RED : "#e7e7e7" }}>{value}</div>
    </div>
  );
}

function H2({ children }: { children: React.ReactNode }) {
  return (
    <h2
      style={{
        fontFamily: DISPLAY,
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        fontSize: 18,
        margin: "0 0 12px",
        paddingBottom: 6,
        borderBottom: `2px solid ${RED}`,
        display: "inline-block",
      }}
    >
      {children}
    </h2>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block" }}>
      <span style={{ fontFamily: MONO, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: "#9a9a9a" }}>
        {label}
      </span>
      <div style={{ marginTop: 4 }}>{children}</div>
    </label>
  );
}

const screen: React.CSSProperties = {
  minHeight: "100vh",
  background: "#0a0a0a",
  color: "#e7e7e7",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontFamily: MONO,
};
const card: React.CSSProperties = { padding: 16, border: "1px solid #222", borderRadius: 12, background: "#111" };
const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid #333",
  background: "#0a0a0a",
  color: "#e7e7e7",
  fontFamily: MONO,
  fontSize: 13,
  boxSizing: "border-box",
};
const btn: React.CSSProperties = {
  padding: "8px 16px",
  borderRadius: 8,
  border: "none",
  cursor: "pointer",
  background: RED,
  color: "#fff",
  fontFamily: DISPLAY,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  fontSize: 13,
};
const btnGhost: React.CSSProperties = {
  padding: "8px 16px",
  borderRadius: 8,
  border: "1px solid #333",
  cursor: "pointer",
  background: "transparent",
  color: "#e7e7e7",
  fontFamily: DISPLAY,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  fontSize: 13,
  textDecoration: "none",
};
const th: React.CSSProperties = { padding: "10px 12px", fontWeight: 400 };
const td: React.CSSProperties = { padding: "8px 12px", whiteSpace: "nowrap" };
