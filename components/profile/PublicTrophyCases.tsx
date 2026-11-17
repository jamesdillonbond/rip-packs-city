"use client";

// components/profile/PublicTrophyCases.tsx
//
// A collector's EXTRA trophy cases on /profile/<username> (2026-11-06): named
// cases and challenge entries, each a 6-slot grid. Renders nothing while
// loading and nothing for a collector with no extra cases (the main case above
// already speaks for the empty profile). ⚠ A FAILED read renders a "couldn't
// load" line, never nothing-at-all-as-if-none — but quietly, because the main
// case is the page's headline and this panel is supplementary.

import Link from "next/link";
import { useEffect, useState } from "react";
import TrophySlab from "@/components/TrophySlab";
import { slotsOf, type TrophyCaseData } from "@/components/profile/TrophyCasesPanel";
import { challengeCaseSharePath } from "@/lib/trophy/challenge-link";

const condensedFont = "var(--font-display)";
const monoFont = "var(--font-mono)";

export default function PublicTrophyCases({ username }: { username: string }) {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "failed" } | { kind: "ok"; cases: TrophyCaseData[] }>({
    kind: "loading",
  });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/public/trophy-cases?username=" + encodeURIComponent(username))
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((d) => {
        if (!cancelled) setState({ kind: "ok", cases: Array.isArray(d?.cases) ? d.cases : [] });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [username]);

  if (state.kind === "loading") return null;
  if (state.kind === "failed") {
    return (
      <div role="status" style={{ fontFamily: monoFont, fontSize: 11, color: "var(--rpc-text-muted)", margin: "16px 0" }}>
        Couldn&rsquo;t load this collector&rsquo;s other trophy cases. Refresh to try again.
      </div>
    );
  }
  // Only cases with something in them: an empty named case is a draft.
  const shown = state.cases.filter((c) => Array.isArray(c.slabs) && c.slabs.length > 0);
  if (shown.length === 0) return null;

  return (
    <div style={{ marginTop: 28 }}>
      <style>{`
        @media (max-width: 768px) {
          .rpc-pubcase-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
        }
      `}</style>
      {shown.map((c) => (
        <section key={c.id} style={{ marginBottom: 28 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
            <h2 style={{ margin: 0, fontFamily: condensedFont, fontWeight: 800, fontSize: 20, letterSpacing: "0.04em", textTransform: "uppercase" }}>
              {c.name}
            </h2>
            {c.challenge && (
              <Link
                href={`/trophy-challenges/${c.challenge.slug}`}
                style={{ fontFamily: monoFont, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}
              >
                {c.challenge.title} challenge · see all entries →
              </Link>
            )}
            <span style={{ fontFamily: monoFont, fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.15em" }}>
              {c.slabs.length} / 6
            </span>
            {c.challenge && (
              <Link
                href={challengeCaseSharePath(username, c.challenge.slug)}
                style={{ fontFamily: monoFont, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}
              >
                Open · share →
              </Link>
            )}
          </div>
          <div className="rpc-pubcase-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 16 }}>
            {slotsOf(c.slabs).map((s, i) => (
              <TrophySlab key={c.id + "-" + i} slab={s} slot={i + 1} mode="public" />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
