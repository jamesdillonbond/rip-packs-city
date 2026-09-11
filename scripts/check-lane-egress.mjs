#!/usr/bin/env node
/**
 * scripts/check-lane-egress.mjs
 *
 * WHY THIS EXISTS (2026-09-10 PT)
 * -------------------------------
 * On 2026-09-10 ten lanes lost every scheduler they had (#76 the Vercel
 * spend-cap pause killed cron-job.org's entries, #80 GitHub then shed every
 * scheduled tick for 2.8h). Nine of them sit behind INGEST_SECRET_TOKEN and
 * their durable fix is a credential decision. ONE — `wmc-fmv-populate` — turned
 * out to be a pure-database lane wearing an HTTP route as a coat, so pg_cron can
 * drive it with no token, no Vercel and no GitHub in the path. It now has a
 * conditional pg_cron backstop (`rpc_wmc_fmv_populate_backstop`) whose entire
 * justification is that property.
 *
 * ⚠ NOTHING CHECKED THAT PROPERTY, AND THE OBVIOUS CHECK GETS IT WRONG.
 * The first pass at this question grepped the ROUTE FILE:
 *
 *     grep -cE 'fetch\(|https?://' app/api/wmc-fmv-populate/route.ts   ->  0
 *
 * That returns 0 for FOUR of the ten lanes. Two of those four — `snapshot-pack-asks`
 * and `ownership-onchain-walk` — make external calls anyway, one via
 * `lib/packs/live-pack-listings.ts:233` (`fetch(TOPSHOT_GRAPHQL)`) and one via
 * `@onflow/fcl`, which does its network IO inside the package. The route-file
 * grep would have called both "pure DB" and any pg_cron backstop built on that
 * answer would have silently done LESS than the route does. This repo already
 * records the general form: a guard that walks `app/api/cron` is blind to the
 * copy sitting in the `lib/` module two routes delegate to.
 *
 * So this classifies by a TRANSITIVE import walk, and it counts CALL SITES, not
 * URL strings. `lib/collections.ts` contains 28 `https://` lines and not one of
 * them is a fetch — they are config constants and URL builders. Counting strings
 * would have called `wmc-fmv-populate` NEEDS-EGRESS and thrown away the one real
 * finding. The discriminator is an invocation.
 *
 * WHICH WAY IT ROUNDS, AND WHY
 * ----------------------------
 * Reachability is approximated by IMPORT, not by call graph: if a module in the
 * transitive tree contains an egress call site, the lane is NEEDS-EGRESS even if
 * the route never calls that particular export. That over-approximates in the
 * SAFE direction and the asymmetry is deliberate:
 *
 *   a false NEEDS-EGRESS costs one lane not moving to pg_cron — nothing breaks;
 *   a false PURE-DB ships a backstop that quietly does less than the lane it
 *   replaces, which is the failure this whole file exists to prevent.
 *
 * ⚠ IT IS A STATIC READ AND CANNOT SEE RUNTIME EGRESS: a URL assembled from a
 * env var and handed to a helper resolved at runtime, or a bare dependency that
 * opens a socket without matching NET_PKG. It is a drift alarm on a claim that is
 * currently true, not a proof of isolation. Re-derive before trusting it for a
 * NEW backstop.
 *
 * THE LANE LIST IS A TREE WALK, NOT A CURATED LIST. It is read from every
 * `url:` in .github/workflows/dead-lane-backstop.yml, so a lane added to the
 * backstop is enrolled here automatically and arrives as an UNPINNED drift
 * failure rather than as silence.
 *
 * ⚠ ZERO LANES IS RED, NOT GREEN. If the workflow is renamed or the `url:` shape
 * changes, this must fail loudly instead of passing having inspected nothing —
 * this repo has already shipped a staged-only guard that inspected NOTHING on a
 * CI checkout and exited 0.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
// ⚠ The SHARED stripper, never a fresh copy — a local one is banned at zero here,
// and that ban earned its keep on this very file: the hand-rolled stripper this
// started with deleted block comments INCLUDING their newlines, so every line
// number it printed after one was too low — it reported the snapshot-pack-asks
// fetch at live-pack-listings.ts:219 when the truth is :233. The classification
// was right and the evidence a human would click was wrong, which is this repo's
// "fix the guard AND the record" all over again. Line-number fidelity is pinned
// in the test; do not swap this out for anything that collapses lines.
// because a blind stripper does not error: it returns text, the guard still runs,
// still prints a population and still passes. This repo has been blinded by one
// three times. The comment case is pinned in this guard's own test.
import { stripComments } from "./lib/strip-comments.mjs";

const ROOT = process.cwd();
const WORKFLOW = ".github/workflows/dead-lane-backstop.yml";

/**
 * THE PINNED CLAIM. Each lane's classification as measured 2026-09-10 PT.
 * A lane may only be "pure-db" here if a human has read WHY — the whole point is
 * that a pg_cron backstop can be built on it without a credential.
 *
 * ⚠ This is the SUPPRESSION list, not the subject list: the subjects come from
 * the workflow. An entry here with no matching lane in the workflow is also a
 * failure, so a deleted lane cannot rot into a stale pin.
 */
