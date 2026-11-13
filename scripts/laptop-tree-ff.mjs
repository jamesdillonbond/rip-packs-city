#!/usr/bin/env node
// laptop-tree-ff.mjs — keep Trevor's laptop working tree on origin/main (2026-11-13).
//
// WHY: the Panini runner (Windows Task Scheduler, every 2 h) runs `scripts/ingest-panini-runner.mjs`
// FROM the laptop tree, so a pushed fix reaches it only once that tree moves. Until 11-13 the tree
// moved once a day (the 5:15 AM native `pull-main-ff.cmd`, plus a 5:37 AM Claude scheduled task
// that depended on a Cowork folder mount and failed on 11-13 with "no folders connected"). A fix
// pushed at 9 AM therefore waited ~20 h. Two failure modes made a pull refuse outright:
//   1. a file byte-identical to origin/main left on the tree outside docs/ (11-13:
//      lib/candy/edition-rarity-label.ts + its test) — the old stray-clearer only looked in docs/;
//   2. a `.git/index.lock` left by a git run that could not delete its own lock (the Cowork mount).
//
// WHAT: fetch; if behind and not ahead, `merge --ff-only`. When git refuses because files "would be
// overwritten", clear ONLY the ones whose bytes equal origin/main's copy (delete untracked / restore
// modified) and retry once. Anything that differs is kept and reported — no local work is ever lost.
// A lock older than 10 min is RENAMED (never deleted) to `.git/stale-index-lock-<time>`.
//
// `--from-launcher` (used by scripts/panini-run.bat): cmd.exe reads a running .bat from disk by byte
// offset, so rewriting a launcher mid-run corrupts the rest of that run. In that mode the pull is
// DEFERRED whenever origin/main changes any scripts/*.bat|*.cmd|*.ps1; the daily 5:15 AM pull
// (no flag) takes it instead.
//
// Always exits 0: a failed pull must never stop an ingest run. Every line is prefixed [tree-ff].
import { execFileSync } from "node:child_process";
import { existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const LAUNCHER_RE = /^scripts\/[^/]+\.(bat|cmd|ps1)$/i;
export const STALE_LOCK_MS = 10 * 60 * 1000;

/** Paths git lists after "...would be overwritten by merge:" (tab-indented), unquoted. */
export function parseOverwrittenPaths(stderr) {
  const out = [];
  let inList = false;
  for (const line of String(stderr).split(/\r?\n/)) {
    if (/would be overwritten by (merge|checkout)/.test(line)) { inList = true; continue; }
    if (!inList) continue;
    if (line.startsWith("\t")) {
      let p = line.slice(1).trim();
      if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1).replace(/\\(["\\])/g, "$1");
      if (p) out.push(p);
    } else if (line.trim() !== "") {
      inList = false;
    }
  }
  return out;
}

/** The changed paths that are Windows launchers (rewriting one mid-run breaks cmd.exe). */
export function launcherChanges(changedPaths) {
  return changedPaths.filter((p) => LAUNCHER_RE.test(p.replace(/\\/g, "/")));
}

function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repo = path.resolve(here, "..");
  const fromLauncher = process.argv.includes("--from-launcher");
  const log = (m) => console.log(`[tree-ff] ${m}`);
  const git = (args, timeout = 120_000) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const tryGit = (args) => { try { return git(args); } catch { return null; } };
  const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");

  try {
    const lock = path.join(repo, ".git", "index.lock");
    if (existsSync(lock)) {
      const age = Date.now() - statSync(lock).mtimeMs;
      if (age > STALE_LOCK_MS) {
        const dest = path.join(repo, ".git", `stale-index-lock-${stamp()}`);
        renameSync(lock, dest);
        log(`moved stale index.lock (${Math.round(age / 60000)} min old) to ${path.basename(dest)}`);
      } else {
        log(`index.lock is ${Math.round(age / 1000)} s old (git may be running) — skipping this pull`);
        return;
      }
    }

    git(["fetch", "-q", "origin", "main"], 90_000);
    const start = git(["rev-parse", "--short", "HEAD"]);
    const ahead = Number(git(["rev-list", "--count", "origin/main..HEAD"]));
    const behind = Number(git(["rev-list", "--count", "HEAD..origin/main"]));
    if (ahead > 0) { log(`HEAD ${start} is ${ahead} ahead of origin/main — not touching local commits`); return; }
    if (behind === 0) { log(`HEAD ${start} up to date`); return; }

    if (fromLauncher) {
      const changed = git(["diff", "--name-only", "HEAD", "origin/main"]).split("\n").filter(Boolean);
      const launchers = launcherChanges(changed);
      if (launchers.length) {
        log(`DEFERRED: ${behind} behind but origin/main changes running launcher(s) ${launchers.join(", ")} — the 5:15 AM daily pull takes it`);
        return;
      }
    }

    const merge = () => {
      try { git(["merge", "--ff-only", "-q", "origin/main"], 170_000); return null; }
      catch (e) { return `${e.stderr ?? ""}${e.stdout ?? ""}` || String(e.message); }
    };

    let err = merge();
    if (err) {
      const paths = parseOverwrittenPaths(err);
      if (!paths.length) { log(`FAILED: merge --ff-only refused: ${err.split("\n").find(Boolean)}`); return; }
      const kept = [];
      for (const p of paths) {
        const theirs = tryGit(["rev-parse", `origin/main:${p}`]);
        const mine = tryGit(["hash-object", "--", p]);
        if (!theirs || theirs !== mine) kept.push(p);
      }
      if (kept.length) { log(`FAILED: local edits differ from origin/main, kept: ${kept.join(", ")}`); return; }
      for (const p of paths) {
        if (tryGit(["ls-files", "--error-unmatch", "--", p]) === null) unlinkSync(path.join(repo, p));
        else git(["checkout", "--", p]);
        log(`cleared ${p} (identical to origin/main)`);
      }
      err = merge();
      if (err) { log(`FAILED after clearing strays: ${err.split("\n").find(Boolean)}`); return; }
    }

    const end = git(["rev-parse", "--short", "HEAD"]);
    const left = git(["rev-list", "--count", "HEAD..origin/main"]);
    log(`${start} -> ${end} (${behind} pulled, ${left} behind)`);
  } catch (e) {
    log(`FAILED: ${String(e.message).split("\n")[0]}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
