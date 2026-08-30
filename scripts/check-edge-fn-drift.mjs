#!/usr/bin/env node
// Compare every Supabase edge function's DEPLOYED artifact against the repo source.
//
// WHY THIS EXISTS — the one rot class nothing else in this repo can see.
//
// `edge-deno` (CI) type-checks the SOURCE. `edge-inline-copy-drift-guard` and
// `db-invariants-drift-guard` are repo-vs-repo. There is NO repo<->deployed
// comparator anywhere, so an edge function can be fixed, reviewed, tested,
// merged — and still never run. Silently. Indefinitely. While every in-repo
// signal reads green.
//
// That is not hypothetical. Measured 2026-08-07:
//   ingest-allday-pack-opens had been running 2026-07-27 code for 11 days,
//   missing e67606f5's budget-checkpoint fix, so production kept silently
//   dropping AllDay pack opens past the 180-tx cutoff while the repo, its three
//   green tests, and everyone reading `main` believed it fixed.
// A fleet sweep the same day put 31 of 35 eligible functions in that state.
//
// ── TWO TIERS ───────────────────────────────────────────────────────────────
//
// TIER 1 — IMPORT-MAP PROOF (cheap, zero false positives, needs only metadata)
//   A BARE specifier (`@supabase/supabase-js`, `std/http/server.ts`) cannot
//   resolve without an import map. So if the repo source imports one and the
//   deployed function reports `import_map: false`, the deployed artifact CANNOT
//   be a build of the current repo source — it would have failed to boot. Drift
//   is CERTAIN, not inferred.
//
//   ⚠ RELATIVE `../_shared/…` IMPORTS ARE DELIBERATELY *NOT* PART OF THIS PROOF,
//   even though a same-day analysis proposed folding them in. A relative
//   specifier resolves fine WITHOUT an import map (it just needs the file passed
//   in `files`), so "imports from _shared" implies nothing about `import_map`.
//   Including it would have produced the identical list today (every _shared
//   importer also uses a bare specifier, so the clause adds zero) — which is
//   exactly how an unsound rule survives review. Tier 1 stays bare-only so the
//   proof is actually a proof. Drift in a _shared importer is caught by tier 2.
//
// TIER 2 — CONTENT CENSUS (authoritative, needs the deployed body)
//   Fetch each deployed entrypoint, normalise (strip comments + collapse
//   whitespace), diff against the repo file. This is the only census: tier 1 is
//   a LOWER BOUND and is blind to a function whose import STYLE happens to match
//   (e.g. sync-nba-games, which is url-only in both places).
//
// ⚠ TIMESTAMPS CANNOT ANSWER THIS. Comparing deployed `updated_at` to the last
// commit touching a directory is unsound here for three independent reasons, all
// hit in practice: the 2026-08-03 credential-purge force-push restamped every
// commit date; a shallow clone's `git log -1 -- <path>` reports the oldest
// VISIBLE commit, not the true last change; and "a commit touched this dir" is
// not "behaviour changed" (a test fixture counts). Do not reintroduce it.
//
// Usage:
//   node scripts/check-edge-fn-drift.mjs           # report + non-zero exit on drift
//   node scripts/check-edge-fn-drift.mjs --json    # machine-readable
//   node scripts/check-edge-fn-drift.mjs --tier1   # metadata only, skip body fetches
//
// Needs SUPABASE_ACCESS_TOKEN (a `sbp_…` Management API PAT) + SUPABASE_PROJECT_ID.
// Exit 0 clean · 1 drift found · 2 config/transport error.

import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./lib/strip-comments.mjs"

const FUNCTIONS_DIR = "supabase/functions"
const API = "https://api.supabase.com/v1"

// ── Pure core (exported for unit tests; no network, no fs) ──────────────────

/**
 * Every module specifier in a source file, multi-line aware.
 * A line-anchored /^import .* from/ regex MISSES the common multi-line form:
 *   import {
 *     aggregateHoldingsByCollection,
 *   } from "../_shared/institutional-snapshot.ts"
 * That false negative is not theoretical — it produced a wrong reading of
 * snapshot-institutional-wallets on 2026-08-07.
 */
export function moduleSpecifiers(src) {
  return [...src.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1])
}

