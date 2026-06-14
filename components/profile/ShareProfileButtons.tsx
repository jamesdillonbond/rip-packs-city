"use client";

// components/profile/ShareProfileButtons.tsx
//
// "Share your collection" affordance — used on a user's OWN public profile and
// on /rewards. Two actions:
//   (a) Share on X  → opens a twitter.com/intent/tweet in a new tab.
//   (b) Copy link   → clipboard-copies the profile URL (for Discord paste).
//
// Both build the /profile/<username> URL with UTM params so inbound clicks are
// attributable, and both fire the `share_profile` rewards earn via
// /api/rewards/track (the share ACTION is what's rewarded — a posted tweet
// can't be verified without X API access; the DB caps it to +50 once/day).
//
// REFERRAL: when `referrerId` (the sharer's auth user id) is supplied, the
// shared URL also carries `&ref=<id>`. RefCapture (mounted in the root layout)
// stashes it on landing, SignInWithDapper forwards it, and fcl-verify credits
// `referral_verified` to the sharer when the visitor links a verified wallet as
// a genuinely-new user. Self-referral is ignored server-side, so it's safe to
// always include it on the owner's own share. Without this the profile-share
// links never fed the referral loop (it only lived on the buried /rewards
// invite block) — this connects the two.
//
// We NEVER auto-post on the user's behalf — the intent link opens a pre-filled
// composer the user submits themselves.

import { useCallback, useMemo, useState } from "react";

const DISPLAY = "var(--font-display)";
const MONO = "var(--font-mono)";
const RED = "var(--rpc-red)";

function profileUrl(
  username: string,
  medium: string,
  referrerId?: string | null,
): string {
  const origin =
    typeof window !== "undefined"
      ? window.location.origin
      : "https://www.rippackscity.com";
  const ref = referrerId ? `&ref=${encodeURIComponent(referrerId)}` : "";
  return `${origin}/profile/${encodeURIComponent(
    username,
  )}?utm_source=share&utm_medium=${medium}${ref}`;
}

export default function ShareProfileButtons({
  username,
  fmv,
  moments,
  compact,
  referrerId,
}: {
  username: string;
  fmv?: number | null;
  moments?: number | null;
  compact?: boolean;
  /** Sharer's auth user id — when set, the shared link carries &ref= so a
   *  verified-wallet signup credits the sharer. */
  referrerId?: string | null;
}) {
  const [copied, setCopied] = useState(false);
  // null = not attempted; true = +50 just earned; false = already earned today
  const [earned, setEarned] = useState<boolean | null>(null);

  const tweetText = useMemo(() => {
    let stat = "";
    if (fmv && fmv > 0) {
      const f =
        fmv >= 1000 ? "$" + (fmv / 1000).toFixed(1) + "K" : "$" + fmv.toFixed(0);
      const m =
        moments && moments > 0
          ? " across " + moments.toLocaleString() + " Moments"
          : "";
      stat = ` — ${f}${m}`;
    }
    const cta = referrerId ? " See how yours stacks up 👇" : "";
    return `My NBA Top Shot collection on @RipPacksCity${stat}.${cta}`;
  }, [fmv, moments, referrerId]);

  // Fire-and-forget reward. The endpoint is session-resolved + DB-capped, so a
  // repeat same-day click is a harmless no-op ({ awarded:false }). 401 (anon)
  // just leaves the note hidden.
  const track = useCallback(() => {
    fetch("/api/rewards/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "share_profile" }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) setEarned(!!d.awarded);
      })
      .catch(() => {});
  }, []);

  const shareX = useCallback(() => {
    const url = profileUrl(username, "x", referrerId);
    const intent = `https://twitter.com/intent/tweet?text=${encodeURIComponent(
      tweetText,
    )}&url=${encodeURIComponent(url)}`;
    track();
    window.open(intent, "_blank", "noopener,noreferrer");
  }, [username, tweetText, track, referrerId]);

  const copy = useCallback(async () => {
    const url = profileUrl(username, "copy", referrerId);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // clipboard can be blocked — non-fatal.
    }
    track();
  }, [username, track, referrerId]);

  const btn: React.CSSProperties = {
    padding: compact ? "8px 14px" : "10px 18px",
    borderRadius: 8,
    border: "none",
    cursor: "pointer",
    background: RED,
    color: "#fff",
    fontFamily: DISPLAY,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    fontSize: 13,
    whiteSpace: "nowrap",
  };
  const ghostBtn: React.CSSProperties = {
    ...btn,
    background: "transparent",
    color: "#e7e7e7",
    border: "1px solid #333",
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <button type="button" onClick={shareX} style={btn}>
          Share on X
        </button>
        <button type="button" onClick={copy} style={ghostBtn}>
          {copied ? "Copied!" : "Copy link"}
        </button>
      </div>
      {earned !== null && (
        <div
          style={{
            marginTop: 8,
            fontFamily: MONO,
            fontSize: 11,
            color: earned ? "#5cc46a" : "#9a9a9a",
          }}
        >
          {earned ? "+50 Status earned for sharing" : "Already earned your share bonus today"}
        </div>
      )}
    </div>
  );
}
