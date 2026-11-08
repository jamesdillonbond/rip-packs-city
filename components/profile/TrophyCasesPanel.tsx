"use client";

// components/profile/TrophyCasesPanel.tsx
//
// The owner's EXTRA trophy cases on the dashboard (2026-11-06): named cases and
// challenge entries (first challenge: Dame Time). The main case keeps its own
// section above; this panel never reads or writes it.
//
// ⚠ THREE STATES for the cases read (CLAUDE.md "Honesty"): loading · failed (a
// "couldn't load" notice, NEVER the "create your first case" empty state — that
// would invite a collector with three cases to rebuild them) · loaded. The open
// challenge list is separately `null` when its read failed, and then the join
// prompt simply isn't offered rather than claiming there are no challenges.

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import TrophySlab, { type TrophySlabData } from "@/components/TrophySlab";
import TrophyPickerModal from "@/components/profile/TrophyPickerModal";
import TrophyNoteEditor from "@/components/profile/TrophyNoteEditor";
import { apiErrorMessage } from "@/lib/api-error-message";
import { MAX_CASE_NAME_LEN, MAX_EXTRA_CASES } from "@/lib/trophy/cases";
import { parseChallengeRules } from "@/lib/trophy/challenge-rules";
import { challengeAnchorId } from "@/lib/trophy/challenge-link";

const condensedFont = "var(--font-display)";
const monoFont = "var(--font-mono)";

export interface TrophyChallengeInfo {
  id: string;
  slug: string;
  title: string;
  tagline: string | null;
  description: string | null;
  rules?: unknown;
  ends_at: string | null;
  is_active: boolean;
}

export interface TrophyCaseData {
  id: string;
  name: string;
  created_at: string;
  completed_at: string | null;
  challenge: TrophyChallengeInfo | null;
  slabs: TrophySlabData[];
}

type Load =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "ok"; cases: TrophyCaseData[]; challenges: TrophyChallengeInfo[] | null; board: BoardListing };

/**
 * Whether a challenge entry can appear on the public board, which lists only
 * collectors with a profile username. "unknown" = that read failed; the copy
 * then claims neither listed nor unlisted (2026-11-07 review).
 */
export type BoardListing = "listed" | "needs_username" | "unknown";

export function boardListingOf(d: { board_username?: unknown; board_username_known?: unknown } | null | undefined): BoardListing {
  if (d?.board_username_known !== true) return "unknown";
  return typeof d.board_username === "string" && d.board_username.length > 0 ? "listed" : "needs_username";
}

/** The challenge-entry status line. Pure, so every state is pinned. */
export function entryStatusCopy(filled: number, board: BoardListing): string {
  if (filled === 0) return "Challenge entry · tap a slot to add — each pick saves itself →";
  if (board === "listed") return `✓ Entry saved · ${filled} of 6 on the board →`;
  if (board === "needs_username") return `✓ Entry saved · ${filled} of 6 — set a username to appear on the board →`;
  return `✓ Entry saved · ${filled} of 6 →`;
}

/** Six fixed cells keyed by the slab's OWN slot (never array position). */
export function slotsOf(slabs: TrophySlabData[]): (TrophySlabData | null)[] {
  const out: (TrophySlabData | null)[] = [null, null, null, null, null, null];
  for (const s of slabs) if (s.slot >= 1 && s.slot <= 6) out[s.slot - 1] = s;
  return out;
}

const btn: React.CSSProperties = {
  fontFamily: condensedFont,
  fontWeight: 700,
  fontSize: 11,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  borderRadius: 8,
  padding: "6px 12px",
  cursor: "pointer",
  background: "transparent",
  border: "1px solid var(--rpc-border)",
  color: "var(--rpc-text-primary)",
  whiteSpace: "nowrap",
};

