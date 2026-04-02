"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { getOwnerKey, setOwnerKey } from "@/lib/owner-key";
import { COLLECTIONS } from "@/lib/collections";
import { getTrackedCollections, setTrackedCollections } from "@/lib/tracked-collections";

const condensedFont = "'Barlow Condensed', sans-serif";
const monoFont = "'Share Tech Mono', monospace";
const RED = "#E03A2F";

interface OnboardingModalProps {
  onClose: () => void;
}

export default function OnboardingModal({ onClose }: OnboardingModalProps) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [address, setAddress] = useState("");
  const [selected, setSelected] = useState<string[]>(["nba-top-shot"]);

  // Pre-populate address from localStorage
  useEffect(() => {
    const saved = getOwnerKey();
    if (saved) setAddress(saved);
  }, []);

  function handleStep1Continue() {
    if (address.trim()) {
      setOwnerKey(address.trim());
    }
    setStep(2);
  }

  function handleStep2Continue() {
    setTrackedCollections(selected);
    setStep(3);
  }

  // Mark onboarded when step 3 renders
  useEffect(() => {
    if (step === 3) {
      try { localStorage.setItem("rpc_onboarded", "1"); } catch {}
    }
  }, [step]);

  function toggleCollection(id: string) {
    setSelected(prev =>
      prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]
    );
  }

  const firstTracked = selected[0] || "nba-top-shot";
  const ownerKey = address.trim();

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0,0,0,0.85)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        style={{
          background: "#0d0d0d",
          border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: 12,
          padding: 32,
          maxWidth: 480,
          width: "100%",
          position: "relative",
          maxHeight: "90vh",
          overflowY: "auto",
        }}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          style={{
            position: "absolute",
            top: 12,
            right: 12,
            background: "none",
            border: "none",
            color: "rgba(255,255,255,0.4)",
            fontSize: 20,
            cursor: "pointer",
            lineHeight: 1,
          }}
        >
          ✕
        </button>

        {/* Step indicator */}
        <div style={{ display: "flex", gap: 8, justifyContent: "center", marginBottom: 24 }}>
          {[1, 2, 3].map(n => (
            <div
              key={n}
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: n === step ? RED : "rgba(255,255,255,0.15)",
                transition: "background 0.2s",
              }}
            />
          ))}
        </div>

        {/* Step 1 */}
        {step === 1 && (
          <div>
            <h2 style={{ fontFamily: condensedFont, fontWeight: 900, fontSize: 28, textTransform: "uppercase", color: "#fff", textAlign: "center", marginBottom: 8 }}>
              Welcome to Rip Packs City
            </h2>
            <p style={{ fontFamily: monoFont, fontSize: 11, color: "rgba(255,255,255,0.5)", textAlign: "center", lineHeight: 1.6, marginBottom: 24, letterSpacing: "0.04em" }}>
              The collector intelligence platform for digital sports and entertainment collectibles.
            </p>
            <label style={{ fontFamily: monoFont, fontSize: 10, color: "rgba(255,255,255,0.4)", letterSpacing: "0.1em", display: "block", marginBottom: 8 }}>
              ENTER YOUR DAPPER USERNAME OR WALLET ADDRESS
            </label>
            <input
              value={address}
              onChange={e => setAddress(e.target.value)}
              placeholder="Dapper username or 0x address…"
              style={{
                width: "100%",
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 6,
                padding: "10px 14px",
                color: "#fff",
                fontFamily: monoFont,
                fontSize: 12,
                outline: "none",
                marginBottom: 20,
              }}
            />
            <button
              onClick={handleStep1Continue}
              style={{
                width: "100%",
                background: RED,
                border: "none",
                borderRadius: 6,
                padding: "10px 0",
                color: "#fff",
                fontFamily: condensedFont,
                fontWeight: 700,
                fontSize: 14,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                cursor: "pointer",
                marginBottom: 12,
              }}
            >
              Continue →
            </button>
            <div style={{ textAlign: "center" }}>
              <button
                onClick={() => setStep(2)}
                style={{ background: "none", border: "none", color: "rgba(255,255,255,0.35)", fontFamily: monoFont, fontSize: 10, cursor: "pointer", letterSpacing: "0.08em" }}
              >
                Skip for now
              </button>
            </div>
          </div>
        )}

        {/* Step 2 */}
        {step === 2 && (
          <div>
            <h2 style={{ fontFamily: condensedFont, fontWeight: 900, fontSize: 24, textTransform: "uppercase", color: "#fff", textAlign: "center", marginBottom: 20 }}>
              Which Collections Do You Collect?
            </h2>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 24 }}>
              {COLLECTIONS.map(col => {
                const isSelected = selected.includes(col.id);
                const dimmed = !col.published;
                return (
                  <button
                    key={col.id}
                    onClick={() => toggleCollection(col.id)}
                    style={{
                      background: isSelected ? `${col.accent}15` : "rgba(255,255,255,0.03)",
                      border: isSelected ? `1px solid ${col.accent}66` : "1px solid rgba(255,255,255,0.08)",
                      borderRadius: 8,
                      padding: "12px 10px",
                      cursor: "pointer",
                      textAlign: "left",
                      opacity: dimmed && !isSelected ? 0.5 : 1,
                      transition: "all 0.15s ease",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                      <span style={{ fontSize: 16 }}>{col.icon}</span>
                      <span style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 12, color: isSelected ? col.accent : "rgba(255,255,255,0.7)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                        {col.shortLabel}
                      </span>
                    </div>
                    <div style={{ fontFamily: monoFont, fontSize: 9, color: "rgba(255,255,255,0.3)", letterSpacing: "0.08em" }}>
                      {col.published ? col.sport : "COMING SOON"}
                    </div>
                    {isSelected && (
                      <div style={{ color: col.accent, fontSize: 10, marginTop: 4 }}>✓</div>
                    )}
                  </button>
                );
              })}
            </div>
            <button
              onClick={handleStep2Continue}
              style={{
                width: "100%",
                background: RED,
                border: "none",
                borderRadius: 6,
                padding: "10px 0",
                color: "#fff",
                fontFamily: condensedFont,
                fontWeight: 700,
                fontSize: 14,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                cursor: "pointer",
              }}
            >
              Continue →
            </button>
          </div>
        )}

        {/* Step 3 */}
        {step === 3 && (
          <div style={{ textAlign: "center" }}>
            <h2 style={{ fontFamily: condensedFont, fontWeight: 900, fontSize: 28, textTransform: "uppercase", color: "#fff", marginBottom: 12 }}>
              You&apos;re All Set
            </h2>
            <p style={{ fontFamily: monoFont, fontSize: 11, color: "rgba(255,255,255,0.5)", lineHeight: 1.6, marginBottom: 28, letterSpacing: "0.04em" }}>
              Your profile is configured. Head to your collection to see your portfolio, or explore the sniper feed for live deals.
            </p>
            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={() => {
                  const url = ownerKey
                    ? `/${firstTracked}/collection?address=${encodeURIComponent(ownerKey)}`
                    : `/${firstTracked}/collection`;
                  router.push(url);
                  onClose();
                }}
                style={{
                  flex: 1,
                  background: RED,
                  border: "none",
                  borderRadius: 6,
                  padding: "10px 0",
                  color: "#fff",
                  fontFamily: condensedFont,
                  fontWeight: 700,
                  fontSize: 12,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  cursor: "pointer",
                }}
              >
                View My Collection
              </button>
              <button
                onClick={() => {
                  router.push(`/${firstTracked}/sniper`);
                  onClose();
                }}
                style={{
                  flex: 1,
                  background: "transparent",
                  border: `1px solid ${RED}`,
                  borderRadius: 6,
                  padding: "10px 0",
                  color: RED,
                  fontFamily: condensedFont,
                  fontWeight: 700,
                  fontSize: 12,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  cursor: "pointer",
                }}
              >
                Explore Sniper
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
