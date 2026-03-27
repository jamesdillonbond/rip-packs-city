"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";

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
  cache_updated_at: string | null;
}

interface RecentSearch {
  id: number;
  query: string;
  query_type: string;
  searched_at: string;
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

interface TrophyMoment {
  id?: number;
  slot: number;
  moment_id: string;
  edition_id?: string | null;
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

// ─── CONSTANTS ────────────────────────────────────────────────
const ACCENT_CYCLE = ["#E03A2F", "#3B82F6", "#10B981", "#F59E0B", "#818CF8", "#F472B6"];
const STORAGE_KEY = "rpc_owner_key";
const MAX_SLOTS = 3;

// ─── HELPERS ──────────────────────────────────────────────────
function fmtDollars(n: number): string {
  if (n >= 1000) return "$" + (n / 1000).toFixed(1) + "K";
  return "$" + n.toFixed(0);
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

function thumbnailUrl(url: string | null): string {
  if (url) return url;
  return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Crect fill='%23111' width='200' height='200'/%3E%3C/svg%3E";
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

// ─── TROPHY SLOT COMPONENT ────────────────────────────────────
function TrophySlot(props: {
  slot: number;
  trophy: TrophyMoment | null;
  ownerKey: string;
  onPin: (slot: number) => void;
  onRemove: (slot: number) => void;
  isOwner: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const [videoError, setVideoError] = useState(false);
  const t = props.trophy;
  const tc = tierColor(t?.tier ?? null);

  const slotLabels = ["", "🥇 SLOT 1", "🥈 SLOT 2", "🥉 SLOT 3"];

  if (!t) {
    // Empty slot
    return (
      <div
        style={{
          background: "rgba(255,255,255,0.02)",
          border: "1px dashed rgba(255,255,255,0.12)",
          borderRadius: 10,
          aspectRatio: "3/4",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          cursor: props.isOwner ? "pointer" : "default",
          transition: "all 0.2s",
        }}
        onMouseEnter={function(e) {
          if (props.isOwner) e.currentTarget.style.borderColor = "rgba(224,58,47,0.4)";
        }}
        onMouseLeave={function(e) {
          e.currentTarget.style.borderColor = "rgba(255,255,255,0.12)";
        }}
        onClick={function() { if (props.isOwner) props.onPin(props.slot); }}
      >
        <div style={{ fontSize: 28, opacity: 0.2 }}>🏆</div>
        <div style={Object.assign({}, labelStyle, { textAlign: "center" })}>
          {slotLabels[props.slot]}
        </div>
        {props.isOwner && (
          <div style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.2)", textAlign: "center", padding: "0 12px" }}>
            Click to pin a moment
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      style={{
        position: "relative",
        borderRadius: 10,
        overflow: "hidden",
        aspectRatio: "3/4",
        border: "1px solid " + tc + "44",
        cursor: "pointer",
        transition: "all 0.2s",
        transform: hovered ? "translateY(-3px)" : "translateY(0)",
        boxShadow: hovered ? "0 12px 40px " + tc + "22" : "none",
      }}
      onMouseEnter={function() { setHovered(true); }}
      onMouseLeave={function() { setHovered(false); }}
    >
      {/* Thumbnail / Video */}
      <div style={{ position: "absolute", inset: 0, background: "#111" }}>
        {t.video_url && !videoError && hovered ? (
          <video
            src={t.video_url}
            autoPlay
            muted
            loop
            playsInline
            onError={function() { setVideoError(true); }}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : (
          <img
            src={thumbnailUrl(t.thumbnail_url)}
            alt={t.player_name ?? "Moment"}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
            onError={function(e) { e.currentTarget.style.opacity = "0.3"; }}
          />
        )}
      </div>

      {/* Gradient overlay */}
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to top, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.3) 50%, transparent 100%)" }} />

      {/* Tier badge top-left */}
      <div style={{ position: "absolute", top: 10, left: 10 }}>
        <span style={{ fontSize: 8, fontFamily: monoFont, color: tc, background: tc + "22", border: "1px solid " + tc + "44", padding: "2px 6px", borderRadius: 3, letterSpacing: "0.1em" }}>
          {(t.tier ?? "COMMON").toUpperCase()}
        </span>
      </div>

      {/* Slot label top-right */}
      <div style={{ position: "absolute", top: 10, right: 10 }}>
        <span style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.5)" }}>
          {slotLabels[props.slot]}
        </span>
      </div>

      {/* Remove button (owner only, on hover) */}
      {props.isOwner && hovered && (
        <button
          onClick={function(e) { e.stopPropagation(); props.onRemove(props.slot); }}
          style={{ position: "absolute", top: 8, right: 8, background: "rgba(0,0,0,0.7)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: "50%", width: 22, height: 22, color: "rgba(255,255,255,0.6)", fontSize: 10, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}
        >
          ✕
        </button>
      )}

      {/* Info bottom */}
      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "12px 12px 14px" }}>
        <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 15, color: "#fff", letterSpacing: "0.04em", lineHeight: 1.1, marginBottom: 4 }}>
          {t.player_name ?? "Unknown"}
        </div>
        <div style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.5)", marginBottom: 6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {t.set_name ?? ""}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 11, fontFamily: condensedFont, fontWeight: 700, color: tc }}>
            {t.serial_number != null ? ("#" + t.serial_number + " / " + (t.circulation_count ?? "?")) : ""}
          </span>
          {t.fmv != null && (
            <span style={{ fontSize: 10, fontFamily: monoFont, color: "#34D399" }}>
              {fmtDollars(t.fmv)}
            </span>
          )}
        </div>
        {(t.badges ?? []).length > 0 && (
          <div style={{ display: "flex", gap: 3, marginTop: 5, flexWrap: "wrap" }}>
            {(t.badges ?? []).slice(0, 3).map(function(b, i) {
              return <span key={i} style={{ fontSize: 10 }}>{b}</span>;
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── PIN MODAL ────────────────────────────────────────────────
function PinModal(props: {
  slot: number;
  ownerKey: string;
  onClose: () => void;
  onPinned: (trophy: TrophyMoment) => void;
}) {
  const [searchVal, setSearchVal] = useState("");
  const [momentIdInput, setMomentIdInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<TrophyMoment | null>(null);

  async function handleLookup() {
    const input = momentIdInput.trim() || searchVal.trim();
    if (!input) return;
    setLoading(true);
    setError("");
    setPreview(null);

    try {
      // Use the existing wallet-search approach: resolve by username or moment ID
      // Try user-resolve first if it looks like a username
      let resolvedData: any = null;

      // Direct moment ID lookup via sniper-feed metadata or market-snapshot
      const res = await fetch("/api/market-snapshot?momentId=" + encodeURIComponent(input));
      if (res.ok) {
        resolvedData = await res.json();
      }

      if (!resolvedData) {
        setError("Could not find that moment. Try a different moment ID.");
        return;
      }

      const draft: TrophyMoment = {
        slot: props.slot,
        moment_id: input,
        edition_id: resolvedData.editionId ?? null,
        player_name: resolvedData.playerName ?? resolvedData.player ?? null,
        set_name: resolvedData.setName ?? resolvedData.set ?? null,
        serial_number: resolvedData.serialNumber ?? null,
        circulation_count: resolvedData.circulationCount ?? null,
        tier: resolvedData.tier ?? null,
        thumbnail_url: resolvedData.thumbnailUrl ?? resolvedData.thumbnail ?? null,
        video_url: resolvedData.videoUrl ?? resolvedData.video ?? null,
        fmv: resolvedData.fmv ?? resolvedData.adjustedFmv ?? null,
        badges: resolvedData.badges ?? null,
      };
      setPreview(draft);
    } catch {
      setError("Lookup failed. Check the moment ID and try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirmPin() {
    if (!preview) return;
    setLoading(true);
    try {
      const res = await fetch("/api/profile/trophy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerKey: props.ownerKey,
          slot: props.slot,
          momentId: preview.moment_id,
          editionId: preview.edition_id,
          playerName: preview.player_name,
          setName: preview.set_name,
          serialNumber: preview.serial_number,
          circulationCount: preview.circulation_count,
          tier: preview.tier,
          thumbnailUrl: preview.thumbnail_url,
          videoUrl: preview.video_url,
          fmv: preview.fmv,
          badges: preview.badges,
        }),
      });
      if (!res.ok) throw new Error("Failed to pin");
      const d = await res.json();
      props.onPinned(d.trophy);
      props.onClose();
    } catch {
      setError("Failed to save trophy. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 999, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ background: "#111", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, padding: 24, width: "100%", maxWidth: 480, animation: "fadeIn 0.2s ease both" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 18, color: "#fff", letterSpacing: "0.05em", textTransform: "uppercase" }}>
            {"Pin to Slot " + props.slot}
          </div>
          <button onClick={props.onClose} style={Object.assign({}, btnBase, { fontSize: 12, padding: "4px 8px" })}>✕</button>
        </div>

        <div style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.4)", marginBottom: 14, lineHeight: 1.6 }}>
          Enter a Top Shot moment ID to pin it to your Trophy Case. You can find moment IDs in the URL on NBA Top Shot (e.g. /moment/12345678).
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          <input
            value={momentIdInput}
            onChange={function(e) { setMomentIdInput(e.target.value); }}
            onKeyDown={function(e) { if (e.key === "Enter") handleLookup(); }}
            placeholder="Moment ID (e.g. 12345678)…"
            style={{ flex: 1, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6, padding: "8px 12px", color: "#fff", fontFamily: monoFont, fontSize: 11, outline: "none", letterSpacing: "0.04em" }}
          />
          <button
            onClick={handleLookup}
            disabled={loading}
            style={Object.assign({}, btnBase, { background: "#E03A2F", color: "#fff", borderColor: "#E03A2F", padding: "8px 16px", fontSize: 11, opacity: loading ? 0.6 : 1 })}
          >
            {loading ? "…" : "Look Up"}
          </button>
        </div>

        {error && (
          <div style={{ fontSize: 10, fontFamily: monoFont, color: "#F87171", marginBottom: 12 }}>{error}</div>
        )}

        {preview && (
          <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: 14, marginBottom: 16 }}>
            <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 16, color: "#fff", marginBottom: 4 }}>{preview.player_name ?? "Unknown"}</div>
            <div style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.4)", marginBottom: 8 }}>{preview.set_name ?? ""}</div>
            <div style={{ display: "flex", gap: 16 }}>
              {preview.serial_number != null && (
                <div>
                  <div style={Object.assign({}, labelStyle, { marginBottom: 2 })}>Serial</div>
                  <div style={{ fontSize: 13, fontFamily: condensedFont, fontWeight: 700, color: tierColor(preview.tier) }}>{"#" + preview.serial_number}</div>
                </div>
              )}
              {preview.tier && (
                <div>
                  <div style={Object.assign({}, labelStyle, { marginBottom: 2 })}>Tier</div>
                  <div style={{ fontSize: 13, fontFamily: condensedFont, fontWeight: 700, color: tierColor(preview.tier) }}>{preview.tier}</div>
                </div>
              )}
              {preview.fmv != null && (
                <div>
                  <div style={Object.assign({}, labelStyle, { marginBottom: 2 })}>FMV</div>
                  <div style={{ fontSize: 13, fontFamily: condensedFont, fontWeight: 700, color: "#34D399" }}>{fmtDollars(preview.fmv)}</div>
                </div>
              )}
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={props.onClose} style={Object.assign({}, btnBase, { padding: "8px 16px", fontSize: 11 })}>Cancel</button>
          <button
            onClick={handleConfirmPin}
            disabled={!preview || loading}
            style={Object.assign({}, btnBase, { background: preview ? "#E03A2F" : "rgba(255,255,255,0.05)", color: preview ? "#fff" : "rgba(255,255,255,0.3)", borderColor: preview ? "#E03A2F" : "rgba(255,255,255,0.1)", padding: "8px 16px", fontSize: 11, opacity: loading ? 0.6 : 1 })}
          >
            {loading ? "Saving…" : "Pin to Trophy Case"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── SHARED SUB-COMPONENTS ────────────────────────────────────
function Ticker() {
  const items = [
    "WALLET ANALYZER — FMV + Flowty asks + badge intel",
    "PACK EV CALCULATOR — expected value vs price",
    "SNIPER — real-time deals below FMV",
    "BADGE TRACKER — Top Shot Debut · Fresh · Rookie Year",
    "PROFILE — saved wallets · trophy case · search history",
  ];
  const doubled = [...items, ...items];
  return (
    <div style={{ background: "#0D0D0D", borderBottom: "1px solid rgba(224,58,47,0.2)", overflow: "hidden", height: 28, display: "flex", alignItems: "center" }}>
      <div style={{ background: "#E03A2F", padding: "0 12px", fontSize: 9, fontFamily: monoFont, letterSpacing: "0.15em", color: "#fff", height: "100%", display: "flex", alignItems: "center", flexShrink: 0, fontWeight: 700 }}>LIVE</div>
      <div style={{ overflow: "hidden", flex: 1 }}>
        <div style={{ display: "flex", gap: 64, animation: "ticker 38s linear infinite", whiteSpace: "nowrap", paddingLeft: 24 }}>
          {doubled.map(function(item, i) {
            return <span key={i} style={{ fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.45)", letterSpacing: "0.07em" }}>{"⚡ " + item}</span>;
          })}
        </div>
      </div>
    </div>
  );
}

function StatTile(props: { label: string; value: string; sub: string; change: string; up: boolean; icon: string; color: string; delay: number }) {
  const [vis, setVis] = useState(false);
  useEffect(function() {
    const t = setTimeout(function() { setVis(true); }, props.delay);
    return function() { clearTimeout(t); };
  }, [props.delay]);
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

function WalletCard(props: { wallet: SavedWallet; onLoad: (addr: string, user?: string) => void; onRemove: (addr: string) => void }) {
  const [hovered, setHovered] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const w = props.wallet;
  const label = w.display_name || w.username || (w.wallet_addr.slice(0, 10) + "…");
  const initials = label.slice(0, 2).toUpperCase();
  const changeVal = w.cached_change_24h;
  const changeColor = (changeVal != null && changeVal >= 0) ? "#34D399" : "#F87171";
  const changeStr = changeVal != null ? ((changeVal > 0 ? "+" : "") + changeVal + "%") : "—";

  return (
    <div
      style={{ background: hovered ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.025)", border: "1px solid " + (hovered ? w.accent_color + "55" : "rgba(255,255,255,0.07)"), borderRadius: 10, padding: "14px 16px", cursor: "pointer", transition: "all 0.2s", position: "relative", overflow: "hidden" }}
      onMouseEnter={function() { setHovered(true); }}
      onMouseLeave={function() { setHovered(false); setConfirm(false); }}
    >
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
          <div><div style={{ fontSize: 8, fontFamily: monoFont, color: "rgba(255,255,255,0.3)", letterSpacing: "0.12em", marginBottom: 2 }}>FMV</div><div style={{ fontSize: 13, fontFamily: condensedFont, fontWeight: 700, color: "#fff" }}>{fmtDollars(w.cached_fmv ?? 0)}</div></div>
          <div><div style={{ fontSize: 8, fontFamily: monoFont, color: "rgba(255,255,255,0.3)", letterSpacing: "0.12em", marginBottom: 2 }}>MOMENTS</div><div style={{ fontSize: 13, fontFamily: condensedFont, fontWeight: 700, color: "#fff" }}>{w.cached_moment_count ?? "—"}</div></div>
          <div><div style={{ fontSize: 8, fontFamily: monoFont, color: "rgba(255,255,255,0.3)", letterSpacing: "0.12em", marginBottom: 2 }}>24H</div><div style={{ fontSize: 13, fontFamily: condensedFont, fontWeight: 700, color: changeColor }}>{changeStr}</div></div>
        </div>
      ) : (
        <div style={{ fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.25)", marginBottom: 10 }}>Load wallet to populate stats</div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.06)" }}>
        <span style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.25)" }}>{w.last_viewed ? "Viewed " + relTime(w.last_viewed) : "Never loaded"}</span>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {confirm ? (
            <>
              <button onClick={function(e) { e.stopPropagation(); setConfirm(false); }} style={Object.assign({}, btnBase, { fontSize: 9 })}>Cancel</button>
              <button onClick={function(e) { e.stopPropagation(); props.onRemove(w.wallet_addr); }} style={Object.assign({}, btnBase, { background: "rgba(239,68,68,0.15)", color: "#F87171", borderColor: "rgba(239,68,68,0.35)", fontSize: 9 })}>Remove</button>
            </>
          ) : (
            <>
              <button onClick={function(e) { e.stopPropagation(); setConfirm(true); }} style={Object.assign({}, btnBase, { background: "transparent", border: "none", opacity: hovered ? 0.5 : 0, transition: "opacity 0.15s", fontSize: 9 })}>✕</button>
              <button onClick={function(e) { e.stopPropagation(); props.onLoad(w.wallet_addr, w.username ?? undefined); }} style={Object.assign({}, btnBase, { background: w.accent_color + "22", color: w.accent_color, borderColor: w.accent_color + "44", opacity: hovered ? 1 : 0.6, fontSize: 9 })}>{"Load Wallet →"}</button>
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
    <div style={{ display: "flex", gap: 8, marginBottom: 12, animation: "fadeIn 0.2s ease both" }}>
      <input autoFocus value={val} onChange={function(e) { setVal(e.target.value); }} onKeyDown={function(e) { if (e.key === "Enter" && val.trim()) props.onAdd(val.trim()); }} placeholder="Username or 0x address…" style={{ flex: 1, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(224,58,47,0.35)", borderRadius: 6, padding: "7px 12px", color: "#fff", fontFamily: monoFont, fontSize: 11, outline: "none", letterSpacing: "0.04em" }} />
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
  const [profileLoading, setProfileLoading] = useState(false);
  const [sniperLoading, setSniperLoading] = useState(false);
  const [heroSearch, setHeroSearch] = useState("");
  const [showAddWallet, setShowAddWallet] = useState(false);
  const [pinModalSlot, setPinModalSlot] = useState<number | null>(null);

  // Load ownerKey from localStorage
  useEffect(function() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) setOwnerKeyState(stored);
    } catch {}
  }, []);

  function setOwnerKey(key: string) {
    setOwnerKeyState(key);
    try { localStorage.setItem(STORAGE_KEY, key); } catch {}
  }

  // Load profile data
  const loadProfile = useCallback(async function(key: string) {
    if (!key) return;
    setProfileLoading(true);
    try {
      const encoded = encodeURIComponent(key);
      const [wRes, sRes, tRes] = await Promise.all([
        fetch("/api/profile/saved-wallets?ownerKey=" + encoded),
        fetch("/api/profile/recent-searches?ownerKey=" + encoded),
        fetch("/api/profile/trophy?ownerKey=" + encoded),
      ]);
      if (wRes.ok) { const d = await wRes.json(); setSavedWallets(d.wallets ?? []); }
      if (sRes.ok) { const d = await sRes.json(); setRecentSearches(d.searches ?? []); }
      if (tRes.ok) {
        const d = await tRes.json();
        const slots: (TrophyMoment | null)[] = [null, null, null];
        (d.trophies ?? []).forEach(function(t: TrophyMoment) {
          if (t.slot >= 1 && t.slot <= 3) slots[t.slot - 1] = t;
        });
        setTrophies(slots);
      }
    } catch (err) {
      console.error("[profile load]", err);
    } finally {
      setProfileLoading(false);
    }
  }, []);

  useEffect(function() {
    if (ownerKey) loadProfile(ownerKey);
  }, [ownerKey, loadProfile]);

  // Load sniper preview
  useEffect(function() {
    setSniperLoading(true);
    fetch("/api/sniper-feed?limit=5")
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (!data) return;
        const raw: any[] = data.deals ?? data.rows ?? [];
        const rows: SniperRow[] = raw.slice(0, 5).map(function(r: any) {
          const price = r.lowAsk ?? r.price ?? 0;
          const fmv = r.adjustedFmv ?? r.fmv ?? 0;
          const pct = fmv > 0 && price > 0 ? Math.round(((price - fmv) / fmv) * 100) : 0;
          return { player: r.playerName ?? r.player ?? "Unknown", set: r.setName ?? r.set ?? "", serial: r.serialNumber ? "#" + r.serialNumber : "", price, fmv, pct, tier: r.tier ?? r.rarity ?? "Common" };
        });
        setSniperRows(rows);
      })
      .catch(function() {})
      .finally(function() { setSniperLoading(false); });
  }, []);

  function recordSearch(query: string, queryType?: string) {
    if (!ownerKey || !query.trim()) return;
    fetch("/api/profile/recent-searches", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ownerKey, query: query.trim(), queryType }) })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(d) {
        if (!d?.search) return;
        setRecentSearches(function(prev) { return [d.search, ...prev.filter(function(s) { return s.query !== query.trim(); })].slice(0, 20); });
      })
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
    let walletAddr = input;
    let username: string | undefined;
    if (!input.startsWith("0x")) {
      try {
        const r = await fetch("/api/user-resolve?username=" + encodeURIComponent(input));
        if (r.ok) { const d = await r.json(); if (d.address) { walletAddr = d.address; username = input; } }
      } catch {}
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
    { label: "Portfolio FMV", value: totalFmv > 0 ? fmtDollars(totalFmv) : "—", sub: savedWallets.length + " saved wallet" + (savedWallets.length !== 1 ? "s" : ""), change: "Updated", up: true, icon: "◈", color: "#E03A2F" },
    { label: "Trophy Case", value: trophies.filter(Boolean).length + " / " + MAX_SLOTS, sub: "pinned moments", change: "Your best", up: true, icon: "🏆", color: "#F59E0B" },
    { label: "Live Deals", value: sniperLoading ? "…" : (sniperRows.length + " below FMV"), sub: "Sniper feed preview", change: "Live", up: true, icon: "⚡", color: "#34D399" },
    { label: "Recent Searches", value: String(recentSearches.length), sub: "saved queries", change: "Synced", up: true, icon: "⌕", color: "#3B82F6" },
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
    { label: "Pack EV", desc: "Expected value vs price for live packs", icon: "▣", href: "/packs", color: "#F59E0B" },
    { label: "Sniper", desc: "Real-time deals below FMV", icon: "⚡", href: "/sniper", color: "#34D399" },
    { label: "Badge Tracker", desc: "Top Shot Debut · Fresh · Rookie Year", icon: "⭐", href: "/badges", color: "#818CF8" },
    { label: "Set Tracker", desc: "Completion progress + bottleneck finder", icon: "◉", href: "/sets", color: "#F472B6" },
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
      `}</style>

      {pinModalSlot !== null && (
        <PinModal
          slot={pinModalSlot}
          ownerKey={ownerKey}
          onClose={function() { setPinModalSlot(null); }}
          onPinned={handleTrophyPinned}
        />
      )}

      <Ticker />

      {/* NAV */}
      <header style={{ background: "rgba(8,8,8,0.97)", borderBottom: "1px solid rgba(255,255,255,0.06)", position: "sticky", top: 0, zIndex: 100, backdropFilter: "blur(20px)" }}>
        <div style={{ maxWidth: 1440, margin: "0 auto", padding: "0 24px", height: 56, display: "flex", alignItems: "center", gap: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0, cursor: "pointer" }} onClick={function() { router.push("/"); }}>
            <svg width="30" height="30" viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="46" fill="none" stroke="#E03A2F" strokeWidth="4" />
              <path d="M50 50 L50 8 A18 18 0 0 1 72 32 Z" fill="#E03A2F" transform="rotate(0 50 50)" />
              <path d="M50 50 L50 8 A18 18 0 0 1 72 32 Z" fill="#E03A2F" transform="rotate(72 50 50)" />
              <path d="M50 50 L50 8 A18 18 0 0 1 72 32 Z" fill="#E03A2F" transform="rotate(144 50 50)" />
              <path d="M50 50 L50 8 A18 18 0 0 1 72 32 Z" fill="#E03A2F" transform="rotate(216 50 50)" />
              <path d="M50 50 L50 8 A18 18 0 0 1 72 32 Z" fill="#E03A2F" transform="rotate(288 50 50)" />
              <circle cx="50" cy="50" r="7" fill="#080808" />
            </svg>
            <div>
              <div style={{ fontFamily: condensedFont, fontWeight: 900, fontSize: 18, letterSpacing: "0.06em", color: "#F1F1F1", lineHeight: 1, textTransform: "uppercase" }}>{"Rip Packs "}<span style={{ color: "#E03A2F" }}>City</span></div>
              <div style={{ fontSize: 7, fontFamily: monoFont, letterSpacing: "0.2em", color: "rgba(224,58,47,0.5)" }}>@RIPPACKSCITY</div>
            </div>
          </div>
          <div style={{ flex: 1, position: "relative", maxWidth: 480 }}>
            <input value={heroSearch} onChange={function(e) { setHeroSearch(e.target.value); }} onKeyDown={function(e) { if (e.key === "Enter" && heroSearch.trim()) handleSearch(heroSearch); }} placeholder="Search wallet, player, edition…" style={{ width: "100%", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, padding: "7px 34px 7px 14px", color: "#fff", fontFamily: monoFont, fontSize: 11, outline: "none", letterSpacing: "0.04em" }} onFocus={function(e) { e.target.style.borderColor = "rgba(224,58,47,0.5)"; }} onBlur={function(e) { e.target.style.borderColor = "rgba(255,255,255,0.1)"; }} />
            <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", color: "rgba(255,255,255,0.3)", fontSize: 14, pointerEvents: "none" }}>⌕</span>
          </div>
          <nav style={{ display: "flex", gap: 3, flexShrink: 0 }}>
            {navItems.map(function(item) {
              const active = item.active ?? false;
              return (
                <button key={item.label} onClick={function() { router.push(item.href); }} style={{ background: active ? "rgba(224,58,47,0.15)" : "transparent", border: active ? "1px solid rgba(224,58,47,0.4)" : "1px solid transparent", color: active ? "#E03A2F" : "rgba(255,255,255,0.5)", padding: "4px 10px", borderRadius: 4, fontSize: 10, fontFamily: condensedFont, fontWeight: 700, letterSpacing: "0.08em", cursor: "pointer", textTransform: "uppercase", transition: "all 0.15s" }}>
                  {item.label}
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      <main style={{ maxWidth: 1440, margin: "0 auto", padding: "24px 24px 60px" }}>

        {/* HERO */}
        <section style={{ marginBottom: 28, animation: "fadeIn 0.45s ease both", textAlign: "center" }}>
          <div style={{ maxWidth: 600, margin: "0 auto" }}>
            <div style={Object.assign({}, labelStyle, { marginBottom: 8 })}>◈ YOUR COMMAND CENTER ◈</div>
            <h1 style={{ fontFamily: condensedFont, fontWeight: 900, fontSize: 36, letterSpacing: "0.04em", color: "#fff", textTransform: "uppercase", lineHeight: 1, marginBottom: 16 }}>
              {"Your "}<span style={{ color: "#E03A2F" }}>Profile</span>
            </h1>
            <div style={{ display: "flex", gap: 8, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 10, padding: "8px 8px 8px 16px", alignItems: "center" }}>
              <input value={heroSearch} onChange={function(e) { setHeroSearch(e.target.value); }} onKeyDown={function(e) { if (e.key === "Enter" && heroSearch.trim()) handleSearch(heroSearch); }} placeholder="Enter any Top Shot username or wallet address…" style={{ flex: 1, background: "transparent", border: "none", color: "#fff", fontFamily: monoFont, fontSize: 12, outline: "none", letterSpacing: "0.04em" }} />
              <button onClick={function() { if (heroSearch.trim()) handleSearch(heroSearch); }} style={{ background: "#E03A2F", border: "none", borderRadius: 7, padding: "8px 20px", color: "#fff", fontFamily: condensedFont, fontWeight: 800, fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer", flexShrink: 0 }} onMouseEnter={function(e) { e.currentTarget.style.background = "#c42e24"; }} onMouseLeave={function(e) { e.currentTarget.style.background = "#E03A2F"; }}>Search</button>
            </div>
          </div>
        </section>

        {/* STAT TILES */}
        <section style={{ marginBottom: 22 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10 }}>
            {tiles.map(function(t, i) { return <StatTile key={t.label} label={t.label} value={t.value} sub={t.sub} change={t.change} up={t.up} icon={t.icon} color={t.color} delay={i * 70} />; })}
          </div>
        </section>

        {/* TROPHY CASE */}
        <section style={{ marginBottom: 22 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={labelStyle}>🏆 Trophy Case</span>
              {ownerKey && (
                <button
                  onClick={function() {
                    const shareUrl = window.location.origin + "/profile/" + ownerKey;
                    navigator.clipboard.writeText(shareUrl).then(function() { alert("Profile link copied!"); });
                  }}
                  style={Object.assign({}, btnBase, { fontSize: 9, background: "rgba(245,158,11,0.1)", color: "#F59E0B", borderColor: "rgba(245,158,11,0.3)" })}
                >
                  🔗 Share Profile
                </button>
              )}
            </div>
            <span style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.25)" }}>
              {trophies.filter(Boolean).length + " / " + MAX_SLOTS + " filled"}
            </span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14 }}>
            {trophies.map(function(trophy, i) {
              return (
                <TrophySlot
                  key={i}
                  slot={i + 1}
                  trophy={trophy}
                  ownerKey={ownerKey}
                  onPin={function(slot) { setPinModalSlot(slot); }}
                  onRemove={handleRemoveTrophy}
                  isOwner={!!ownerKey}
                />
              );
            })}
          </div>
        </section>

        {/* MAIN GRID: SAVED WALLETS + MARKET */}
        <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 14, marginBottom: 14 }}>

          {/* SAVED WALLETS */}
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
            {profileLoading ? (
              <div style={{ fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.3)", textAlign: "center", padding: "24px 0" }}>Loading…</div>
            ) : !ownerKey ? (
              <div style={{ fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.25)", textAlign: "center", padding: "28px 16px", border: "1px dashed rgba(255,255,255,0.1)", borderRadius: 8, lineHeight: 1.7 }}>Set your Profile Key below<br />to save wallets across sessions.</div>
            ) : savedWallets.length === 0 ? (
              <div style={{ fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.25)", textAlign: "center", padding: "28px 16px", border: "1px dashed rgba(255,255,255,0.1)", borderRadius: 8, lineHeight: 1.7 }}>No saved wallets yet.<br />Click + Add to pin a wallet here.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {savedWallets.map(function(w) { return <WalletCard key={w.id} wallet={w} onLoad={handleLoadWallet} onRemove={handleRemoveWallet} />; })}
              </div>
            )}
          </section>

          {/* RIGHT: SNIPER + SEARCHES */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <section style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 10, overflow: "hidden", flex: 1 }}>
              <div style={{ padding: "12px 14px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#34D399", animation: "pulse 2s infinite" }} />
                  <span style={labelStyle}>Live Sniper Feed — Below FMV</span>
                </div>
                <button onClick={function() { router.push("/sniper"); }} style={Object.assign({}, btnBase, { background: "rgba(52,211,153,0.1)", color: "#34D399", borderColor: "rgba(52,211,153,0.25)", fontSize: 9 })}>{"Full Sniper →"}</button>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 80px 60px 60px 62px", padding: "7px 14px", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                {["Moment", "Tier", "Ask", "FMV", "Disc%"].map(function(h, i) { return <span key={h} style={{ fontSize: 8, fontFamily: monoFont, color: "rgba(255,255,255,0.25)", letterSpacing: "0.15em", textAlign: i === 0 ? "left" : "right" }}>{h}</span>; })}
              </div>
              {sniperLoading ? (
                <div style={{ padding: "24px", fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.3)", textAlign: "center" }}>Loading live feed…</div>
              ) : sniperRows.length === 0 ? (
                <div style={{ padding: "24px", fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.25)", textAlign: "center" }}>No deals loaded.</div>
              ) : sniperRows.map(function(row, i) {
                const tc = tierColor(row.tier);
                return (
                  <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 80px 60px 60px 62px", alignItems: "center", padding: "9px 14px", borderBottom: "1px solid rgba(255,255,255,0.04)", cursor: "pointer", transition: "background 0.15s" }} onMouseEnter={function(e) { e.currentTarget.style.background = "rgba(255,255,255,0.03)"; }} onMouseLeave={function(e) { e.currentTarget.style.background = "transparent"; }} onClick={function() { router.push("/sniper"); }}>
                    <div>
                      <div style={{ fontSize: 12, fontFamily: condensedFont, fontWeight: 700, color: "#fff", letterSpacing: "0.03em" }}>{row.player}</div>
                      <div style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.35)" }}>{row.set + " · " + row.serial}</div>
                    </div>
                    <span style={{ fontSize: 8, fontFamily: monoFont, color: tc, background: tc + "18", border: "1px solid " + tc + "33", padding: "2px 5px", borderRadius: 3, textAlign: "center", letterSpacing: "0.05em" }}>{row.tier.toUpperCase()}</span>
                    <span style={{ fontSize: 12, fontFamily: condensedFont, fontWeight: 700, color: "#fff", textAlign: "right" }}>{fmtDollars(row.price)}</span>
                    <span style={{ fontSize: 11, fontFamily: monoFont, color: "rgba(255,255,255,0.4)", textAlign: "right" }}>{fmtDollars(row.fmv)}</span>
                    <span style={{ fontSize: 11, fontFamily: monoFont, fontWeight: 700, color: "#34D399", textAlign: "right" }}>{row.pct + "%"}</span>
                  </div>
                );
              })}
            </section>

            <section style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 10, padding: "14px 16px" }}>
              <span style={labelStyle}>Recent Searches</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginTop: 10 }}>
                {recentSearches.length === 0 ? (
                  <span style={{ fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.25)" }}>{ownerKey ? "No searches yet" : "Set your Profile Key to track searches"}</span>
                ) : recentSearches.map(function(s, i) {
                  const tc = typeColor(s.query_type);
                  return (
                    <button key={i} onClick={function() { handleSearch(s.query); }} style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 5, padding: "5px 10px", color: "rgba(255,255,255,0.65)", fontFamily: monoFont, fontSize: 10, cursor: "pointer", display: "flex", alignItems: "center", gap: 7, letterSpacing: "0.04em", transition: "all 0.15s" }} onMouseEnter={function(e) { e.currentTarget.style.background = "rgba(224,58,47,0.1)"; e.currentTarget.style.borderColor = "rgba(224,58,47,0.3)"; e.currentTarget.style.color = "#fff"; }} onMouseLeave={function(e) { e.currentTarget.style.background = "rgba(255,255,255,0.04)"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)"; e.currentTarget.style.color = "rgba(255,255,255,0.65)"; }}>
                      <span style={{ fontSize: 8, color: tc, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>{s.query_type}</span>
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
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 10 }}>
            {quickLinks.map(function(link) {
              return (
                <button key={link.label} onClick={function() { router.push(link.href); }} style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 8, padding: "14px 16px", textAlign: "left", cursor: "pointer", transition: "all 0.2s", position: "relative", overflow: "hidden" }} onMouseEnter={function(e) { e.currentTarget.style.background = "rgba(255,255,255,0.05)"; e.currentTarget.style.borderColor = link.color + "44"; e.currentTarget.style.transform = "translateY(-2px)"; }} onMouseLeave={function(e) { e.currentTarget.style.background = "rgba(255,255,255,0.025)"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.07)"; e.currentTarget.style.transform = "translateY(0)"; }}>
                  <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 2, background: link.color, opacity: 0.5 }} />
                  <div style={{ fontSize: 18, marginBottom: 7, color: link.color }}>{link.icon}</div>
                  <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 13, color: "#fff", letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 3 }}>{link.label}</div>
                  <div style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.35)", letterSpacing: "0.04em" }}>{link.desc}</div>
                </button>
              );
            })}
          </div>
        </section>

        {/* PROFILE KEY */}
        <section style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 10, padding: "16px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
            <div>
              <span style={labelStyle}>Profile Key</span>
              <div style={{ fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.3)", marginTop: 4 }}>
                {ownerKey ? ("Active: " + ownerKey) : "Set your Top Shot username to save wallets, trophy moments, and search history across sessions."}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input value={ownerInput} onChange={function(e) { setOwnerInput(e.target.value); }} onKeyDown={function(e) { if (e.key === "Enter" && ownerInput.trim()) { setOwnerKey(ownerInput.trim()); loadProfile(ownerInput.trim()); } }} placeholder="your username…" style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6, padding: "6px 12px", color: "#fff", fontFamily: monoFont, fontSize: 11, outline: "none", width: 200 }} />
              <button onClick={function() { if (ownerInput.trim()) { setOwnerKey(ownerInput.trim()); loadProfile(ownerInput.trim()); } }} style={Object.assign({}, btnBase, { background: "#E03A2F", color: "#fff", borderColor: "#E03A2F" })}>
                {ownerKey ? "Update" : "Set Key"}
              </button>
            </div>
          </div>
        </section>

      </main>
    </div>
  );
}