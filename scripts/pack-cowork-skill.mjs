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
for (const bin of ["zip", "touch"]) {
  try {
    execFileSync(bin, ["-v"], { stdio: "ignore" });
  } catch (err) {
    if (err?.code !== "ENOENT") continue; // present, just unhappy with `-v`
    console.error(
      `pack-cowork-skill: \`${bin}\` is not on PATH, so packing would DELETE each ` +
        `.skill bundle and fail before rewriting it. Refusing to touch the working ` +
        `tree. Install ${bin} (CI ubuntu-latest ships it; on Windows use Git Bash ` +
        `with the full MSYS toolchain) and re-run.`,
    );
    process.exit(2);
  }
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
