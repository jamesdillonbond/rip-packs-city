"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import MobileNav from "@/components/MobileNav";
import SupportChatConnected from "@/components/SupportChatConnected";
import RpcLogo from "@/components/RpcLogo";
import { publishedCollections } from "@/lib/collections";

const condensedFont = "'Barlow Condensed', sans-serif";
const monoFont = "'Share Tech Mono', monospace";
const ACCENT_RED = "#E03A2F";

// ── Types ─────────────────────────────────────────────────────────────────────

interface PerCollection {
  collection_slug: string;
  moment_count: number;
  total_fmv_usd?: number | null;
  fmv_usd?: number | null;
}

interface TopMoment {
  moment_id?: string | null;
  edition_name?: string | null;
  player_name?: string | null;
  character_name?: string | null;
  tier?: string | null;
  collection_slug?: string | null;
  fmv_usd?: number | null;
}

interface Portfolio {
  total_moments?: number;
  total_fmv_usd?: number;
  per_collection?: PerCollection[];
  top_moments?: TopMoment[];
  updated_at?: string | null;
}

interface ProfileResponse {
  has_wallet: boolean;
  wallet_address?: string | null;
  topshot_username?: string | null;
  display_name?: string | null;
  portfolio?: Portfolio | null;
  updated_at?: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtUsd0(n: number): string {
  return "$" + Math.round(n).toLocaleString();
}

function truncateAddress(addr: string): string {
  if (!addr) return "";
  const clean = addr.startsWith("0x") ? addr : "0x" + addr;
  if (clean.length <= 12) return clean;
  return clean.slice(0, 6) + "\u2026" + clean.slice(-4);
}

function tierColor(tier?: string | null): string {
  switch ((tier || "").toLowerCase()) {
    case "ultimate":   return "#EC4899";
    case "legendary":  return "#F59E0B";
    case "rare":       return "#818CF8";
    case "challenger": return "#818CF8";
    case "uncommon":   return "#14B8A6";
    case "fandom":     return "#34D399";
    case "common":     return "#9CA3AF";
    case "contender":  return "#9CA3AF";
    default:           return "#6B7280";
  }
}

// Normalize DB slugs (nba_top_shot, ufc_strike) → frontend registry ids
// (nba-top-shot, ufc). Everything else: underscores → hyphens.
function normalizeCollectionSlug(raw: string): string {
  if (raw === "ufc_strike") return "ufc";
  return raw.replace(/_/g, "-");
}

const REGISTRY_BY_ID = (() => {
  const out: Record<string, { id: string; label: string; shortLabel: string; icon: string; accent: string }> = {};
  for (const c of publishedCollections()) {
    out[c.id] = { id: c.id, label: c.label, shortLabel: c.shortLabel, icon: c.icon, accent: c.accent };
  }
  return out;
})();

function metaForSlug(rawSlug: string | null | undefined) {
  const id = normalizeCollectionSlug(rawSlug ?? "");
  return REGISTRY_BY_ID[id] ?? { id, label: id || "Collection", shortLabel: id || "—", icon: "\u{1F4CA}", accent: "#9CA3AF" };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ProfilePage() {
  const [ownerKey, setOwnerKey] = useState<string | null>(null);
  const [initializing, setInitializing] = useState(true);

  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  const [walletInput, setWalletInput] = useState("");
  const [usernameInput, setUsernameInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Initialize owner key + pre-fill wallet from ?wallet= query
  useEffect(() => {
    try {
      let key = localStorage.getItem("rpc_owner_key");
      if (!key) {
        key = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        localStorage.setItem("rpc_owner_key", key);
      }
      setOwnerKey(key);

      const prefill = new URLSearchParams(window.location.search).get("wallet");
      if (prefill) setWalletInput(prefill);
    } catch {
      // localStorage blocked — create a volatile key so the flow still works
      setOwnerKey(`rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    } finally {
      setInitializing(false);
    }
  }, []);

  const loadProfile = useCallback(async (key: string) => {
    setProfileLoading(true);
    setProfileError(null);
    try {
      const res = await fetch(`/api/wallet/profile?ownerKey=${encodeURIComponent(key)}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: ProfileResponse = await res.json();
      setProfile(data);
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : String(err));
    } finally {
      setProfileLoading(false);
    }
  }, []);

  // Fetch profile once we have an owner key
  useEffect(() => {
    if (!ownerKey) return;
    loadProfile(ownerKey);
  }, [ownerKey, loadProfile]);

  const handleSave = useCallback(async () => {
    if (!ownerKey) return;
    const address = walletInput.trim().toLowerCase();
    if (!address) {
      setSaveError("Wallet address required");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/wallet/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerKey,
          walletAddress: address,
          topshotUsername: usernameInput.trim() || undefined,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadProfile(ownerKey);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not save wallet");
    } finally {
      setSaving(false);
    }
  }, [ownerKey, walletInput, usernameInput, loadProfile]);

  const handleDisconnect = useCallback(() => {
    try {
      localStorage.removeItem("rpc_owner_key");
      localStorage.removeItem("rpc_last_wallet");
      localStorage.removeItem("rpc_collection_last_wallet");
    } catch { /* ignore */ }
    const fresh = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try { localStorage.setItem("rpc_owner_key", fresh); } catch { /* ignore */ }
    setOwnerKey(fresh);
    setProfile(null);
    setWalletInput("");
    setUsernameInput("");
  }, []);

  const handleRefresh = useCallback(() => {
    if (ownerKey) loadProfile(ownerKey);
  }, [ownerKey, loadProfile]);

  // Derive display state
  const state: "init" | "form" | "portfolio" | "error" = useMemo(() => {
    if (initializing || (profileLoading && !profile)) return "init";
    if (profileError && !profile) return "error";
    if (profile?.has_wallet) return "portfolio";
    return "form";
  }, [initializing, profileLoading, profile, profileError]);

  return (
    <div style={{ minHeight: "100vh", background: "#080808", color: "#fff", paddingBottom: 80 }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;600;700;800;900&family=Share+Tech+Mono&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        @media(max-width:768px){
          .rpc-profile-main{padding:16px 16px 80px!important;}
          .rpc-profile-grid{grid-template-columns:1fr!important;}
          .rpc-profile-summary{grid-template-columns:repeat(1,1fr)!important;}
        }
      `}</style>

      <main className="rpc-profile-main" style={{ maxWidth: 1200, margin: "0 auto", padding: "24px 24px 60px" }}>

        {state === "init" && <InitState />}

        {state === "error" && (
          <ErrorState onRetry={handleRefresh} />
        )}

        {state === "form" && (
          <ConnectForm
            walletInput={walletInput}
            setWalletInput={setWalletInput}
            usernameInput={usernameInput}
            setUsernameInput={setUsernameInput}
            saving={saving}
            saveError={saveError}
            onSave={handleSave}
          />
        )}

        {state === "portfolio" && profile && (
          <PortfolioView
            profile={profile}
            loading={profileLoading}
            onDisconnect={handleDisconnect}
            onRefresh={handleRefresh}
          />
        )}

      </main>

      <MobileNav />
      <SupportChatConnected />
    </div>
  );
}

// ── States ────────────────────────────────────────────────────────────────────

function InitState() {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "80px 20px", gap: 16 }}>
      <RpcLogo size={56} />
      <div style={{ fontSize: 11, fontFamily: monoFont, color: "rgba(255,255,255,0.35)", letterSpacing: "0.14em", textTransform: "uppercase" }}>
        Loading profile…
      </div>
      <div className="rpc-skeleton" style={{ width: 240, height: 14, borderRadius: 4, background: "rgba(255,255,255,0.06)" }} />
      <div className="rpc-skeleton" style={{ width: 180, height: 14, borderRadius: 4, background: "rgba(255,255,255,0.06)" }} />
    </div>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "80px 20px", gap: 16 }}>
      <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 18, letterSpacing: "0.06em", textTransform: "uppercase", color: "#fff" }}>
        Could not load profile
      </div>
      <div style={{ fontFamily: monoFont, fontSize: 12, color: "rgba(255,255,255,0.5)", letterSpacing: "0.04em" }}>
        Try refreshing.
      </div>
      <button onClick={onRetry} style={buttonPrimaryStyle}>
        {"Retry \u2192"}
      </button>
    </div>
  );
}

function ConnectForm({
  walletInput,
  setWalletInput,
  usernameInput,
  setUsernameInput,
  saving,
  saveError,
  onSave,
}: {
  walletInput: string;
  setWalletInput: (v: string) => void;
  usernameInput: string;
  setUsernameInput: (v: string) => void;
  saving: boolean;
  saveError: string | null;
  onSave: () => void;
}) {
  return (
    <div style={{ maxWidth: 520, margin: "40px auto", background: "#18181b", border: "1px solid #27272a", borderRadius: 12, padding: "32px 28px", textAlign: "center" }}>
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}>
        <RpcLogo size={72} />
      </div>
      <h1 style={{ fontFamily: condensedFont, fontWeight: 900, fontSize: 24, letterSpacing: "0.04em", textTransform: "uppercase", color: "#fff", marginBottom: 10 }}>
        Connect Your Dapper Wallet
      </h1>
      <p style={{ fontFamily: monoFont, fontSize: 12, color: "rgba(255,255,255,0.55)", letterSpacing: "0.04em", lineHeight: 1.6, marginBottom: 24 }}>
        Enter your Flow wallet address to see your moments across all 5 collections — Top Shot, All Day, Pinnacle, Golazos, and UFC Strike.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!saving) onSave();
        }}
        style={{ display: "flex", flexDirection: "column", gap: 12 }}
      >
        <input
          type="text"
          value={walletInput}
          onChange={(e) => setWalletInput(e.target.value)}
          placeholder="0x…"
          autoComplete="off"
          spellCheck={false}
          disabled={saving}
          style={{
            width: "100%",
            padding: "12px 14px",
            background: "#0D0D0D",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 6,
            color: "#fff",
            fontFamily: monoFont,
            fontSize: 13,
            letterSpacing: "0.04em",
            outline: "none",
          }}
        />
        <input
          type="text"
          value={usernameInput}
          onChange={(e) => setUsernameInput(e.target.value)}
          placeholder="Top Shot username (optional, for display)"
          autoComplete="off"
          disabled={saving}
          style={{
            width: "100%",
            padding: "12px 14px",
            background: "#0D0D0D",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 6,
            color: "#fff",
            fontFamily: condensedFont,
            fontSize: 13,
            letterSpacing: "0.04em",
            outline: "none",
          }}
        />
        <button type="submit" disabled={saving} style={{ ...buttonPrimaryStyle, width: "100%", marginTop: 6, opacity: saving ? 0.7 : 1 }}>
          {saving ? "Saving\u2026" : <>Save &amp; Analyze {"\u2192"}</>}
        </button>
      </form>

      {saving && (
        <div style={{ marginTop: 14, fontFamily: monoFont, fontSize: 11, color: "rgba(255,255,255,0.5)", letterSpacing: "0.04em" }}>
          {"Fetching your moments across all 5 networks\u2026"}
        </div>
      )}
      {saveError && !saving && (
        <div style={{ marginTop: 14, fontFamily: monoFont, fontSize: 11, color: "#F87171", letterSpacing: "0.04em" }}>
          {saveError}
        </div>
      )}
    </div>
  );
}

function PortfolioView({
  profile,
  loading,
  onDisconnect,
  onRefresh,
}: {
  profile: ProfileResponse;
  loading: boolean;
  onDisconnect: () => void;
  onRefresh: () => void;
}) {
  const walletAddress = profile.wallet_address ?? "";
  const username = profile.topshot_username ?? null;
  const portfolio = profile.portfolio ?? null;

  const perCollection = portfolio?.per_collection ?? [];
  const totalMoments = portfolio?.total_moments ?? perCollection.reduce((sum, c) => sum + (c.moment_count ?? 0), 0);
  const totalFmv = portfolio?.total_fmv_usd ?? 0;
  const activeCollections = perCollection.filter((c) => (c.moment_count ?? 0) > 0).length;

  const topMoments = (portfolio?.top_moments ?? [])
    .slice()
    .sort((a, b) => (b.fmv_usd ?? 0) - (a.fmv_usd ?? 0))
    .slice(0, 10);

  const lastUpdated = portfolio?.updated_at ?? profile.updated_at ?? null;
  const lastUpdatedStr = lastUpdated ? new Date(lastUpdated).toLocaleString() : null;

  const showFetchingCallout = profile.has_wallet && totalMoments === 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>

      {/* Header bar */}
      <section style={{ background: "#18181b", border: "1px solid #27272a", borderRadius: 10, padding: "14px 18px", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ fontFamily: monoFont, fontSize: 13, letterSpacing: "0.04em", color: "#fff" }}>
            {truncateAddress(walletAddress)}
          </div>
          {username && (
            <div style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 12, letterSpacing: "0.06em", color: ACCENT_RED }}>
              @{username}
            </div>
          )}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          {lastUpdatedStr && (
            <div style={{ fontFamily: monoFont, fontSize: 10, color: "rgba(255,255,255,0.4)", letterSpacing: "0.08em" }}>
              Updated {lastUpdatedStr}
            </div>
          )}
          <button onClick={onRefresh} disabled={loading} style={{ ...buttonGhostStyle, opacity: loading ? 0.5 : 1 }}>
            {loading ? "Refreshing\u2026" : "Refresh"}
          </button>
          <button onClick={onDisconnect} style={{ ...linkButtonStyle }}>
            Disconnect
          </button>
        </div>
      </section>

      {showFetchingCallout && (
        <section style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.4)", borderRadius: 10, padding: "12px 16px", fontFamily: monoFont, fontSize: 12, color: "#F59E0B", letterSpacing: "0.04em" }}>
          Your wallet was saved — fetching moments in the background. Refresh in a moment.
        </section>
      )}

      {/* Platform summary */}
      <section className="rpc-profile-summary" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
        <SummaryCard label="Total Moments" value={totalMoments.toLocaleString()} color="#fff" />
        <SummaryCard label="Total FMV" value={fmtUsd0(totalFmv)} color="#34D399" />
        <SummaryCard label="Collections Active" value={`${activeCollections} / ${perCollection.length || 0}`} color="#A855F7" />
      </section>

      {/* Per-collection grid */}
      <section>
        <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 13, letterSpacing: "0.14em", textTransform: "uppercase", color: "rgba(255,255,255,0.7)", marginBottom: 10 }}>
          Per Collection
        </div>
        <div className="rpc-profile-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
          {perCollection.length === 0 ? (
            <div style={{ gridColumn: "1 / -1", padding: "20px 18px", background: "#18181b", border: "1px solid #27272a", borderRadius: 10, fontFamily: monoFont, fontSize: 12, color: "rgba(255,255,255,0.45)", letterSpacing: "0.04em", textAlign: "center" }}>
              No collection data yet.
            </div>
          ) : (
            perCollection.map((row) => {
              const meta = metaForSlug(row.collection_slug);
              const count = row.moment_count ?? 0;
              const fmv = row.total_fmv_usd ?? row.fmv_usd ?? 0;
              const isEmpty = count === 0;
              return (
                <Link
                  key={row.collection_slug}
                  href={`/${meta.id}/collection`}
                  style={{
                    display: "block",
                    background: "#18181b",
                    border: "1px solid #27272a",
                    borderBottom: `2px solid ${isEmpty ? "rgba(255,255,255,0.15)" : meta.accent}`,
                    borderRadius: 10,
                    padding: "14px 16px",
                    color: "#fff",
                    textDecoration: "none",
                    opacity: isEmpty ? 0.5 : 1,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                    <span style={{ fontSize: 20 }}>{meta.icon}</span>
                    <span style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 13, letterSpacing: "0.04em", textTransform: "uppercase" }}>
                      {meta.label}
                    </span>
                  </div>
                  {isEmpty ? (
                    <div style={{ fontFamily: monoFont, fontSize: 11, color: "rgba(255,255,255,0.4)", letterSpacing: "0.08em" }}>
                      No moments
                    </div>
                  ) : (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                      <div>
                        <div style={{ fontSize: 8, fontFamily: monoFont, color: "rgba(255,255,255,0.4)", letterSpacing: "0.1em", textTransform: "uppercase" }}>Moments</div>
                        <div style={{ fontSize: 16, fontFamily: condensedFont, fontWeight: 800 }}>{count.toLocaleString()}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 8, fontFamily: monoFont, color: "rgba(255,255,255,0.4)", letterSpacing: "0.1em", textTransform: "uppercase" }}>FMV</div>
                        <div style={{ fontSize: 16, fontFamily: condensedFont, fontWeight: 800, color: "#34D399" }}>{fmtUsd0(fmv)}</div>
                      </div>
                    </div>
                  )}
                </Link>
              );
            })
          )}
        </div>
      </section>

      {/* Top Moments */}
      <section>
        <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 13, letterSpacing: "0.14em", textTransform: "uppercase", color: "rgba(255,255,255,0.7)", marginBottom: 10 }}>
          Top Moments
        </div>
        {topMoments.length === 0 ? (
          <div style={{ padding: "20px 18px", background: "#18181b", border: "1px solid #27272a", borderRadius: 10, fontFamily: monoFont, fontSize: 12, color: "rgba(255,255,255,0.45)", letterSpacing: "0.04em", textAlign: "center" }}>
            No moments with FMV data yet — refresh to fetch your collection.
          </div>
        ) : (
          <div style={{ background: "#18181b", border: "1px solid #27272a", borderRadius: 10, overflow: "hidden" }}>
            {topMoments.map((m, i) => {
              const name = m.edition_name || m.player_name || m.character_name || "\u2014";
              const meta = metaForSlug(m.collection_slug ?? "");
              const tc = tierColor(m.tier);
              return (
                <div key={`${m.moment_id ?? i}`} style={{
                  display: "grid",
                  gridTemplateColumns: "1.5fr auto auto auto",
                  gap: 12,
                  alignItems: "center",
                  padding: "10px 14px",
                  borderBottom: i < topMoments.length - 1 ? "1px solid #27272a" : "none",
                }}>
                  <div style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 13, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {name}
                  </div>
                  {m.tier ? (
                    <span style={{ fontSize: 9, fontFamily: condensedFont, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: tc, background: `${tc}22`, border: `1px solid ${tc}55`, padding: "2px 6px", borderRadius: 3 }}>
                      {m.tier}
                    </span>
                  ) : (
                    <span />
                  )}
                  <span style={{ fontSize: 10, fontFamily: monoFont, letterSpacing: "0.08em", color: meta.accent, textTransform: "uppercase" }}>
                    {meta.shortLabel}
                  </span>
                  <span style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 14, color: "#34D399", textAlign: "right" }}>
                    {typeof m.fmv_usd === "number" ? fmtUsd0(m.fmv_usd) : "\u2014"}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SummaryCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ background: "#18181b", border: "1px solid #27272a", borderRadius: 10, padding: "12px 16px" }}>
      <div style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.4)", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontFamily: condensedFont, fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
    </div>
  );
}

const buttonPrimaryStyle = {
  background: ACCENT_RED,
  border: "none",
  color: "#fff",
  padding: "10px 20px",
  borderRadius: 6,
  fontFamily: condensedFont,
  fontWeight: 700,
  fontSize: 13,
  letterSpacing: "0.08em",
  textTransform: "uppercase" as const,
  cursor: "pointer",
};

const buttonGhostStyle = {
  background: "transparent",
  border: "1px solid rgba(255,255,255,0.15)",
  color: "#fff",
  padding: "6px 14px",
  borderRadius: 6,
  fontFamily: condensedFont,
  fontWeight: 700,
  fontSize: 11,
  letterSpacing: "0.08em",
  textTransform: "uppercase" as const,
  cursor: "pointer",
};

const linkButtonStyle = {
  background: "transparent",
  border: "none",
  color: "rgba(255,255,255,0.5)",
  padding: 0,
  fontFamily: monoFont,
  fontSize: 10,
  letterSpacing: "0.1em",
  textTransform: "uppercase" as const,
  cursor: "pointer",
  textDecoration: "underline",
};
