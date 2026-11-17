#!/usr/bin/env node
// RETIRED RULES must not survive anywhere in the LIVE memory surfaces.
//
// ⭐ WHY THIS EXISTS, and it is not a hypothetical. Over 2026-08-24 a memory
// refresh corrected six facts. Every single one was wrong on MORE THAN ONE
// surface, and in three cases the surfaces disagreed with each other in three
// different ways. Nothing had decayed — the corrections had simply never
// PROPAGATED. Two were still being found after the pass that "fixed" them:
//
//   * `.limit(10000)` was corrected in RPC_DESIGN_SYSTEM.md §5 and left intact
//     in the §0 CHECKLIST of the SAME FILE, the section headed "run through this
//     on every edit" — a file contradicting itself.
//   * the retired iPhone-copy-paste handoff rule was corrected in §10 and in the
//     rpc-handoff skill on 2026-07-25, and was still sitting in CLAUDE.md — the
//     highest-authority memory file — on 2026-08-24.
//
// CLAUDE.md's own rule is "when you find one, grep for the EXPRESSION, not the
// file". This guard is that rule, executable, so the next copy cannot survive.
//
// ⛔ SCOPE, and the exclusion rests on a stated POLICY, not on a claim that some
// other instrument covers the rest. FROZEN HISTORY — docs/sessions/**,
// docs/archive/**, docs/overnight/** — legitimately RECORDS retired text; that
// is what a ledger and a session log are FOR. A tree-wide ban would be
// permanently red, and this repo already records that a permanently-red
// instrument is indistinguishable from a broken one at a glance.
//
// ⛔ The .skill bundles are NOT scanned here, deliberately: the bundle-parity
// guard (check-cowork-skill-bundles.mjs) already binds every bundle to its
// SKILL.md, which IS scanned — so a retired rule cannot reach a bundle without
// first passing this guard. That is a claim about a specific sibling instrument,
// and it is checkable: if bundle parity is ever removed, re-scope this guard.
//
// SUPPRESSION IS THE CURATED LIST, exactly as CLAUDE.md prescribes. A doc that
// must QUOTE a retired rule in order to warn about it marks the line:
//     <!-- retired-rule:allow <id> -->
// on that line or the line immediately above. Suppressions are counted and
// reported, so quietly sprinkling them is visible rather than silent.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const rootFlag = process.argv.indexOf("--root");
const ROOT = rootFlag !== -1 ? process.argv[rootFlag + 1] : ".";
const IS_LIVE = rootFlag === -1;

// The population floor below only applies to the live tree, because a fixture is
// deliberately small. That left the floor's own logic UNTESTABLE — and an
// untested watcher is indistinguishable from a broken one, which is this repo's
// standing rule. `--min-files <n>` makes it exercisable from a fixture without
// weakening the live default: live ALWAYS uses LIVE_MIN_FILES.
const minFlag = process.argv.indexOf("--min-files");
const LIVE_MIN_FILES = 15;
const MIN_FILES = IS_LIVE
  ? LIVE_MIN_FILES
  : minFlag !== -1
    ? Number(process.argv[minFlag + 1])
    : 0;

