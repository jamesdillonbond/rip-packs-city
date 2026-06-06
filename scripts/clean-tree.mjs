#!/usr/bin/env node
// scripts/clean-tree.mjs
//
// One-shot working-tree cleanup for the Windows<->sandbox mount corruption.
//   - Restores tracked files that are NUL-corrupted or mid-file truncations
//     (a strict prefix of HEAD) back to their HEAD content. Safe: such files
//     hold no real edits, only corruption (a real edit is never a prefix of
//     HEAD, and NUL-mangled content is unrecoverable anyway).
//   - Removes untracked Git Bash `ps`-dump junk (the stray `cd` / `git` files
//     created by mistyped redirects), matched by a very specific header.
//   - Runs the corruption guard and lists the real work left to commit.
//
// Usage:  node scripts/clean-tree.mjs         fix corruption + junk, then report
//         node scripts/clean-tree.mjs --dry   report only, change nothing
//
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const DRY = process.argv.includes("--dry");
const BINARY = /\.(ico|png|jpe?g|gif|webp|woff2?|ttf|otf|eot|zip|skill|pdf|mp4|webm|mov|wasm|gz|bin)$/i;

function git(args, encoding = "utf8") {
  try { return execFileSync("git", args, { encoding, maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return null; }
}
const lines = (o) => (o || "").split("\n").map((s) => s.trim()).filter(Boolean);
const stripCR = (b) => Buffer.from(b.toString("latin1").replace(/\r/g, ""), "latin1");

// 1) Restore corrupted tracked (modified) files from HEAD.
const modified = lines(git(["diff", "--name-only", "--diff-filter=M"]));
const restored = [];
for (const f of modified) {
  if (BINARY.test(f)) continue;
  let wt; try { wt = fs.readFileSync(f); } catch { continue; }
  const head = git(["show", `HEAD:${f}`], "buffer");
  if (!head) continue;
  const nul = wt.includes(0x00);
  const c = stripCR(wt), h = stripCR(head);
  const truncated = c.length < h.length && h.subarray(0, c.length).equals(c);
  if (nul || truncated) {
    restored.push(`${f} (${nul ? "NUL" : "truncated"})`);
    if (!DRY) git(["checkout", "HEAD", "--", f], "buffer");
  }
}

// 2) Remove untracked Git Bash ps-dump junk (specific header signature).
const untracked = lines(git(["ls-files", "--others", "--exclude-standard"]));
const junk = [];
for (const f of untracked) {
  if (BINARY.test(f)) continue;
  let head; try { head = fs.readFileSync(f, { encoding: "latin1" }).slice(0, 160); } catch { continue; }
  if (/\bPID\b[\s\S]*\bPPID\b[\s\S]*\bPGID\b[\s\S]*\bWINPID\b/.test(head)) {
    junk.push(f);
    if (!DRY) { try { fs.rmSync(f); } catch {} }
  }
}

// 3) Report + verify.
console.log(`\n${DRY ? "would restore" : "restored"} ${restored.length} corrupted file(s):`);
for (const r of restored) console.log(`   ${r}`);
console.log(`${DRY ? "would remove" : "removed"} ${junk.length} junk file(s): ${junk.join(", ") || "none"}`);

const left = lines(git(["status", "--porcelain"]));
console.log(`\nremaining changes to review/commit (${left.length}):`);
for (const l of left) console.log(`   ${l}`);

console.log("\nguard:");
try { execFileSync("node", ["scripts/check-tree-corruption.mjs", "--all"], { stdio: "inherit" }); }
catch { process.exitCode = 1; }