/** bare | relative | url — only `bare` requires an import map. */
export function specifierKind(spec) {
  if (spec.startsWith(".") || spec.startsWith("/")) return "relative"
  if (/^(https?:|jsr:|npm:|node:|data:)/.test(spec)) return "url"
  return "bare"
}

/** Does this source REQUIRE an import map to resolve? (tier-1 precondition) */
export function requiresImportMap(src) {
  return moduleSpecifiers(src).some((s) => specifierKind(s) === "bare")
}

/**
 * Tier 1. `repo` = [{slug, src}], `deployed` = [{slug, import_map}].
 * Returns {proven, clean, notDeployed, inapplicable}.
 */
export function classifyImportMapDrift(repo, deployed) {
  const bySlug = new Map(deployed.map((d) => [d.slug, d]))
  const proven = [], clean = [], notDeployed = [], inapplicable = []
  for (const { slug, src } of repo) {
    const dep = bySlug.get(slug)
    if (!dep) { notDeployed.push(slug); continue }
    if (!requiresImportMap(src)) { inapplicable.push(slug); continue }
    ;(dep.import_map ? clean : proven).push(slug)
  }
  return { proven, clean, notDeployed, inapplicable }
}

/** Comment/whitespace-insensitive comparison for tier 2. */
export function normaliseSource(src) {
  // The comment strip is the SHARED one. This function used to roll its own,
  // block-regex-first, which meant a `//` comment mentioning a glob path opened
  // a block comment that closed at the next `*/` anywhere in the file — so an
  // arbitrary span of BOTH sources was blanked and any drift inside it was
  // invisible. Both sides are normalised identically either way, so
  // comment-only differences still do not read as drift.
  return stripComments(src)
    .replace(/\s+/g, " ")
    .trim()
}

// ── I/O ────────────────────────────────────────────────────────────────────

function readRepoFunctions() {
  if (!existsSync(FUNCTIONS_DIR)) return []
  return readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "_shared")
    .map((d) => ({ slug: d.name, path: join(FUNCTIONS_DIR, d.name, "index.ts") }))
    .filter((f) => existsSync(f.path))
    .map((f) => ({ ...f, src: readFileSync(f.path, "utf8") }))
}

/**
 * TIER 2 — the content census, and the counters are the point.
 *
 * ⚠ WHY THIS IS NOT JUST A LOOP WITH A TRY/CATCH. It used to be, and every
 * body-read failure went into a bare `catch {}` whose comment said "tier 1 still
 * covers it". Tier 1 does NOT cover it: this file's own header calls tier 1 a
 * LOWER BOUND and tier 2 "the only census". So a run in which EVERY body fetch
 * failed printed the same DRIFT number as a run in which the census completed and
 * found nothing new. The census not running and the census finding nothing were
 * indistinguishable in the output — the failed-read-rendered-as-an-answer defect
 * this repo tracks, committed by a detector against itself.
 *
 * `fetchBody` is injected so this is testable without the network.
 * Returns { contentDrift, bodiesRead, bodiesFailed, bodyFailures, ran }.
 * `ran` is the POSITIVE CONTROL: false means no body was read, so nothing this
 * returns may be presented as a census.
 */
/**
 * The run's exit code, extracted so it can be pinned — it was inline and untested,
 * and it disagreed with the report printed immediately above it.
 *
 * The bug it fixes is LATENT, not live: today tier 1 proves 19 drifted functions,
 * so the run is red for that reason and the disagreement is invisible. The moment
 * those 19 are redeployed with their import maps, `drifted.length` goes to 0 and
 * this process exits 0 — while tier 2, the AUTHORITATIVE tier, has failed on all
 * 38 bodies since 2026-08-09 (the Management API now serves an eszip bundle where
 * this script's `api()` helper calls `r.json()`).
 *
 * The reporting already refuses to publish an all-clear it did not earn: it prints
 * "no PROVEN drift — but the content census did not run, so this is NOT an
 * all-clear." The exit code said 0 anyway, and CI reads the exit code, not the
 * prose. Someone fixing the 19 would have watched the badge go green and
 * reasonably concluded the fleet was clean.
 *
 * ⚠ `--tier1` is deliberately unaffected: when the census was never ATTEMPTED,
 * its not having run is the stated mode, not a failure. A guard that reds on its
 * own documented opt-out is a guard people delete.
 */
export function driftExitCode({ driftedCount, tier2Attempted, tier2Ran }) {
  if (tier2Attempted && !tier2Ran) return 1
  return driftedCount > 0 ? 1 : 0
}

