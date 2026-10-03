// ─────────────────────────────────────────────────────────────────────────────
// A RUN IN WHICH EVERYTHING FAILED MUST NOT RECORD ITSELF AS A SUCCESS.
//
// This is the write-side honesty rule (CLAUDE.md, R120/R123: "a swallowed write
// error + a hardcoded ok=true … publishes a FAILED WRITE as a successful run —
// 66 days on one lane, 20+ writers estate-wide"), executed against the edge
// fleet instead of grepped for. Nothing could execute these functions before
// 2026-10-02 (see auth_gate_test.ts).
//
// How: harness.admit() gets each function past its own gate with the test value
// of its own env vars, with EVERY database call failing and EVERY upstream
// answering 503, and waits for its background work. Then:
//   (1) no pipeline_runs write may claim success: `log_pipeline_run` with
//       p_ok=true, or a pipeline_runs insert/upsert/update with ok=true. Here
//       every read failed, so success can only be a failure misrecorded. The
//       commonest shape: a failed read returns [] and the run concludes
//       "nothing to do", ok=true.
//   (2) a SYNCHRONOUS response (no background work left running) may not claim
//       success in its body (ok:true / status:"ok"). An `accepted` / `queued`
//       body with work still running is honest by construction: its outcome
//       belongs in pipeline_runs, which (1) reads.
//   (3) the failure must leave a TRACE: an admitted run answering 2xx must
//       write an ok=false pipeline_runs row. A 2xx with no row is the shape
//       ingest-allday-pack-opens recorded on 2026-08-13: HTTP 200, no row, and a
//       "succeeded" cron run, so every instrument read clean while it did
//       nothing. A non-2xx answer is a trace of its own.
//   (4) every function must be admitted. One that no probe can get past is
//       one this suite cannot see; it reds rather than passing unseen.
//
// ⭐ MEASURED 2026-10-02: 36 of 43 passed as found. ~25 record `ok:false` with
// the real error even when they answer 200/202 (on purpose: so cron-job.org does
// not auto-disable the lane). Seven did not. The three with a live caller were
// fixed the day this landed:
//   sales-serial-backfill (vercel cron, every 2 h): a failed target read logged ok=true;
//   snapshot-institutional-wallets (cron-job.org + GHA backstop): a failed read
//     wrote ok=false, then a second row, same started_at, ok=true;
//   enrich-ufc-wallet (user wallet backfill): a failed read answered
//     {"ok":true,"message":"No moments"}, so the caller marked the wallet done.
// The four with no caller found are KNOWN below. The list can only shrink: a
// listed function that starts passing reds until it is removed.
// Rule (3), added the same evening, failed 5 functions. The two on pg_cron were
// fixed: ingest-topshot-pack-opens-history (every 15 min: tip_unreachable
// answered 200 with no row; the All Day sibling had this fix since 08-13) and
// resolve-allday-rip-dist-api (hourly: a failed read answered {"note":"none"}).
// The three that write no run row on ANY outcome are KNOWN_TRACELESS.
//
// ⚠ WHAT IT IS STRUCTURALLY SILENT ABOUT:
//   * Partial failure: here everything fails at once.
//   * Whether a lane's ok=false is SEEN: that is the sentinel's job.
// ─────────────────────────────────────────────────────────────────────────────
import { admit, FN_ROOT, functionNames, install, load } from "./harness.ts"

/** name → what it does when every read fails. ⛔ Remove an entry when it is fixed; never add one to make a new function pass. */
const KNOWN: Record<string, string> = {
  "topshot-insider-detect-patterns":
    "DORMANT (no caller, zero pipeline_runs ever). loadRecentBuybacks error returns [] → log_pipeline_run p_ok=true no_recent_buybacks",
  "seed-ufc-editions": "no caller found 10-02. Every Flowty page fails → body ok:true with errors[], no pipeline_runs row",
  "special-serial-delta": "no caller found 10-02. Holders read error → body status:\"ok\" scanned=0 failed=0, no pipeline_runs row",
  "scan-ufc-wallet": "no caller found 10-02. The ids script 503s → body ok:true momentsFound=0 with the error in errors[]",
}

/** name → how it answers 2xx with no ok=false row. Rule (3) only; shrink-only like KNOWN. */
const KNOWN_TRACELESS: Record<string, string> = {
  "seed-topshot-pack-distributions":
    "writes NO pipeline_runs row on any outcome (console only); 202 accepted, then a failed catalog walk just logs. Scheduled at :13 (topshot-active-listings-ingest.yml's minute census). Fix = a new pipeline lane, which is a monitoring decision.",
  "special-serial-sweep": "no pipeline_runs row on any outcome; 202 accepted, per-collection rpc errors only logged. No caller found 10-02.",
  "backfill-allday-pack-supply": "no pipeline_runs row; 200 done:true with pageErrs=1. No caller found 10-02.",
}

