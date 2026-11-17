"use client"

// components/profile/FillTop6Button.tsx
//
// "Fill with my top 6" for the MAIN trophy case (2026-11-16). Since 09-01, members
// who pinned on day 0 came back far more often than those who pinned nothing, and
// the only path was "+ Pick a moment" — six trips through the picker. Propose →
// confirm → pin; the server writes only EMPTY slots (app/api/profile/trophy/fill).
// A failed read or write says so in a toast; it never claims an empty collection.

import { useState } from "react"
import { track } from "@/lib/telemetry/track"
import { mainFillConfirmCopy, type MainFillProposal } from "@/lib/trophy/fill-main"

type Tone = "success" | "info"

export default function FillTop6Button(props: {
  onToast: (text: string, tone?: Tone) => void
  /** Reload the case after a fill attempt (whatever its outcome). */
  onDone: () => Promise<void> | void
  style?: React.CSSProperties
}) {
  const [busy, setBusy] = useState(false)

  async function run() {
    setBusy(true)
    try {
      const post = (confirm: boolean) =>
        fetch("/api/profile/trophy/fill", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirm }),
        })
      track("main-fill-click", {})
      const res = await post(false)
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        props.onToast(typeof d?.error === "string" ? d.error : "Couldn't read your collection right now — try again.", "info")
        return
      }
      const picks: MainFillProposal[] = Array.isArray(d?.picks) ? d.picks : []
      const short = typeof d?.short === "number" ? d.short : 0
      if (picks.length === 0) {
        props.onToast("No priced moments to pin yet — try again once your collection finishes loading.", "info")
        return
      }
      if (!window.confirm(mainFillConfirmCopy(picks, short))) {
        track("main-fill-declined", { proposed: picks.length })
        return
      }
      const done = await post(true)
      const dd = await done.json().catch(() => ({}))
      if (!done.ok) {
        props.onToast(typeof dd?.error === "string" ? dd.error : "Couldn't fill your case right now — try again.", "info")
        return
      }
      const pinned = typeof dd?.pinned === "number" ? dd.pinned : 0
      track("main-fill-pinned", { pinned })
      props.onToast(
        pinned > 0 ? `Pinned ${pinned} to your trophy case` : "Nothing was pinned — your case may have changed. Refresh and try again.",
        pinned > 0 ? "success" : "info",
      )
    } catch {
      props.onToast("Couldn't reach the server — try again.", "info")
    } finally {
      setBusy(false)
      await props.onDone()
    }
  }

  return (
    <button data-testid="fill-top-6" type="button" onClick={run} disabled={busy} style={{ ...props.style, opacity: busy ? 0.6 : 1 }}>
      {busy ? "Finding your top 6…" : "Fill with my top 6"}
    </button>
  )
}
