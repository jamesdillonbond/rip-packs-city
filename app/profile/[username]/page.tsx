"use client";

import { useState, useEffect } from "react";
import { useRouter, useParams } from "next/navigation";

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

const monoFont = "'Share Tech Mono', monospace";
const condensedFont = "'Barlow Condensed', sans-serif";

function fmtDollars(n: number): string {
  if (n >= 1000) return "$" + (n / 1000).toFixed(1) + "K";
  return "$" + n.toFixed(0);
}

function tierColor(t: string | null): string {
  if (t === "Legendary") return "#F59E0B";
  if (t === "Rare") return "#818CF8";
  return "#6B7280";
}

function thumbnailUrl(url: string | null): string {
  if (url) return url;
  return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Crect fill='%23111' width='200' height='200'/%3E%3C/svg%3E";
}

function PublicTrophySlot(props: { slot: number; trophy: TrophyMoment | null }) {
  const [hovered, setHovered] = useState(false);
  const [videoError, setVideoError] = useState(false);
  const t = props.trophy;
  const tc = tierColor(t?.tier ?? null);
  const slotLabels = ["", "🥇", "🥈", "🥉"];

  if (!t) {
    return (
      <div style={{ background: "rgba(255,255,255,0.02)", border: "1px dashed rgba(255,255,255,0.1)", borderRadius: 10, aspectRatio: "3/4", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8 }}>
        <div style={{ fontSize: 24, opacity: 0.15 }}>🏆</div>
        <div style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.2)", letterSpacing: "0.1em" }}>EMPTY SLOT</div>
      </div>
    );
  }

  return (
    <div
      style={{ position: "relative", borderRadius: 10, overflow: "hidden", aspectRatio: "3/4", border: "1px solid " + tc + "44", cursor: "default", transition: "all 0.2s", transform: hovered ? "translateY(-3px)" : "translateY(0)", boxShadow: hovered ? "0 12px 40px " + tc + "22" : "none" }}
      onMouseEnter={function() { setHovered(true); }}
      onMouseLeave={function() { setHovered(false); }}
    >
      <div style={{ position: "absolute", inset: 0, background: "#111" }}>
        {t.video_url && !videoError && hovered ? (
          <video src={t.video_url} autoPlay muted loop playsInline onError={function() { setVideoError(true); }} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <img src={thumbnailUrl(t.thumbnail_url)} alt={t.player_name ?? "Moment"} style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={function(e) { e.currentTarget.style.opacity = "0.3"; }} />
        )}
      </div>
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to top, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.3) 50%, transparent 100%)" }} />
      <div style={{ position: "absolute", top: 10, left: 10 }}>
        <span style={{ fontSize: 8, fontFamily: monoFont, color: tc, background: tc + "22", border: "1px solid " + tc + "44", padding: "2px 6px", borderRadius: 3, letterSpacing: "0.1em" }}>{(t.tier ?? "COMMON").toUpperCase()}</span>
      </div>
      <div style={{ position: "absolute", top: 10, right: 10 }}>
        <span style={{ fontSize: 14 }}>{slotLabels[props.slot]}</span>
      </div>
      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "12px 12px 14px" }}>
        <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 15, color: "#fff", letterSpacing: "0.04em", lineHeight: 1.1, marginBottom: 4 }}>{t.player_name ?? "Unknown"}</div>
        <div style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.5)", marginBottom: 6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.set_name ?? ""}</div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 11, fontFamily: condensedFont, fontWeight: 700, color: tc }}>
            {t.serial_number != null ? ("#" + t.serial_number + " / " + (t.circulation_count ?? "?")) : ""}
          </span>
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

