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
//   Fetch each deployed bundle — /body serves a Deno eszip since ~2026-08-09 —
//   PARSE it (@deno/eszip: Parser.parseBytes → load → getModuleSource) and
//   compare the entrypoint's stored source against the repo file: directly,
//   then through the canonicalising build→parse roundtrip in
//   scripts/lib/eszip-source.mjs, because the hosted bundler TRANSPILES before
//   storing (types stripped, swc-reprinted) so repo TS and stored source are
//   two dialects of the same module. A CALIBRATION rule guards the dialect
//   bridge: mismatches are findings only once at least one function matches,
//   otherwise the run reports that the census did not run. This is the only
//   census: tier 1 is a LOWER BOUND and is blind to a function whose import
//   STYLE happens to match (e.g. sync-nba-games, url-only in both places).
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
// Needs SUPABASE_ACCESS_TOKEN (a `sbp_…` Management API PAT) + SUPABASE_PROJECT_ID,
// and the @deno/eszip devDependency for tier 2's parse mode.
// Exit 0 clean · 1 drift found · 2 config/transport error.

import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./lib/strip-comments.mjs"
// Static import is safe for the pure-core consumers: eszip-source lazy-loads
// the wasm only when extraction/canonicalisation is actually called.
import { extractEntrypointSource, canonicaliseSource, tightNormalise } from "./lib/eszip-source.mjs"

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
 * ⚠ THE MECHANISM ABOVE WAS RE-DERIVED 2026-09-02 AND IS STATED WRONG FOR THE
 * FOUR THAT REMAIN. It says the secret "is unset". Nothing can enumerate Supabase
 * secrets, so that was never a measurement. What the four DEPLOYED builds actually
 * do (read back via get_edge_function through a redacted-report subagent) is gate
 * on a HARDCODED STRING LITERAL compiled into the artifact; they read no
 * *_GATE_KEY at all. The correct statement of the risk is therefore:
 *
 *   repo HEAD introduces an env-var dependency THE DEPLOYED BUILD DOES NOT HAVE,
 *   and fails closed if it is unset.
 *
 * The conclusion (do not deploy without an operator setting the secret first) is
 * unchanged — but the restated mechanism is what makes the NEXT question askable:
 * "do deployed and HEAD read the same env vars?" If they do, there is no new
 * dependency and the function is safe. That question is what cleared two entries
 * off this list, and it is the check to run before adding one.
 *
 * ⛔ COROLLARY — A GREEN pipeline_runs PROVES NOTHING HERE. All four are fully
 * green (ingest-pinnacle-mints: 2,599/2,599 ok in 7d). That proves cron's ?key=
 * matches the deployed build's baked-in literal. It is not evidence about a
 * secret, because the running program is not the program in the repo.
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
  // ➖ REMOVED 2026-09-02, and deployed the same pass:
  //   backfill-pack-opens-api, backfill-allday-pack-supply
  // Both were blocked on the assumption their gate secret was unset. Re-derived
  // from the deployed sources: each ALREADY reads its own *_GATE_KEY from env and
  // ALREADY fails closed without it, and repo HEAD reads THE SAME var (adding only
  // an optional _OLD rotation fallback). Same requirement before and after ⇒ the
  // deploy could not introduce a new dependency, so the block had no mechanism.
  // Corroborating for backfill-allday-pack-supply: all 3,195 allday_pack_supply
  // rows carry updated_at five minutes AFTER its fail-closed build shipped, which
  // a gate reading "" could not have written — the secret is demonstrably set.
  // ⚠ Over-blocking is not the safe default. It parks a fixable function as
  // permanent drift and trains readers to scroll past the whole list.
])

/**
 * DEFERRED BY DECISION — drifted on purpose, for a reason that is NOT "the gate
 * would fail closed". A THIRD state, added 2026-08-31 because the partition was
 * binary and the report therefore told a reader that a deliberately-undeployed
 * function was "SAFE to redeploy".
 *
 * ⚠ THIS IS NOT A SECOND BLOCKED LIST, and collapsing the two would lose the
 * distinction that matters: a GATE_KEY_DEPLOY_BLOCKED function must not be
 * deployed until an operator sets a SECRET; one of these must not be deployed
 * YET, and the value is the condition that clears it. Different remedy,
 * different owner, different timeline.
 *
 * ⛔ It deliberately does NOT change the exit code. Drift is still drift and the
 * check still exits 1 — suppressing the exit is how a detector goes green while
 * the drift stands, which is the failure this whole file exists to prevent.
 * This changes the ADVICE only.
 *
 * ⚠ DATED SAMPLE, like the list above. Each entry must carry the condition that
 * clears it, so a reader can tell whether it is still true rather than trusting
 * that someone re-checked. Re-derive before acting.
 */
