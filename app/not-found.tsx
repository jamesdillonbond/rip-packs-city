import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "404 — Rip Packs City",
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
        <span style={{ color: "var(--rpc-red)" }}>Rip City</span>
      </Link>
    </main>
  );
}
