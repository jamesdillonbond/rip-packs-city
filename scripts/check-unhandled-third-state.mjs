#!/usr/bin/env node
// Unhandled-third-state guard (2026-08-22).
//
// WHY THIS EXISTS. CLAUDE.md's honesty canon says there are always THREE states,
// never two: read failed · read ok + genuinely empty · read ok + unrenderable.
// This guard bans one specific syntactic way of having only two.
//
//     const { data, error } = await supabase.rpc("...");
//     if (error) {
//       push(a warning)
//     } else if (data) {
//       push(the real answer)
//     }
//     // <-- no else. A read that returns NEITHER an error NOR a payload
//     //     pushes NOTHING AT ALL.
//
// The measured instance was app/api/sentinel/route.ts:479, the sentinel's
// "FMV Confidence (canonical TS)" arm — the roadmap's HEADLINE accuracy metric.
// When that RPC returned no payload the arm did not warn, did not error, and did
// not render zero: it VANISHED from the report. Absence in an alert reads as
// "not among today's problems", which is the unfalsifiable-alert sub-class
// CLAUDE.md names as one of the worst, because its output is silence and there
// is nothing to falsify.
//
// ── WHY A BAN AT POPULATION ZERO ──
// Measured across 1,299 .ts/.tsx files at the time of writing: exactly ONE
// instance, now fixed. CLAUDE.md prefers a ban at population zero over an
// allowlist, and this shape has no legitimate use — if a payload branch is worth
// writing, the no-payload case is worth SAYING something about. A guard that
// starts at zero can never punish its own success.
//
// ── THE POSITIVE CONTROL IS BUILT IN, AND IS NOT OPTIONAL ──
// A detector that has silently stopped matching reports "0 violations" and looks
// identical to a clean tree. CLAUDE.md: "Before relying on a watcher, prove it
// can see a FAILURE." So this guard runs itself against a synthetic fixture that
// MUST be flagged, and fails if it is not — before it reports anything about the
// real tree. It also asserts the file count it actually inspected, because
// "0 file(s) checked, exit 0" is the check-tree-corruption theatre.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const rootFlag = process.argv.indexOf("--root");
const ROOT = rootFlag !== -1 ? process.argv[rootFlag + 1] : ".";
const IS_LIVE = rootFlag === -1;

const ROOTS = ["app", "lib", "components", "workers", "supabase/functions"];
const SKIP = new Set(["node_modules", ".next", "__tests__", "tests", "e2e", "dist", "build"]);

const HEAD = /if\s*\(\s*!?([A-Za-z_$][\w$]*)\s*\)\s*\{/g;
const ELIF = /^\}\s*else\s+if\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{/;
const TRAILING_ELSE = /^\s*else\b/;

function matchClose(s, i) {
  let d = 0;
  for (; i < s.length; i++) {
    if (s[i] === "{") d++;
    else if (s[i] === "}") {
      d--;
      if (d === 0) return i;
    }
  }
  return -1;
}

// Find `if (<something error-ish>) {…} else if (<payload>) {…}` with no final else.
function findViolations(src) {
  const out = [];
  HEAD.lastIndex = 0;
  let m;
  while ((m = HEAD.exec(src)) !== null) {
    const errName = m.group ?? m[1];
    const lower = errName.toLowerCase();
    if (!lower.includes("error") && lower !== "err") continue;

    const ob = src.indexOf("{", m.index);
    if (ob === -1) continue;
    const cb = matchClose(src, ob);
    if (cb === -1) continue;

    const rest = src.slice(cb);
    const m2 = ELIF.exec(rest);
    if (!m2) continue;

    const ob2 = src.indexOf("{", cb + m2[0].length - 1);
    if (ob2 === -1) continue;
    const cb2 = matchClose(src, ob2);
    if (cb2 === -1) continue;

    if (TRAILING_ELSE.test(src.slice(cb2 + 1, cb2 + 40))) continue; // three branches — fine

    out.push({
      line: src.slice(0, m.index).split("\n").length,
      errName,
      payloadName: m2[1],
    });
  }
  return out;
}

// ── POSITIVE CONTROL: run before touching the tree. ──
const FIXTURE = `
  const { data, error } = await supabase.rpc("x");
  if (error) {
    checks.push({ status: "warn" });
  } else if (data) {
    checks.push({ status: "ok" });
  }
`;
const NEGATIVE_FIXTURE = `
  const { data, error } = await supabase.rpc("x");
  if (error) {
    checks.push({ status: "warn" });
  } else if (data) {
    checks.push({ status: "ok" });
  } else {
    checks.push({ status: "warn", detail: "no payload" });
  }
`;
if (findViolations(FIXTURE).length !== 1) {
  console.error(
    `Unhandled-third-state guard FAILED ITS OWN POSITIVE CONTROL: the synthetic ` +
      `two-branch fixture was not flagged. The detector has stopped matching, so any ` +
      `"clean" result would be meaningless. FAILING.`
  );
  process.exit(1);
}
if (findViolations(NEGATIVE_FIXTURE).length !== 0) {
  console.error(
    `Unhandled-third-state guard FAILED ITS NEGATIVE CONTROL: a correct ` +
      `three-branch fixture was flagged. The guard would red correct code. FAILING.`
  );
  process.exit(1);
}

function walk(dir, acc) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, acc);
    else if (e.endsWith(".ts") || e.endsWith(".tsx")) acc.push(p);
  }
  return acc;
}

const files = [];
for (const r of ROOTS) {
  const d = join(ROOT, r);
  if (existsSync(d)) walk(d, files);
}

const violations = [];
let inspected = 0;
for (const f of files) {
  let src;
  try {
    src = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  inspected++;
  for (const v of findViolations(src)) violations.push({ file: f, ...v });
}

// Always-on floor: a run that inspected nothing must never read as a pass.
if (inspected === 0) {
  console.error(
    `Unhandled-third-state guard inspected 0 files under "${ROOT}". A guard that ` +
      `reads nothing cannot vouch for anything. FAILING.`
  );
  process.exit(1);
}
// Live-tree floor: the repo is ~1,300 source files. A collapse to a handful means
// the walk lost its roots (a rename, a moved directory) rather than the tree
// getting clean.
if (IS_LIVE && inspected < 500) {
  console.error(
    `Unhandled-third-state guard inspected only ${inspected} files on the live ` +
      `tree, expected 500+. The walk has lost a root directory. FAILING.`
  );
  process.exit(1);
}

if (violations.length > 0) {
  console.error(
    `\nUnhandled-third-state guard: ${violations.length} site(s) branch on error, ` +
      `then on a payload, and say NOTHING when there is neither.\n`
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  if(${v.errName}) … else if(${v.payloadName}) [no else]`);
  }
  console.error(
    `\nA read that returns no error and no payload is a THIRD state. Falling ` +
      `through renders nothing at all — in an alert that is silence, which is ` +
      `indistinguishable from health and cannot be falsified.\n` +
      `Add an else branch that SAYS the read was unreadable. Do not substitute a ` +
      `number: "0" and "unknown" are different claims.\n`
  );
  process.exit(1);
}

console.log(
  `Unhandled-third-state guard: ${inspected} file(s) inspected, 0 violations ` +
    `(positive + negative controls passed).`
);