export const DEPLOY_DEFERRED = new Map([
  [
    'sync-nba-projections',
    '\u26d4 ITS _shared DEP CANNOT BE DEPLOYED BY THE MCP PATH \u2014 measured 2026-09-02, and this is a TRANSPORT limit, not a code problem. _shared/nba-projections-parse.ts line 40 is .replace(/[\\u0300-\\u036f]/g, ""), where \\u0300 is SIX LITERAL ASCII CHARACTERS. deploy_edge_function takes file content as a JSON string argument, and JSON decodes \\uXXXX as an escape \u2014 so unless the backslash is itself doubled at every layer, the deploy silently substitutes the two RAW COMBINING MARKS U+0300/U+036F. \u26a0 THE FAILURE IS SILENT AND DELAYED: the raw form behaves IDENTICALLY today, so nothing goes red; it rots later when a Windows mount, an editor re-encode or the next transport drops the invisible marks, at which point accent-stripping stops and the ingest auto-INSERTS duplicate nba_players rows for every accented name (Don\u010di\u0107, Joki\u0107). The header comment on that file predicted exactly this. A 2026-09-02 attempt was ABORTED by its byte-exactness diff rather than shipped \u2014 that gate is what caught it. \u26a0 SECOND REASON, independent: the pipeline is failing 100% on upstream Akamai 403s and is alert-suppressed to 2026-10-14, so this deploy carries a real silent-corruption risk in exchange for ZERO benefit today \u2014 the change is a behaviour-neutral refactor (030b9fa6a, de-dup 8 inline copies into the tested _shared core). CLEARS WHEN: the upstream 403s lift and this pipeline WRITES ROWS AGAIN \u2014 check SELECT max(started_at) FROM pipeline_runs WHERE pipeline = \u2018sync-nba-projections\u2019 AND ok, and verify on ROWS WRITTEN, never on ok (both legs are slate-gated; 08-02/03 recorded 8 runs / 8 ok / rows_written = 0). Deploy it THEN, together with the un-pause, where a real tick can verify it. \u26a0 If deploying via MCP, the post-condition to assert is that the deployed source contains the six-character sequence backslash-u-0-3-0-0, NOT a raw combining mark \u2014 diff the readback, do not trust the deploy response.',
  ],
  [
    'compute-topshot-pack-ev',
    '\u26a0 THE CODE HALF IS DONE \u2014 v59 deployed 2026-09-02 by the cloud pass, which did NOT consult this map (it re-derived tier 1 from list_edge_functions metadata, where the deferral annotation does not exist). Harmless: the function has no caller at all (no cron.job entry, nothing in .github/workflows, zero invocations in 24h of function_edge_logs), so an early deploy is inert rather than premature. The original reason, still true for the half that remains: the pipeline is PAUSED and alert-suppressed to 2026-09-13 (dead upstream host public-api.nbatopshot.com, 530/1033), so the honesty fix has no ticks to correct. CLEARS WHEN: this pipeline TICKS AGAIN \u2014 check `SELECT max(started_at) FROM pipeline_runs WHERE pipeline = \'compute-topshot-pack-ev\'`, not whether "Top Shot is back". \u26a0 Those differ: measured 2026-08-31 09:5xZ, Top Shot FMV freshness had RECOVERED (topshot_fmv_stale_hours 0.2) while the legacy host still returned 530 residentially and this pipeline had 0 ticks in 24h \u2014 FMV is sales-driven and recovered without it. The remaining step is the UN-PAUSE alone; the honest ok:false flag is already deployed and is exactly what tells you the restored pipeline works. Ledger 2026-08-30 + inbox 2026-08-31T0610Z, deploy recorded in ledger 2026-09-01.',
  ],
])

/**
 * Split drifted slugs three ways: safe to redeploy, deferred by decision, and
 * those that would 403. Order-preserving and TOTAL — every input lands in
 * exactly one bucket, so nothing can fall out of the report silently.
 */
