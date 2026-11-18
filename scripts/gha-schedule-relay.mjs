#!/usr/bin/env node
/**
 * scripts/gha-schedule-relay.mjs
 *
 * WHY THIS EXISTS
 * ---------------
 * Since 2026-11-17 08:59 UTC GitHub has delivered NO `schedule` event to this
 * repository (ledger 2026-11-17; nine re-registration attempts failed, and
 * GitHub Support closed ticket 5020807 unread because the account is on the
 * free plan). `workflow_dispatch` still works, and a workflow's own
 * GITHUB_TOKEN is allowed to create `workflow_dispatch` runs.
 *
 * So this is a clock that lives inside one long-running job: once a minute it
 * reads every `cron:` line under .github/workflows, and dispatches the
 * workflows whose cron matches. The workflow that runs it
 * (.github/workflows/schedule-relay.yml) re-dispatches itself when the job
 * ends, so the chain needs no outside scheduler and no stored token.
 *
 * IT IS NOT A FAITHFUL CRON. Before the outage GitHub shed most ticks here
 * (sub-hourly workflows really ran about every 7 hours). MIN_GAP_MINUTES keeps
 * the relay from running them at their written rate, which nothing downstream
 * has ever been sized for.
 *
 * IT IS THE BACKSTOP, NOT THE PRIMARY. The laptop runs
 * scripts/gha-schedule-fallback.mjs every 5 minutes at the written rate; this
 * relay defers to it (DEFER_MINUTES) and reuses its INPUTS map, so a relayed
 * run does what the scheduled run would (ufc-aptos apply=true, badge-sync's
 * catalog flag, ...). It exists because the laptop sleeps.
 *
 * IT RETIRES ITSELF. When a real `schedule` run appears again it stops and
 * does not re-dispatch itself. Then delete this file, its workflow, and
 * schedule-probe.yml.
 *
 * TO STOP IT BY HAND: disable "Schedule relay" in the Actions tab (a disabled
 * workflow cannot be dispatched, so the chain ends), or cancel the run.
 */
import { readdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { INPUTS } from "./gha-schedule-fallback.mjs";

export const MIN_GAP_MINUTES = 110;
/**
 * The laptop's fallback (scripts/gha-schedule-fallback.mjs, Windows task every 5 min) goes first.
 * The relay only looks at cron slots at least this old, and skips a slot the laptop already ran,
 * so with the laptop awake the relay dispatches nothing and with it asleep the relay covers.
 */
export const DEFER_MINUTES = 7;
export const SELF = "schedule-relay.yml";
/** Never dispatched: the relay itself, and the probe whose only job is to detect a real schedule. */
export const SKIP = new Set([SELF, "schedule-probe.yml"]);

const RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

/** Expand one cron field to a Set of numbers; null when it cannot be parsed. */
export function expandField(field, [lo, hi]) {
  const out = new Set();
  for (const part of String(field).split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) return null;
    let a = lo;
    let b = hi;
    if (m[1] !== "*") {
      const [x, y] = m[1].split("-").map(Number);
      a = x;
      b = y === undefined ? (m[2] ? hi : x) : y;
    }
    if (a < lo || b > hi || a > b) return null;
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

/** Parse a 5-field cron; null when any field is unparseable. */
export function parseCron(expr) {
  const fields = String(expr).trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const sets = fields.map((f, i) => expandField(f, RANGES[i]));
  if (sets.some((s) => s === null)) return null;
  if (sets[4].has(7)) sets[4].add(0);
  return { sets, domStar: fields[2] === "*", dowStar: fields[4] === "*" };
}

/** Does the parsed cron fire in the UTC minute containing `date`? */
export function cronMatches(parsed, date) {
  const [min, hour, dom, mon, dow] = parsed.sets;
  if (!min.has(date.getUTCMinutes()) || !hour.has(date.getUTCHours()) || !mon.has(date.getUTCMonth() + 1)) return false;
  const domOk = dom.has(date.getUTCDate());
  const dowOk = dow.has(date.getUTCDay());
  // Standard cron: when both day fields are restricted, either one matching fires.
  if (!parsed.domStar && !parsed.dowStar) return domOk || dowOk;
  return domOk && dowOk;
}

/** Every `- cron:` line of a workflow file's text, comments excluded. */
export function cronsOf(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const m = /^\s*-\s*cron:\s*(['"])(.+?)\1/.exec(line);
    if (m) out.push(m[2]);
  }
  return out;
}

/** Workflows the relay may dispatch: scheduled, dispatchable, not skipped. */
export function loadSchedule(dir) {
  const schedule = [];
  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    if (SKIP.has(file)) continue;
    const text = readFileSync(join(dir, file), "utf8");
    const crons = cronsOf(text);
    if (crons.length === 0 || !/^\s*workflow_dispatch:/m.test(text)) continue;
    const parsed = crons.map((c) => {
      const p = parseCron(c);
      if (!p) throw new Error(`${file}: cannot parse cron "${c}"`);
      return p;
    });
    schedule.push({ file, crons, parsed });
  }
  return schedule;
}

/** Workflows whose cron fires in any minute of (afterMs, uptoMs]: one entry per file, its LATEST slot and that slot's cron. */
export function dueBetween(schedule, afterMs, uptoMs) {
  const due = new Map();
  for (let t = Math.floor(afterMs / 60000) * 60000 + 60000; t <= uptoMs; t += 60000) {
    const d = new Date(t);
    for (const w of schedule) {
      const i = w.parsed.findIndex((p) => cronMatches(p, d));
      if (i >= 0) due.set(w.file, { file: w.file, cron: w.crons[i], slotMs: t });
    }
  }
  return [...due.values()];
}

/** The fallback's `-f k=v` argument list as the API's inputs object. */
export function inputsFor(file, cron) {
  const args = INPUTS[file] ? INPUTS[file](cron) : [];
  const inputs = {};
  for (let i = 0; i + 1 < args.length; i += 2) {
    if (args[i] !== "-f") throw new Error(`${file}: unexpected fallback input flag ${args[i]}`);
    const eq = args[i + 1].indexOf("=");
    inputs[args[i + 1].slice(0, eq)] = args[i + 1].slice(eq + 1);
  }
  return inputs;
}

async function gh(path, init = {}) {
  const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(20000),
  });
  return res;
}

