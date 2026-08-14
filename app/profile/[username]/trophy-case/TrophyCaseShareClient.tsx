"use client";

// The shareable trophy-case surface.
//
// Renders the six Moments large, with the collector's caption under each — the
// captions are the whole reason this page reads differently from a grid of
// thumbnails, and they are the one thing on a trophy the collector wrote
// themselves.
//
// ⚠ It reuses `TrophySlab` in `public` mode rather than drawing its own tiles.
// The slab already carries the tier holo, badge art, serial/FMV footer and the
// caption; a second renderer here would drift from the profile page the first
// time either changed, and a visitor arriving from a shared link would see a
// different case than the one the owner arranged.

import Link from "next/link";
import RpcLogo from "@/components/RpcLogo";
import TrophySlab, { type TrophySlabData } from "@/components/TrophySlab";
import ShareProfileButtons from "@/components/profile/ShareProfileButtons";

const MONO = "var(--font-mono)";
const DISPLAY = "var(--font-display)";

export default function TrophyCaseShareClient({
  username,
  displayName,
  accentColor,
  trophies,
  readFailed,
}: {
  username: string;
  displayName: string;
  accentColor: string | null;
  trophies: Array<Record<string, unknown>>;
  /** The read errored — distinct from "this collector has pinned nothing". */
  readFailed: boolean;
}) {
  const accent = accentColor || "var(--rpc-red)";
  const slabs = trophies
    .filter((t) => t && t.moment_id)
    .slice(0, 6) as unknown as TrophySlabData[];

  return (
    <div style={{ minHeight: "100vh", background: "var(--rpc-black)", color: "var(--rpc-text-primary)" }}>
      <header
        style={{
          borderBottom: "1px solid var(--rpc-border)",
          position: "sticky",
          top: 0,
          zIndex: 50,
          background: "rgba(8,8,8,0.97)",
          backdropFilter: "blur(20px)",
        }}
      >
        <div
          style={{
            maxWidth: 1100,
            margin: "0 auto",
            padding: "0 24px",
            height: 56,
            display: "flex",
            alignItems: "center",
            gap: 16,
          }}
        >
          <Link href="/" style={{ display: "flex", alignItems: "center", textDecoration: "none" }}>
            <RpcLogo size={30} />
          </Link>
          <div style={{ flex: 1 }} />
          <Link
            href={`/profile/${encodeURIComponent(username)}`}
            className="rpc-btn-ghost"
            style={{ textDecoration: "none", fontSize: 10 }}
          >
            FULL PROFILE →
          </Link>
        </div>
      </header>

      <main style={{ maxWidth: 1100, margin: "0 auto", padding: "40px 24px 64px" }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div
            style={{
              fontFamily: MONO,
              fontSize: 9,
              letterSpacing: "0.22em",
              color: "var(--rpc-text-muted)",
              textTransform: "uppercase",
            }}
          >
            🏆 Trophy Case
          </div>
          <h1
            style={{
              fontFamily: DISPLAY,
              fontWeight: 900,
              fontSize: 34,
              letterSpacing: "0.05em",
              textTransform: "uppercase",
              lineHeight: 1.05,
              margin: "8px 0 6px",
            }}
          >
            {displayName}
          </h1>
          <Link
            href={`/profile/${encodeURIComponent(username)}`}
            style={{
              fontFamily: MONO,
              fontSize: 10,
              color: "var(--rpc-text-muted)",
              letterSpacing: "0.1em",
              textDecoration: "none",
            }}
          >
            @{username}
          </Link>
        </div>

        {readFailed ? (
          /* Says what is true — that WE could not read it — rather than making
             a claim about this collector's case out of our own outage. */
          <div
            style={{
              textAlign: "center",
              fontFamily: MONO,
              fontSize: 13,
              color: "var(--rpc-text-muted)",
              padding: "48px 0",
            }}
          >
            Couldn&rsquo;t load this trophy case. Refresh to try again.
          </div>
        ) : slabs.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              fontFamily: MONO,
              fontSize: 13,
              color: "var(--rpc-text-muted)",
              padding: "48px 0",
            }}
          >
            No trophies pinned yet.
          </div>
        ) : (
          <>
            <div
              className="rpc-case-grid"
              style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 20 }}
            >
              {slabs.map((s, i) => (
                <TrophySlab key={`case-${i}`} slab={s} slot={i + 1} mode="public" />
              ))}
            </div>
            <style>{`
              @media (max-width: 900px) { .rpc-case-grid { grid-template-columns: repeat(2, minmax(0,1fr)) !important; } }
              @media (max-width: 560px) { .rpc-case-grid { grid-template-columns: minmax(0,1fr) !important; } }
            `}</style>
          </>
        )}

        <div
          style={{
            marginTop: 40,
            paddingTop: 28,
            borderTop: "1px solid var(--rpc-border)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 14,
          }}
        >
          <ShareProfileButtons
            username={username}
            trophyCount={slabs.length}
            compact
          />
          <Link
            href="/dashboard"
            className="rpc-btn-primary"
            style={{
              textDecoration: "none",
              fontSize: 12,
              padding: "9px 20px",
              background: accent,
              borderColor: accent,
            }}
          >
            BUILD YOUR OWN TROPHY CASE →
          </Link>
        </div>
      </main>
    </div>
  );
}