export function partitionByDeploySafety(
  slugs,
  blocked = GATE_KEY_DEPLOY_BLOCKED,
  deferred = DEPLOY_DEFERRED,
) {
  const safe = []
  const mustNotDeploy = []
  const deferredSlugs = []
  for (const s of slugs) {
    if (blocked.has(s)) mustNotDeploy.push(s)
    else if (deferred.has(s)) deferredSlugs.push(s)
    else safe.push(s)
  }
  return { safe, mustNotDeploy, deferred: deferredSlugs }
}

/**
 * Which dialect bridge two sources of ONE module meet at, or null for none.
 * Ordered strongest-claim-first; the mode is reported so a calibration shift
 * (e.g. the hosted bundler changing swc versions and "canonical" decaying to
 * "canonical_tight") is visible in the series, not silent.
 *
 * @param {string} repoSrc
 * @param {string} depSrc
 * @param {((src: string) => Promise<string>) | null} [canonicalise]
 * @returns {Promise<"verbatim" | "normalised" | "canonical" | "canonical_tight" | null>}
 */
export async function matchDialects(repoSrc, depSrc, canonicalise = null) {
  if (repoSrc === depSrc) return "verbatim"
  if (normaliseSource(repoSrc) === normaliseSource(depSrc)) return "normalised"
  if (canonicalise) {
    let canon = null
    try {
      canon = await canonicalise(repoSrc)
    } catch {
      // A repo file the canonicaliser cannot process compares on the plain
      // modes above only; returning null here reads as a mismatch, which the
      // calibration rule keeps honest.
      return null
    }
    if (normaliseSource(canon) === normaliseSource(depSrc)) return "canonical"
    if (tightNormalise(canon) === tightNormalise(depSrc)) return "canonical_tight"
  }
  return null
}

/**
 * @param {{
 *   repo: Array<{ slug: string, src: string }>,
 *   deployed: any[],
 *   attempted?: boolean,
 *   fetchBody: (slug: string) => Promise<any>,
 *   maxFailuresKept?: number,
 *   parseEszip?: ((bytes: Uint8Array, opts: { entrypointPath?: string | null }) => Promise<{ source: string }>) | null,
 *   canonicalise?: ((src: string) => Promise<string>) | null,
 * }} args
 */
