/**
 * Did anyone actually HEAR the last alarm?
 *
 * ── WHY (measured 2026-09-11) ──────────────────────────────────────────────
 * The sentinel records per-channel delivery in `pipeline_runs.extra.notifications`
 * — `"telegram"` when the channel accepted the message, `"telegram-FAILED:<reason>"`
 * when it did not. That record has existed since 2026-08-29 and **nothing read it.**
 *
 * 🚨 What it was holding, across all 18 runs in the durable record:
 *   - `email-FAILED:not_configured` on **18 of 18**. The email channel has never
 *     once delivered, so the estate has been running on a SINGLE out-of-band
 *     channel for the whole recorded history of this alarm.
 *   - and then, on the 00:01:09Z CRITICAL sweep, that single channel returned
 *     `telegram-FAILED:http_400 … "message is too long"`.
 *
 * **So on the one run that mattered, the alarm reached nobody, and the only
 * surviving signal was a GitHub annotation.** Every fact needed to say so was
 * already in the table; no check looked.
 *
 * ── THE FAILURE CONDITION IS "ZERO CHANNELS", NOT "ALL CHANNELS" ───────────
 * ⚠ Deliberate, and it is what keeps this arm from being useless. Email is
 * unconfigured today, so an "every channel delivered" arm would be RED from its
 * first run until someone sets an env var — and this repo's own rule is that *a
 * permanently-red instrument is indistinguishable from a broken one at a glance*.
 * Keyed on **zero** channels, the arm is green while one channel works, and goes
 * CRITICAL exactly when the alarm is mute. The unconfigured channel is still
 * reported — in the DETAIL, where it informs without crying wolf.
 *
 * ⚠ RUNS THAT DID NOT ATTEMPT A NOTIFICATION ARE NOT EVIDENCE. The sentinel only
 * notifies on warn/critical or the six-hourly report, so an ALL-CLEAR run carries
 * an EMPTY `notifications` and says nothing about whether delivery works.
 * Counting those as failures would fabricate an outage out of a healthy estate —
 * the emptiness-vs-failure distinction this file exists to defend.
 */

export type DeliveryRun = { started_at?: string | null; notifications?: unknown }
export type DeliveryVerdict = {
  status: "ok" | "warn" | "critical"
  detail: string
  /** Attempts actually inspected. A verdict from zero attempts is not a verdict. */
  inspected: number
}

const OUT_OF_BAND = ["telegram", "email"] as const

/** An entry is a DELIVERY only when it is the bare channel name; `telegram-FAILED:…` is not. */
function delivered(notifications: string[]): string[] {
  return OUT_OF_BAND.filter((c) => notifications.includes(c))
}

function failedReasons(notifications: string[]): string[] {
  return notifications.filter((n) => OUT_OF_BAND.some((c) => n.startsWith(`${c}-FAILED`)))
}

function attempts(rows: DeliveryRun[]): { at: string; notifications: string[] }[] {
  return rows
    .map((r) => ({
      at: typeof r.started_at === "string" ? r.started_at : "",
      notifications: Array.isArray(r.notifications) ? r.notifications.filter((n): n is string => typeof n === "string") : [],
    }))
    // An out-of-band attempt is what this arm measures. `github-actions-native`
    // is always present and is not a channel that reaches anyone off GitHub.
    .filter((r) => r.notifications.some((n) => OUT_OF_BAND.some((c) => n === c || n.startsWith(`${c}-FAILED`))))
}

export function summariseAlertDelivery(rows: DeliveryRun[] | null | undefined): DeliveryVerdict {
  const seen = (rows ?? []).length
  const tried = attempts(rows ?? [])
  if (tried.length === 0) {
    // ⚠ TWO DIFFERENT ZEROES, and collapsing them is how this arm would have
    // punished its own success. No RUNS at all inside retention means the route
    // stopped recording itself — a real defect, and unmeasured rather than
    // healthy. Runs that simply had NOTHING TO SAY are a HEALTHY estate: the
    // sentinel notifies only on warn/critical or the six-hourly report, so a
    // quiet window exercises no channel. Warning on that would make a green
    // fleet permanently amber, and "a not-vacuous check must be satisfiable at a
    // population of zero".
    //
    // The detail still refuses to claim delivery works, because it was not
    // tested — the ok is about the ESTATE, not about the channel.
    if (seen === 0) {
      return {
        status: "warn",
        detail:
          "no sentinel run at all inside pipeline_runs retention (~73h), so alert delivery is UNMEASURED — not known good",
        inspected: 0,
      }
    }
    return {
      status: "ok",
      detail: `no alert was needed in the last ${seen} sentinel run${seen === 1 ? "" : "s"} — delivery was not exercised, so this is not a claim that it works`,
      inspected: 0,
    }
  }

  // Newest first is the caller's contract; sort defensively so a caller that
  // forgets the `.order()` cannot silently invert the verdict.
  const sorted = [...tried].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  const newest = sorted[0]
  const ok = delivered(newest.notifications)
  const bad = failedReasons(newest.notifications)
  const muteRuns = sorted.filter((r) => delivered(r.notifications).length === 0).length

  const where = `${sorted.length} attempt${sorted.length === 1 ? "" : "s"} inspected`
  const reasons = bad.length ? ` — ${bad.join("; ")}` : ""

  if (ok.length === 0) {
    return {
      status: "critical",
      detail: `the most recent alert reached NOBODY off GitHub (${where})${reasons}`,
      inspected: sorted.length,
    }
  }
  if (muteRuns > 0) {
    return {
      status: "warn",
      detail: `delivered on ${ok.join("+")} now, but ${muteRuns} of ${sorted.length} recent alerts reached nobody${reasons}`,
      inspected: sorted.length,
    }
  }
  return {
    status: bad.length ? "warn" : "ok",
    detail: bad.length
      ? `delivered on ${ok.join("+")} (${where}), but a channel is down${reasons}`
      : `delivered on ${ok.join("+")} (${where})`,
    inspected: sorted.length,
  }
}
