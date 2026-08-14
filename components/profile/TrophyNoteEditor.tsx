"use client";

// components/profile/TrophyNoteEditor.tsx
//
// The owner's caption control for one trophy slot — the missing entry point for
// `trophy_moments.note`.
//
// That column has been writable by the API, stored, returned by the slab RPC,
// typed on TrophySlabData and rendered in the trophy-case PDF since the feature
// shipped. No UI ever set it, so every pinned trophy in production carries a
// null note and the only surface that could show one was a PDF export. Same
// shape as the follow button: a fully-built backend with nothing to reach it.
//
// ⚠ WHY THIS IS A SIBLING OF THE SLAB AND NOT PART OF IT. `TrophySlab`'s entire
// filled body is wrapped in a `<Link href="/moment/...">`. Any input nested
// inside would sit in an anchor — every click, every caret placement and every
// Enter keypress would navigate away mid-sentence unless each handler
// remembered to preventDefault, and the one that forgot would be a caption the
// user could not finish typing. Rendering below the slab keeps the editor out
// of the anchor entirely, which is a structural fix rather than a vigilant one.

import { useCallback, useEffect, useRef, useState } from "react";

const MONO = "var(--font-mono)";
/** Mirrors MAX_NOTE_LEN in app/api/profile/trophy/route.ts. */
export const MAX_NOTE_LEN = 90;

export default function TrophyNoteEditor({
  slot,
  note,
  onSaved,
}: {
  slot: number;
  note: string | null;
  /** Lets the parent update its slab state so the caption renders immediately. */
  onSaved?: (slot: number, note: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Re-sync when the parent swaps this slot's trophy underneath us (reorder,
  // repin). Without this the editor would keep the previous trophy's caption.
  useEffect(() => {
    if (!editing) setDraft(note ?? "");
  }, [note, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const save = useCallback(async () => {
    const next = draft.replace(/\s+/g, " ").trim();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/profile/trophy", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slot, note: next || null }),
      });
      if (!res.ok) {
        // ⚠ Report what actually happened. A blanket "couldn't save" on a 404
        // would tell a collector their caption failed when the real state is
        // that the slot is empty — a different problem with a different fix.
        const body = await res.json().catch(() => null);
        setError(
          res.status === 404
            ? "That slot is empty — pin a Moment first."
            : res.status === 401
              ? "Sign in to edit your trophy case."
              : typeof body?.error === "string"
                ? body.error
                : "Couldn't save that caption. Try again.",
        );
        return;
      }
      onSaved?.(slot, next || null);
      setEditing(false);
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setSaving(false);
    }
  }, [draft, slot, onSaved]);

  const cancel = useCallback(() => {
    setDraft(note ?? "");
    setError(null);
    setEditing(false);
  }, [note]);

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        style={{
          marginTop: 6,
          width: "100%",
          background: "transparent",
          border: "1px dashed var(--rpc-border)",
          borderRadius: 6,
          padding: "5px 8px",
          cursor: "pointer",
          fontFamily: MONO,
          fontSize: 9,
          letterSpacing: "0.08em",
          color: note ? "var(--rpc-text-secondary)" : "var(--rpc-text-muted)",
          textAlign: "left",
        }}
      >
        {note ? "EDIT CAPTION" : "+ ADD A CAPTION"}
      </button>
    );
  }

  const remaining = MAX_NOTE_LEN - draft.length;

  return (
    <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 5 }}>
      <input
        ref={inputRef}
        value={draft}
        maxLength={MAX_NOTE_LEN}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void save();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        placeholder="Why this one matters…"
        aria-label={`Caption for trophy slot ${slot}`}
        style={{
          background: "var(--rpc-black)",
          border: "1px solid var(--rpc-border)",
          borderRadius: 6,
          padding: "6px 8px",
          fontFamily: MONO,
          fontSize: 10,
          color: "var(--rpc-text-primary)",
          width: "100%",
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          style={{
            fontFamily: MONO,
            fontSize: 9,
            letterSpacing: "0.08em",
            padding: "4px 10px",
            borderRadius: 5,
            border: "1px solid var(--rpc-red)",
            background: "var(--rpc-red)",
            color: "#fff",
            cursor: saving ? "not-allowed" : "pointer",
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? "SAVING…" : "SAVE"}
        </button>
        <button
          type="button"
          onClick={cancel}
          disabled={saving}
          style={{
            fontFamily: MONO,
            fontSize: 9,
            letterSpacing: "0.08em",
            padding: "4px 10px",
            borderRadius: 5,
            border: "1px solid var(--rpc-border)",
            background: "transparent",
            color: "var(--rpc-text-secondary)",
            cursor: "pointer",
          }}
        >
          CANCEL
        </button>
        <span
          style={{
            marginLeft: "auto",
            fontFamily: MONO,
            fontSize: 9,
            color: remaining <= 10 ? "var(--rpc-warning)" : "var(--rpc-text-ghost)",
          }}
        >
          {remaining}
        </span>
      </div>
      {error && (
        <div style={{ fontFamily: MONO, fontSize: 9, color: "var(--rpc-danger)" }}>
          {error}
        </div>
      )}
    </div>
  );
}
