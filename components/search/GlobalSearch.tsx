"use client";

// components/search/GlobalSearch.tsx
//
// The site's first catalog search bar. Type a player, set, team, or an edition
// key ("8:145") and jump straight to the page.
//
// Deliberate behaviours, each of which is the honest option:
//
//  · A FAILED SEARCH IS NOT AN EMPTY SEARCH. /api/search answers 503 (never a
//    200 with an empty array) when the query fails, and this renders that as
//    "Search is unavailable right now." — never as "No results", which would
//    tell a user their moment doesn't exist because our database blinked.
//
//  · THE COVERAGE GAP IS STATED, NOT HIDDEN. Moment descriptions ARE searched
//    now (2026-08-13) — "lillard game winner" returns the For the Win moments.
//    But the prose covers only part of the catalog and only Top Shot, so a
//    narrative query matching nothing is ambiguous: it may mean "no such
//    moment" or "no description for that moment". The empty state says which,
//    using the LIVE figure the API measures (`meta.note`) rather than a
//    hardcoded percentage that goes stale on the next backfill. Do not replace
//    it with a tidier fixed sentence; that is the difference between a
//    limitation and a lie.
//
//  · RESPONSES CAN ARRIVE OUT OF ORDER. Each request carries a sequence number
//    and a stale response is dropped, so a slow "li" cannot overwrite a fast
//    "lillard". Debounced at 180ms.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { searchKindLabel } from "@/lib/search/href";

interface Hit {
  kind: string;
  label: string;
  sublabel: string | null;
  href: string;
  collection: string;
  collectionName: string;
  thumbnailUrl: string | null;
  editionCount: number | null;
}

type Status = "idle" | "loading" | "ok" | "error";

interface Meta {
  note?: string;
}

const monoFont = "var(--font-mono)";
const DEBOUNCE_MS = 180;

export default function GlobalSearch() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<Hit[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const seqRef = useRef(0);

  const trimmed = q.trim();

  useEffect(() => {
    if (trimmed.length < 2) {
      setHits([]);
      setStatus("idle");
      return;
    }
    setStatus("loading");
    const seq = ++seqRef.current;
    const t = setTimeout(() => {
      fetch("/api/search?q=" + encodeURIComponent(trimmed) + "&limit=12")
        .then(async (r) => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json();
        })
        .then((j) => {
          // Drop a response that a newer keystroke has already superseded.
          if (seq !== seqRef.current) return;
          setHits(Array.isArray(j?.results) ? j.results : []);
          setMeta(j?.meta ?? null);
          setStatus("ok");
          setActive(0);
        })
        .catch(() => {
          if (seq !== seqRef.current) return;
          setHits([]);
          setMeta(null);
          setStatus("error");
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [trimmed]);

  // Close on outside click.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const showPanel = open && trimmed.length >= 2;

  function go(hit: Hit | undefined) {
    if (!hit) return;
    setOpen(false);
    setQ("");
    router.push(hit.href);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") { setOpen(false); return; }
    if (!showPanel || hits.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, hits.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); go(hits[active]); }
  }

  const panel = useMemo(() => {
    if (status === "loading" && hits.length === 0) {
      return <Msg>Searching…</Msg>;
    }
    if (status === "error") {
      // Distinct from "no results" on purpose.
      return <Msg tone="error">Search is unavailable right now. Try again in a moment.</Msg>;
    }
    if (status === "ok" && hits.length === 0) {
      return (
        <div style={{ padding: "12px 14px" }}>
          <div style={{ fontFamily: monoFont, fontSize: 12, color: "var(--rpc-text-secondary)" }}>
            No matches for &ldquo;{trimmed}&rdquo;
          </div>
          <div style={{ fontFamily: monoFont, fontSize: 10, color: "var(--rpc-text-muted)", marginTop: 6, lineHeight: 1.6 }}>
            {/* Live, measured disclosure — never a hardcoded percentage. */}
            {meta?.note ??
              "Search covers players, sets, teams, play types, edition keys and moment descriptions."}
          </div>
        </div>
      );
    }
    return (
      <ul role="listbox" style={{ listStyle: "none", margin: 0, padding: 4, maxHeight: 420, overflowY: "auto" }}>
        {hits.map((h, i) => (
          <li key={h.kind + h.href}>
            <button
              type="button"
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => go(h)}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 10px",
                borderRadius: 6,
                border: "none",
                textAlign: "left",
                cursor: "pointer",
                background: i === active ? "var(--rpc-surface)" : "transparent",
              }}
            >
              {h.thumbnailUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={h.thumbnailUrl} alt="" style={{ width: 28, height: 28, objectFit: "cover", borderRadius: 4, flexShrink: 0 }} />
              ) : (
                <span style={{ width: 28, height: 28, borderRadius: 4, flexShrink: 0, background: "var(--rpc-surface)" }} />
              )}
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 13, color: "var(--rpc-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {h.label}
                </span>
                <span style={{ display: "block", fontFamily: monoFont, fontSize: 9, letterSpacing: "0.08em", color: "var(--rpc-text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {searchKindLabel(h.kind, h.collection === "disney-pinnacle")}
                  {" · "}
                  {h.collectionName}
                  {h.sublabel ? " · " + h.sublabel : ""}
                  {h.kind !== "edition" && h.editionCount ? " · " + h.editionCount + " editions" : ""}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    );
  }, [status, hits, active, trimmed, meta]);

  return (
    <div ref={boxRef} style={{ position: "relative", flex: "0 1 320px", minWidth: 110 }}>
      <input
        type="search"
        value={q}
        placeholder="Search players, sets, teams…"
        aria-label="Search the catalog"
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        style={{
          width: "100%",
          height: 32,
          padding: "0 10px",
          borderRadius: 6,
          border: "1px solid var(--rpc-border)",
          background: "var(--rpc-surface)",
          color: "var(--rpc-text-primary)",
          fontFamily: monoFont,
          fontSize: 12,
          outline: "none",
        }}
      />
      {showPanel && (
        <div
          style={{
            position: "absolute",
            top: 38,
            // Right-anchored, not left+right: the input shrinks in a crowded
            // header (flex 0 1 320px), and a left-anchored panel with a 320px
            // minimum would then extend past the right edge of the viewport.
            left: "auto",
            right: 0,
            minWidth: 320,
            maxWidth: "min(420px, calc(100vw - 32px))",
            background: "var(--rpc-header-bg)",
            border: "1px solid var(--rpc-border)",
            borderRadius: 8,
            boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
            zIndex: 200,
          }}
        >
          {panel}
        </div>
      )}
    </div>
  );
}

function Msg({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
  return (
    <div
      style={{
        padding: "12px 14px",
        fontFamily: monoFont,
        fontSize: 12,
        color: tone === "error" ? "var(--rpc-danger)" : "var(--rpc-text-muted)",
      }}
    >
      {children}
    </div>
  );
}