// Each entry was measured wrong on >= 2 surfaces on 2026-08-24. `pattern` must
// match the RETIRED SPELLING, never merely the topic — a topic-matcher would
// red on the correction itself and the suppression list would swallow the file.
const RETIRED = [
  {
    id: "limit-10000-lifts-the-postgrest-cap",
    pattern: /\.?limit\(\s*10000\s*\)/i,
    why: "PostgREST CLAMPS an explicit .limit() above 1000, so this hands back 1000 rows to a caller who believes they have 10,000 — a partial read rendering as a complete one.",
    instead: "Aggregate in SQL, wrap in an RPC, or paginate. For a TOTAL read the returned `count` (head: true), never rows.length.",
  },
  {
    id: "other-is-a-valid-short-form-collection",
    pattern: /`unknown`\s*\/\s*`other`|`ufc`\s*·\s*`unknown`\s*\/\s*`other`/i,
    why: "flowty_transactions_collection_check whitelists exactly six values and `other` is not among them (verified against pg_constraint 2026-08-24).",
    instead: "topshot | allday | golazos | pinnacle | ufc | unknown — and the CHECK is on flowty_transactions ONLY.",
  },
  {
    id: "log-sessions-in-claude-md",
    pattern: /log it[^.\n]{0,40}`?CLAUDE\.md`?\s+Recent sessions/i,
    why: "CLAUDE.md's own rule since the 2026-08-17 restructure is 'write new ones into docs/sessions/ … never here', and the file runs within tens of characters of a hard 40,000-char ceiling — appending there can silently destroy the project's memory.",
    instead: "docs/sessions/<YYYY-MM>.md (prepend, newest-first) + docs/overnight/ledger.md.",
  },
  {
    id: "rolconfig-is-the-effective-read-path-budget",
    pattern: /`?service_role`?\s+with\s+a\s+\*{0,2}30s?\*{0,2}\s+timeout/i,
    why: "rolconfig binds at LOGIN and PostgREST logs in as `authenticator`, so anon's 3s and authenticated's 8s never bind and service_role's 30s does not bound a supabaseAdmin RPC at all.",
    instead: "authenticator's 8s is the real ceiling for anon/authenticated; the bound on a supabaseAdmin RPC is the CLIENT.",
  },
  {
    id: "handoffs-are-iphone-pasteable",
    pattern: /no (?:markdown )?code blocks? \(iPhone|copy-pasted from an iPhone|optimized for iPhone/i,
    why: "Retired 2026-07-25 — handoffs are read and pasted on DESKTOP (PowerShell / Git Bash); normal markdown including fenced code blocks is fine.",
    instead: "Normal markdown, desktop-read.",
  },
  {
    id: "cadence-harness-is-red-on-c1-c2",
    pattern: /currently red on (?:the )?purchase-moment/i,
    why: "ci.yml records C1/C2 fixed and green since 2026-05-30, with continue-on-error REMOVED — cadence-lint is a BLOCKING gate. The stale claim trains a reader to dismiss a genuine red as 'the known audit thing'.",
    instead: "CI is the authority. In a sandbox without the Flow CLI the harness exits 127 (`flow: not found`) — read the error string, not the exit code.",
  },
];

const ALLOW_RE = /<!--\s*retired-rule:allow\s+([a-z0-9-]+)\s*-->/gi;

// Derived by a TREE WALK, never a curated list — a new docs/reference/*.md or a
// new skill would otherwise be outside the guard by construction.
function scopeFiles() {
  const out = [];
  for (const f of ["CLAUDE.md", "RPC_DESIGN_SYSTEM.md"]) {
    const p = join(ROOT, f);
    if (existsSync(p)) out.push(p);
  }
  const refs = join(ROOT, "docs/reference");
  if (existsSync(refs) && statSync(refs).isDirectory()) {
    for (const n of readdirSync(refs).sort()) if (n.endsWith(".md")) out.push(join(refs, n));
  }
  const skills = join(ROOT, "docs/cowork-skills");
  if (existsSync(skills) && statSync(skills).isDirectory()) {
    for (const n of readdirSync(skills).sort()) {
      const p = join(skills, n, "SKILL.md");
      if (existsSync(p)) out.push(p);
    }
  }
  return out;
}

const files = scopeFiles();
const violations = [];
let linesScanned = 0;
let suppressions = 0;

for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    linesScanned++;
    const line = lines[i];
    const context = `${lines[i - 1] ?? ""}\n${line}`;
    const allowed = new Set();
    for (const m of context.matchAll(ALLOW_RE)) allowed.add(m[1].toLowerCase());
    for (const rule of RETIRED) {
      if (!rule.pattern.test(line)) continue;
      if (allowed.has(rule.id)) {
        suppressions++;
        continue;
      }
      violations.push({ file: relative(ROOT, file), line: i + 1, rule, text: line.trim().slice(0, 160) });
    }
  }
}

// ⚠ ASSERT THE COUNT IT INSPECTED. A guard that silently gates an empty set
// reads as coverage in every report; this repo has shipped exactly that before.
if (files.length === 0 || linesScanned === 0) {
  console.error(
    `Retired-rule guard INSPECTED NOTHING (${files.length} file(s), ${linesScanned} line(s)) ` +
      `under root "${ROOT}". A guard that gates an empty set reads as coverage — FAILING instead.`
  );
  process.exit(1);
}
if (files.length < MIN_FILES) {
  console.error(
    `Retired-rule guard scanned only ${files.length} file(s), below the ${MIN_FILES} floor. ` +
      `Expected CLAUDE.md + ` +
      `RPC_DESIGN_SYSTEM.md + docs/reference/**.md + docs/cowork-skills/*/SKILL.md ` +
      `(33 as of 2026-08-24). Broken, or running from the wrong directory — FAILING.`
  );
  process.exit(1);
}

if (violations.length) {
  console.error(`\nRetired-rule guard: ${violations.length} live memory surface(s) still state a RETIRED rule.\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.rule.id}]`);
    console.error(`      ${v.text}`);
    console.error(`      WHY RETIRED: ${v.rule.why}`);
    console.error(`      INSTEAD:     ${v.rule.instead}\n`);
  }
  console.error(
    `Every rule above was measured wrong on MORE THAN ONE surface — the corrections ` +
      `never propagated, they did not decay. Fix the text.\nIf a doc must QUOTE the ` +
      `retired rule to warn about it, mark that line (or the line above) with:\n` +
      `    <!-- retired-rule:allow <id> -->\n`
  );
  process.exit(1);
}

console.log(
  `Retired-rule guard: ${RETIRED.length} retired rule(s) absent from ${files.length} live memory ` +
    `surface(s) (${linesScanned} lines, ${suppressions} documented quote(s)).`
);
