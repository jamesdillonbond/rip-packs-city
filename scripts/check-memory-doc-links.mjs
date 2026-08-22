#!/usr/bin/env node
// Memory-doc link guard (2026-08-22).
//
// WHY THIS EXISTS. The 2026-08-17 restructure bet this project's whole memory
// architecture on POINTERS: CLAUDE.md was cut to what a session needs before it
// knows its topic, and everything else moved verbatim into docs/reference/*.md
// with a one-line pointer left behind. That trade is only sound while the
// pointers RESOLVE. A rotted link does not look broken — it looks like a detail
// that was never written, which is exactly the failure CLAUDE.md's own header
// warns about ("a rule that feels missing is in one of those files").
//
// Found by a sweep on 2026-08-22: two links in docs/reference/ pointed at
// repo-root files (`vercel.json`, `vitest.config.ts`) WITHOUT the `../../`
// prefix, so both resolved to docs/reference/<file> and silently missed. Both
// fixed in the same commit; this guard is what stops them regrowing.
//
// ── SCOPE, AND WHY IT IS NOT THE WHOLE TREE ──
// Gated set = CLAUDE.md + docs/reference/**.md — the files a session reads
// BEFORE it knows its topic, i.e. the ones whose pointers are load-bearing.
//
// ⚠ A tree-wide check is NOT possible and must not be attempted. Measured
// 2026-08-22: 558 of 919 relative links across docs/ are broken, concentrated
// in docs/sessions (324), docs/overnight (125) and docs/archive (59). Those are
// FROZEN HISTORY that CLAUDE.md explicitly forbids rewriting, so a tree-wide
// guard would be permanently red — and this repo already records that a
// permanently-red instrument is indistinguishable from a broken one at a glance.
// The exclusion here rests on a stated project POLICY (frozen history), not on
// a claim that some other instrument covers those files. Nothing does.
//
// This is a BAN AT POPULATION ZERO: the gated set was brought to 0 broken links
// in the commit that added this file, so any breakage is new and fails hard.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, normalize } from "node:path";

// `--root <dir>` re-points the guard at a fixture tree so its detection can be
// TESTED. Without it the guard could only ever be observed passing on the live
// tree, and this repo's own rule is that a watcher never shown red is
// indistinguishable from a broken one. Live behaviour is unchanged.
const rootFlag = process.argv.indexOf("--root");
const ROOT = rootFlag !== -1 ? process.argv[rootFlag + 1] : ".";
const IS_LIVE = rootFlag === -1;

const REFERENCE_DIR = join(ROOT, "docs/reference");
const EXTRA_FILES = [join(ROOT, "CLAUDE.md")];

// Derived by a TREE WALK, never a curated list — a curated list drifts, and a
// new docs/reference/*.md would otherwise be outside the guard by construction.
function gatedFiles() {
  const out = [...EXTRA_FILES.filter((f) => existsSync(f))];
  if (existsSync(REFERENCE_DIR) && statSync(REFERENCE_DIR).isDirectory()) {
    for (const name of readdirSync(REFERENCE_DIR).sort()) {
      if (name.endsWith(".md")) out.push(join(REFERENCE_DIR, name));
    }
  }
  return out;
}

const LINK_RE = /\[([^\]]{1,120})\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

const files = gatedFiles();
const violations = [];
let linksChecked = 0;

for (const file of files) {
  const base = dirname(file);
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(LINK_RE)) {
    const raw = m[2].trim();
    // Anchors, external schemes and bare fragments are not filesystem targets.
    if (!raw || raw.startsWith("#")) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
    const target = raw.split("#")[0].trim();
    if (!target) continue;
    linksChecked++;
    if (!existsSync(normalize(join(base, target)))) {
      violations.push({ file, target });
    }
  }
}

// ⚠ ASSERT THE COUNT IT INSPECTED. check-tree-corruption.mjs shipped as pure
// theatre because its default mode inspected NOTHING on a CI checkout and still
// exited 0. A guard that silently gates an empty set reads as coverage in every
// report. These floors are deliberately far below the real population (1 + 20
// files, ~180 links as of 2026-08-22) so ordinary pruning does not trip them.
// Always-on floor: inspecting NOTHING is a failure in every mode.
if (files.length === 0 || linksChecked === 0) {
  console.error(
    `Memory-doc link guard INSPECTED NOTHING (${files.length} file(s), ` +
      `${linksChecked} link(s)) under root "${ROOT}". A guard that gates an ` +
      `empty set reads as coverage in every report — FAILING instead.`
  );
  process.exit(1);
}

// Richer floors apply only to the LIVE tree, where the real population is known
// (1 + 22 files, 79 links as of 2026-08-22). A fixture run is deliberately small.
if (IS_LIVE && files.length < 5) {
  console.error(
    `Memory-doc link guard INSPECTED ALMOST NOTHING (${files.length} file(s)). ` +
      `Expected CLAUDE.md + docs/reference/**.md. The guard is broken or is ` +
      `running from the wrong directory — this is a FAILURE, not a pass.`
  );
  process.exit(1);
}
if (IS_LIVE && linksChecked < 20) {
  console.error(
    `Memory-doc link guard found only ${linksChecked} relative link(s) across ` +
      `${files.length} file(s). That is implausibly few — the link regex or the ` +
      `file set has broken. Treating as a FAILURE rather than a clean run.`
  );
  process.exit(1);
}

if (violations.length > 0) {
  console.error(
    `\nMemory-doc link guard: ${violations.length} BROKEN relative link(s) in ` +
      `the load-bearing memory docs.\n`
  );
  for (const v of violations) {
    console.error(`  ${v.file} -> ${v.target}`);
  }
  console.error(
    `\nThese files are how a session finds detail that was deliberately moved ` +
      `OUT of CLAUDE.md, so a dead pointer reads as "never written" rather ` +
      `than "broken".\n` +
      `Fix the path — note that a link from ${REFERENCE_DIR}/ to a repo-root ` +
      `file needs the ../../ prefix (the exact bug this guard was written for).\n`
  );
  process.exit(1);
}

console.log(
  `Memory-doc link guard: ${linksChecked} relative link(s) across ` +
    `${files.length} file(s) all resolve.`
);