export default function TrophyCasesPanel({
  ownerKey,
  savedChains,
  onToast,
}: {
  ownerKey: string | null;
  savedChains: readonly string[] | null;
  onToast: (text: string, tone?: "success" | "info") => void;
}) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [pick, setPick] = useState<{ c: TrophyCaseData; slot: number } | null>(null);
  const [newName, setNewName] = useState("");
  // 2026-11-06: the name box used to sit bare under the LAST case, where it read as
  // "name this case and save it" — Trevor, right after filling his Dame Time
  // entry: "It should auto save as you create it. We don't need to put a name".
  // Every pick already saves itself; the box only STARTS a new named case, so
  // it now opens from a button that says exactly that.
  const [startingCase, setStartingCase] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/profile/trophy-cases", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const d = await res.json();
      setLoad({
        state: "ok",
        cases: Array.isArray(d?.cases) ? d.cases : [],
        challenges: Array.isArray(d?.challenges) ? d.challenges : null,
        board: boardListingOf(d),
      });
    } catch {
      setLoad((prev) => (prev.state === "ok" ? prev : { state: "failed" }));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Deep link (challengeEntryHref): the browser's own hash scroll fires before
  // this panel exists, so scroll once the rows have rendered. Once per mount —
  // a later refresh (every pick) must not yank the page back.
  const loaded = load.state === "ok";
  const scrolledToHash = useRef(false);
  useEffect(() => {
    if (!loaded || scrolledToHash.current) return;
    scrolledToHash.current = true;
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!id.startsWith("challenge-")) return;
    document.getElementById(id)?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, [loaded]);

  const send = useCallback(
    async (url: string, method: string, body: unknown, okText: string): Promise<boolean> => {
      setBusy(true);
      try {
        const res = await fetch(url, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          onToast(apiErrorMessage(data, res.status), "info");
          return false;
        }
        onToast(okText, "success");
        await refresh();
        return true;
      } catch {
        onToast("Couldn't reach the server — try again.", "info");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [onToast, refresh]
  );

  if (load.state === "loading") return null;
  if (load.state === "failed") {
    return (
      <section className="rpc-section">
        <div className="rpc-section-title">More Trophy Cases</div>
        <div role="status" style={{ fontFamily: monoFont, fontSize: 12, color: "var(--rpc-text-muted)" }}>
          Couldn&rsquo;t load your other trophy cases. This is a loading problem — nothing was removed. Refresh to try again.
        </div>
      </section>
    );
  }

  const { cases, challenges } = load;
  const entered = new Set(cases.map((c) => c.challenge?.slug).filter(Boolean) as string[]);
  const joinable = (challenges ?? []).filter((ch) => !entered.has(ch.slug));
  const atCap = cases.length >= MAX_EXTRA_CASES;

  return (
    <section className="rpc-section" data-tour-anchor="trophy-cases">
      <style>{`
        @media (max-width: 768px) {
          .rpc-xcase-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
        }
      `}</style>
      <div className="rpc-section-title">More Trophy Cases</div>
      <div style={{ fontFamily: monoFont, fontSize: 11, color: "var(--rpc-text-muted)", marginBottom: 14, lineHeight: 1.5 }}>
        Build themed cases beyond your main six, and enter challenges. They show on your public profile.
      </div>

      {/* Open challenges you haven't entered */}
      {joinable.map((ch) => (
        <div
          key={ch.id}
          id={challengeAnchorId(ch.slug)}
          style={{
            scrollMarginTop: 80,
            display: "flex",
            gap: 12,
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            padding: "12px 14px",
            marginBottom: 14,
            borderRadius: 10,
            border: "1px solid var(--rpc-border)",
            background: "var(--rpc-surface)",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 16, letterSpacing: "0.04em", textTransform: "uppercase" }}>
              Challenge · {ch.title}
            </div>
            {ch.tagline && (
              <div style={{ fontFamily: monoFont, fontSize: 11, color: "var(--rpc-text-muted)", marginTop: 2 }}>{ch.tagline}</div>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Link href={`/trophy-challenges/${ch.slug}`} style={{ ...btn, textDecoration: "none" }}>
              See entries
            </Link>
            <button
              type="button"
              disabled={busy || atCap}
              onClick={() => send("/api/profile/trophy-cases", "POST", { challengeSlug: ch.slug }, `Entered ${ch.title}`)}
              style={{ ...btn, borderColor: "var(--rpc-red-border)", color: "var(--rpc-red-text)" }}
            >
              Enter
            </button>
          </div>
        </div>
      ))}

      {cases.map((c) => (
        <CaseBlock
          key={c.id}
          c={c}
          board={load.board}
          busy={busy}
          onPick={(slot) => setPick({ c, slot })}
          onRemove={(slot) =>
            send("/api/profile/trophy", "DELETE", { slot, caseId: c.id }, "Trophy removed")
          }
          onRename={(name) => send("/api/profile/trophy-cases", "PATCH", { caseId: c.id, name }, "Case renamed")}
          onDelete={() => send("/api/profile/trophy-cases", "DELETE", { caseId: c.id }, "Case deleted")}
          onNoteSaved={() => void refresh()}
        />
      ))}

      {/* Start another NAMED case — behind a button, so it never reads as the save
          step for the case above it (every pick saves on its own). */}
      {!startingCase ? (
        <button
          type="button"
          disabled={busy || atCap}
          onClick={() => setStartingCase(true)}
          style={{ ...btn, marginTop: 6 }}
          aria-expanded={false}
        >
          {atCap ? `Limit of ${MAX_EXTRA_CASES} extra cases reached` : "+ Start another case (named, your own theme)"}
        </button>
      ) : (
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!newName.trim()) return;
          if (await send("/api/profile/trophy-cases", "POST", { name: newName }, "Case created")) {
            setNewName("");
            setStartingCase(false);
          }
        }}
        style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}
      >
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          maxLength={MAX_CASE_NAME_LEN}
          placeholder={atCap ? `Limit of ${MAX_EXTRA_CASES} extra cases reached` : "New case name, e.g. Rookie Class"}
          disabled={busy || atCap}
          aria-label="New trophy case name"
          style={{
            flex: "1 1 220px",
            minWidth: 0,
            fontFamily: monoFont,
            fontSize: 12,
            padding: "8px 10px",
            borderRadius: 8,
            background: "var(--rpc-surface)",
            border: "1px solid var(--rpc-border)",
            color: "var(--rpc-text-primary)",
          }}
        />
        <button type="submit" disabled={busy || atCap || !newName.trim()} style={btn}>
          New case
        </button>
        <button type="button" onClick={() => { setStartingCase(false); setNewName(""); }} style={{ ...btn, color: "var(--rpc-text-muted)" }}>
          Cancel
        </button>
      </form>
      )}

      {pick && (
        <TrophyPickerModal
          slot={pick.slot}
          ownerKey={ownerKey}
          caseId={pick.c.id}
          title={pick.c.challenge ? pick.c.challenge.title : pick.c.name}
          initialQuery={pick.c.challenge ? (parseChallengeRules(pick.c.challenge.rules).playerNames[0] ?? "") : ""}
          onClose={() => setPick(null)}
          onPinned={async () => {
            setPick(null);
            await refresh();
            onToast("Trophy pinned", "success");
          }}
          pinnedMomentIds={pick.c.slabs.map((s) => s.moment_id)}
          replacingName={slotsOf(pick.c.slabs)[pick.slot - 1]?.player_name ?? null}
          savedChains={savedChains}
        />
      )}
    </section>
  );
}

