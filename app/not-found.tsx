import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "404",
  description: "The page you're looking for isn't here.",
};

export default function NotFound() {
  return (
    <main
      style={{
        minHeight: "100vh",
        background: "transparent",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: "48px 24px",
        gap: 18,
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-sm)",
          letterSpacing: "0.3em",
          textTransform: "uppercase",
          color: "var(--rpc-text-muted)",
        }}
      >
        404
      </div>

      <h1
        style={{
          fontFamily: "var(--font-display)",
          fontWeight: 900,
          fontSize: "clamp(48px, 9vw, 96px)",
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          lineHeight: 1,
          color: "var(--rpc-text-primary)",
          margin: 0,
        }}
      >
        <span className="sr-only">Page not found. </span>
        Bingo Bango Bongo
      </h1>

      <p
        style={{
          fontFamily: "var(--font-body)",
          fontSize: 16,
          lineHeight: 1.5,
          color: "var(--rpc-text-secondary)",
          maxWidth: 480,
          margin: 0,
        }}
      >
        But the page you&apos;re looking for isn&apos;t here.
      </p>

      {/* 2026-10-24: a dead end offered only "home". The places a lost collector
          most often meant to go, one tap each. */}
      <nav aria-label="Popular pages" style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "center", marginTop: 4 }}>
        {[
          { href: "/market", label: "Market" },
          { href: "/sniper", label: "Sniper" },
          { href: "/insights", label: "Insights" },
          { href: "/teams", label: "Teams" },
          { href: "/help", label: "Help" },
        ].map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="rpc-tap44"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "var(--rpc-text-primary)",
              border: "1px solid var(--rpc-border-hover)",
              borderRadius: "var(--radius-sm)",
              padding: "10px 14px",
              textDecoration: "none",
            }}
          >
            {l.label}
          </Link>
        ))}
      </nav>

      <Link
        href="/"
        style={{
          marginTop: 8,
          fontFamily: "var(--font-body)",
          fontSize: 14,
          color: "var(--rpc-text-muted)",
          textDecoration: "underline",
          textUnderlineOffset: 4,
        }}
      >
        Back to{" "}
        <span style={{ color: "var(--rpc-red-text)" }}>Rip City</span>
      </Link>
    </main>
  );
}