/** Creation time (ms) of the workflow's newest run of any kind; 0 when it has none; null when the read failed. */
async function lastRunMs(file) {
  const res = await gh(`/actions/workflows/${file}/runs?per_page=1`);
  if (!res.ok) return null;
  const run = (await res.json()).workflow_runs?.[0];
  return run ? Date.parse(run.created_at) : 0;
}

/** true / false, or null when the read failed (a failed read is not "still dark"). */
async function nativeScheduleIsBack(nowMs) {
  const since = new Date(nowMs - 3 * 3600_000).toISOString().replace(/\.\d+Z$/, "Z");
  const res = await gh(`/actions/runs?event=schedule&per_page=1&created=${encodeURIComponent(">" + since)}`);
  if (!res.ok) return null;
  return (await res.json()).total_count > 0;
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function main() {
  const runMinutes = Number(process.env.RELAY_RUN_MINUTES ?? 330);
  const schedule = loadSchedule(".github/workflows");
  console.log(`relay: watching ${schedule.length} workflows for ${runMinutes} min, min gap ${MIN_GAP_MINUTES} min`);
  if (schedule.length === 0) throw new Error("relay: found no scheduled workflows — refusing to run as a clock that watches nothing");

  const startMs = Date.now();
  const sinceInput = Date.parse(process.env.RELAY_SINCE ?? "");
  // Pick up where the previous link stopped, but never replay more than 15 minutes.
  let cursor = Number.isFinite(sinceInput) ? Math.max(sinceInput, startMs - 15 * 60000) : startMs - 60000;
  let dispatched = 0;
  let failed = 0;
  let tick = 0;

  while (Date.now() - startMs < runMinutes * 60000) {
    const now = Date.now();
    if (tick % 10 === 0) {
      const back = await nativeScheduleIsBack(now).catch(() => null);
      if (back === true) {
        console.log("::notice::A real `schedule` run exists again. The relay is retiring itself — delete schedule-relay.yml, this script and schedule-probe.yml.");
        setOutput("native", "true");
        break;
      }
    }
    const defer = DEFER_MINUTES * 60000;
    for (const { file, cron, slotMs } of dueBetween(schedule, cursor - defer, now - defer)) {
      const last = await lastRunMs(file).catch(() => null);
      // Something (the laptop fallback, a person, GitHub) already ran this slot, or it ran too recently.
      if (last !== null && (last >= slotMs || now - last < MIN_GAP_MINUTES * 60000)) continue;
      const body = JSON.stringify({ ref: "main", inputs: inputsFor(file, cron) });
      const res = await gh(`/actions/workflows/${file}/dispatches`, { method: "POST", body }).catch((e) => ({ status: String(e) }));
      if (res.status === 204) {
        dispatched++;
        console.log(`${new Date(now).toISOString()} dispatched ${file} for slot ${new Date(slotMs).toISOString()} ${body}`);
      } else {
        failed++;
        console.log(`::warning::${new Date(now).toISOString()} dispatch of ${file} answered ${res.status}`);
      }
    }
    cursor = now;
    setOutput("since", new Date(cursor).toISOString());
    tick++;
    await new Promise((r) => setTimeout(r, 60000 - (Date.now() % 60000) + 2000));
  }
  console.log(`relay: link finished — ${dispatched} dispatched, ${failed} failed`);
  if (dispatched === 0 && failed > 0) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