/**
 * DO-NOT-REDEPLOY LIST — functions that are drifted and MUST STAY THAT WAY.
 *
 * These read Deno.env.get("<NAME>_GATE_KEY") in the repo while the secret is
 * UNSET, so deploying makes the gate read "" and fail CLOSED: 403 on every tick.
 * That is the mechanism of the 24h 2026-08-11 AllDay/Pinnacle outage and of the
 * backfill-topshot-pack-supply break, and it is strictly worse than the drift it
 * would "fix".
 *
 * THEY ARE DRIFTED *BECAUSE* THEY WERE NEVER REDEPLOYED, WHICH IS CORRECT.
 * Their drift signature is their documented one: deployed import_map:false while
 * the repo source imports by bare specifier -- exactly what tier 1 keys on. So
 * this report lists them every night, and its old "Redeploy each" line was an
 * instruction to cause an outage.
 *
 * DATED SAMPLE (2026-08-18 deploy-time measurement), not a constant. It goes
 * stale the moment an operator sets one of the secrets, and it is a KNOWN
 * MINIMUM, not exhaustive -- a newly de-hardcoded function would not be here.
 * Re-derive before acting; absence from this list is NEVER clearance to deploy.
 *
 * Excluded deliberately: compute-pinnacle-pack-ev and backfill-topshot-pack-supply
 * WERE deployed after the dual-accept cutoff, so they are safe.
 */
export const GATE_KEY_DEPLOY_BLOCKED = new Set([
  'ingest-allday-pack-opens',
  'ingest-topshot-pack-opens-history',
  'ingest-pinnacle-mints',
  'compute-golazos-pack-ev',
  'backfill-pack-opens-api',
  'backfill-allday-pack-supply',
])

/** Split drifted slugs into those safe to redeploy and those that would 403. */
export function partitionByDeploySafety(slugs, blocked = GATE_KEY_DEPLOY_BLOCKED) {
  const safe = []
  const mustNotDeploy = []
  for (const s of slugs) (blocked.has(s) ? mustNotDeploy : safe).push(s)
  return { safe, mustNotDeploy }
}

export async function runContentCensus({ repo, deployed, attempted = true, fetchBody, maxFailuresKept = 5 }) {
  const contentDrift = []
  const bodyFailures = []
  let bodiesRead = 0
  let bodiesFailed = 0

  if (!attempted) return { contentDrift, bodiesRead, bodiesFailed, bodyFailures, ran: false }

  const bySlug = new Map(deployed.map((d) => [d.slug, d]))
  for (const { slug, src } of repo) {
    if (!bySlug.has(slug)) continue
    try {
      const body = await fetchBody(slug)
      const depSrc = typeof body === "string" ? body : (body?.files?.find((f) => /index\.ts$/.test(f.name))?.content ?? "")
      if (!depSrc) {
        // A 200 with no readable entrypoint is a FAILED READ, not a clean one.
        // Counting it as read would let a shape change on the API silently turn
        // the whole census into "no drift found".
        bodiesFailed++
        if (bodyFailures.length < maxFailuresKept) bodyFailures.push(`${slug}: no index.ts in body response`)
        continue
      }
      bodiesRead++
      if (normaliseSource(depSrc) !== normaliseSource(src)) {
        contentDrift.push({ slug, version: bySlug.get(slug).version, updated_at: bySlug.get(slug).updated_at })
      }
    } catch (e) {
      bodiesFailed++
      // Message only — NEVER the body. A deployed function can carry a gate key and
      // this output goes to a CI log. api() puts the token in a header, not the URL.
      if (bodyFailures.length < maxFailuresKept) bodyFailures.push(`${slug}: ${e.message}`)
    }
  }

  return { contentDrift, bodiesRead, bodiesFailed, bodyFailures, ran: bodiesRead > 0 }
}

class AuthError extends Error {}

async function api(path, token) {
  const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } })
  if (!r.ok) {
    const body = (await r.text()).slice(0, 200)
    // A REJECTED token is categorically different from a network fault and must
    // never read as "nothing to report". The workflow soft-skips when the secret
    // is ABSENT (correct — that is an un-opted-in repo); if it is PRESENT but the
    // API refuses it, this run checked nothing and must go red. The PAT in use
    // expires 2027-07-31, so this path is not hypothetical — it is exactly what
    // an expired or revoked token produces.
    if (r.status === 401 || r.status === 403) {
      throw new AuthError(`Management API REJECTED the token (HTTP ${r.status}) on ${path}: ${body}`)
    }
    throw new Error(`GET ${path} -> HTTP ${r.status}: ${body}`)
  }
  return r.json()
}

