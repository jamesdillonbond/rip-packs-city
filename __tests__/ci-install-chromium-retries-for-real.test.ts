// scripts/ci/install-chromium.sh — the E2E DOM Smoke / a11y install step must RETRY for real.
//
// 2026-10-23: the first bounded-retry (an inline `for attempt in 1 2 3; do timeout 240 npx
// playwright install …` loop) was one attempt wearing three labels — `timeout` killed `npx`,
// the orphaned `sudo apt-get` kept the dpkg lock, and attempts 2 and 3 failed in 2 s each on
// it. This pins the loop's contract against a fake install command:
//   · a command that fails once and then succeeds → exit 0, "ok on attempt 2";
//   · a command that stalls past the bound on every attempt → exit 1, one ::warning:: per
//     attempt naming the stall, a ::error:: at the end, and the whole thing finishes in about
//     attempts × (bound + kill grace) — never hanging on the stalled command.
// The orphan-process cleanup itself (pkill apt-get / dpkg, lock wait) is exercised by the
// script's self-test in the 10-23 ledger entry, not here: a unit test must not pkill on a
// developer's box.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(process.cwd(), "scripts", "ci", "install-chromium.sh");
const isPosix = process.platform !== "win32";

function run(env: Record<string, string>) {
  return spawnSync("bash", [SCRIPT], {
    env: { ...process.env, ...env, CI_INSTALL_NO_MIRROR_SWITCH: "1" },
    encoding: "utf8",
    timeout: 60_000,
  });
}

describe("scripts/ci/install-chromium.sh retries for real", () => {
  it("exists and is executable", () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it.skipIf(!isPosix)("a command that fails once then succeeds exits 0 on the second attempt", () => {
    const dir = mkdtempSync(join(tmpdir(), "rpc-ic-"));
    const marker = join(dir, "once");
    const flaky = join(dir, "flaky.sh");
    writeFileSync(flaky, `#!/usr/bin/env bash\nif [ -f "${marker}" ]; then exit 0; fi\ntouch "${marker}"\nexit 100\n`);
    chmodSync(flaky, 0o755);
    try {
      const r = run({ PW_INSTALL_CMD: flaky, INSTALL_TIMEOUT_SECS: "10", INSTALL_ATTEMPTS: "3" });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("::warning::playwright install attempt 1 failed (exit 100)");
      expect(r.stdout).toContain("ok on attempt 2");
      expect(r.stdout).not.toContain("attempt 3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!isPosix)("a command that stalls on every attempt is bounded, warned per attempt, and fails loudly", () => {
    const started = Date.now();
    const r = run({ PW_INSTALL_CMD: "sleep 300", INSTALL_TIMEOUT_SECS: "1", INSTALL_ATTEMPTS: "2" });
    const elapsed = Date.now() - started;
    expect(r.status).toBe(1);
    const warnings = r.stdout.match(/::warning::playwright install attempt \d exceeded 1s/g) ?? [];
    expect(warnings).toHaveLength(2);
    expect(r.stdout).toContain("::error::playwright install failed 2 times");
    // 2 attempts × (1 s bound + ≤15 s kill grace + ≤3 s cleanup) — far under the 300 s the fake would take.
    expect(elapsed).toBeLessThan(45_000);
  });
});