function CaseBlock({
  c,
  board,
  busy,
  onPick,
  onRemove,
  onRename,
  onDelete,
  onNoteSaved,
}: {
  c: TrophyCaseData;
  board: BoardListing;
  busy: boolean;
  onPick: (slot: number) => void;
  onRemove: (slot: number) => void;
  onRename: (name: string) => Promise<boolean>;
  onDelete: () => void;
  onNoteSaved: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(c.name);
  const cells = slotsOf(c.slabs);
  const filled = c.slabs.length;
  const ch = c.challenge;

  return (
    <div id={ch ? challengeAnchorId(ch.slug) : undefined} style={{ marginBottom: 22, scrollMarginTop: 80 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flexWrap: "wrap" }}>
          {renaming && !ch ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (await onRename(draft)) setRenaming(false);
              }}
              style={{ display: "flex", gap: 6 }}
            >
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={MAX_CASE_NAME_LEN}
                aria-label="Trophy case name"
                style={{
                  fontFamily: monoFont,
                  fontSize: 12,
                  padding: "4px 8px",
                  borderRadius: 6,
                  background: "var(--rpc-surface)",
                  border: "1px solid var(--rpc-border)",
                  color: "var(--rpc-text-primary)",
                }}
              />
              <button type="submit" disabled={busy} style={{ ...btn, padding: "4px 10px" }}>Save</button>
              <button type="button" onClick={() => { setRenaming(false); setDraft(c.name); }} style={{ ...btn, padding: "4px 10px" }}>Cancel</button>
            </form>
          ) : (
            <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 18, letterSpacing: "0.04em", textTransform: "uppercase" }}>
              {c.name}
            </div>
          )}
          {ch && (
            <Link
              href={filled > 0 && board === "needs_username" ? "/profile/edit" : `/trophy-challenges/${ch.slug}`}
              role="status"
              style={{ fontFamily: monoFont, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: filled > 0 ? "var(--rpc-success-text)" : "var(--rpc-text-muted)" }}
            >
              {/* Each pick saves itself; there is no save step and no name to give. */}
              {entryStatusCopy(filled, board)}
            </Link>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontFamily: monoFont, fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.15em" }}>{filled} / 6</span>
          {!ch && !renaming && (
            <button type="button" disabled={busy} onClick={() => setRenaming(true)} style={{ ...btn, padding: "4px 10px" }}>
              Rename
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              const what = ch ? `your ${ch.title} entry` : `"${c.name}"`;
              if (window.confirm(`Delete ${what} and unpin its ${filled} trophies? Your main trophy case is not affected.`)) onDelete();
            }}
            style={{ ...btn, padding: "4px 10px", color: "var(--rpc-text-muted)" }}
          >
            Delete
          </button>
        </div>
      </div>
      {ch?.description && (
        <div style={{ fontFamily: monoFont, fontSize: 11, color: "var(--rpc-text-muted)", marginBottom: 10, lineHeight: 1.5 }}>
          {ch.description}
        </div>
      )}
      <div className="rpc-xcase-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 16 }}>
        {cells.map((s, i) => (
          <div key={c.id + "-" + i} style={{ display: "flex", flexDirection: "column" }}>
            <TrophySlab slab={s} slot={i + 1} mode="owner" onEmptyClick={onPick} onRemove={onRemove} />
            {s && <TrophyNoteEditor slot={i + 1} caseId={c.id} note={s.note} onSaved={onNoteSaved} />}
          </div>
        ))}
      </div>
    </div>
  );
}
