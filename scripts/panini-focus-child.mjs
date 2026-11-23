// FOCUS SCAN (2026-11-22, Trevor: "add an additional scan to just pick these up without sacrificing
// the rest"). A newly admitted product whose catalogue is far behind its grid (NWSL #1065: ~100
// catalogued editions against 2,370 grid listings) gets a SECOND runner process for the rest of a
// scheduled run. The scheduled run keeps its whole walk; the child walks ONLY the focus products.
//
// Why a parallel process and not a bigger slot: measured 11-22, each 4-hourly run is busy ~3h45m
// (idle ~13 min), and the bootstrap that would spend a whole run on a new product yields while the
// catalogue's oldest edition is >= 6.5 days old (8.6 days that evening). The child shares the
// scheduled run's logged-in CDP Chrome but drives its OWN tab and its OWN files:
//   - PANINI_RUNNER_TAB_FILE: each runner closes "the tab a previous run left open" from this file
//     at start — sharing it would make the child close the scheduled run's live tab.
//   - PANINI_OPS_CAPTURE_FILE / PANINI_BACKUP_FILE: both rotate by rename; two writers would race.
// It starts AFTER the scheduled run's grid phase (both runs never enumerate at once) and its budget
// ends before the scheduled run's deadline, so the Task Scheduler's 2 h kill never cuts it.

/** Whether to start a focus child, and with what environment. Pure — the runner does the spawn. */
export function focusChildPlan({ focusSetIds, isFocus, mainDeadlineMs, nowMs, env, home, marginMin = 8, minBudgetMin = 20 }) {
  const ids = Array.isArray(focusSetIds) ? focusSetIds.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  if (isFocus) return { spawn: false, reason: "this IS the focus child" };
  if (env?.PANINI_FOCUS_SPAWN === "0") return { spawn: false, reason: "disabled via PANINI_FOCUS_SPAWN=0" };
  if (!ids.length) return { spawn: false, reason: "no focus products" };
  if (!env?.PANINI_CDP_URL) return { spawn: false, reason: "needs a CDP Chrome (a second persistent profile would need its own login)" };
  const budgetMin = Math.floor((mainDeadlineMs - nowMs) / 60000) - marginMin;
  if (!(budgetMin >= minBudgetMin)) return { spawn: false, reason: `only ${budgetMin} min left before the scheduled run's deadline` };
  const sep = (p) => (home ? `${home.replace(/[\\/]+$/, "")}/${p}` : p);
  const derive = (file, fallback) => {
    const f = file || fallback;
    return /\.jsonl$/i.test(f) ? f.replace(/\.jsonl$/i, "-focus.jsonl") : `${f}-focus`;
  };
  return {
    spawn: true,
    reason: `focus on [${ids.join(",")}] for ${budgetMin} min`,
    budgetMin,
    env: {
      ...env,
      PANINI_FOCUS: "1",
      PANINI_FOCUS_SPAWN: "0",
      PANINI_RUN_BUDGET_MIN: String(budgetMin),
      PANINI_WALK_BUDGET_MIN: String(budgetMin),
      PANINI_RUNNER_TAB_FILE: sep(".panini-runner-tab-focus.json"),
      PANINI_OPS_CAPTURE_FILE: derive(env?.PANINI_OPS_CAPTURE_FILE, "panini-ops-capture.jsonl"),
      PANINI_BACKUP_FILE: derive(env?.PANINI_BACKUP_FILE, "panini-capture.jsonl"),
      // the child does only the focus products' grid; the store/pack phases are the scheduled run's
      PANINI_PACK_GRID: "0",
    },
  };
}

/** Wait for a child process to exit; after `timeoutMs`, kill it. Resolves to how it ended. */
export function waitForChild(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode) return Promise.resolve(child ? "exited" : "none");
  return new Promise((resolve) => {
    let done = false;
    const finish = (how) => { if (!done) { done = true; clearTimeout(t); resolve(how); } };
    const t = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } finish("killed"); }, timeoutMs);
    child.once("exit", () => finish("exited"));
    child.once("error", () => finish("error"));
  });
}
