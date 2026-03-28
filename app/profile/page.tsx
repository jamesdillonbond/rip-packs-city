"use client";

import { useState, useEffect, useCallback, useMemo, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getOwnerKey, setOwnerKey as saveOwnerKey, onOwnerKeyChange } from "@/lib/owner-key";

// ─── TYPES ────────────────────────────────────────────────────
interface SavedWallet {
  id: number;
  owner_key: string;
  wallet_addr: string;
  username: string | null;
  display_name: string | null;
  accent_color: string;
  pinned_at: string;
  last_viewed: string | null;
  cached_fmv: number | null;
  cached_moment_count: number | null;
  cached_top_tier: string | null;
  cached_change_24h: number | null;
  cached_badges: string[] | null;
}

interface RecentSearch {
  id: number;
  query: string;
  query_type: string;
  searched_at: string;
}

interface TrophyMoment {
  id?: number;
  slot: number;
  moment_id: string;
  player_name: string | null;
  set_name: string | null;
  serial_number: number | null;
  circulation_count: number | null;
  tier: string | null;
  thumbnail_url: string | null;
  video_url: string | null;
  fmv: number | null;
  badges: string[] | null;
}

interface SniperRow {
  player: string;
  set: string;
  serial: string;
  price: number;
  fmv: number;
  pct: number;
  tier: string;
}

interface MarketPulse {
  commonFloor: number | null;
  rareFloor: number | null;
  legendaryFloor: number | null;
  indexedEditions: number;
}

interface ProfileBio {
  display_name: string | null;
  tagline: string | null;
  favorite_team: string | null;
  twitter: string | null;
  discord: string | null;
  avatar_url: string | null;
}

interface SetProgress {
  setId: string;
  setName: string;
  totalEditions: number;
  ownedCount: number;
  missingCount: number;
  completionPct: number;
  totalMissingCost: number | null;
  lowestSingleAsk: number | null;
}

interface ActivityItem {
  walletUsername: string;
  walletAccent: string;
  playerName: string;
  setName: string;
  serialNumber: number | null;
  tier: string;
  price: number;
  soldAt: string;
}

interface PinPreview {
  momentId: string;
  playerName: string;
  setName: string;
  serialNumber: number | null;
  circulationCount: number | null;
  tier: string;
  thumbnailUrl: string | null;
  videoUrl: string | null;
  fmv: number | null;
  badges: string[] | null;
}

interface PortfolioSnapshot {
  snapshot_date: string;
  total_fmv: number;
  moment_count: number;
  wallet_count: number;
}

// ─── CONSTANTS ────────────────────────────────────────────────
const ACCENT_CYCLE = ["#E03A2F", "#3B82F6", "#10B981", "#F59E0B", "#818CF8", "#F472B6"];
const MAX_SLOTS = 3;

// ─── HELPERS ──────────────────────────────────────────────────
function fmtDollars(n: number): string {
  if (n >= 1000) return "$" + (n / 1000).toFixed(1) + "K";
  return "$" + n.toFixed(2);
}

function relTime(iso: string | null): string {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 2) return "Just now";
  if (mins < 60) return mins + "m ago";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  return Math.floor(hrs / 24) + "d ago";
}

function tierColor(t: string | null): string {
  if (t === "Legendary") return "#F59E0B";
  if (t === "Rare") return "#818CF8";
  return "#6B7280";
}

function typeColor(t: string): string {
  if (t === "wallet") return "#E03A2F";
  if (t === "moment") return "#F59E0B";
  if (t === "edition") return "#818CF8";
  if (t === "player") return "#34D399";
  return "#3B82F6";
}

function pickAccent(index: number): string {
  return ACCENT_CYCLE[index % ACCENT_CYCLE.length];
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return (d.getMonth() + 1) + "/" + d.getDate();
}

// ─── STYLE TOKENS ─────────────────────────────────────────────
const monoFont = "'Share Tech Mono', monospace";
const condensedFont = "'Barlow Condensed', sans-serif";

const labelStyle: React.CSSProperties = {
  fontSize: 9,
  fontFamily: monoFont,
  letterSpacing: "0.2em",
  color: "rgba(255,255,255,0.4)",
  textTransform: "uppercase",
};

const btnBase: React.CSSProperties = {
  background: "rgba(255,255,255,0.05)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 4,
  padding: "4px 10px",
  color: "rgba(255,255,255,0.5)",
  fontFamily: condensedFont,
  fontWeight: 700,
  fontSize: 10,
  letterSpacing: "0.08em",
  cursor: "pointer",
  textTransform: "uppercase",
  transition: "all 0.15s",
};

// ─── AVATAR COMPONENT ─────────────────────────────────────────
function Avatar(props: { ownerKey: string; bio: ProfileBio | null; size?: number; fontSize?: number }) {
  const size = props.size ?? 44;
  const fontSize = props.fontSize ?? 16;
  const initials = props.ownerKey ? props.ownerKey.slice(0, 2).toUpperCase() : "?";

  if (props.bio?.avatar_url) {
    return (
      <div style={{ width: size, height: size, borderRadius: "50%", overflow: "hidden", border: "2px solid rgba(224,58,47,0.4)", flexShrink: 0 }}>
        <img
          src={props.bio.avatar_url}
          alt={props.ownerKey}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
          onError={function(e) {
            // Fall back to initials on image error
            e.currentTarget.style.display = "none";
            if (e.currentTarget.parentElement) {
              e.currentTarget.parentElement.innerHTML = initials;
              Object.assign(e.currentTarget.parentElement.style, {
                background: "rgba(224,58,47,0.15)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: condensedFont,
                fontWeight: 800,
                fontSize: fontSize + "px",
                color: "#E03A2F",
              });
            }
          }}
        />
      </div>
    );
  }

  return (
    <div style={{ width: size, height: size, borderRadius: "50%", background: "rgba(224,58,47,0.15)", border: "1px solid rgba(224,58,47,0.35)", display: "flex", alignItems: "center", justifyContent: "center", fontSize, fontWeight: 800, color: "#E03A2F", fontFamily: condensedFont, flexShrink: 0 }}>
      {initials}
    </div>
  );
}

