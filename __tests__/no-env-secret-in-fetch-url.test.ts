import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

// ── A secret belongs in a HEADER, never in a URL ─────────────────────────────
// Request logs record full URLs. A token in a query string is therefore written
// to a log store on every call, and the tokens in question here are SHARED —
// `INGEST_SECRET_TOKEN` gates ~15 edge functions and a dozen Vercel routes, so
// one leaked URL is not one leaked route.
//
// ⛔ Do NOT "confirm" an instance of this by reading the logs. Reading them IS
// the leak. The caller's SOURCE is the proof, which is what this file checks.
//
// This class has now recurred twice and been fixed twice:
//   · `app/api/cron/sales-serial-backfill/route.ts` — `?token=` to a Supabase
//     edge fn, ~12x/day.
//   · `app/api/ufc-pipeline/route.ts` — `?token=` to two of our own routes; the
//     sales-indexer call was ALREADY sending the correct Bearer header, so its
//     query param was pure redundancy that leaked.
// Two recurrences is what earns a ratchet rather than a third fix.
//
// ⚠ Deliberately scoped to secrets that come from `process.env`. Unsubscribe and
// email-confirm links legitimately carry a per-row token in a URL — that token is
// addressed to one recipient, is not shared, and the URL is the delivery
// mechanism. Widening this to every `?token=` would redden those for no gain.

const ROOTS = ["app", "lib", "scripts"]

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const e of entries) {
    if (e === "node_modules" || e === ".next") continue
    const p = join(dir, e)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e)) out.push(p)
  }
  return out
}

/** Names assigned from `process.env` anywhere in the file. */
function envBackedNames(src: string): Set<string> {
  const names = new Set<string>()
  const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*process\.env\.[A-Z0-9_]+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) names.add(m[1])
  return names
}

describe("no env-backed secret is interpolated into a fetch URL", () => {
  it("every source file keeps process.env secrets out of query strings", () => {
    const offenders: string[] = []

    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const src = readFileSync(file, "utf8")
        if (!src.includes("process.env")) continue
        const envNames = envBackedNames(src)
        if (envNames.size === 0) continue

        const lines = src.split("\n")
        lines.forEach((line, i) => {
          // Ignore comments — this rule is DOCUMENTED in prose in the very files
          // that fixed it, and an unanchored match would fire on its own warning.
          const t = line.trimStart()
          if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return

          // `…?token=${X}…` / `&key=${X}` where X (or X's base) is env-backed.
          const re = /[?&](?:token|key|secret|api_key|apikey|access_token)=\$\{\s*(?:encodeURIComponent\(\s*)?([A-Za-z_$][\w$]*)/gi
          let m: RegExpExecArray | null
          while ((m = re.exec(line))) {
            if (envNames.has(m[1])) {
              offenders.push(`${file}:${i + 1}  ${t.slice(0, 100)}`)
            }
          }
        })
      }
    }

    // ── The allowance, and why it is two-way ──────────────────────────────
    // Exactly ONE site is still permitted, because fixing it alone would cause
    // the outage it is meant to prevent: deployed `enrich-ufc-wallet` v47 reads
    // the Authorization header nowhere, so header-only 401s a user-facing UFC
    // wallet scan. Its header-accepting build is committed and registered in
    // scripts/check-edge-fn-drift.mjs → DEPLOY_DEFERRED.
    //
    // ⚠ The check runs in BOTH directions on purpose. An allowance that merely
    // suppresses is how a "temporary" exception becomes permanent: once the
    // deploy lands and the caller moves to a header, this entry stops matching
    // and the test FAILS, telling you to delete the allowance. A one-way
    // allowlist would have gone quiet instead and left the exemption in place
    // guarding nothing — the same shape as a guard that keeps shouting after
    // its fix, just inverted.
    const ALLOWED = ["app/api/ufc-wallet-scan/route.ts"]

    const unexpected = offenders.filter(
      (o) => !ALLOWED.some((a) => o.startsWith(a + ":")),
    )
    const staleAllowances = ALLOWED.filter(
      (a) => !offenders.some((o) => o.startsWith(a + ":")),
    )

    expect(
      staleAllowances,
      `An allowance in this test no longer matches any leak — the fix has landed.\n` +
        `DELETE the entry (and the comment block explaining it) rather than leaving\n` +
        `an exemption that guards nothing:\n\n` + staleAllowances.join("\n"),
    ).toEqual([])

    expect(
      unexpected,
      `A secret read from process.env is being placed in a URL query string.\n` +
        `Send it as an Authorization header instead — request logs record full URLs.\n` +
        `⛔ Do not read the logs to assess the impact; reading them is the leak.\n\n` +
        unexpected.join("\n"),
    ).toEqual([])
  })
})
