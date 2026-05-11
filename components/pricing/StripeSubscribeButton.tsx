"use client";

// components/pricing/StripeSubscribeButton.tsx
//
// Pro Monthly Stripe Checkout CTA. POSTs to /api/stripe/checkout (which
// requires auth) and redirects to the returned Checkout URL. If Stripe is
// not configured server-side, the route returns 503 and we surface a
// concise inline error.

import { useState } from "react";

export default function StripeSubscribeButton({ style }: { style?: React.CSSProperties }) {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onClick = async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/stripe/checkout", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      if (res.status === 401) {
        window.location.href = `/login?next=${encodeURIComponent("/pricing")}`;
        return;
      }

      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(j?.error || `HTTP ${res.status}`);
        return;
      }

      if (j?.url) {
        window.location.href = j.url as string;
      } else {
        setErr("No checkout URL returned");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <button
        type="button"
        onClick={onClick}
        disabled={loading}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--rpc-red, #E03A2F)",
          color: "#fff",
          padding: "12px 22px",
          borderRadius: "var(--radius-sm, 6px)",
          border: "none",
          cursor: loading ? "not-allowed" : "pointer",
          opacity: loading ? 0.7 : 1,
          fontFamily: "'Barlow Condensed', sans-serif",
          fontWeight: 800,
          fontSize: 13,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          ...style,
        }}
      >
        {loading ? "Loading…" : "Subscribe — $9.99 / mo"}
      </button>
      {err && (
        <div style={{ color: "#F87171", fontFamily: "var(--font-mono)", fontSize: 11 }}>
          {err}
        </div>
      )}
    </div>
  );
}