// ─── PIN PARAM READER ─────────────────────────────────────────
function PinParamReader(props: {
  trophies: (TrophyMoment | null)[];
  onPinRequest: (slot: number, momentId: string) => void;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(function() {
    const momentId = searchParams.get("pin");
    if (!momentId) return;
    router.replace("/profile");
    const firstEmpty = props.trophies.findIndex(function(t) { return t === null; });
    const slot = firstEmpty >= 0 ? firstEmpty + 1 : 1;
    props.onPinRequest(slot, momentId);
  }, [searchParams, props.trophies, props.onPinRequest, router]);

  return null;
}

// ─── SIGN IN BANNER ───────────────────────────────────────────
function SignInBanner(props: { onSetKey: (key: string) => void }) {
  const [val, setVal] = useState("");
  const [focused, setFocused] = useState(false);

  return (
    <div style={{ background: "linear-gradient(135deg, rgba(224,58,47,0.14) 0%, rgba(224,58,47,0.04) 100%)", border: "1px solid rgba(224,58,47,0.35)", borderRadius: 12, padding: "22px 28px", marginBottom: 16, animation: "fadeIn 0.4s ease both" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
        <div style={{ width: 52, height: 52, borderRadius: "50%", background: "rgba(224,58,47,0.15)", border: "1px solid rgba(224,58,47,0.4)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, flexShrink: 0 }}>
          👤
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 18, color: "#fff", letterSpacing: "0.04em", marginBottom: 4 }}>
            Set Up Your Rip Packs City Profile
          </div>
          <div style={{ fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.4)", lineHeight: 1.7 }}>
            Save wallets · track searches · pin trophy moments · build your FMV sparkline.
            <br />Just your Top Shot username — no account, no password. Stays signed in everywhere.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0, flexWrap: "wrap" }}>
          <input
            value={val}
            onChange={function(e) { setVal(e.target.value); }}
            onKeyDown={function(e) { if (e.key === "Enter" && val.trim()) props.onSetKey(val.trim()); }}
            onFocus={function() { setFocused(true); }}
            onBlur={function() { setFocused(false); }}
            placeholder="your Top Shot username…"
            style={{ background: "rgba(255,255,255,0.07)", border: "1px solid " + (focused ? "rgba(224,58,47,0.7)" : "rgba(224,58,47,0.35)"), borderRadius: 7, padding: "9px 16px", color: "#fff", fontFamily: monoFont, fontSize: 11, outline: "none", width: 220, transition: "border-color 0.15s" }}
          />
          <button
            onClick={function() { if (val.trim()) props.onSetKey(val.trim()); }}
            style={{ background: "#E03A2F", border: "none", borderRadius: 7, padding: "9px 20px", color: "#fff", fontFamily: condensedFont, fontWeight: 800, fontSize: 13, letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer", flexShrink: 0 }}
            onMouseEnter={function(e) { e.currentTarget.style.background = "#c42e24"; }}
            onMouseLeave={function(e) { e.currentTarget.style.background = "#E03A2F"; }}
          >
            Sign In
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── TICKER ───────────────────────────────────────────────────
function Ticker() {
  const items = [
    "WALLET ANALYZER — FMV + Flowty asks + badge intel",
    "PACK EV CALCULATOR — expected value vs price",
    "SNIPER — real-time deals below FMV",
    "BADGE TRACKER — Top Shot Debut · Fresh · Rookie Year",
    "PROFILE — trophy case · sets tracker · activity feed · sparkline",
  ];
  const doubled = [...items, ...items];
  return (
    <div style={{ background: "#0D0D0D", borderBottom: "1px solid rgba(224,58,47,0.2)", overflow: "hidden", height: 28, display: "flex", alignItems: "center" }}>
      <div style={{ background: "#E03A2F", padding: "0 12px", fontSize: 9, fontFamily: monoFont, letterSpacing: "0.15em", color: "#fff", height: "100%", display: "flex", alignItems: "center", flexShrink: 0, fontWeight: 700 }}>LIVE</div>
      <div style={{ overflow: "hidden", flex: 1 }}>
        <div style={{ display: "flex", gap: 64, animation: "ticker 38s linear infinite", whiteSpace: "nowrap", paddingLeft: 24 }}>
          {doubled.map(function(item, i) { return <span key={i} style={{ fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.45)", letterSpacing: "0.07em" }}>{"⚡ " + item}</span>; })}
        </div>
      </div>
    </div>
  );
}

// ─── STAT TILE ────────────────────────────────────────────────
function StatTile(props: { label: string; value: string; sub: string; change: string; up: boolean; icon: string; color: string; delay: number }) {
  const [vis, setVis] = useState(false);
  useEffect(function() { const t = setTimeout(function() { setVis(true); }, props.delay); return function() { clearTimeout(t); }; }, [props.delay]);
  return (
    <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 8, padding: "16px 18px", position: "relative", overflow: "hidden", opacity: vis ? 1 : 0, transform: vis ? "translateY(0)" : "translateY(10px)", transition: "opacity 0.35s, transform 0.35s" }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: props.color, opacity: 0.7 }} />
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={labelStyle}>{props.label}</span>
        <span style={{ fontSize: 16, opacity: 0.5 }}>{props.icon}</span>
      </div>
      <div style={{ fontSize: 24, fontFamily: condensedFont, fontWeight: 800, color: "#fff", letterSpacing: "0.02em", lineHeight: 1, marginBottom: 6 }}>{props.value}</div>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.35)" }}>{props.sub}</span>
        <span style={{ fontSize: 10, fontFamily: monoFont, color: props.up ? "#34D399" : "#F87171", fontWeight: 700 }}>{props.change}</span>
      </div>
    </div>
  );
}

// ─── PORTFOLIO SPARKLINE ──────────────────────────────────────
function PortfolioSparkline(props: { ownerKey: string; currentFmv: number }) {
  const [snapshots, setSnapshots] = useState<PortfolioSnapshot[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(function() {
    if (!props.ownerKey) return;
    setLoading(true);
    fetch("/api/profile/portfolio-history?ownerKey=" + encodeURIComponent(props.ownerKey) + "&days=30")
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(d) { if (d?.snapshots) setSnapshots(d.snapshots); })
      .catch(function() {})
      .finally(function() { setLoading(false); });
  }, [props.ownerKey]);

  const points = useMemo(function() {
    const today = new Date().toISOString().split("T")[0];
    const historical = snapshots.filter(function(s) { return s.snapshot_date !== today; });
    const liveToday: PortfolioSnapshot = { snapshot_date: today, total_fmv: props.currentFmv, moment_count: 0, wallet_count: 0 };
    return [...historical, liveToday].filter(function(s) { return s.total_fmv > 0; });
  }, [snapshots, props.currentFmv]);

  const isEmpty = !loading && points.length < 2;
  const minVal = points.length ? Math.min(...points.map(function(p) { return p.total_fmv; })) : 0;
  const maxVal = points.length ? Math.max(...points.map(function(p) { return p.total_fmv; })) : 0;
  const range = maxVal - minVal || 1;
  const change = points.length >= 2 ? points[points.length - 1].total_fmv - points[0].total_fmv : 0;
  const changePct = points.length >= 2 && points[0].total_fmv > 0 ? (change / points[0].total_fmv) * 100 : 0;
  const changeColor = change >= 0 ? "#34D399" : "#F87171";
  const changeSign = change >= 0 ? "+" : "";
  const W = 360; const H = 56; const PAD = 4;

  const svgPath = useMemo(function() {
    if (points.length < 2) return "";
    return "M " + points.map(function(p, i) {
      const x = PAD + (i / (points.length - 1)) * (W - PAD * 2);
      const y = PAD + ((maxVal - p.total_fmv) / range) * (H - PAD * 2);
      return x.toFixed(1) + "," + y.toFixed(1);
    }).join(" L ");
  }, [points, maxVal, range]);

  const areaPath = svgPath ? svgPath + " L " + (W - PAD).toFixed(1) + "," + (H - PAD).toFixed(1) + " L " + PAD.toFixed(1) + "," + (H - PAD).toFixed(1) + " Z" : "";

  return (
    <section style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 10, padding: "14px 18px", marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <span style={labelStyle}>◈ Portfolio Value · 30d</span>
        {points.length >= 2 && (
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.3)", letterSpacing: "0.1em" }}>30D CHANGE</div>
            <div style={{ fontSize: 13, fontFamily: condensedFont, fontWeight: 800, color: changeColor }}>{changeSign + fmtDollars(Math.abs(change)) + " (" + changeSign + changePct.toFixed(1) + "%)"}</div>
          </div>
        )}
      </div>
      {loading ? (
        <div style={{ height: 60, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.2)" }}>Loading…</span>
        </div>
      ) : isEmpty ? (
        <div style={{ height: 60, display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1, fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.25)", lineHeight: 1.7 }}>
            Sparkline builds as you load wallets. Load any saved wallet to record today's data point.
          </div>
          <svg width={W} height={H} viewBox={"0 0 " + W + " " + H} style={{ opacity: 0.15, flexShrink: 0 }}>
            <line x1={PAD} y1={H / 2} x2={W - PAD} y2={H / 2} stroke="#E03A2F" strokeWidth="1.5" strokeDasharray="4 4" />
          </svg>
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "flex-end", gap: 16 }}>
          <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", height: H, flexShrink: 0, paddingTop: PAD, paddingBottom: PAD }}>
            <div style={{ fontSize: 8, fontFamily: monoFont, color: "rgba(255,255,255,0.25)", textAlign: "right" }}>{fmtDollars(maxVal)}</div>
            <div style={{ fontSize: 8, fontFamily: monoFont, color: "rgba(255,255,255,0.25)", textAlign: "right" }}>{fmtDollars(minVal)}</div>
          </div>
          <div style={{ flex: 1, position: "relative" }}>
            <svg width="100%" viewBox={"0 0 " + W + " " + H} style={{ display: "block", overflow: "visible" }} preserveAspectRatio="none">
              <defs>
                <linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={changeColor} stopOpacity="0.25" />
                  <stop offset="100%" stopColor={changeColor} stopOpacity="0.02" />
                </linearGradient>
              </defs>
              <path d={areaPath} fill="url(#sparkGrad)" />
              <path d={svgPath} fill="none" stroke={changeColor} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              {points.length > 0 && (function() {
                const last = points[points.length - 1];
                const x = PAD + ((points.length - 1) / (points.length - 1)) * (W - PAD * 2);
                const y = PAD + ((maxVal - last.total_fmv) / range) * (H - PAD * 2);
                return <circle cx={x} cy={y} r="3" fill={changeColor} />;
              })()}
            </svg>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
              <span style={{ fontSize: 8, fontFamily: monoFont, color: "rgba(255,255,255,0.2)" }}>{fmtDate(points[0].snapshot_date)}</span>
              {points.length > 2 && <span style={{ fontSize: 8, fontFamily: monoFont, color: "rgba(255,255,255,0.2)" }}>{fmtDate(points[Math.floor(points.length / 2)].snapshot_date)}</span>}
              <span style={{ fontSize: 8, fontFamily: monoFont, color: "rgba(255,255,255,0.2)" }}>Today</span>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

// ─── MARKET PULSE ─────────────────────────────────────────────
function MarketPulseWidget(props: { pulse: MarketPulse | null; loading: boolean }) {
  const stats = [
    { label: "Common Floor", value: props.pulse?.commonFloor != null ? fmtDollars(props.pulse.commonFloor) : "—", color: "#6B7280" },
    { label: "Rare Floor", value: props.pulse?.rareFloor != null ? fmtDollars(props.pulse.rareFloor) : "—", color: "#818CF8" },
    { label: "Legendary Floor", value: props.pulse?.legendaryFloor != null ? fmtDollars(props.pulse.legendaryFloor) : "—", color: "#F59E0B" },
    { label: "Indexed Editions", value: props.pulse?.indexedEditions ? props.pulse.indexedEditions.toLocaleString() : "—", color: "#34D399" },
  ];
  return (
    <section style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 10, padding: "14px 18px", marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#34D399", animation: "pulse 2s infinite" }} />
        <span style={labelStyle}>Market Pulse</span>
        <span style={{ fontSize: 8, fontFamily: monoFont, color: "rgba(255,255,255,0.2)", letterSpacing: "0.1em", marginLeft: "auto" }}>60s cache · from RPC index</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 12 }}>
        {stats.map(function(s) {
          return (
            <div key={s.label}>
              <div style={{ fontSize: 8, fontFamily: monoFont, color: "rgba(255,255,255,0.3)", letterSpacing: "0.1em", marginBottom: 4, textTransform: "uppercase" }}>{s.label}</div>
              <div style={{ fontSize: 18, fontFamily: condensedFont, fontWeight: 800, color: props.loading ? "rgba(255,255,255,0.2)" : s.color }}>{props.loading ? "…" : s.value}</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ─── BIO WIDGET ───────────────────────────────────────────────
function BioWidget(props: { ownerKey: string; bio: ProfileBio | null; onSave: (bio: ProfileBio) => void }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<ProfileBio>({ display_name: "", tagline: "", favorite_team: "", twitter: "", discord: "", avatar_url: "" });
  const [saving, setSaving] = useState(false);

  useEffect(function() {
    setForm({
      display_name: props.bio?.display_name ?? "",
      tagline: props.bio?.tagline ?? "",
      favorite_team: props.bio?.favorite_team ?? "",
      twitter: props.bio?.twitter ?? "",
      discord: props.bio?.discord ?? "",
      avatar_url: props.bio?.avatar_url ?? "",
    });
  }, [props.bio]);

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch("/api/profile/bio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerKey: props.ownerKey,
          displayName: form.display_name,
          tagline: form.tagline,
          favoriteTeam: form.favorite_team,
          twitter: form.twitter,
          discord: form.discord,
          avatarUrl: form.avatar_url,
        }),
      });
      if (res.ok) { const d = await res.json(); props.onSave(d.bio); setEditing(false); }
    } finally { setSaving(false); }
  }

  if (!editing) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "14px 18px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 10, marginBottom: 14 }}>
        <Avatar ownerKey={props.ownerKey} bio={props.bio} size={48} fontSize={17} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 17, color: "#fff", letterSpacing: "0.04em" }}>{props.bio?.display_name || props.ownerKey}</div>
          <div style={{ fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.35)", marginTop: 2 }}>{props.bio?.tagline || "NBA Top Shot Collector"}</div>
          {(props.bio?.twitter || props.bio?.favorite_team || props.bio?.discord) && (
            <div style={{ display: "flex", gap: 10, marginTop: 5, flexWrap: "wrap" }}>
              {props.bio?.favorite_team && <span style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.35)" }}>{"🏀 " + props.bio.favorite_team}</span>}
              {props.bio?.twitter && <span style={{ fontSize: 9, fontFamily: monoFont, color: "#1DA1F2" }}>{"𝕏 @" + props.bio.twitter}</span>}
              {props.bio?.discord && <span style={{ fontSize: 9, fontFamily: monoFont, color: "#7289DA" }}>{"⌘ " + props.bio.discord}</span>}
            </div>
          )}
        </div>
        <button onClick={function() { setEditing(true); }} style={Object.assign({}, btnBase, { fontSize: 9, flexShrink: 0 })}>{props.bio?.display_name ? "Edit" : "Set Bio"}</button>
      </div>
    );
  }

  const fields = [
    { key: "display_name", label: "Display Name", placeholder: "e.g. Trevor D." },
    { key: "tagline", label: "Tagline", placeholder: "e.g. Chasing Legendaries since 2020", wide: true },
    { key: "avatar_url", label: "Profile Picture URL", placeholder: "https://… (any image URL)", wide: true },
    { key: "favorite_team", label: "Favorite Team", placeholder: "e.g. Los Angeles Lakers" },
    { key: "twitter", label: "𝕏 / Twitter", placeholder: "username (no @)" },
    { key: "discord", label: "Discord", placeholder: "username" },
  ];

  return (
    <div style={{ padding: "16px 18px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(224,58,47,0.25)", borderRadius: 10, marginBottom: 14 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
        {fields.map(function(f) {
          return (
            <div key={f.key} style={(f as any).wide ? { gridColumn: "1 / -1" } : {}}>
              <div style={Object.assign({}, labelStyle, { marginBottom: 4 })}>{f.label}</div>
              <input value={(form as any)[f.key] ?? ""} onChange={function(e) { setForm(function(prev) { return Object.assign({}, prev, { [f.key]: e.target.value }); }); }} placeholder={f.placeholder} style={{ width: "100%", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 5, padding: "6px 10px", color: "#fff", fontFamily: monoFont, fontSize: 11, outline: "none", letterSpacing: "0.04em" }} />
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button onClick={function() { setEditing(false); }} style={Object.assign({}, btnBase, { padding: "6px 14px" })}>Cancel</button>
        <button onClick={handleSave} disabled={saving} style={Object.assign({}, btnBase, { background: "#E03A2F", color: "#fff", borderColor: "#E03A2F", padding: "6px 14px", opacity: saving ? 0.6 : 1 })}>{saving ? "Saving…" : "Save Profile"}</button>
      </div>
    </div>
  );
}

// ─── TROPHY SLOT ──────────────────────────────────────────────
function TrophySlot(props: { slot: number; trophy: TrophyMoment | null; ownerKey: string; onPin: (slot: number) => void; onRemove: (slot: number) => void }) {
  const [hovered, setHovered] = useState(false);
  const [videoError, setVideoError] = useState(false);
  const t = props.trophy;
  const tc = tierColor(t?.tier ?? null);
  const slotLabels = ["", "🥇 SLOT 1", "🥈 SLOT 2", "🥉 SLOT 3"];

  if (!t) {
    return (
      <div style={{ background: "rgba(255,255,255,0.02)", border: "1px dashed rgba(255,255,255,0.12)", borderRadius: 10, aspectRatio: "3/4", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, cursor: props.ownerKey ? "pointer" : "default", transition: "all 0.2s" }}
        onMouseEnter={function(e) { if (props.ownerKey) e.currentTarget.style.borderColor = "rgba(224,58,47,0.4)"; }}
        onMouseLeave={function(e) { e.currentTarget.style.borderColor = "rgba(255,255,255,0.12)"; }}
        onClick={function() { if (props.ownerKey) props.onPin(props.slot); }}>
        <div style={{ fontSize: 28, opacity: 0.2 }}>🏆</div>
        <div style={Object.assign({}, labelStyle, { textAlign: "center" })}>{slotLabels[props.slot]}</div>
        {props.ownerKey && <div style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.2)", textAlign: "center", padding: "0 12px" }}>Click to pin · or use ⭐ Pin in Wallet</div>}
      </div>
    );
  }

  return (
    <div style={{ position: "relative", borderRadius: 10, overflow: "hidden", aspectRatio: "3/4", border: "1px solid " + tc + "44", cursor: "pointer", transition: "all 0.2s", transform: hovered ? "translateY(-3px)" : "translateY(0)", boxShadow: hovered ? "0 12px 40px " + tc + "22" : "none" }}
      onMouseEnter={function() { setHovered(true); }}
      onMouseLeave={function() { setHovered(false); }}>
      <div style={{ position: "absolute", inset: 0, background: "#111" }}>
        {t.video_url && !videoError && hovered ? (
          <video src={t.video_url} autoPlay muted loop playsInline onError={function() { setVideoError(true); }} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <img src={t.thumbnail_url ?? ""} alt={t.player_name ?? "Moment"} style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={function(e) { e.currentTarget.style.opacity = "0.3"; }} />
        )}
      </div>
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to top, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.3) 50%, transparent 100%)" }} />
      <div style={{ position: "absolute", top: 10, left: 10 }}>
        <span style={{ fontSize: 8, fontFamily: monoFont, color: tc, background: tc + "22", border: "1px solid " + tc + "44", padding: "2px 6px", borderRadius: 3, letterSpacing: "0.1em" }}>{(t.tier ?? "COMMON").toUpperCase()}</span>
      </div>
      {props.ownerKey && hovered && (
        <button onClick={function(e) { e.stopPropagation(); props.onRemove(props.slot); }} style={{ position: "absolute", top: 8, right: 8, background: "rgba(0,0,0,0.7)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: "50%", width: 24, height: 24, color: "rgba(255,255,255,0.6)", fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
      )}
      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "12px 12px 14px" }}>
        <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 15, color: "#fff", letterSpacing: "0.04em", lineHeight: 1.1, marginBottom: 4 }}>{t.player_name ?? "Unknown"}</div>
        <div style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.5)", marginBottom: 6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.set_name ?? ""}</div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 11, fontFamily: condensedFont, fontWeight: 700, color: tc }}>{t.serial_number != null ? ("#" + t.serial_number + " / " + (t.circulation_count ?? "?")) : ""}</span>
          {t.fmv != null && <span style={{ fontSize: 10, fontFamily: monoFont, color: "#34D399" }}>{fmtDollars(t.fmv)}</span>}
        </div>
        {(t.badges ?? []).length > 0 && (
          <div style={{ display: "flex", gap: 3, marginTop: 5 }}>
            {(t.badges ?? []).slice(0, 3).map(function(b, i) { return <span key={i} style={{ fontSize: 10 }}>{b}</span>; })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── PIN MODAL ────────────────────────────────────────────────
function PinModal(props: { slot: number; ownerKey: string; prefilled: PinPreview | null; onClose: () => void; onPinned: (t: TrophyMoment) => void }) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<PinPreview | null>(props.prefilled);

  useEffect(function() { if (props.prefilled) setPreview(props.prefilled); }, [props.prefilled]);

  async function handleLookup() {
    if (!input.trim()) return;
    setLoading(true); setError(""); setPreview(null);
    try {
      const res = await fetch("/api/market-snapshot?momentId=" + encodeURIComponent(input.trim()));
      if (!res.ok) throw new Error("Not found");
      const d = await res.json();
      setPreview({ momentId: input.trim(), playerName: d.playerName ?? "Unknown", setName: d.setName ?? "", serialNumber: d.serialNumber ?? null, circulationCount: d.circulationCount ?? null, tier: d.tier ?? "Common", thumbnailUrl: d.thumbnailUrl ?? null, videoUrl: d.videoUrl ?? null, fmv: d.fmv ?? null, badges: d.badges ?? null });
    } catch { setError("Could not find that moment. Check the ID and try again."); }
    finally { setLoading(false); }
  }

  async function handlePin() {
    if (!preview) return;
    setLoading(true);
    try {
      const res = await fetch("/api/profile/trophy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ownerKey: props.ownerKey, slot: props.slot, momentId: preview.momentId, playerName: preview.playerName, setName: preview.setName, serialNumber: preview.serialNumber, circulationCount: preview.circulationCount, tier: preview.tier, thumbnailUrl: preview.thumbnailUrl, videoUrl: preview.videoUrl, fmv: preview.fmv, badges: preview.badges }) });
      if (!res.ok) throw new Error("Failed");
      const d = await res.json();
      props.onPinned(d.trophy);
      props.onClose();
    } catch { setError("Failed to save. Try again."); }
    finally { setLoading(false); }
  }

  const tc = tierColor(preview?.tier ?? null);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 999, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ background: "#111", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, padding: 24, width: "100%", maxWidth: 460, animation: "fadeIn 0.2s ease both" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 17, color: "#fff", letterSpacing: "0.05em", textTransform: "uppercase" }}>{"Pin to Slot " + props.slot}</div>
          <button onClick={props.onClose} style={Object.assign({}, btnBase, { padding: "3px 8px" })}>✕</button>
        </div>
        {props.prefilled && preview ? (
          <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: 14, marginBottom: 14 }}>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              {preview.thumbnailUrl && <img src={preview.thumbnailUrl} alt={preview.playerName} style={{ width: 56, height: 56, borderRadius: 6, objectFit: "cover", border: "1px solid " + tc + "44" }} onError={function(e) { e.currentTarget.style.display = "none"; }} />}
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 16, color: "#fff", marginBottom: 2 }}>{preview.playerName}</div>
                <div style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.4)", marginBottom: 8 }}>{preview.setName}</div>
                <div style={{ display: "flex", gap: 12 }}>
                  {preview.serialNumber != null && <div><div style={Object.assign({}, labelStyle, { marginBottom: 1 })}>Serial</div><div style={{ fontSize: 12, fontFamily: condensedFont, fontWeight: 700, color: tc }}>{"#" + preview.serialNumber}</div></div>}
                  {preview.tier && <div><div style={Object.assign({}, labelStyle, { marginBottom: 1 })}>Tier</div><div style={{ fontSize: 12, fontFamily: condensedFont, fontWeight: 700, color: tc }}>{preview.tier}</div></div>}
                  {preview.fmv != null && <div><div style={Object.assign({}, labelStyle, { marginBottom: 1 })}>FMV</div><div style={{ fontSize: 12, fontFamily: condensedFont, fontWeight: 700, color: "#34D399" }}>{fmtDollars(preview.fmv)}</div></div>}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.35)", marginBottom: 12, lineHeight: 1.6 }}>Enter a moment ID from the Top Shot URL: nbatopshot.com/moment/XXXXXXXX</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <input value={input} onChange={function(e) { setInput(e.target.value); }} onKeyDown={function(e) { if (e.key === "Enter") handleLookup(); }} placeholder="Moment ID…" style={{ flex: 1, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6, padding: "8px 12px", color: "#fff", fontFamily: monoFont, fontSize: 11, outline: "none" }} />
              <button onClick={handleLookup} disabled={loading} style={Object.assign({}, btnBase, { background: "#E03A2F", color: "#fff", borderColor: "#E03A2F", padding: "8px 14px", opacity: loading ? 0.6 : 1 })}>{loading ? "…" : "Look Up"}</button>
            </div>
            {preview && (
              <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: 12, marginBottom: 14 }}>
                <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 15, color: "#fff", marginBottom: 3 }}>{preview.playerName}</div>
                <div style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.4)", marginBottom: 8 }}>{preview.setName}</div>
                <div style={{ display: "flex", gap: 14 }}>
                  {preview.serialNumber != null && <div><div style={Object.assign({}, labelStyle, { marginBottom: 1 })}>Serial</div><div style={{ fontSize: 12, fontFamily: condensedFont, fontWeight: 700, color: tc }}>{"#" + preview.serialNumber}</div></div>}
                  {preview.tier && <div><div style={Object.assign({}, labelStyle, { marginBottom: 1 })}>Tier</div><div style={{ fontSize: 12, fontFamily: condensedFont, fontWeight: 700, color: tc }}>{preview.tier}</div></div>}
                  {preview.fmv != null && <div><div style={Object.assign({}, labelStyle, { marginBottom: 1 })}>FMV</div><div style={{ fontSize: 12, fontFamily: condensedFont, fontWeight: 700, color: "#34D399" }}>{fmtDollars(preview.fmv)}</div></div>}
                </div>
              </div>
            )}
          </>
        )}
        {error && <div style={{ fontSize: 10, fontFamily: monoFont, color: "#F87171", marginBottom: 10 }}>{error}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={props.onClose} style={Object.assign({}, btnBase, { padding: "7px 14px" })}>Cancel</button>
          <button onClick={handlePin} disabled={!preview || loading} style={Object.assign({}, btnBase, { background: preview ? "#E03A2F" : "rgba(255,255,255,0.05)", color: preview ? "#fff" : "rgba(255,255,255,0.3)", borderColor: preview ? "#E03A2F" : "rgba(255,255,255,0.1)", padding: "7px 14px", opacity: loading ? 0.6 : 1 })}>
            {loading ? "Saving…" : "Pin to Trophy Case"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── SETS PROGRESS ────────────────────────────────────────────
function SetsProgressWidget(props: { savedWallets: SavedWallet[] }) {
  const [sets, setSets] = useState<SetProgress[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const router = useRouter();

  async function loadSets() {
    if (!props.savedWallets.length) return;
    setLoading(true);
    try {
      const w = props.savedWallets[0];
      const q = w.username ?? w.wallet_addr;
      const res = await fetch("/api/sets?wallet=" + encodeURIComponent(q) + "&skipAsks=1");
      if (!res.ok) return;
      const d = await res.json();
      const inProgress: SetProgress[] = (d.sets ?? [])
        .filter(function(s: SetProgress) { return s.completionPct > 0 && s.completionPct < 100; })
        .sort(function(a: SetProgress, b: SetProgress) { return b.completionPct - a.completionPct; })
        .slice(0, 3);
      setSets(inProgress);
      setLoaded(true);
    } catch {} finally { setLoading(false); }
  }

  return (
    <section style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 10, padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: loaded && sets.length > 0 ? 12 : 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={labelStyle}>◉ Sets Progress</span>
          {props.savedWallets[0]?.username && <span style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.25)" }}>{"— " + props.savedWallets[0].username}</span>}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {loaded && <button onClick={function() { router.push("/sets?wallet=" + encodeURIComponent(props.savedWallets[0].username ?? props.savedWallets[0].wallet_addr)); }} style={Object.assign({}, btnBase, { fontSize: 9, color: "#F472B6", borderColor: "rgba(244,114,182,0.3)", background: "rgba(244,114,182,0.1)" })}>{"Full Sets →"}</button>}
          {!loaded && <button onClick={loadSets} disabled={loading} style={Object.assign({}, btnBase, { fontSize: 9, opacity: loading ? 0.6 : 1 })}>{loading ? "Loading…" : "Load Sets"}</button>}
        </div>
      </div>
      {loaded && sets.length === 0 && <div style={{ fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.25)", padding: "8px 0" }}>No sets in progress found.</div>}
      {sets.map(function(s) {
        const pct = Math.round(s.completionPct);
        const isClose = s.missingCount <= 3;
        const barColor = isClose ? "#34D399" : "#E03A2F";
        return (
          <div key={s.setId} style={{ marginBottom: 8, padding: "10px 12px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
              <div style={{ flex: 1, minWidth: 0, marginRight: 12 }}>
                <div style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 13, color: "#fff", letterSpacing: "0.03em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.setName}</div>
                <div style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.35)", marginTop: 2 }}>
                  {s.ownedCount + " / " + s.totalEditions + " owned"}
                  {isClose && <span style={{ color: "#34D399", marginLeft: 6 }}>{"⚡ " + s.missingCount + " away"}</span>}
                </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div style={{ fontSize: 16, fontFamily: condensedFont, fontWeight: 800, color: barColor }}>{pct + "%"}</div>
                {s.totalMissingCost != null && s.totalMissingCost > 0 && <div style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.3)" }}>{fmtDollars(s.totalMissingCost) + " to complete"}</div>}
              </div>
            </div>
            <div style={{ height: 4, background: "rgba(255,255,255,0.07)", borderRadius: 2, overflow: "hidden" }}>
              <div style={{ width: pct + "%", height: "100%", background: barColor, borderRadius: 2, transition: "width 0.6s ease" }} />
            </div>
          </div>
        );
      })}
    </section>
  );
}

// ─── ACTIVITY FEED ────────────────────────────────────────────
function ActivityFeed(props: { savedWallets: SavedWallet[] }) {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  async function loadActivity() {
    if (!props.savedWallets.length) return;
    setLoading(true);
    try {
      const results: ActivityItem[] = [];
      for (const w of props.savedWallets.slice(0, 2)) {
        try {
          const res = await fetch("/api/edition-sales?wallet=" + encodeURIComponent(w.username ?? w.wallet_addr) + "&limit=5");
          if (!res.ok) continue;
          const d = await res.json();
          (d.sales ?? d.rows ?? d.data ?? []).slice(0, 5).forEach(function(sale: any) {
            results.push({ walletUsername: w.username ?? w.wallet_addr.slice(0, 10) + "…", walletAccent: w.accent_color, playerName: sale.playerName ?? sale.player ?? "Unknown", setName: sale.setName ?? sale.set ?? "", serialNumber: sale.serialNumber ?? null, tier: sale.tier ?? "Common", price: sale.price ?? sale.salePrice ?? 0, soldAt: sale.soldAt ?? sale.timestamp ?? new Date().toISOString() });
          });
        } catch {}
      }
      results.sort(function(a, b) { return new Date(b.soldAt).getTime() - new Date(a.soldAt).getTime(); });
      setItems(results.slice(0, 10));
      setLoaded(true);
    } finally { setLoading(false); }
  }

  return (
    <section style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 10, overflow: "hidden" }}>
      <div style={{ padding: "12px 16px", borderBottom: loaded && items.length > 0 ? "1px solid rgba(255,255,255,0.06)" : "none", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={labelStyle}>📈 Activity Feed</span>
        {!loaded && <button onClick={loadActivity} disabled={loading} style={Object.assign({}, btnBase, { fontSize: 9, opacity: loading ? 0.6 : 1 })}>{loading ? "Loading…" : "Load Activity"}</button>}
      </div>
      {loaded && items.length === 0 && <div style={{ padding: "16px", fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.25)", textAlign: "center" }}>No recent sales found.</div>}
      {items.map(function(item, i) {
        const tc = tierColor(item.tier);
        return (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "auto 1fr auto auto", alignItems: "center", gap: 10, padding: "9px 16px", borderBottom: "1px solid rgba(255,255,255,0.04)", transition: "background 0.15s" }}
            onMouseEnter={function(e) { e.currentTarget.style.background = "rgba(255,255,255,0.03)"; }}
            onMouseLeave={function(e) { e.currentTarget.style.background = "transparent"; }}>
            <div style={{ width: 24, height: 24, borderRadius: "50%", background: item.walletAccent + "22", border: "1px solid " + item.walletAccent + "44", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 800, color: item.walletAccent, fontFamily: condensedFont }}>
              {item.walletUsername.slice(0, 2).toUpperCase()}
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 12, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.playerName}</div>
              <div style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.35)" }}>{item.setName + (item.serialNumber ? " · #" + item.serialNumber : "")}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <span style={{ fontSize: 8, fontFamily: monoFont, color: tc, background: tc + "18", border: "1px solid " + tc + "33", padding: "1px 5px", borderRadius: 3, display: "block", marginBottom: 3 }}>{item.tier.toUpperCase()}</span>
              <span style={{ fontSize: 12, fontFamily: condensedFont, fontWeight: 700, color: "#fff" }}>{fmtDollars(item.price)}</span>
            </div>
            <div style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.25)", textAlign: "right" }}>{relTime(item.soldAt)}</div>
          </div>
        );
      })}
    </section>
  );
}

// ─── WALLET CARD ──────────────────────────────────────────────
function WalletCard(props: { wallet: SavedWallet; onLoad: (addr: string, user?: string) => void; onRemove: (addr: string) => void }) {
  const [hovered, setHovered] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const w = props.wallet;
  const label = w.display_name || w.username || (w.wallet_addr.slice(0, 10) + "…");
  const initials = label.slice(0, 2).toUpperCase();
  const changeColor = (w.cached_change_24h != null && w.cached_change_24h >= 0) ? "#34D399" : "#F87171";
  const changeStr = w.cached_change_24h != null ? ((w.cached_change_24h > 0 ? "+" : "") + w.cached_change_24h + "%") : "—";

  return (
    <div style={{ background: hovered ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.025)", border: "1px solid " + (hovered ? w.accent_color + "55" : "rgba(255,255,255,0.07)"), borderRadius: 10, padding: "14px 16px", cursor: "pointer", transition: "all 0.2s", position: "relative", overflow: "hidden" }}
      onMouseEnter={function() { setHovered(true); }}
      onMouseLeave={function() { setHovered(false); setConfirm(false); }}>
      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: w.accent_color, borderRadius: "10px 0 0 10px", opacity: hovered ? 1 : 0.4, transition: "opacity 0.2s" }} />
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <div style={{ width: 36, height: 36, borderRadius: "50%", background: w.accent_color + "22", border: "1px solid " + w.accent_color + "44", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 800, color: w.accent_color, fontFamily: condensedFont, flexShrink: 0 }}>{initials}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 14, color: "#fff", letterSpacing: "0.04em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
          <div style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.3)" }}>{w.wallet_addr.slice(0, 14) + "…"}</div>
        </div>
        {(w.cached_badges ?? []).slice(0, 3).map(function(b, i) { return <span key={i} style={{ fontSize: 11 }}>{b}</span>; })}
      </div>
      {w.cached_fmv != null ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 10 }}>
          <div><div style={{ fontSize: 8, fontFamily: monoFont, color: "rgba(255,255,255,0.3)", marginBottom: 2 }}>FMV</div><div style={{ fontSize: 13, fontFamily: condensedFont, fontWeight: 700, color: "#fff" }}>{fmtDollars(w.cached_fmv ?? 0)}</div></div>
          <div><div style={{ fontSize: 8, fontFamily: monoFont, color: "rgba(255,255,255,0.3)", marginBottom: 2 }}>MOMENTS</div><div style={{ fontSize: 13, fontFamily: condensedFont, fontWeight: 700, color: "#fff" }}>{w.cached_moment_count ?? "—"}</div></div>
          <div><div style={{ fontSize: 8, fontFamily: monoFont, color: "rgba(255,255,255,0.3)", marginBottom: 2 }}>24H</div><div style={{ fontSize: 13, fontFamily: condensedFont, fontWeight: 700, color: changeColor }}>{changeStr}</div></div>
        </div>
      ) : (
        <div style={{ fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.25)", marginBottom: 10 }}>Load wallet to populate stats</div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.06)" }}>
        <span style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.25)" }}>{w.last_viewed ? "Viewed " + relTime(w.last_viewed) : "Never loaded"}</span>
        <div style={{ display: "flex", gap: 6 }}>
          {confirm ? (
            <>
              <button onClick={function(e) { e.stopPropagation(); setConfirm(false); }} style={Object.assign({}, btnBase, { fontSize: 9 })}>Cancel</button>
              <button onClick={function(e) { e.stopPropagation(); props.onRemove(w.wallet_addr); }} style={Object.assign({}, btnBase, { background: "rgba(239,68,68,0.15)", color: "#F87171", borderColor: "rgba(239,68,68,0.35)", fontSize: 9 })}>Remove</button>
            </>
          ) : (
            <>
              <button onClick={function(e) { e.stopPropagation(); setConfirm(true); }} style={Object.assign({}, btnBase, { background: "transparent", border: "none", opacity: hovered ? 0.5 : 0, transition: "opacity 0.15s", fontSize: 9 })}>✕</button>
              <button onClick={function(e) { e.stopPropagation(); props.onLoad(w.wallet_addr, w.username ?? undefined); }} style={Object.assign({}, btnBase, { background: w.accent_color + "22", color: w.accent_color, borderColor: w.accent_color + "44", opacity: hovered ? 1 : 0.6, fontSize: 9 })}>{"Load →"}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function AddWalletForm(props: { onAdd: (val: string) => void; onCancel: () => void }) {
  const [val, setVal] = useState("");
  return (
    <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
      <input autoFocus value={val} onChange={function(e) { setVal(e.target.value); }} onKeyDown={function(e) { if (e.key === "Enter" && val.trim()) props.onAdd(val.trim()); }} placeholder="Username or 0x address…" style={{ flex: 1, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(224,58,47,0.35)", borderRadius: 6, padding: "7px 12px", color: "#fff", fontFamily: monoFont, fontSize: 11, outline: "none" }} />
      <button onClick={function() { if (val.trim()) props.onAdd(val.trim()); }} style={Object.assign({}, btnBase, { background: "#E03A2F", color: "#fff", borderColor: "#E03A2F", fontSize: 11 })}>Save</button>
      <button onClick={props.onCancel} style={Object.assign({}, btnBase, { fontSize: 11 })}>✕</button>
    </div>
  );
}

// ─── MAIN PAGE ────────────────────────────────────────────────
export default function ProfilePage() {
  const router = useRouter();

  const [ownerKey, setOwnerKeyState] = useState("");
  const [ownerInput, setOwnerInput] = useState("");
  const [savedWallets, setSavedWallets] = useState<SavedWallet[]>([]);
  const [recentSearches, setRecentSearches] = useState<RecentSearch[]>([]);
  const [sniperRows, setSniperRows] = useState<SniperRow[]>([]);
  const [trophies, setTrophies] = useState<(TrophyMoment | null)[]>([null, null, null]);
  const [pulse, setPulse] = useState<MarketPulse | null>(null);
  const [bio, setBio] = useState<ProfileBio | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [sniperLoading, setSniperLoading] = useState(false);
  const [pulseLoading, setPulseLoading] = useState(false);
  const [heroSearch, setHeroSearch] = useState("");
  const [showAddWallet, setShowAddWallet] = useState(false);
  const [pinModal, setPinModal] = useState<{ slot: number; prefilled: PinPreview | null } | null>(null);

  // Read from localStorage + listen for cross-tab changes
  useEffect(function() {
    setOwnerKeyState(getOwnerKey());
    return onOwnerKeyChange(function(key) {
      setOwnerKeyState(key);
      if (key) loadProfile(key);
    });
  }, []);

  function setOwnerKey(key: string) {
    setOwnerKeyState(key);
    saveOwnerKey(key);
  }

  const handlePinRequest = useCallback(async function(slot: number, momentId: string) {
    try {
      const res = await fetch("/api/market-snapshot?momentId=" + encodeURIComponent(momentId));
      if (!res.ok) { setPinModal({ slot, prefilled: null }); return; }
      const d = await res.json();
      setPinModal({ slot, prefilled: { momentId, playerName: d.playerName ?? "Unknown", setName: d.setName ?? "", serialNumber: d.serialNumber ?? null, circulationCount: d.circulationCount ?? null, tier: d.tier ?? "Common", thumbnailUrl: d.thumbnailUrl ?? null, videoUrl: d.videoUrl ?? null, fmv: d.fmv ?? null, badges: d.badges ?? null } });
    } catch { setPinModal({ slot, prefilled: null }); }
  }, []);

  const loadProfile = useCallback(async function(key: string) {
    if (!key) return;
    setProfileLoading(true);
    try {
      const enc = encodeURIComponent(key);
      const [wRes, sRes, tRes, bRes] = await Promise.all([
        fetch("/api/profile/saved-wallets?ownerKey=" + enc),
        fetch("/api/profile/recent-searches?ownerKey=" + enc),
        fetch("/api/profile/trophy?ownerKey=" + enc),
        fetch("/api/profile/bio?ownerKey=" + enc),
      ]);
      if (wRes.ok) { const d = await wRes.json(); setSavedWallets(d.wallets ?? []); }
      if (sRes.ok) { const d = await sRes.json(); setRecentSearches(d.searches ?? []); }
      if (tRes.ok) {
        const d = await tRes.json();
        const slots: (TrophyMoment | null)[] = [null, null, null];
        (d.trophies ?? []).forEach(function(t: TrophyMoment) { if (t.slot >= 1 && t.slot <= 3) slots[t.slot - 1] = t; });
        setTrophies(slots);
      }
      if (bRes.ok) { const d = await bRes.json(); setBio(d.bio); }
    } catch (err) { console.error("[profile load]", err); }
    finally { setProfileLoading(false); }
  }, []);

  useEffect(function() { if (ownerKey) loadProfile(ownerKey); }, [ownerKey, loadProfile]);

  useEffect(function() {
    setPulseLoading(true);
    fetch("/api/profile/market-pulse").then(function(r) { return r.ok ? r.json() : null; }).then(function(d) { if (d) setPulse(d); }).catch(function() {}).finally(function() { setPulseLoading(false); });
  }, []);

  useEffect(function() {
    setSniperLoading(true);
    fetch("/api/sniper-feed?limit=5")
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (!data) return;
        const raw: any[] = data.deals ?? data.rows ?? [];
        setSniperRows(raw.slice(0, 5).map(function(r: any) {
          const price = r.lowAsk ?? r.price ?? 0;
          const fmv = r.adjustedFmv ?? r.fmv ?? 0;
          const pct = fmv > 0 && price > 0 ? Math.round(((price - fmv) / fmv) * 100) : 0;
          return { player: r.playerName ?? r.player ?? "Unknown", set: r.setName ?? r.set ?? "", serial: r.serialNumber ? "#" + r.serialNumber : "", price, fmv, pct, tier: r.tier ?? "Common" };
        }));
      })
      .catch(function() {}).finally(function() { setSniperLoading(false); });
  }, []);

  function recordSearch(query: string, queryType?: string) {
    if (!ownerKey || !query.trim()) return;
    fetch("/api/profile/recent-searches", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ownerKey, query: query.trim(), queryType }) })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(d) { if (!d?.search) return; setRecentSearches(function(prev) { return [d.search, ...prev.filter(function(s) { return s.query !== query.trim(); })].slice(0, 20); }); })
      .catch(function() {});
  }

  function handleSearch(val: string) {
    const q = val.trim();
    if (!q) return;
    recordSearch(q);
    router.push("/wallet?q=" + encodeURIComponent(q));
  }

  async function handleAddWallet(input: string) {
    if (!ownerKey) { alert("Set your Profile Key first."); return; }
    let walletAddr = input; let username: string | undefined;
    if (!input.startsWith("0x")) {
      try { const r = await fetch("/api/user-resolve?username=" + encodeURIComponent(input)); if (r.ok) { const d = await r.json(); if (d.address) { walletAddr = d.address; username = input; } } } catch {}
    }
    const r = await fetch("/api/profile/saved-wallets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ownerKey, walletAddr, username, accentColor: pickAccent(savedWallets.length) }) });
    if (!r.ok) return;
    const d = await r.json();
    if (d.wallet) setSavedWallets(function(prev) { return [d.wallet, ...prev.filter(function(w) { return w.wallet_addr !== walletAddr; })]; });
    setShowAddWallet(false);
  }

  async function handleRemoveWallet(walletAddr: string) {
    if (!ownerKey) return;
    await fetch("/api/profile/saved-wallets", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ownerKey, walletAddr }) });
    setSavedWallets(function(prev) { return prev.filter(function(w) { return w.wallet_addr !== walletAddr; }); });
  }

  function handleLoadWallet(addr: string, username?: string) {
    const q = username ?? addr;
    recordSearch(q, "wallet");
    router.push("/wallet?q=" + encodeURIComponent(q));
  }

  async function handleRemoveTrophy(slot: number) {
    if (!ownerKey) return;
    await fetch("/api/profile/trophy", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ownerKey, slot }) });
    setTrophies(function(prev) { const next = [...prev]; next[slot - 1] = null; return next; });
  }

  function handleTrophyPinned(trophy: TrophyMoment) {
    setTrophies(function(prev) { const next = [...prev]; next[trophy.slot - 1] = trophy; return next; });
  }

  const totalFmv = useMemo(function() { return savedWallets.reduce(function(sum, w) { return sum + (w.cached_fmv ?? 0); }, 0); }, [savedWallets]);

  const tiles = [
    { label: "Portfolio FMV", value: totalFmv > 0 ? fmtDollars(totalFmv) : "—", sub: savedWallets.length + " wallet" + (savedWallets.length !== 1 ? "s" : ""), change: "Updated", up: true, icon: "◈", color: "#E03A2F" },
    { label: "Trophy Case", value: trophies.filter(Boolean).length + " / " + MAX_SLOTS, sub: "pinned moments", change: "Your best", up: true, icon: "🏆", color: "#F59E0B" },
    { label: "Live Deals", value: sniperLoading ? "…" : (sniperRows.length + " below FMV"), sub: "sniper preview", change: "Live", up: true, icon: "⚡", color: "#34D399" },
    { label: "Searches", value: String(recentSearches.length), sub: "saved queries", change: "Synced", up: true, icon: "⌕", color: "#3B82F6" },
  ];

  const navItems = [
    { label: "Wallet", href: "/wallet" },
    { label: "Packs", href: "/packs" },
    { label: "Sniper", href: "/sniper" },
    { label: "Badges", href: "/badges" },
    { label: "Sets", href: "/sets" },
    { label: "Profile", href: "/profile", active: true },
  ];

  const quickLinks = [
    { label: "Wallet Analyzer", desc: "FMV · Flowty asks · badge intel", icon: "◈", href: "/wallet", color: "#E03A2F" },
    { label: "Pack EV", desc: "Expected value vs price", icon: "▣", href: "/packs", color: "#F59E0B" },
    { label: "Sniper", desc: "Real-time deals below FMV", icon: "⚡", href: "/sniper", color: "#34D399" },
    { label: "Badge Tracker", desc: "Debut · Fresh · Rookie Year", icon: "⭐", href: "/badges", color: "#818CF8" },
    { label: "Set Tracker", desc: "Completion + bottleneck finder", icon: "◉", href: "/sets", color: "#F472B6" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: "#080808", color: "#fff" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;600;700;800;900&family=Share+Tech+Mono&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        @keyframes ticker{from{transform:translateX(0)}to{transform:translateX(-50%)}}
        @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.35}}
        input::placeholder{color:rgba(255,255,255,0.25)!important;}
        ::-webkit-scrollbar{width:4px}
        ::-webkit-scrollbar-track{background:#111}
        ::-webkit-scrollbar-thumb{background:rgba(224,58,47,0.3);border-radius:2px}
        @media(max-width:768px){
          .rpc-main{padding:16px 16px 60px!important;}
          .rpc-nav-links{display:none!important;}
          .rpc-hero h1{font-size:26px!important;}
          .rpc-grid-4{grid-template-columns:1fr 1fr!important;}
          .rpc-grid-5{grid-template-columns:1fr 1fr!important;}
          .rpc-layout{grid-template-columns:1fr!important;}
          .rpc-trophy-grid{grid-template-columns:1fr 1fr 1fr!important;}
          .rpc-sets-activity{grid-template-columns:1fr!important;}
          .rpc-quick-links{grid-template-columns:1fr 1fr!important;}
        }
      `}</style>

      <Suspense fallback={null}>
        <PinParamReader trophies={trophies} onPinRequest={handlePinRequest} />
      </Suspense>

      {pinModal !== null && (
        <PinModal slot={pinModal.slot} ownerKey={ownerKey} prefilled={pinModal.prefilled} onClose={function() { setPinModal(null); }} onPinned={handleTrophyPinned} />
      )}

      <Ticker />

      {/* NAV */}
      <header style={{ background: "rgba(8,8,8,0.97)", borderBottom: "1px solid rgba(255,255,255,0.06)", position: "sticky", top: 0, zIndex: 100, backdropFilter: "blur(20px)" }}>
        <div style={{ maxWidth: 1440, margin: "0 auto", padding: "0 20px", height: 56, display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0, cursor: "pointer" }} onClick={function() { router.push("/"); }}>
            <svg width="28" height="28" viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="46" fill="none" stroke="#E03A2F" strokeWidth="4" />
              <path d="M50 50 L50 8 A18 18 0 0 1 72 32 Z" fill="#E03A2F" transform="rotate(0 50 50)" />
              <path d="M50 50 L50 8 A18 18 0 0 1 72 32 Z" fill="#E03A2F" transform="rotate(72 50 50)" />
              <path d="M50 50 L50 8 A18 18 0 0 1 72 32 Z" fill="#E03A2F" transform="rotate(144 50 50)" />
              <path d="M50 50 L50 8 A18 18 0 0 1 72 32 Z" fill="#E03A2F" transform="rotate(216 50 50)" />
              <path d="M50 50 L50 8 A18 18 0 0 1 72 32 Z" fill="#E03A2F" transform="rotate(288 50 50)" />
              <circle cx="50" cy="50" r="7" fill="#080808" />
            </svg>
            <div>
              <div style={{ fontFamily: condensedFont, fontWeight: 900, fontSize: 17, letterSpacing: "0.06em", color: "#F1F1F1", lineHeight: 1, textTransform: "uppercase" }}>{"Rip Packs "}<span style={{ color: "#E03A2F" }}>City</span></div>
              <div style={{ fontSize: 7, fontFamily: monoFont, letterSpacing: "0.2em", color: "rgba(224,58,47,0.5)" }}>@RIPPACKSCITY</div>
            </div>
          </div>
          <div style={{ flex: 1, position: "relative", maxWidth: 440 }}>
            <input value={heroSearch} onChange={function(e) { setHeroSearch(e.target.value); }} onKeyDown={function(e) { if (e.key === "Enter" && heroSearch.trim()) handleSearch(heroSearch); }} placeholder="Search wallet, player, edition…" style={{ width: "100%", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, padding: "7px 34px 7px 14px", color: "#fff", fontFamily: monoFont, fontSize: 11, outline: "none" }} onFocus={function(e) { e.target.style.borderColor = "rgba(224,58,47,0.5)"; }} onBlur={function(e) { e.target.style.borderColor = "rgba(255,255,255,0.1)"; }} />
            <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", color: "rgba(255,255,255,0.3)", fontSize: 14, pointerEvents: "none" }}>⌕</span>
          </div>
          {/* Avatar in nav when signed in */}
          {ownerKey && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <Avatar ownerKey={ownerKey} bio={bio} size={30} fontSize={11} />
              <span style={{ fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.5)", display: "none" }}>{ownerKey}</span>
            </div>
          )}
          <nav className="rpc-nav-links" style={{ display: "flex", gap: 3, flexShrink: 0 }}>
            {navItems.map(function(item) {
              const active = item.active ?? false;
              return <button key={item.label} onClick={function() { router.push(item.href); }} style={{ background: active ? "rgba(224,58,47,0.15)" : "transparent", border: active ? "1px solid rgba(224,58,47,0.4)" : "1px solid transparent", color: active ? "#E03A2F" : "rgba(255,255,255,0.5)", padding: "4px 10px", borderRadius: 4, fontSize: 10, fontFamily: condensedFont, fontWeight: 700, letterSpacing: "0.08em", cursor: "pointer", textTransform: "uppercase", transition: "all 0.15s" }}>{item.label}</button>;
            })}
          </nav>
        </div>
      </header>

      <main className="rpc-main" style={{ maxWidth: 1440, margin: "0 auto", padding: "24px 24px 60px" }}>

        {/* HERO */}
        <section className="rpc-hero" style={{ marginBottom: 20, textAlign: "center" }}>
          <div style={{ maxWidth: 560, margin: "0 auto" }}>
            <div style={Object.assign({}, labelStyle, { marginBottom: 8 })}>◈ COLLECTOR INTELLIGENCE PLATFORM ◈</div>
            <h1 style={{ fontFamily: condensedFont, fontWeight: 900, fontSize: 32, letterSpacing: "0.04em", color: "#fff", textTransform: "uppercase", lineHeight: 1, marginBottom: 16 }}>
              {"Rip Packs "}<span style={{ color: "#E03A2F" }}>City</span>
            </h1>
            <div style={{ display: "flex", gap: 8, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 10, padding: "8px 8px 8px 16px", alignItems: "center" }}>
              <input value={heroSearch} onChange={function(e) { setHeroSearch(e.target.value); }} onKeyDown={function(e) { if (e.key === "Enter" && heroSearch.trim()) handleSearch(heroSearch); }} placeholder="Enter any Top Shot username or wallet address…" style={{ flex: 1, background: "transparent", border: "none", color: "#fff", fontFamily: monoFont, fontSize: 12, outline: "none" }} />
              <button onClick={function() { if (heroSearch.trim()) handleSearch(heroSearch); }} style={{ background: "#E03A2F", border: "none", borderRadius: 7, padding: "8px 20px", color: "#fff", fontFamily: condensedFont, fontWeight: 800, fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer", flexShrink: 0 }} onMouseEnter={function(e) { e.currentTarget.style.background = "#c42e24"; }} onMouseLeave={function(e) { e.currentTarget.style.background = "#E03A2F"; }}>Search</button>
            </div>
          </div>
        </section>

        {/* SIGN IN BANNER */}
        {!ownerKey && (
          <SignInBanner onSetKey={function(key) { setOwnerKey(key); loadProfile(key); }} />
        )}

        <MarketPulseWidget pulse={pulse} loading={pulseLoading} />
        {ownerKey && <BioWidget ownerKey={ownerKey} bio={bio} onSave={setBio} />}

        {/* STAT TILES */}
        <section style={{ marginBottom: 14 }}>
          <div className="rpc-grid-4" style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10 }}>
            {tiles.map(function(t, i) { return <StatTile key={t.label} label={t.label} value={t.value} sub={t.sub} change={t.change} up={t.up} icon={t.icon} color={t.color} delay={i * 70} />; })}
          </div>
        </section>

        {ownerKey && <PortfolioSparkline ownerKey={ownerKey} currentFmv={totalFmv} />}

        {/* TROPHY CASE */}
        <section style={{ marginBottom: 18 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={labelStyle}>🏆 Trophy Case</span>
              {ownerKey && (
                <button onClick={function() { navigator.clipboard.writeText(window.location.origin + "/profile/" + ownerKey).then(function() { alert("Profile link copied!"); }); }} style={Object.assign({}, btnBase, { fontSize: 9, background: "rgba(245,158,11,0.1)", color: "#F59E0B", borderColor: "rgba(245,158,11,0.3)" })}>
                  🔗 Share Profile
                </button>
              )}
            </div>
            <span style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.25)" }}>
              {trophies.filter(Boolean).length + " / " + MAX_SLOTS}
            </span>
          </div>
          <div className="rpc-trophy-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14 }}>
            {trophies.map(function(trophy, i) {
              return <TrophySlot key={i} slot={i + 1} trophy={trophy} ownerKey={ownerKey} onPin={function(slot) { setPinModal({ slot, prefilled: null }); }} onRemove={handleRemoveTrophy} />;
            })}
          </div>
        </section>

        {/* SETS + ACTIVITY */}
        {savedWallets.length > 0 && (
          <div className="rpc-sets-activity" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
            <SetsProgressWidget savedWallets={savedWallets} />
            <ActivityFeed savedWallets={savedWallets} />
          </div>
        )}

        {/* SAVED WALLETS + SNIPER */}
        <div className="rpc-layout" style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 14, marginBottom: 14 }}>
          <section>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={labelStyle}>Saved Wallets</span>
                <span style={{ background: "rgba(224,58,47,0.15)", border: "1px solid rgba(224,58,47,0.3)", color: "#E03A2F", fontSize: 9, fontFamily: monoFont, padding: "1px 6px", borderRadius: 3 }}>{savedWallets.length}</span>
              </div>
              <button onClick={function() { setShowAddWallet(function(v) { return !v; }); }} style={Object.assign({}, btnBase, showAddWallet ? { background: "rgba(224,58,47,0.15)", color: "#E03A2F", borderColor: "rgba(224,58,47,0.4)" } : {})}>
                {showAddWallet ? "Cancel" : "+ Add"}
              </button>
            </div>
            {showAddWallet && <AddWalletForm onAdd={handleAddWallet} onCancel={function() { setShowAddWallet(false); }} />}
            {!ownerKey ? (
              <div style={{ fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.25)", textAlign: "center", padding: "28px 16px", border: "1px dashed rgba(255,255,255,0.1)", borderRadius: 8, lineHeight: 1.7 }}>Sign in above to save wallets across sessions.</div>
            ) : profileLoading ? (
              <div style={{ fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.3)", textAlign: "center", padding: "24px 0" }}>Loading…</div>
            ) : savedWallets.length === 0 ? (
              <div style={{ fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.25)", textAlign: "center", padding: "28px 16px", border: "1px dashed rgba(255,255,255,0.1)", borderRadius: 8, lineHeight: 1.7 }}>No saved wallets yet.<br />Click + Add to pin one.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {savedWallets.map(function(w) { return <WalletCard key={w.id} wallet={w} onLoad={handleLoadWallet} onRemove={handleRemoveWallet} />; })}
              </div>
            )}
          </section>

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {/* Sniper */}
            <section style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 10, overflow: "hidden" }}>
              <div style={{ padding: "12px 14px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#34D399", animation: "pulse 2s infinite" }} />
                  <span style={labelStyle}>Live Sniper — Below FMV</span>
                </div>
                <button onClick={function() { router.push("/sniper"); }} style={Object.assign({}, btnBase, { background: "rgba(52,211,153,0.1)", color: "#34D399", borderColor: "rgba(52,211,153,0.25)", fontSize: 9 })}>{"Full Sniper →"}</button>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 80px 60px 60px 62px", padding: "7px 14px", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                {["Moment", "Tier", "Ask", "FMV", "Disc%"].map(function(h, i) { return <span key={h} style={{ fontSize: 8, fontFamily: monoFont, color: "rgba(255,255,255,0.25)", letterSpacing: "0.15em", textAlign: i === 0 ? "left" : "right" }}>{h}</span>; })}
              </div>
              {sniperLoading ? (
                <div style={{ padding: "20px", fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.3)", textAlign: "center" }}>Loading…</div>
              ) : sniperRows.length === 0 ? (
                <div style={{ padding: "20px", fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.25)", textAlign: "center" }}>No deals loaded.</div>
              ) : sniperRows.map(function(row, i) {
                const tc = tierColor(row.tier);
                return (
                  <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 80px 60px 60px 62px", alignItems: "center", padding: "9px 14px", borderBottom: "1px solid rgba(255,255,255,0.04)", cursor: "pointer", transition: "background 0.15s" }} onMouseEnter={function(e) { e.currentTarget.style.background = "rgba(255,255,255,0.03)"; }} onMouseLeave={function(e) { e.currentTarget.style.background = "transparent"; }} onClick={function() { router.push("/sniper"); }}>
                    <div>
                      <div style={{ fontSize: 12, fontFamily: condensedFont, fontWeight: 700, color: "#fff" }}>{row.player}</div>
                      <div style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.35)" }}>{row.set + " · " + row.serial}</div>
                    </div>
                    <span style={{ fontSize: 8, fontFamily: monoFont, color: tc, background: tc + "18", border: "1px solid " + tc + "33", padding: "2px 5px", borderRadius: 3, textAlign: "center" }}>{row.tier.toUpperCase()}</span>
                    <span style={{ fontSize: 12, fontFamily: condensedFont, fontWeight: 700, color: "#fff", textAlign: "right" }}>{fmtDollars(row.price)}</span>
                    <span style={{ fontSize: 11, fontFamily: monoFont, color: "rgba(255,255,255,0.4)", textAlign: "right" }}>{fmtDollars(row.fmv)}</span>
                    <span style={{ fontSize: 11, fontFamily: monoFont, fontWeight: 700, color: "#34D399", textAlign: "right" }}>{row.pct + "%"}</span>
                  </div>
                );
              })}
            </section>

            {/* Recent Searches */}
            <section style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 10, padding: "14px 16px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <span style={labelStyle}>Recent Searches</span>
                {recentSearches.length > 0 && <span style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.25)" }}>{recentSearches.length + " / 20"}</span>}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                {recentSearches.length === 0 ? (
                  <span style={{ fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.25)" }}>{ownerKey ? "No searches yet" : "Sign in above to track searches"}</span>
                ) : recentSearches.map(function(s, i) {
                  const tc = typeColor(s.query_type);
                  return (
                    <button key={i} onClick={function() { handleSearch(s.query); }} style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 5, padding: "5px 10px", color: "rgba(255,255,255,0.65)", fontFamily: monoFont, fontSize: 10, cursor: "pointer", display: "flex", alignItems: "center", gap: 7, transition: "all 0.15s" }} onMouseEnter={function(e) { e.currentTarget.style.background = "rgba(224,58,47,0.1)"; e.currentTarget.style.borderColor = "rgba(224,58,47,0.3)"; e.currentTarget.style.color = "#fff"; }} onMouseLeave={function(e) { e.currentTarget.style.background = "rgba(255,255,255,0.04)"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)"; e.currentTarget.style.color = "rgba(255,255,255,0.65)"; }}>
                      <span style={{ fontSize: 8, color: tc, fontWeight: 700, textTransform: "uppercase" }}>{s.query_type}</span>
                      {s.query}
                      <span style={{ color: "rgba(255,255,255,0.25)", fontSize: 9 }}>{relTime(s.searched_at)}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          </div>
        </div>

        {/* QUICK LINKS */}
        <section style={{ marginBottom: 20 }}>
          <div className="rpc-quick-links" style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 10 }}>
            {quickLinks.map(function(link) {
              return (
                <button key={link.label} onClick={function() { router.push(link.href); }} style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 8, padding: "14px 16px", textAlign: "left", cursor: "pointer", transition: "all 0.2s", position: "relative", overflow: "hidden" }} onMouseEnter={function(e) { e.currentTarget.style.background = "rgba(255,255,255,0.05)"; e.currentTarget.style.borderColor = link.color + "44"; e.currentTarget.style.transform = "translateY(-2px)"; }} onMouseLeave={function(e) { e.currentTarget.style.background = "rgba(255,255,255,0.025)"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.07)"; e.currentTarget.style.transform = "translateY(0)"; }}>
                  <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 2, background: link.color, opacity: 0.5 }} />
                  <div style={{ fontSize: 18, marginBottom: 7, color: link.color }}>{link.icon}</div>
                  <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 13, color: "#fff", letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 3 }}>{link.label}</div>
                  <div style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.35)" }}>{link.desc}</div>
                </button>
              );
            })}
          </div>
        </section>

        {/* PROFILE KEY — secondary */}
        <section style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 10, padding: "16px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
            <div>
              <span style={labelStyle}>Set Up Your Rip Packs City Profile</span>
              <div style={{ fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.3)", marginTop: 4 }}>
                {ownerKey ? ("Signed in as: " + ownerKey + "  ·  Public: rip-packs-city.vercel.app/profile/" + ownerKey) : "Enter your Top Shot username to unlock the full profile experience."}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input value={ownerInput} onChange={function(e) { setOwnerInput(e.target.value); }} onKeyDown={function(e) { if (e.key === "Enter" && ownerInput.trim()) { setOwnerKey(ownerInput.trim()); loadProfile(ownerInput.trim()); } }} placeholder={ownerKey ? ownerKey : "your username…"} style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6, padding: "6px 12px", color: "#fff", fontFamily: monoFont, fontSize: 11, outline: "none", width: 200 }} />
              <button onClick={function() { if (ownerInput.trim()) { setOwnerKey(ownerInput.trim()); loadProfile(ownerInput.trim()); } }} style={Object.assign({}, btnBase, { background: "#E03A2F", color: "#fff", borderColor: "#E03A2F" })}>
                {ownerKey ? "Update" : "Sign In"}
              </button>
              {ownerKey && (
                <button onClick={function() { setOwnerKey(""); setOwnerKeyState(""); setSavedWallets([]); setRecentSearches([]); setTrophies([null, null, null]); setBio(null); }} style={Object.assign({}, btnBase, { fontSize: 9 })}>Sign Out</button>
              )}
            </div>
          </div>
        </section>

      </main>
    </div>
  );
}