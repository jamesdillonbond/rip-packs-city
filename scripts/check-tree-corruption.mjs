#!/usr/bin/env node
// scripts/check-tree-corruption.mjs
//
// Guards against the Windows<->sandbox mount corruption (NUL-byte injection and
// mid-file truncation) reaching a commit. By default it inspects STAGED content
// (wire it as a pre-commit hook); pass --all to audit every tracked file.
//
//   node scripts/check-tree-corruption.mjs          # check staged (hook mode)
//   node scripts/check-tree-corruption.mjs --all    # audit the whole tree
//
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const ALL = process.argv.includes("--all");
const BINARY = /\.(ico|png|jpe?g|gif|webp|woff2?|ttf|otf|eot|zip|skill|pdf|mp4|webm|mov|wasm|gz|bin)$/i;

function git(args, encoding) {
  try {
    return execFileSync("git", args, { encoding, maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}
const lines = (out) => (out || "").split("\n").map((s) => s.trim()).filter(Boolean);
const stripCR = (buf) => Buffer.from(buf.toString("latin1").replace(/\r/g, ""), "latin1");

const files = ALL
  ? lines(git(["ls-files"], "utf8"))
  : lines(git(["diff", "--cached", "--name-only", "--diff-filter=ACM"], "utf8"));

const problems = [];
for (const f of files) {
  if (BINARY.test(f)) continue;
  let content;
  if (ALL) {
    try { content = fs.readFileSync(f); } catch { continue; }
  } else {
    content = git(["show", `:0:${f}`], "buffer");
  }
  if (!content) continue;

  if (content.includes(0x00)) {
    problems.push([f, "contains NUL bytes (corruption)"]);
    continue;
  }
  const head = git(["show", `HEAD:${f}`], "buffer");
  if (head) {
    const c = stripCR(content), h = stripCR(head);
    if (c.length < h.length && h.subarray(0, c.length).equals(c)) {
      problems.push([f, `truncated: ${c.length} of ${h.length} bytes (strict prefix of HEAD)`]);
    }
  }
}

if (problems.length) {
  console.error(`\n✖ corruption guard blocked ${problems.length} file(s):`);
  for (const [f, why] of problems) console.error(`   ${f} - ${why}`);
  console.error("\nRestore each from HEAD before committing:  git checkout HEAD -- <file>\n");
  process.exit(1);
}
console.log(`✓ corruption guard: ${files.length} file(s) checked, clean`);
process.exit(0);
