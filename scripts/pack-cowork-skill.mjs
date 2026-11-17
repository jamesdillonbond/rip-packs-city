#!/usr/bin/env node
// Re-pack docs/cowork-skills/<name>/SKILL.md into <name>.skill.
//
// DETERMINISTIC on purpose: the zip entry carries a FIXED timestamp, so
// re-packing unchanged content produces byte-identical output. Without that,
// every re-pack would show as a binary diff and reviewers would stop reading
// them — which is how the stale bundle survived from 2026-05-30 to 2026-08-24.
//
// Usage: node scripts/pack-cowork-skill.mjs <name> [<name>...]
//        node scripts/pack-cowork-skill.mjs --all

import { readdirSync, existsSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zipFiles } from "./lib/zip-one-file.mjs";

const SKILLS_DIR = "docs/cowork-skills";

let names = process.argv.slice(2);
if (names.includes("--all")) {
  names = readdirSync(SKILLS_DIR)
    .sort()
    .filter((n) => {
      const p = join(SKILLS_DIR, n);
      return statSync(p).isDirectory() && existsSync(join(p, "SKILL.md"));
    });
}
if (!names.length) {
  console.error("usage: node scripts/pack-cowork-skill.mjs <name>... | --all");
  process.exit(2);
}

// ⛔ PREFLIGHT `zip` AND `touch` BEFORE MUTATING ANYTHING. The loop below is a
// delete-then-recreate: `unlinkSync(out)` removes a TRACKED repo file and only
// the `zip` on the next line puts it back. On a box without `zip` on PATH that
// second step throws and the bundle is GONE from the working tree — which is
// exactly what happened on Trevor's Windows box on 2026-08-24: a plain
// `npm test` deleted `docs/cowork-skills/rpc-handoff.skill`, and the checker
// then misreported the wreckage as "no rpc-handoff.skill bundle beside the
// source" — a MISSING-file message for a file the test itself had just removed.
//
// ⚠ CI IS STRUCTURALLY BLIND TO THIS: ubuntu-latest ships `zip`, so the guard
// is green there and destructive only on a developer machine. Checking here
// costs one spawn and converts silent repo corruption into a clear message.
// ⚠ Keys on ENOENT (the binary is genuinely absent), NOT on a non-zero exit —
// a version flag this build does not accept must not be reported as "missing".

// ── The native writer, added 2026-09-18 ─────────────────────────────────────
//
// ⛔ WHY: the preflight this replaces EXITED 2 when `zip` was absent, which made
// the documented repair for a live defect LINUX-ONLY. Git for Windows ships
// `zipgrep`/`zipinfo` but no `zip`, so on Trevor's box the bundle guard could go
// red and the fix for it could not be run — "the guard works, the documented
// repair does not" (tooling-gotchas.md, 2026-09-14). A pure-Node writer takes
// the binary off the critical path entirely.
//
// ⭐ IT ALSO REMOVES THE CORRUPTION HAZARD THE PREFLIGHT EXISTED TO WORK AROUND.
// The `zip` path is delete-then-recreate: unlinkSync(out) drops a TRACKED file
// and only the next line puts it back, so on a box without `zip` a plain
// `npm test` once DELETED docs/cowork-skills/rpc-handoff.skill. The native path
// BUILDS THE BUFFER FIRST and writes once — a failure cannot leave it missing.
//
// ⚠ The writer itself lives in scripts/lib/zip-one-file.mjs, shared with the
// guard's fixture builder so the two cannot drift.
//
// ⚠ HONEST LIMIT ON "DETERMINISTIC": within one writer, re-packing unchanged
// content is byte-identical — every field below is fixed, with no mtime, no
// extra fields and no creator-version drift. ACROSS writers it is NOT: a bundle
// packed here differs byte-wise from what `zip -jqX` produces for the same text,
// so a later Linux re-pack will churn it back. That is a DIFF cost, never a
// correctness one — check-cowork-skill-bundles.mjs compares NORMALIZED TEXT and
// never bytes, for exactly this reason. Re-pack only what you changed.

// ⭐ 2026-09-24: the bundle carries `references/*` beside SKILL.md. rpc-surface-qa's
// SKILL.md tells the reader to open references/surface-checklist.md; the installed copy
// has that file, the repo bundle did not, so re-saving the bundle would have removed it.
// The `zip -j` path junked directory names and could never carry it, so the pure-Node
// writer is now the only path (it was already the one every arm of the guard tests).
function bundleEntries(name) {
  const dir = join(SKILLS_DIR, name);
  const entries = [{ name: "SKILL.md", content: readFileSync(join(dir, "SKILL.md")) }];
  const refs = join(dir, "references");
  if (existsSync(refs) && statSync(refs).isDirectory()) {
    for (const f of readdirSync(refs).sort()) {
      const p = join(refs, f);
      if (statSync(p).isFile()) entries.push({ name: `references/${f}`, content: readFileSync(p) });
    }
  }
  return entries;
}

for (const name of names) {
  const src = join(SKILLS_DIR, name, "SKILL.md");
  if (!existsSync(src)) {
    console.error(`no such skill source: ${src}`);
    process.exit(1);
  }
  const out = join(SKILLS_DIR, `${name}.skill`);
  const entries = bundleEntries(name);
  // Build first, write once — the bundle can never go missing on failure.
  writeFileSync(out, zipFiles(entries));
  console.log(`packed ${out} (${entries.length} entr${entries.length === 1 ? "y" : "ies"})`);
}
