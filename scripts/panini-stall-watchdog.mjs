// scripts/panini-stall-watchdog.mjs — tell a HUNG runner from a SLEEPING PC, and say where it stopped.
//
// WHY (2026-10-03): the 10:00 AM PT walk posted its auth preflight (10:00:10) and read the walk
// order (10:00:11), then nothing for 80+ minutes — no enum marker (normally ~32-37 min in), no
// card batch, no further request. From the server the two candidate causes look identical:
//   - the PC went to sleep (no process runs, no timer fires), or
//   - the runner HUNG: a page.evaluate() into a frozen renderer has no timeout, so the process sits
//     until the task's 2-hour limit kills it, and every later minute of that run is lost.
// Only the runner can tell them apart, and only it knows which phase and sport it was in.
//
// HOW: the runner calls mark(phase, detail) whenever it makes progress; a 60 s interval calls
// check(). Two verdicts:
//   - "slept": the interval's own ticks arrived far apart (gap > sleepGapMs). Timers do not fire
//     while Windows sleeps, so a long gap between ticks is the machine, not the runner. The idle
//     clock is reset (a sleep is not a hang) and the event is reported once.
//   - "stall": ticks arrive on time but nothing has called mark() for idleLimitMs. That is a hung
//     call; the runner reports it and exits, so the task ends and the next run's Chrome preflight
//     (scripts/panini-run.bat) restarts a hung browser instead of inheriting it.
// Pure: no timers, no I/O, an injected clock — unit-tested in __tests__/panini-stall-watchdog.test.ts.

export function createStallWatchdog({ now = () => Date.now(), idleLimitMs = 15 * 60_000, sleepGapMs = 5 * 60_000 } = {}) {
  let lastProgress = now();
  let lastTick = lastProgress;
  let phase = "start";
  /** @type {string | null} */
  let detail = null;
  return {
    /** @param {string} p @param {string | null} [d] */
    mark(p, d = null) {
      lastProgress = now();
      phase = p;
      detail = d;
    },
    /** null while healthy; otherwise a verdict object to log, post and act on. */
    check() {
      const t = now();
      const gap = t - lastTick;
      lastTick = t;
      if (gap > sleepGapMs) {
        // The clock jumped: the machine was asleep. Restart the idle window from now.
        lastProgress = t;
        return { kind: "slept", phase, detail, gap_min: Math.round(gap / 60_000) };
      }
      const idle = t - lastProgress;
      if (idle > idleLimitMs) return { kind: "stall", phase, detail, idle_min: Math.round(idle / 60_000) };
      return null;
    },
    state() {
      return { phase, detail };
    },
  };
}