const PINNED = {
  "cron/alerts-dispatch": "pure-db",
  "cron/alerts-send": "needs-egress",
  "allday-listings-indexer": "needs-egress",
  "allday-listings-retry": "needs-egress",
  "golazos-listings-indexer": "needs-egress",
  "pinnacle-listings-retry": "needs-egress",
  "cron/pinnacle-events-ingest": "needs-egress",
  "cron/snapshot-pack-asks": "needs-egress",
  "wmc-fmv-populate": "pure-db",
  "cron/ownership-onchain-walk": "needs-egress",
};

const EXTS = [".ts", ".tsx", ".mts", ".js", ".mjs"];

/** An INVOCATION, not a string constant. `https://x` is config; `fetch(` is egress. */
const CALL_RE =
  /(?<![.\w])fetch\s*\(|\baxios\s*(?:\.\w+)?\s*\(|\bgot\s*\(|new\s+XMLHttpRequest|\bfcl\.(?:send|query|mutate|decode)\s*\(|\bhttps?\.request\s*\(/;

/** Bare deps that perform network IO inside the package, where no call site is visible here. */
const NET_PKG = /^(@onflow\/fcl|axios|node-fetch|undici|got|graphql-request|ky)$/;

const SPEC_RES = [
  /(?:^|\n)\s*import\s+(?:[^'"]*?from\s*)?['"]([^'"]+)['"]/g,
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /(?:^|\n)\s*export\s+(?:\*|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/g,
];

/**
 * ⚠ `exists` is injected, not closed over: the tests drive this against an
 * in-memory tree, and a resolver that reached for the real filesystem would make
 * every transitive mutation case silently unresolvable — which is to say, GREEN.
 * That is exactly how a mutation test comes to prove nothing.
 */
function resolveSpec(spec, fromFile, exists) {
  let base;
  if (spec.startsWith("@/")) base = path.join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null;
  for (const e of EXTS) {
    const c = base + e;
    if (exists(c)) return c;
  }
  for (const e of EXTS) {
    const c = path.join(base, "index" + e);
    if (exists(c)) return c;
  }
  return exists(base) ? base : null;
}

/** The real-filesystem predicate: a FILE, never a directory. */
const existsAsFile = (f) => fs.existsSync(f) && fs.statSync(f).isFile();

/** Read the lanes the backstop actually drives. Returns [{lane, routeFile}]. */
export function lanesFromWorkflow(workflowText) {
  const out = [];
  const seen = new Set();
  const re = /url:\s*https?:\/\/[^/\s]+\/api\/([A-Za-z0-9/_-]+)/g;
  let m;
  while ((m = re.exec(workflowText))) {
    const lane = m[1].replace(/\/+$/, "");
    if (seen.has(lane)) continue;
    seen.add(lane);
    out.push({ lane, routeFile: path.join(ROOT, "app", "api", lane, "route.ts") });
  }
  return out;
}

/** Transitive, repo-local. Returns {klass, files, calls, deps}. */
export function classifyLane(entryFile, { readFile = (f) => fs.readFileSync(f, "utf8"), exists = existsAsFile } = {}) {
  const seen = new Set();
  const stack = [entryFile];
  const calls = [];
  const deps = [];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f) || !exists(f)) continue;
    seen.add(f);
    const code = stripComments(readFile(f));
    code.split("\n").forEach((line, i) => {
      if (CALL_RE.test(line)) calls.push(`${path.relative(ROOT, f)}:${i + 1}`);
    });
    for (const re of SPEC_RES) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(code))) {
        const spec = m[1];
        if (NET_PKG.test(spec)) deps.push(`${spec} (via ${path.relative(ROOT, f)})`);
        const r = resolveSpec(spec, f, exists);
        if (r) stack.push(r);
      }
    }
  }
  const klass = calls.length === 0 && deps.length === 0 ? "pure-db" : "needs-egress";
  return { klass, files: seen.size, calls, deps };
}

/**
 * The verdict logic, pure and fully testable: given the derived lanes, a
 * classifier and the pinned map, produce the failure list. Every red branch this
 * guard has lives here, so every red branch can be mutation-tested without a
 * filesystem.
 */
export function evaluateLanes(lanes, classify, pinned) {
  const failures = [];
  const rows = [];

  // ⚠ Satisfiable-at-zero is the WRONG property here: zero lanes means the
  // derivation broke, not that every lane is clean.
  if (lanes.length === 0) {
    failures.push(
      `parsed 0 lanes out of ${WORKFLOW}. The \`url:\` shape changed and this guard is inspecting nothing.`
    );
    return { rows, failures };
  }

  for (const lane of lanes) {
    const result = classify(lane);
    if (result === null) {
      failures.push(`${lane.lane}: the backstop drives /api/${lane.lane} but its route file does not exist`);
      continue;
    }
    const pin = pinned[lane.lane];
    rows.push({ lane: lane.lane, ...result, pinned: pin });

    if (pin === undefined) {
      failures.push(`${lane.lane}: driven by the backstop but not pinned here. Classified ${result.klass} — read why, then pin it.`);
    } else if (result.klass !== pin) {
      failures.push(
        `${lane.lane}: pinned ${pin}, measured ${result.klass}.` +
          (pin === "pure-db"
            ? " A pg_cron backstop may rest on this lane being credential-free; that claim is now false."
            : " It may now be movable to pg_cron with no credential — re-read and re-pin.")
      );
    }
  }

  const laneNames = new Set(lanes.map((l) => l.lane));
  for (const pinnedLane of Object.keys(pinned)) {
    if (!laneNames.has(pinnedLane)) {
      failures.push(`${pinnedLane}: pinned here but no longer driven by the backstop. Remove the pin or restore the lane.`);
    }
  }

  return { rows, failures };
}

function main() {
  const wfPath = path.join(ROOT, WORKFLOW);
  if (!fs.existsSync(wfPath)) {
    console.error(`FAIL: ${WORKFLOW} not found. The lane list is derived from it; with the file gone this guard inspects nothing.`);
    process.exit(1);
  }
  const lanes = lanesFromWorkflow(fs.readFileSync(wfPath, "utf8"));

  const { rows, failures } = evaluateLanes(
    lanes,
    ({ routeFile }) => (fs.existsSync(routeFile) ? classifyLane(routeFile) : null),
    PINNED
  );

  console.log(`Lane egress classification — ${lanes.length} lanes derived from ${WORKFLOW}\n`);
  for (const r of rows) {
    const mark = r.pinned === undefined ? "NEW" : r.klass === r.pinned ? "ok " : "DRIFT";
    console.log(`  [${mark}] ${r.lane.padEnd(30)} ${r.klass.padEnd(13)} files=${String(r.files).padStart(2)}  calls=${r.calls.length} deps=${r.deps.length}`);
    for (const c of r.calls) console.log(`            egress call  ${c}`);
    for (const d of r.deps) console.log(`            network dep  ${d}`);
  }

  const pure = rows.filter((r) => r.klass === "pure-db").map((r) => r.lane);
  console.log(`\nInspected ${rows.length} lanes; ${pure.length} pure-db (${pure.join(", ") || "none"}).`);

  if (failures.length) {
    console.error(`\nFAIL (${failures.length}):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("PASS: every backstopped lane matches its pinned egress class.");
}

// ⚠ pathToFileURL, not a `file://` + argv[1] concatenation: argv[1] is a PATH and
// import.meta.url is a URL. They coincide on POSIX and never on Windows.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
