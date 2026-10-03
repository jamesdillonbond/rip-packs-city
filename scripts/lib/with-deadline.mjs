// scripts/lib/with-deadline.mjs — a NODE-timer deadline for a browser call that has none of its own.
//
// WHY (2026-10-03): three of five Panini team walks (09-29, 09-30, 10-03) went silent right after
// "backing off 20s before attempt 2" and sat until the 160-min watchdog killed the run — ~130 min
// lost each time, one team walked instead of five. Playwright bounds goto/waitForResponse, but
// Response.text() (CDP Network.getResponseBody), page.title() and page.evaluate() carry NO
// timeout: a Cloudflare challenge tab that stops answering parks them forever. A deadline here
// runs on Node's own timer, so it fires whatever state the tab is in.
//
// Resolves the call's value, or TIMED_OUT when `ms` passes first. A later rejection of the
// abandoned call is already handled by the race and cannot surface as an unhandled rejection.

export const TIMED_OUT = Symbol("timed-out")

/**
 * @template T
 * @param {Promise<T> | T} promise
 * @param {number} ms
 * @returns {Promise<T | typeof TIMED_OUT>}
 */
export function withDeadline(promise, ms) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms)
  })
  return Promise.race([Promise.resolve(promise), deadline]).finally(() => clearTimeout(timer))
}

/** A pause on Node's timer — needs no live tab, unlike page.waitForTimeout. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
