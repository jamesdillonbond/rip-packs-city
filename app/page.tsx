"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getOwnerKey } from "@/lib/owner-key";
import { getTrackedCollections } from "@/lib/tracked-collections";
import { COLLECTIONS } from "@/lib/collections";
import SiteFooter from "@/components/SiteFooter";
import MobileNav from "@/components/MobileNav";
import SupportChatConnected from "@/components/SupportChatConnected";
import OnboardingModal from "@/components/OnboardingModal";

const condensedFont = "'Barlow Condensed', sans-serif";
const monoFont = "'Share Tech Mono', monospace";
const RED = "#E03A2F";

export default function HomePage() {
  const router = useRouter();
  const [address, setAddress] = useState("");
  const [showOnboarding, setShowOnboarding] = useState(false);

  useEffect(() => {
    const saved = getOwnerKey();
    if (saved) setAddress(saved);

    try {
      if (!localStorage.getItem("rpc_onboarded")) {
        setShowOnboarding(true);
      }
    } catch {}
  }, []);

  function handleLoad() {
    const val = address.trim();
    if (!val) return;
    const tracked = getTrackedCollections();
    const first = tracked[0] || "nba-top-shot";
    const param = val.startsWith("0x") ? val : val;
    router.push(`/${first}/collection?address=${encodeURIComponent(param)}`);
  }

  return (
    <div style={{ minHeight: "100vh", background: "#080808", color: "#fff" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;600;700;800;900&family=Share+Tech+Mono&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        input::placeholder{color:rgba(255,255,255,0.25)!important;}
        ::-webkit-scrollbar{width:4px}
        ::-webkit-scrollbar-track{background:#111}
        ::-webkit-scrollbar-thumb{background:rgba(224,58,47,0.3);border-radius:2px}
        @media(max-width:768px){
          .rpc-main{padding:16px 16px 80px!important;}
          .rpc-chat-fab{bottom:76px!important;}
        }
        .rpc-coll-card:hover .rpc-coll-glow{box-shadow:0 0 12px var(--glow-color)!important;border-color:var(--glow-color)!important;}
      `}</style>

      {/* Header — same pattern as profile page */}
      <header style={{ background: "rgba(8,8,8,0.97)", borderBottom: "1px solid rgba(255,255,255,0.06)", position: "sticky", top: 0, zIndex: 100, backdropFilter: "blur(20px)" }}>
        <div style={{ maxWidth: 1440, margin: "0 auto", padding: "0 20px", height: 56, display: "flex", alignItems: "center", gap: 16 }}>
          <Link href="/" style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0, textDecoration: "none" }}>
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
              <div style={{ fontFamily: condensedFont, fontWeight: 900, fontSize: 17, letterSpacing: "0.06em", color: "#F1F1F1", lineHeight: 1, textTransform: "uppercase" }}>
                Rip Packs <span style={{ color: RED }}>City</span>
              </div>
              <div style={{ fontSize: 7, fontFamily: monoFont, letterSpacing: "0.2em", color: "rgba(224,58,47,0.5)" }}>@RIPPACKSCITY</div>
            </div>
          </Link>
          <div style={{ flex: 1 }} />
          <Link href="/profile" style={{ background: "rgba(224,58,47,0.15)", border: "1px solid rgba(224,58,47,0.4)", color: RED, padding: "4px 10px", borderRadius: 4, fontSize: 10, fontFamily: condensedFont, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", textDecoration: "none" }}>
            Profile
          </Link>
        </div>
      </header>

      <main className="rpc-main" style={{ maxWidth: 1440, margin: "0 auto", padding: "24px 24px 60px" }}>

        {/* ── Section A — Hero / wallet connect strip ──────────────── */}
        <section style={{ marginBottom: 32 }}>
          <div style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: "rgba(255,255,255,0.35)", marginBottom: 10 }}>
            ◈ ANALYZE YOUR COLLECTION ◈
          </div>
          <div style={{ display: "flex", gap: 8, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: "8px 8px 8px 16px", alignItems: "center", maxWidth: 560 }}>
            <input
              value={address}
              onChange={e => setAddress(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") handleLoad(); }}
              placeholder="Dapper username or 0x address…"
              style={{
                flex: 1,
                background: "transparent",
                border: "none",
                color: "#fff",
                fontFamily: monoFont,
                fontSize: 12,
                outline: "none",
              }}
            />
            <button
              onClick={handleLoad}
              style={{
                background: RED,
                border: "none",
                borderRadius: 5,
                padding: "8px 18px",
                color: "#fff",
                fontFamily: condensedFont,
                fontWeight: 700,
                fontSize: 12,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              Load
            </button>
          </div>
          <p style={{ fontFamily: monoFont, fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 8, letterSpacing: "0.06em" }}>
            Enter your username to see your portfolio across all collections.
          </p>
        </section>

        {/* ── Section B — Collection grid ──────────────────────────── */}
        <section style={{ marginBottom: 32 }}>
          <div style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: "rgba(255,255,255,0.35)", marginBottom: 12 }}>
            ◈ COLLECTIONS ◈
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 }}>
            {COLLECTIONS.map(col => {
              const isPublished = col.published;

              const cardStyle: React.CSSProperties = {
                background: "rgba(255,255,255,0.03)",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 8,
                padding: "16px 14px 12px",
                position: "relative",
                borderBottom: `2px solid ${col.accent}`,
                opacity: isPublished ? 1 : 0.45,
                transition: "all 0.2s ease",
                textDecoration: "none",
                color: "#fff",
                display: "block",
              };

              const inner = (
                <>
                  {/* Top-right badge */}
                  <div style={{ position: "absolute", top: 8, right: 8 }}>
                    {isPublished ? (
                      <span style={{ fontFamily: monoFont, fontSize: 8, letterSpacing: "0.1em", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 3, padding: "2px 6px", color: "rgba(255,255,255,0.4)", textTransform: "uppercase" }}>
                        {col.chain}
                      </span>
                    ) : (
                      <span style={{ fontFamily: monoFont, fontSize: 8, letterSpacing: "0.1em", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 3, padding: "2px 6px", color: "rgba(255,255,255,0.5)", textTransform: "uppercase" }}>
                        COMING SOON
                      </span>
                    )}
                  </div>
                  {/* Lock icon for unpublished */}
                  {!isPublished && (
                    <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", fontSize: 28, opacity: 0.12, pointerEvents: "none" }}>
                      🔒
                    </div>
                  )}
                  {/* Icon + label */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 24 }}>{col.icon}</span>
                    <div>
                      <div style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 14, textTransform: "uppercase", letterSpacing: "0.04em", lineHeight: 1.2 }}>
                        {col.label}
                      </div>
                      <div style={{ fontFamily: monoFont, fontSize: 9, color: "rgba(255,255,255,0.35)", letterSpacing: "0.08em" }}>
                        {col.shortLabel}
                      </div>
                    </div>
                  </div>
                  <div style={{ fontFamily: monoFont, fontSize: 9, color: "rgba(255,255,255,0.25)", letterSpacing: "0.08em" }}>
                    {col.sport}
                  </div>
                </>
              );

              if (isPublished) {
                return (
                  <Link
                    key={col.id}
                    href={`/${col.id}/overview`}
                    className="rpc-coll-card"
                    style={{
                      ...cardStyle,
                      // CSS custom property for hover glow
                      // @ts-expect-error CSS custom property
                      "--glow-color": `${col.accent}66`,
                    }}
                  >
                    <div className="rpc-coll-glow" style={{ position: "absolute", inset: 0, borderRadius: 8, border: "1px solid transparent", transition: "all 0.2s ease", pointerEvents: "none" }} />
                    {inner}
                  </Link>
                );
              }

              return (
                <div key={col.id} style={cardStyle}>
                  {inner}
                </div>
              );
            })}
          </div>
        </section>

        {/* ── Section C — Onboarding trigger ───────────────────────── */}
        <OnboardingBanner onOpen={() => setShowOnboarding(true)} />
      </main>

      <SiteFooter />
      <MobileNav />
      <SupportChatConnected />

      {showOnboarding && (
        <OnboardingModal onClose={() => setShowOnboarding(false)} />
      )}
    </div>
  );
}

// ── Onboarding banner — only shows if rpc_onboarded is not set ──────────────
function OnboardingBanner({ onOpen }: { onOpen: () => void }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem("rpc_onboarded")) {
        setShow(true);
      }
    } catch {}
  }, []);

  if (!show) return null;

  return (
    <div style={{
      background: `${RED}12`,
      border: `1px solid ${RED}33`,
      borderRadius: 8,
      padding: "14px 18px",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      flexWrap: "wrap",
    }}>
      <span style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, color: "rgba(255,255,255,0.6)", letterSpacing: "0.06em" }}>
        New to RPC? Set up your collections →
      </span>
      <button
        onClick={onOpen}
        style={{
          background: RED,
          border: "none",
          borderRadius: 5,
          padding: "7px 16px",
          color: "#fff",
          fontFamily: "'Barlow Condensed', sans-serif",
          fontWeight: 700,
          fontSize: 11,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          cursor: "pointer",
        }}
      >
        Get Started
      </button>
    </div>
  );
}
