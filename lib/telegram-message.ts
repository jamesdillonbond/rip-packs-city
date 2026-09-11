/**
 * Bounded Telegram alert text.
 *
 * ── WHY THIS EXISTS, and it is not hypothetical ────────────────────────────
 * 🚨 OBSERVED LIVE 2026-09-11T00:01:09Z. The sentinel ran 18 checks, concluded
 * **CRITICAL** (`Pipeline Silence`, during the 09-10 outage), built its Telegram
 * message and got back:
 *
 *     telegram-FAILED:http_400: {"ok":false,"error_code":400,
 *                                "description":"Bad Request: message is too long"}
 *
 * Email was `not_configured`, so BOTH out-of-band channels failed and the only
 * surviving signal was a GitHub annotation. **The fleet alarm detected a real
 * outage and could not tell anyone.**
 *
 * ⭐ THE PART WORTH GENERALISING: the message is one line per check, so ITS
 * LENGTH GROWS WITH THE SIZE OF THE INCIDENT. `Pipeline Silence` names every
 * silent lane, so twenty dead lanes write a far longer detail than one. Telegram
 * caps `sendMessage` text at 4096 characters. **So the alarm's delivery
 * probability falls as the thing it is reporting gets worse** — it is most
 * likely to fail on exactly the runs that matter most. That is this repo's alert
 * sub-class in its purest form: the output is silence, so the failure is
 * unfalsifiable from the outside.
 *
 * ── WHAT THIS DOES, AND THE HONESTY PROPERTY IT KEEPS ──────────────────────
 * Truncation is a lie unless the reader can see it happened, so every path here
 * ends in a VISIBLE notice that states what was dropped and why. Specifically:
 *
 *   - lines are kept in SEVERITY order (critical, then warn, then ok) but
 *     RENDERED in their original order, so making room never costs a critical to
 *     keep an ok;
 *   - the omission notice says how many of how many were dropped, and — the
 *     load-bearing half — whether any CRITICAL was among them, BY NAME. An
 *     "N omitted" that hides which ones is the empty-state-that-concludes shape;
 *   - the notice is sized against its own worst case before anything is cut, so
 *     the notice can never be the thing that pushes the message back over;
 *   - an individual over-long line is capped with its own marker rather than
 *     dropping the check entirely, because a check's NAME and STATUS are worth
 *     more than its detail.
 *
 * ⚠ IT DELIBERATELY DOES NOT SPLIT INTO SEVERAL MESSAGES. Partial delivery
 * (message 1 lands, message 2 400s) would reintroduce the same defect one level
 * down, and `notifications` carries one verdict per channel, which could then no
 * longer be true. One message, bounded, with the cut declared in it.
 */

/** Telegram's documented `sendMessage` cap on `text`, in CHARACTERS (not bytes). */
export const TELEGRAM_TEXT_LIMIT = 4096

export type AlertLine = {
  /** "ok" | "warn" | "critical" — anything else ranks with "ok". */
  status?: string
  /** Used to name a dropped critical in the omission notice. */
  name?: string
  /** The fully rendered line, including any markup. */
  text: string
}

const cutNotice = (dropped: number, limit: number) =>
  `\n…[${dropped} more characters omitted to fit Telegram's ${limit}-character limit]`

/**
 * Bound an opaque block of text, declaring the cut in the text itself.
 * For callers that hand Telegram a single pre-built string.
 */
export function fitTelegramText(text: string, limit: number = TELEGRAM_TEXT_LIMIT): string {
  if (text.length <= limit) return text
  // The notice's own length is computed from the WORST case (dropping
  // everything), because the real count can only be smaller — so the returned
  // string is guaranteed to be within the limit rather than approximately so.
  const worst = cutNotice(text.length, limit)
  if (worst.length >= limit) return `${text.slice(0, Math.max(0, limit - 1))}…`
  const keep = limit - worst.length
  return text.slice(0, keep) + cutNotice(text.length - keep, limit)
}

/**
 * Build a header + per-check message that fits, dropping the least severe lines
 * first and saying plainly what was dropped.
 */
export function fitTelegramMessage(
  header: string,
  lines: AlertLine[],
  limit: number = TELEGRAM_TEXT_LIMIT,
): string {
  // A single runaway detail must not cost the whole message. A quarter of the
  // budget still shows a long detail; beyond that the check's name and status
  // are worth more than the rest of its prose.
  const lineCap = Math.max(120, Math.floor(limit / 4))
  const indexed = lines.map((l, i) => ({
    ...l,
    i,
    text: l.text.length > lineCap ? fitTelegramText(l.text, lineCap) : l.text,
  }))

  const rank = (s?: string) => (s === "critical" ? 0 : s === "warn" ? 1 : 2)
  const bySeverity = [...indexed].sort((a, b) => rank(a.status) - rank(b.status) || a.i - b.i)

  const render = (keep: typeof indexed, omitted: typeof indexed) => {
    const body = [...keep]
      .sort((a, b) => a.i - b.i)
      .map((l) => l.text)
      .join("\n")
    const head = body ? `${header}\n\n${body}` : header
    if (omitted.length === 0) return head
    const crit = omitted.filter((l) => l.status === "critical")
    const why = `omitted to fit Telegram's ${limit}-character limit`
    // Naming the dropped criticals is the whole point: a bare count would let a
    // reader believe the alert they received was the alert that was raised.
    const note =
      crit.length === 0
        ? `\n\n…${omitted.length} of ${lines.length} checks ${why}. None of them was critical.`
        : `\n\n…${omitted.length} of ${lines.length} checks ${why}, INCLUDING ${crit.length} CRITICAL: ${crit
            .map((c) => c.name ?? "unnamed")
            .join(", ")}.`
    return head + note
  }

  for (let n = indexed.length; n >= 0; n--) {
    const out = render(bySeverity.slice(0, n), bySeverity.slice(n))
    if (out.length <= limit) return out
  }
  // Unreachable for any sane limit — the n = 0 case is header + notice — but a
  // header long enough to overflow on its own must still not throw at an alarm.
  return fitTelegramText(render([], indexed), limit)
}