export async function runContentCensus({ repo, deployed, attempted = true, fetchBody, maxFailuresKept = 5, parseEszip = null, canonicalise = null }) {
  const contentDrift = []
  const bodyFailures = []
  const eszipMisses = []
  const parseMismatches = []
  const parseMatchModes = { verbatim: 0, normalised: 0, canonical: 0, canonical_tight: 0 }
  let bodiesRead = 0
  let bodiesFailed = 0
  let eszipContained = 0
  let eszipParsed = 0
  let eszipAttempted = false

  if (!attempted) return { contentDrift, bodiesRead, bodiesFailed, bodyFailures, eszipMisses, parseMismatches, parseMatchModes, eszipParsed, ran: false }

  const bySlug = new Map(deployed.map((d) => [d.slug, d]))
  for (const { slug, src } of repo) {
    if (!bySlug.has(slug)) continue
    try {
      const body = await fetchBody(slug)
      // ── ESZIP PARSE MODE (2026-08-30, the real tier 2) ─────────────────────
      // Parse the bundle, extract the entrypoint's stored module source, and
      // compare across dialects (see matchDialects). The containment scan
      // below survives only as the fallback for a runtime where the wasm
      // parser is unavailable or a bundle it cannot parse.
      if (body && typeof body === "object" && typeof body.eszip === "string" && parseEszip && body.bytes) {
        const dep = bySlug.get(slug)
        let depSrc = null
        try {
          ;({ source: depSrc } = await parseEszip(body.bytes, { entrypointPath: dep.entrypoint_path ?? null }))
        } catch (e) {
          // A bundle the parser rejects is a FAILED read — never "clean".
          bodiesFailed++
          if (bodyFailures.length < maxFailuresKept) bodyFailures.push(`${slug}: eszip parse failed — ${e.message}`)
          continue
        }
        bodiesRead++
        eszipParsed++
        const mode = await matchDialects(src, depSrc, canonicalise)
        if (mode) parseMatchModes[mode]++
        else parseMismatches.push({ slug, version: dep.version, updated_at: dep.updated_at })
        continue
      }
      // ── ESZIP CONTAINMENT MODE (2026-08-30; FALLBACK ONLY since parse mode) ─
      // Reached only when the wasm parser is unavailable (parseEszip null, or a
      // caller that supplied no bytes). Kept because it needs nothing beyond
      // string ops, and its positive control below already knows its limit: the
      // hosted bundler transpiles, so containment matches nothing on a real
      // fleet and the control converts the run to tier-2-did-not-run rather
      // than 38 unprovable "misses". A MISS here is AMBIGUOUS — real drift and
      // a bundler transformation look identical — so misses go to eszipMisses,
      // never the PROVEN drift set.
      if (body && typeof body === "object" && typeof body.eszip === "string") {
        bodiesRead++
        eszipAttempted = true
        const hay = body.eszip.replace(/\s+/g, " ")
        const needle = src.replace(/\s+/g, " ").trim()
        if (needle && !hay.includes(needle)) {
          eszipMisses.push({ slug, version: bySlug.get(slug).version, updated_at: bySlug.get(slug).updated_at })
        } else {
          eszipContained++
        }
        continue
      }
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

  // ── POSITIVE CONTROL for containment mode (2026-08-30, first live run) ────
  // The dispatched 20:02Z run answered the calibration question: ALL 38 eszip
  // reads missed, while a locally BUILT eszip does contain its source — because
  // Supabase's hosted bundler TRANSPILES (TS -> JS, reformat, specifier
  // rewrites) before bundling, so repo TS can never be byte-contained in a
  // production bundle. A census in which containment matched NOTHING has
  // measured nothing: report tier-2-did-not-run rather than 38 unprovable
  // "misses" that would read as near-findings. If even ONE function is
  // contained, the mode has a positive control and misses become meaningful.
  const eszipAttempts = eszipContained + eszipMisses.length
  if (eszipAttempts > 0 && eszipContained === 0) {
    bodiesFailed += eszipMisses.length
    bodiesRead -= eszipMisses.length
    if (bodyFailures.length < maxFailuresKept) {
      bodyFailures.push(
        `eszip containment matched 0 of ${eszipAttempts} bundles — the bundler transpiles sources, so containment cannot census this fleet (parse the eszip instead: @deno/eszip Parser.parseBytes + ts transpile of the repo side)`
      )
    }
    eszipMisses.length = 0
  }

  // ── PARSE-MODE CALIBRATION (the same philosophy, one level up) ────────────
  // A mismatch between the parsed deployed source and the canonicalised repo
  // source is a REAL finding only if the dialect bridge is proven to work —
  // i.e. at least one function in the fleet matched. With zero matches the
  // likelier story is a comparison defect (the hosted bundler's swc printing
  // differently than @deno/eszip's), and publishing 38 "drifted" would be this
  // detector's containment mistake again, one abstraction higher. So: no
  // calibration -> the parse attempts were failed reads and the run says the
  // census did not run; calibrated -> mismatches are content drift.
  const parseMatched = Object.values(parseMatchModes).reduce((a, b) => a + b, 0)
  if (eszipParsed > 0 && parseMatched === 0) {
    bodiesFailed += parseMismatches.length
    bodiesRead -= parseMismatches.length
    if (bodyFailures.length < maxFailuresKept) {
      bodyFailures.push(
        `eszip parse mode matched 0 of ${eszipParsed} parsed bundles under every dialect bridge — uncalibrated, so these mismatches prove nothing; fix the comparison (dialect gap between the hosted bundler and @deno/eszip) before believing any of it`
      )
    }
    parseMismatches.length = 0
  } else {
    for (const m of parseMismatches) contentDrift.push(m)
  }

  return { contentDrift, bodiesRead, bodiesFailed, bodyFailures, eszipMisses, parseMismatches, parseMatchModes, eszipParsed, ran: bodiesRead > 0 }
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

// The /body endpoint's answer changed shape (~2026-08-09): it now serves the
// deployed eszip bundle as bytes. Read bytes; hand back {eszip} for bundles,
// parsed JSON for the old shape, raw text otherwise. Errors mirror api().
async function apiBody(path, token) {
  const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } })
  if (!r.ok) {
    const body = (await r.text()).slice(0, 200)
    if (r.status === 401 || r.status === 403) {
      throw new AuthError(`Management API REJECTED the token (HTTP ${r.status}) on ${path}: ${body}`)
    }
    throw new Error(`GET ${path} -> HTTP ${r.status}: ${body}`)
  }
  const buf = Buffer.from(await r.arrayBuffer())
  // `bytes` feeds the parser; `eszip` (latin1 text view) feeds the containment
  // fallback and keeps the pre-parse-mode result shape stable for callers.
  if (buf.subarray(0, 5).toString("utf8") === "ESZIP") return { eszip: buf.toString("latin1"), bytes: new Uint8Array(buf) }
  const text = buf.toString("utf8")
  try { return JSON.parse(text) } catch { return text }
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
    fetchBody: (slug) => apiBody(`/projects/${project}/functions/${slug}/body`, token),
    parseEszip: extractEntrypointSource,
    canonicalise: canonicaliseSource,
  })
  const { contentDrift, bodiesRead, bodiesFailed, bodyFailures, eszipMisses, parseMatchModes, eszipParsed, ran: tier2Ran } = census
  const parseMatched = Object.values(parseMatchModes ?? {}).reduce((a, b) => a + b, 0)

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

  if (eszipMisses.length > 0) {
    console.error(
      `::warning::eszip containment: ${eszipMisses.length} function(s) whose repo source is NOT contained in the deployed bundle — ` +
        `probable content drift, UNPROVEN (containment cannot distinguish drift from a bundler transformation): ` +
        eszipMisses.map((m) => m.slug).join(", ")
    )
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
    eszip_misses: eszipMisses.map((m) => m.slug).sort(),
    // Parse-mode calibration series: how many bundles the parser read, and at
    // which dialect bridge each match landed. A drift here (canonical decaying
    // to canonical_tight, or matched dropping toward 0) is the early warning
    // that the hosted bundler changed dialects under the census.
    eszip_parsed: eszipParsed ?? 0,
    eszip_parse_matched: parseMatched,
    eszip_parse_match_modes: parseMatchModes ?? {},
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
            : eszipMisses.some((m) => m.slug === d.slug)
              ? "eszip_uncontained"
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
            (eszipParsed > 0
              ? ` (eszip-parsed ${eszipParsed}, matched ${parseMatched}` +
                (parseMatched > 0
                  ? `: ` + Object.entries(parseMatchModes).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(" ")
                  : ``) +
                `)`
              : "") +
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
            const { safe, mustNotDeploy, deferred } = partitionByDeploySafety(drifted)
            const head = `DRIFT: ${drifted.length} function(s).`
            const safeLine = safe.length
              ? ` ${safe.length} SAFE to redeploy — deploy each with deno.json in the files list AND import_map_path; omitting the map turns a stale function into a hard-down one.`
              : ` 0 of them are safe to redeploy.`
            // A function deferred BY DECISION is not "safe to redeploy" — it is
            // drifted on purpose. Naming the condition that clears it is the
            // point: without it this reads as an unexplained exception and the
            // next session either deploys it or re-derives the reasoning.
            const deferredLine = deferred.length
              ? ` ⏸ DEFERRED BY DECISION ${deferred.length}: ${deferred
                  .map((s) => `${s} — ${DEPLOY_DEFERRED.get(s)}`)
                  .join(' | ')}`
              : ``
            // Never let this read as blanket clearance. Naming the blocked ones
            // inline IS the fix: the list is what stops someone working the
            // report top-to-bottom straight into an outage.
            const blockedLine = mustNotDeploy.length
              ? ` ⛔ DO NOT REDEPLOY ${mustNotDeploy.length}: ${mustNotDeploy.join(', ')} — their DEPLOYED builds gate on a HARDCODED literal and read no *_GATE_KEY, while repo HEAD reads one from env and fails CLOSED without it — so deploying introduces a dependency that is not currently in force and 403s every tick (the 2026-08-11 outage mechanism). ⛔ Their green pipeline_runs is NOT evidence the secret exists: it proves cron matches the old build's literal. They are drifted BECAUSE they were never redeployed, which is correct until an operator sets the secrets. Re-derived 2026-09-02; absence from this list is never clearance — diff deployed-vs-HEAD env names first.`
              : ``
            return head + safeLine + deferredLine + blockedLine
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