async function main() {
  const json = process.argv.includes("--json")
  const tier1Only = process.argv.includes("--tier1")
  const token = process.env.SUPABASE_ACCESS_TOKEN
  const project = process.env.SUPABASE_PROJECT_ID

  if (!token || !project) {
    console.error("config: SUPABASE_ACCESS_TOKEN (sbp_… Management API PAT) and SUPABASE_PROJECT_ID are required.")
    process.exit(2)
  }

  const repo = readRepoFunctions()
  if (repo.length === 0) { console.error(`config: no functions found under ${FUNCTIONS_DIR}`); process.exit(2) }

  let deployed
  try {
    deployed = await api(`/projects/${project}/functions`, token)
  } catch (e) {
    if (e instanceof AuthError) {
      // ::error:: so it is loud in the Actions UI — a nightly unattended job that
      // quietly checked nothing is the failure mode this annotation exists for.
      console.error(`::error::edge-fn drift check DID NOT RUN — ${e.message}`)
      console.error("The secret is configured but was refused. Rotate the PAT and update the SUPABASE_ACCESS_TOKEN repo secret.")
    } else {
      console.error(`transport: ${e.message}`)
    }
    process.exit(2)
  }

  const t1 = classifyImportMapDrift(repo, deployed)

  // Tier 2, extracted so its reporting can be tested without the network. See
  // runContentCensus for why the counters exist.
  const tier2Attempted = !tier1Only
  const census = await runContentCensus({
    repo,
    deployed,
    attempted: tier2Attempted,
    fetchBody: (slug) => api(`/projects/${project}/functions/${slug}/body`, token),
  })
  const { contentDrift, bodiesRead, bodiesFailed, bodyFailures, ran: tier2Ran } = census

  if (tier2Attempted && !tier2Ran) {
    console.error(
      `::error::edge-fn drift TIER 2 DID NOT RUN — ${bodiesFailed} body read(s) attempted, 0 succeeded. ` +
        `The number below is tier 1's LOWER BOUND, not a census: a function whose imports happen to match ` +
        `but whose body drifted is invisible to it.`
    )
    for (const f of bodyFailures) console.error(`  body read failed — ${f}`)
  } else if (tier2Attempted && bodiesFailed > 0) {
    console.error(
      `::warning::edge-fn drift tier 2 read ${bodiesRead} bodies and FAILED on ${bodiesFailed}. ` +
        `Those ${bodiesFailed} are covered only by tier 1's proof, so content drift in them is unmeasured.`
    )
    for (const f of bodyFailures) console.error(`  body read failed — ${f}`)
  }

  const drifted = [...new Set([...t1.proven, ...contentDrift.map((c) => c.slug)])].sort()

  // PERSIST THE POPULATION, not just the count.
  //
  // On 2026-08-08 a fleet sweep recorded 67 deployed functions one day and 66 the
  // next and COULD NOT SAY WHICH ONE CHANGED, because only the count had been
  // kept. That is the same defect this detector exists to catch, committed by the
  // detector's own reporting: a count without its population cannot answer "what
  // changed". The series is the product; tonight's number is just one sample.
  const report = {
    // No timestamp is generated here — the workflow run supplies it. A self-stamped
    // report would differ on every run and defeat diffing two artifacts.
    repo_functions: repo.length,
    deployed_functions: deployed.length,
    proven_drifted: t1.proven.length,
    clean: t1.clean.length,
    unclassifiable: t1.inapplicable.length,
    // ⚠ The persisted artifact is the SERIES, and it recorded tier 1 only. A
    // function that tier 1 calls clean but whose BODY drifted was written down as
    // "clean" — the artifact asserted the opposite of the finding. These fields
    // make the census auditable: a reader can tell a real zero from a census that
    // never ran.
    tier2_attempted: tier2Attempted,
    tier2_ran: tier2Ran,
    bodies_read: bodiesRead,
    bodies_failed: bodiesFailed,
    content_drifted: contentDrift.length,
    content_drifted_slugs: contentDrift.map((c) => c.slug).sort(),
    population: deployed
      .map((d) => ({
        slug: d.slug,
        version: d.version ?? null,
        updated_at: d.updated_at ?? null,
        import_map: d.import_map ?? null,
        in_repo: repo.some((r) => r.slug === d.slug),
        verdict: t1.proven.includes(d.slug)
          ? "proven_drifted"
          : contentDrift.some((c) => c.slug === d.slug)
            ? "content_drifted"
            : t1.clean.includes(d.slug)
              ? // Only claim "clean" if the census actually looked at this one.
                tier2Ran
                ? "clean"
                : "clean_tier1_only"
              : t1.inapplicable.includes(d.slug)
                ? "unclassifiable"
                : "not_in_repo",
      }))
      .sort((a, b) => a.slug.localeCompare(b.slug)),
    in_repo_not_deployed: t1.notDeployed.sort(),
  }
  try {
    writeFileSync("edge-fn-drift-report.json", JSON.stringify(report, null, 2))
  } catch {
    // Reporting must never mask the finding itself.
  }

  if (json) {
    console.log(JSON.stringify({ tier1: t1, contentDrift, drifted }, null, 2))
  } else {
    console.log(`edge-fn drift: ${repo.length} repo functions, ${deployed.length} deployed`)
    // State the census on its own line, every run. Without it a reader cannot tell
    // "tier 2 found nothing new" from "tier 2 read nothing at all" — the two
    // produce an identical DRIFT count.
    console.log(
      tier2Attempted
        ? `content census: ${bodiesRead} body/bodies read, ${bodiesFailed} failed` +
            (tier2Ran ? "" : "  ← CENSUS DID NOT RUN; the count below is a LOWER BOUND")
        : `content census: SKIPPED (--tier1); the count below is a LOWER BOUND`
    )
    console.log()
    if (t1.proven.length) {
      console.log(`PROVEN drifted (repo needs an import map, deployed built without one) — ${t1.proven.length}:`)
      for (const s of t1.proven) console.log(`  ✗ ${s}`)
      console.log()
    }
    if (contentDrift.length) {
      console.log(`CONTENT drift (deployed body != repo source) — ${contentDrift.length}:`)
      for (const c of contentDrift) console.log(`  ✗ ${c.slug}  (deployed v${c.version}, ${c.updated_at})`)
      console.log()
    }
    if (t1.notDeployed.length) console.log(`in repo, NOT deployed: ${t1.notDeployed.join(", ")}\n`)
    console.log(
      drifted.length
        ? (() => {
            const { safe, mustNotDeploy } = partitionByDeploySafety(drifted)
            const head = `DRIFT: ${drifted.length} function(s).`
            const safeLine = safe.length
              ? ` ${safe.length} SAFE to redeploy — deploy each with deno.json in the files list AND import_map_path; omitting the map turns a stale function into a hard-down one.`
              : ` 0 of them are safe to redeploy.`
            // Never let this read as blanket clearance. Naming the blocked ones
            // inline IS the fix: the list is what stops someone working the
            // report top-to-bottom straight into an outage.
            const blockedLine = mustNotDeploy.length
              ? ` ⛔ DO NOT REDEPLOY ${mustNotDeploy.length}: ${mustNotDeploy.join(', ')} — their *_GATE_KEY secrets are UNSET, so deploying makes the gate fail CLOSED and 403 every tick (the 2026-08-11 outage mechanism). They are drifted BECAUSE they were never redeployed, which is correct until an operator sets the secrets.`
              : ``
            return head + safeLine + blockedLine
          })()
        : tier2Ran
          ? "clean: every deployed function matches repo source."
          : // Never publish an all-clear the run did not earn. With no content
            // census this says only that tier 1's PROOF found nothing — which is
            // a much weaker claim than "matches repo source".
            "no PROVEN drift — but the content census did not run, so this is NOT an all-clear."
    )
  }
  process.exitCode = driftExitCode({
    driftedCount: drifted.length,
    tier2Attempted,
    tier2Ran,
  })
}

// Only run when invoked directly, so tests can import the pure core.
if (process.argv[1] && process.argv[1].endsWith("check-edge-fn-drift.mjs")) {
  main().catch((e) => { console.error(`unexpected: ${e.message}`); process.exit(2) })
}
