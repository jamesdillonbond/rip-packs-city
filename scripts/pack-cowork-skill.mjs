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

import { readdirSync, existsSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const SKILLS_DIR = "docs/cowork-skills";
const FIXED_MTIME = "202608240000.00"; // touch -t format; see determinism note

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

for (const name of names) {
  const src = join(SKILLS_DIR, name, "SKILL.md");
  if (!existsSync(src)) {
    console.error(`no such skill source: ${src}`);
    process.exit(1);
  }
  const out = join(SKILLS_DIR, `${name}.skill`);
  if (existsSync(out)) unlinkSync(out);
  execFileSync("touch", ["-t", FIXED_MTIME, src]);
  // -j junks the path so the entry is a bare SKILL.md, matching the existing
  // bundles (verified 2026-08-24: every .skill holds exactly one SKILL.md).
  execFileSync("zip", ["-jqX", out, src]);
  console.log(`packed ${out}`);
}