const names = functionNames()
install(names.map((n) => new URL(`${n}/index.ts`, FN_ROOT)))
const opts = { sanitizeOps: false, sanitizeResources: false }

function verdicts(run: NonNullable<Awaited<ReturnType<typeof admit>>>): string[] {
  const out: string[] = []
  for (const c of run.calls) {
    if (!c.payload) continue
    const runLog = c.what === "rpc(log_pipeline_run)" || /^from\(pipeline_runs\)\.(insert|upsert|update)\(\)$/.test(c.what)
    if (!runLog) continue
    let p: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(c.payload)
      p = Array.isArray(parsed) ? parsed[0] ?? {} : parsed
    } catch {
      continue
    }
    if (p.p_ok === true || p.ok === true) out.push(`${c.what} recorded ok=true`)
  }
  if (run.background === 0) {
    try {
      const b = JSON.parse(run.body)
      if (b && (b.ok === true || b.status === "ok")) out.push(`synchronous body claims success: ${run.body.slice(0, 120)}`)
    } catch {
      // not JSON: claims nothing
    }
  }
  return out
}

/** Rule (3): a 2xx answer to a run in which everything failed must come with an ok=false row. */
function traceless(run: NonNullable<Awaited<ReturnType<typeof admit>>>): string | null {
  if (typeof run.status !== "number" || run.status < 200 || run.status >= 300) return null
  for (const c of run.calls) {
    if (!c.payload) continue
    if (!(c.what === "rpc(log_pipeline_run)" || /^from\(pipeline_runs\)\.(insert|upsert|update)\(\)$/.test(c.what))) continue
    try {
      const parsed = JSON.parse(c.payload)
      const p = Array.isArray(parsed) ? parsed[0] ?? {} : parsed
      if (p.p_ok === false || p.ok === false) return null
    } catch {
      // unreadable payload: not a trace
    }
  }
  return `HTTP ${run.status} and no ok=false pipeline_runs row: ${run.body.slice(0, 120)}`
}


Deno.test({
  name: "KNOWN names only functions that exist",
  ...opts,
  fn() {
    const stale = [...Object.keys(KNOWN), ...Object.keys(KNOWN_TRACELESS)].filter((k) => !names.includes(k))
    if (stale.length) throw new Error(`KNOWN lists functions not in the tree: ${stale.join(", ")}`)
  },
})

Deno.test({
  name: "positive control: a run that records ok=true after a failed read is flagged",
  ...opts,
  fn() {
    const v = verdicts({
      via: "X",
      status: 200,
      body: "{}",
      background: 1,
      calls: [{ kind: "db", what: "rpc(log_pipeline_run)", payload: JSON.stringify({ p_ok: true, p_error: null }) }],
    })
    if (v.length !== 1) throw new Error(`expected one verdict, got ${JSON.stringify(v)}`)
    const honest = verdicts({
      via: "X",
      status: 200,
      body: '{"ok":true,"message":"queued"}',
      background: 1,
      calls: [{ kind: "db", what: "rpc(log_pipeline_run)", payload: JSON.stringify({ p_ok: false, p_error: "read failed" }) }],
    })
    if (honest.length) throw new Error(`an honest queued run was flagged: ${JSON.stringify(honest)}`)
  },
})

for (const name of names) {
  Deno.test({
    name: `${name}: a run where everything failed does not record success`,
    ...opts,
    async fn() {
      const run = await admit(name, await load(new URL(`${name}/index.ts`, FN_ROOT)))
      if (!run) throw new Error(`${name}: no test credential got past its gate, so this suite cannot see it — teach harness.admit its scheme`)
      const v = verdicts(run)
      const t = traceless(run)
      if (KNOWN_TRACELESS[name]) {
        if (!t) throw new Error(`${name} is listed in KNOWN_TRACELESS but now leaves a trace. Remove it (and note the fix).`)
      } else if (t && !KNOWN[name]) {
        // A KNOWN false-success already fails rule (1)/(2); do not double-list it.
        throw new Error(
          `${name} ran with every database call and upstream failing and left NO trace (via ${run.via}): ${t}\n` +
            `Write an ok=false pipeline_runs row, or answer non-2xx.`,
        )
      }
      if (KNOWN[name]) {
        if (v.length === 0) {
          throw new Error(`${name} is listed in KNOWN but now records the failure honestly. Remove it from KNOWN (and note the fix).`)
        }
        return
      }
      if (v.length) {
        throw new Error(
          `${name} recorded SUCCESS for a run in which every database call and upstream failed (via ${run.via}, HTTP ${run.status}):\n  ` +
            v.join("\n  ") + `\nA failed read is not "nothing to do". Derive ok from what landed.`,
        )
      }
    },
  })
}
