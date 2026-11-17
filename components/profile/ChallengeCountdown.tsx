"use client";

// components/profile/ChallengeCountdown.tsx
//
// "Closes in 4h 12m 09s" for a trophy challenge with an end (2026-11-08: Trevor
// closed Dame Time at midnight PT and wanted the deadline on the page).
//
// ⚠ HYDRATION (React #418, docs/reference: rpc-hydration-418-class): a render
// that reads the wall clock differs between the server and the browser. The
// clock comes from useSyncExternalStore with a NULL server snapshot, so the
// server and the first client render both print nothing and the ticking text
// appears after hydration. The end time itself is formatted in PT on purpose —
// the deadline is a PT deadline, whatever zone the reader is in.
//
// ⚠ THE COUNTDOWN IS NOT THE GATE. The server refuses every entry and every
// edit once `ends_at` passes (challengeIsOpen / refuseClosedChallenge); this
// only says so. At zero it reads "Closed", never a negative or a frozen 0s.

import { useSyncExternalStore } from "react";

const monoFont = "var(--font-mono)";

/** Remaining time as "2d 4h 05m", "4h 12m 09s" or "45m 09s"; null once ended or unparsable. */
export function countdownText(endsAt: string | null | undefined, nowMs: number): string | null {
  if (!endsAt) return null;
  const end = Date.parse(endsAt);
  if (!Number.isFinite(end)) return null;
  let s = Math.floor((end - nowMs) / 1000);
  if (s <= 0) return null;
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (d > 0) return `${d}d ${h}h ${pad(m)}m`;
  if (h > 0) return `${h}h ${pad(m)}m ${pad(s)}s`;
  return `${m}m ${pad(s)}s`;
}

/** "midnight PT" for 00:00, otherwise e.g. "11:30 PM PT", with the date when not today. */
export function closesAtLabel(endsAt: string, nowMs: number): string {
  const end = new Date(endsAt);
  const fmt = (o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", ...o }).format(end);
  const hm = fmt({ hour: "numeric", minute: "2-digit", hour12: true });
  const time = hm === "12:00 AM" ? "midnight" : hm;
  // "Midnight tonight" is the END of today, so compare the PT day of one second before.
  const dayOf = (ms: number) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(ms));
  const endDay = dayOf(end.getTime() - (time === "midnight" ? 1000 : 0));
  if (endDay === dayOf(nowMs)) return time === "midnight" ? "midnight PT tonight" : `${time} PT today`;
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
  }).format(new Date(end.getTime() - (time === "midnight" ? 1000 : 0)));
  return time === "midnight" ? `midnight PT, end of ${date}` : `${time} PT ${date}`;
}

function subscribe(cb: () => void): () => void {
  const t = setInterval(cb, 1000);
  return () => clearInterval(t);
}
// Whole seconds, so the snapshot is stable between ticks.
// hydration-safe: read only via useSyncExternalStore's CLIENT snapshot; the server snapshot is null, so SSR and hydration both render nothing.
const getNow = () => Math.floor(Date.now() / 1000) * 1000;
const getServerNow = () => null;

export default function ChallengeCountdown({
  endsAt,
  compact = false,
}: {
  endsAt: string | null | undefined;
  /** One short line for a dashboard row; the board uses the full banner. */
  compact?: boolean;
}) {
  const now = useSyncExternalStore(subscribe, getNow, getServerNow);
  if (!endsAt || now == null) return null;
  const left = countdownText(endsAt, now);
  const closed = left == null && Number.isFinite(Date.parse(endsAt));
  if (!left && !closed) return null;

  if (compact) {
    return (
      <span
        data-rpc-challenge-countdown
        role="timer"
        style={{ fontFamily: monoFont, fontSize: 11, letterSpacing: "0.04em", color: closed ? "var(--rpc-text-muted)" : "var(--rpc-red-text)" }}
      >
        {closed ? "Closed — no more entries" : `Closes in ${left}`}
      </span>
    );
  }

  return (
    <div
      data-rpc-challenge-countdown
      role="timer"
      aria-live="off"
      style={{
        display: "inline-flex",
        alignItems: "baseline",
        gap: 10,
        flexWrap: "wrap",
        margin: "4px 0 14px",
        padding: "8px 12px",
        borderRadius: 8,
        border: `1px solid ${closed ? "var(--rpc-border)" : "var(--rpc-red-border)"}`,
        background: "var(--rpc-surface)",
      }}
    >
      {closed ? (
        <span style={{ fontFamily: monoFont, fontSize: 12, color: "var(--rpc-text-muted)" }}>
          Entries closed. No more entries or changes.
        </span>
      ) : (
        <>
          <span style={{ fontFamily: monoFont, fontSize: 10, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}>
            Closes in
          </span>
          <span style={{ fontFamily: monoFont, fontSize: 18, fontWeight: 700, color: "var(--rpc-red-text)", fontVariantNumeric: "tabular-nums" }}>
            {left}
          </span>
          <span style={{ fontFamily: monoFont, fontSize: 11, color: "var(--rpc-text-muted)" }}>
            at {closesAtLabel(endsAt, now)} — no entries after that
          </span>
        </>
      )}
    </div>
  );
}