export default function PublicProfilePage() {
  const router = useRouter();
  const params = useParams();
  const username = params?.username as string;

  const [trophies, setTrophies] = useState<(TrophyMoment | null)[]>([null, null, null]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(function() {
    if (!username) return;
    setLoading(true);
    fetch("/api/profile/trophy?username=" + encodeURIComponent(username))
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (!data) { setNotFound(true); return; }
        const slots: (TrophyMoment | null)[] = [null, null, null];
        (data.trophies ?? []).forEach(function(t: TrophyMoment) {
          if (t.slot >= 1 && t.slot <= 3) slots[t.slot - 1] = t;
        });
        if (data.trophies.length === 0) setNotFound(false);
        setTrophies(slots);
      })
      .catch(function() { setNotFound(true); })
      .finally(function() { setLoading(false); });
  }, [username]);

  const filledCount = trophies.filter(Boolean).length;

  return (
    <div style={{ minHeight: "100vh", background: "#080808", color: "#fff" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;600;700;800;900&family=Share+Tech+Mono&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        input::placeholder{color:rgba(255,255,255,0.25)!important;}
      `}</style>

      {/* NAV */}
      <header style={{ background: "rgba(8,8,8,0.97)", borderBottom: "1px solid rgba(255,255,255,0.06)", position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ maxWidth: 1440, margin: "0 auto", padding: "0 24px", height: 56, display: "flex", alignItems: "center", gap: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }} onClick={function() { router.push("/"); }}>
            <svg width="30" height="30" viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="46" fill="none" stroke="#E03A2F" strokeWidth="4" />
              <path d="M50 50 L50 8 A18 18 0 0 1 72 32 Z" fill="#E03A2F" transform="rotate(0 50 50)" />
              <path d="M50 50 L50 8 A18 18 0 0 1 72 32 Z" fill="#E03A2F" transform="rotate(72 50 50)" />
              <path d="M50 50 L50 8 A18 18 0 0 1 72 32 Z" fill="#E03A2F" transform="rotate(144 50 50)" />
              <path d="M50 50 L50 8 A18 18 0 0 1 72 32 Z" fill="#E03A2F" transform="rotate(216 50 50)" />
              <path d="M50 50 L50 8 A18 18 0 0 1 72 32 Z" fill="#E03A2F" transform="rotate(288 50 50)" />
              <circle cx="50" cy="50" r="7" fill="#080808" />
            </svg>
            <div style={{ fontFamily: condensedFont, fontWeight: 900, fontSize: 18, letterSpacing: "0.06em", color: "#F1F1F1", lineHeight: 1, textTransform: "uppercase" }}>
              {"Rip Packs "}<span style={{ color: "#E03A2F" }}>City</span>
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <button onClick={function() { router.push("/wallet?q=" + encodeURIComponent(username)); }} style={{ background: "rgba(224,58,47,0.15)", border: "1px solid rgba(224,58,47,0.4)", color: "#E03A2F", padding: "6px 16px", borderRadius: 6, fontSize: 11, fontFamily: condensedFont, fontWeight: 700, letterSpacing: "0.08em", cursor: "pointer", textTransform: "uppercase" }}>
            {"Analyze " + username + "'s Wallet →"}
          </button>
        </div>
      </header>

      <main style={{ maxWidth: 800, margin: "0 auto", padding: "48px 24px 60px", animation: "fadeIn 0.4s ease both" }}>

        {/* Profile header */}
        <div style={{ textAlign: "center", marginBottom: 40 }}>
          <div style={{ width: 64, height: 64, borderRadius: "50%", background: "rgba(224,58,47,0.15)", border: "2px solid rgba(224,58,47,0.4)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px", fontSize: 22, fontWeight: 800, color: "#E03A2F", fontFamily: condensedFont }}>
            {username ? username.slice(0, 2).toUpperCase() : "?"}
          </div>
          <h1 style={{ fontFamily: condensedFont, fontWeight: 900, fontSize: 32, letterSpacing: "0.06em", color: "#fff", textTransform: "uppercase", lineHeight: 1, marginBottom: 6 }}>
            {username}
          </h1>
          <div style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.35)", letterSpacing: "0.15em" }}>
            {"NBA TOP SHOT COLLECTOR · " + filledCount + " / 3 TROPHY MOMENTS"}
          </div>
        </div>

        {/* Trophy Case */}
        <div style={{ marginBottom: 32 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, justifyContent: "center" }}>
            <span style={{ fontSize: 9, fontFamily: monoFont, letterSpacing: "0.2em", color: "rgba(255,255,255,0.4)", textTransform: "uppercase" }}>🏆 Trophy Case</span>
          </div>

          {loading ? (
            <div style={{ textAlign: "center", fontSize: 11, fontFamily: monoFont, color: "rgba(255,255,255,0.3)", padding: "48px 0" }}>Loading…</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 16 }}>
              {trophies.map(function(trophy, i) {
                return <PublicTrophySlot key={i} slot={i + 1} trophy={trophy} />;
              })}
            </div>
          )}
        </div>

        {/* CTA */}
        <div style={{ textAlign: "center", paddingTop: 32, borderTop: "1px solid rgba(255,255,255,0.06)" }}>
          <div style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.25)", letterSpacing: "0.15em", marginBottom: 12 }}>POWERED BY RIP PACKS CITY</div>
          <button onClick={function() { router.push("/profile"); }} style={{ background: "#E03A2F", border: "none", borderRadius: 8, padding: "10px 24px", color: "#fff", fontFamily: condensedFont, fontWeight: 800, fontSize: 13, letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer" }}>
            Build Your Own Profile →
          </button>
        </div>
      </main>
    </div>
  );
}