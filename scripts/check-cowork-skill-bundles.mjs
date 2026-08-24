#!/usr/bin/env node
// Cowork skill bundles must match the SKILL.md they were packaged from.
//
// docs/cowork-skills/ holds each skill TWICE: as <name>/SKILL.md (what a human
// edits and reviews in a diff) and as <name>.skill (a zip — the artifact that
// actually gets uploaded and INSTALLED). Nothing in this repo compared them
// until 2026-08-24, and nothing in scripts/, __tests__/ or .github/ referenced
// docs/cowork-skills/ at all, so the whole surface was unguarded.
//
// ⚠ WHY THIS IS NOT COSMETIC. Found on the first run: rpc-handoff's bundle was
// packaged 2026-05-30 and still carried the ORIGINAL "plain text, NO markdown
// code fences — the doc is copy-pasted from an iPhone" rule, plus the matching
// `description:` line. That rule was explicitly CORRECTED on 2026-07-25
// (handoffs are read on desktop; normal markdown is fine) and the correction is
// recorded in RPC_DESIGN_SYSTEM.md §10 and in the repo's SKILL.md. So uploading
// that bundle would have REINSTALLED a rule the project had already retired —
// and because the drift includes `description:`, it also changes what the skill
// TRIGGERS on. A stale bundle does not read as stale; it reads as the skill.
//
// ⛔ WHAT THIS GUARD CANNOT SEE, stated so nobody reads it as broader coverage:
// the copy that actually LOADS lives outside this repo (the account's installed
// skills). On 2026-08-24 the installed rpc-cron-ops was a pre-2026-06-19 export
// MISSING the post-leak secret-safety rule that both the repo file and its
// bundle carry — i.e. drift in the opposite direction, invisible from here.
// This guard covers the direction the REPO controls: edited source, unpackaged
// bundle. Re-uploading is an operator action (see known-issues).
//
// Comparison is on NORMALIZED text (CRLF -> LF, trailing whitespace stripped,
// leading/trailing blank lines trimmed), never bytes: zip archives embed
// mtimes, so a byte comparison would fail on a re-pack that changed nothing.
//
// `--root <dir>` re-points the guard at a fixture tree so its detection can be
// TESTED — a watcher never shown red is indistinguishable from a broken one.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { execFileSync } from "node:child_process";

const rootFlag = process.argv.indexOf("--root");
const ROOT = rootFlag !== -1 ? process.argv[rootFlag + 1] : ".";
const IS_LIVE = rootFlag === -1;
const SKILLS_DIR = join(ROOT, "docs/cowork-skills");

const normalize = (s) =>
  s
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .trim();

// ⚠ Probe for the tool ONCE and fail with its OWN message. Without this, a
// missing `unzip` makes execFileSync throw inside the per-skill try/catch and
// every skill reports "bundle has no readable SKILL.md entry" — a broken
// ENVIRONMENT masquerading as 9 broken bundles. This repo's rule is to read the
// error string, not the fact that something failed; here the guard has to make
// that possible for its own reader.
try {
  execFileSync("unzip", ["-v"], { stdio: "ignore" });
} catch {
  console.error(
    `Cowork skill-bundle guard cannot run: \`unzip\` is not on PATH. This is an ` +
      `ENVIRONMENT failure, not a bundle failure — do NOT read it as drift. ` +
      `Install unzip (CI ubuntu-latest ships it) and re-run.`
  );
  process.exit(1);
}

// Read one entry out of a zip without adding a dependency. Node has no zip
// reader; `unzip -p` is present on CI (ubuntu-latest) and on the dev box.
function readBundleSkill(bundlePath) {
  const out = execFileSync("unzip", ["-p", bundlePath, "SKILL.md"], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return out;
}

// Derived by a TREE WALK, never a curated list — a curated list drifts, and a
// new skill would otherwise be outside the guard by construction.
function skillDirs() {
  if (!existsSync(SKILLS_DIR) || !statSync(SKILLS_DIR).isDirectory()) return [];
  return readdirSync(SKILLS_DIR)
    .sort()
    .filter((n) => {
      const p = join(SKILLS_DIR, n);
      return statSync(p).isDirectory() && existsSync(join(p, "SKILL.md"));
    });
}

const dirs = skillDirs();
const violations = [];
let compared = 0;

for (const name of dirs) {
  const md = join(SKILLS_DIR, name, "SKILL.md");
  const bundle = join(SKILLS_DIR, `${name}.skill`);
  if (!existsSync(bundle)) {
    violations.push({ name, why: `no ${basename(bundle)} bundle beside the source` });
    continue;
  }
  let packed;
  try {
    packed = readBundleSkill(bundle);
  } catch {
    violations.push({ name, why: `bundle has no readable SKILL.md entry` });
    continue;
  }
  compared++;
  if (normalize(readFileSync(md, "utf8")) !== normalize(packed)) {
    violations.push({ name, why: "bundle content differs from SKILL.md — re-pack it" });
  }
}

// ⚠ ASSERT THE COUNT IT INSPECTED. A guard that silently gates an empty set
// reads as coverage in every report. Always-on floor: inspecting NOTHING fails.
if (dirs.length === 0 || compared === 0) {
  console.error(
    `Cowork skill-bundle guard INSPECTED NOTHING (${dirs.length} skill dir(s), ` +
      `${compared} bundle(s) compared) under root "${ROOT}". A guard that gates ` +
      `an empty set reads as coverage — FAILING instead.`
  );
  process.exit(1);
}

// Live-only floor: the real population is 9 skills as of 2026-08-24. Set well
// below it so ordinary pruning does not trip it.
if (IS_LIVE && compared < 5) {
  console.error(
    `Cowork skill-bundle guard compared only ${compared} bundle(s). Expected the ` +
      `docs/cowork-skills/ population (9 as of 2026-08-24). The guard is broken or ` +
      `is running from the wrong directory — this is a FAILURE, not a pass.`
  );
  process.exit(1);
}

if (violations.length) {
  console.error(
    `\nCowork skill-bundle guard: ${violations.length} skill(s) whose uploaded ` +
      `artifact does not match their source.\n`
  );
  for (const v of violations) console.error(`  ${v.name} — ${v.why}`);
  console.error(
    `\nThe .skill zip is what gets UPLOADED and installed, so a stale bundle ` +
      `silently reinstalls retired rules and can change what the skill triggers ` +
      `on (its \`description:\` travels with it).\nRe-pack with: ` +
      `node scripts/pack-cowork-skill.mjs <name>\n`
  );
  process.exit(1);
}

console.log(
  `Cowork skill-bundle guard: ${compared} bundle(s) match their SKILL.md.`
);
