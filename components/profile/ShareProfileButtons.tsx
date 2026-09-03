"use client";

// components/profile/ShareProfileButtons.tsx
//
// "Share your collection" affordance — used on a user's OWN public profile and
// on /rewards. Two actions:
//   (a) Share on X  → opens a twitter.com/intent/tweet in a new tab.
//   (b) Copy link   → clipboard-copies the profile URL (for Discord paste).
//
// Both build the /profile/<username> URL with UTM params so inbound clicks are
// attributable, and both fire the `share_profile` earn via /api/rewards/track.
//
// ⚠ THAT EARN IS SILENT AND MUST STAY SILENT (2026-08-16). The rewards program
// is not built out, so nothing user-facing may promise or confirm points — this
// component used to render "+50 Status earned for sharing" under the buttons,
// on the profile, the dashboard AND the trophy-case share page. The accrual is
// kept so the data is there when rewards actually ship; the CLAIM is gone.
// Do not reinstate a Status/credits confirmation here.
//
// REFERRAL: when `referrerId` (the sharer's auth user id) is supplied, the
// shared URL also carries `&ref=<id>`. RefCapture (mounted in the root layout)
// stashes it on landing, the dashboard's verify step forwards it, and the
// listing-challenge check credits `referral_verified` to the sharer when the
// visitor verifies a wallet. Self-referral is ignored server-side, so it's safe to
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

export type ShareSurface = "profile" | "trophy-case";

function sharePath(username: string, surface: ShareSurface): string {
  const base = `/profile/${encodeURIComponent(username)}`;
  return surface === "trophy-case" ? `${base}/trophy-case` : base;
}

function profileUrl(
  username: string,
  medium: string,
  referrerId?: string | null,
  surface: ShareSurface = "profile",
): string {
  const origin =
    typeof window !== "undefined"
      ? window.location.origin
      : "https://www.rippackscity.com";
  const ref = referrerId ? `&ref=${encodeURIComponent(referrerId)}` : "";
  return `${origin}${sharePath(username, surface)}?utm_source=share&utm_medium=${medium}${ref}`;
}

// The social card behind a shared URL is rendered on first request and takes
// 3.6–4.7 s cold (measured 2026-09-02; ~80 ms once the edge has it). X's card
// fetcher does not wait that long, so the first person to post a fresh case
// could get a link with no picture. Warm it the moment the user reaches for
// the share button — the intent composer opens on top while this runs.
function prewarmCard(username: string, surface: ShareSurface): void {
  if (typeof window === "undefined" || typeof fetch !== "function") return;
  const og =
    surface === "trophy-case"
      ? `/api/og/trophy-case/${encodeURIComponent(username)}`
      : `/api/og/profile/${encodeURIComponent(username)}`;
  try {
    void fetch(og, { method: "GET", cache: "force-cache" }).catch(() => {});
  } catch {
    // best-effort only
  }
}

export default function ShareProfileButtons({
  username,
  fmv,
  moments,
  trophyCount,
  compact,
  referrerId,
  surface,
}: {
  username: string;
  fmv?: number | null;
  moments?: number | null;
  /** Pinned trophies, so the tweet can name what the card leads with. */
  trophyCount?: number | null;
  compact?: boolean;
  /** Sharer's auth user id — when set, the shared link carries &ref= so a
   *  verified-wallet signup credits the sharer. */
  referrerId?: string | null;
  /** Which page the link points at. The trophy-case share page must share
   *  ITSELF — its own URL carries the trophy-case social card — not the
   *  profile it belongs to (2026-09-02 onboarding QA, finding #3). */
  surface?: ShareSurface;
}) {
  const shareSurface: ShareSurface = surface ?? "profile";
  const [copied, setCopied] = useState(false);

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
    // ⚠ Deliberately NOT "My NBA Top Shot collection". RPC covers five Flow
    // collections, and a collector whose portfolio is All Day or Pinnacle was
    // being handed a tweet that misdescribed their own holdings. "collection"
    // is true for all of them, and naming the trophy case points at what the
    // card actually leads with — the six Moments they chose to show off.
    const trophies =
      trophyCount && trophyCount > 0
        ? ` My trophy case${trophyCount < 6 ? "" : " (all 6 slots)"} is up:`
        : "";
    const cta = referrerId ? " See how yours stacks up 👇" : "";
    if (shareSurface === "trophy-case") {
      // The card the link unfurls into IS the trophy case, so lead with it.
      const n = trophyCount && trophyCount > 0 ? trophyCount : null;
      const what = n ? (n === 1 ? "the Moment" : `the ${n} Moments`) : "the Moments";
      return `My trophy case on @RipPacksCity — ${what} I chose to show off${stat}.${cta || " 👇"}`;
    }
    return `My collection on @RipPacksCity${stat}.${trophies}${cta}`;
  }, [fmv, moments, referrerId, trophyCount, shareSurface]);

  // Fire-and-forget reward. The endpoint is session-resolved + DB-capped, so a
  // repeat same-day click is a harmless no-op ({ awarded:false }). 401 (anon)
  // just leaves the note hidden.
  const track = useCallback(() => {
    // Fire-and-forget, and the RESPONSE IS DELIBERATELY IGNORED: reading
    // `awarded` back is what used to drive the "+50 Status earned" note.
    fetch("/api/rewards/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "share_profile" }),
    }).catch(() => {});
  }, []);

  const shareX = useCallback(() => {
    const url = profileUrl(username, "x", referrerId, shareSurface);
    const intent = `https://twitter.com/intent/tweet?text=${encodeURIComponent(
      tweetText,
    )}&url=${encodeURIComponent(url)}`;
    prewarmCard(username, shareSurface);
    track();
    window.open(intent, "_blank", "noopener,noreferrer");
  }, [username, tweetText, track, referrerId, shareSurface]);

  const copy = useCallback(async () => {
    const url = profileUrl(username, "copy", referrerId, shareSurface);
    prewarmCard(username, shareSurface);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // clipboard can be blocked — non-fatal.
    }
    track();
  }, [username, track, referrerId, shareSurface]);

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
    </div>
  );
}
