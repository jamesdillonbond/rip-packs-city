import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { currentSentinelClock, withSentinelClock } from "@/lib/sentinel/clock-store";
import { queryDeadline } from "@/lib/sentinel/wall-budget";

// ── Two sentinel sweeps on one warm instance keep their OWN clocks ─────────────
//
// The wall budget shipped 2026-09-13 with its clock as module state, on the
// stated premise that sentinel invocations never overlap. The redundant
// cron-job.org caller overlapped the delayed GitHub tick by 50.8 s the same
// afternoon (2:02–2:04 PM PT). With a shared clock the later sweep's start
// would overwrite the earlier's (it then runs INTO its wall) and the earlier
// sweep's end would null the clock under the later one (its budget silently
// OFF). These tests assert the property the store exists for: each sweep sees
// its own start and phase across awaits and across the other sweep's lifetime.

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("sentinel clock store — one clock per invocation", () => {
  it("returns null outside any sweep, so the fetch wrapper applies the bare cap", () => {
    expect(currentSentinelClock()).toBeNull();
  });

  it("a sweep sees its own clock after awaits, and the scope ends with it", async () => {
    const seen: (number | null)[] = [];
    await withSentinelClock({ startedAtMs: 1000, phase: "checks" }, async (clock) => {
      seen.push(currentSentinelClock()?.startedAtMs ?? null);
      await tick();
      await tick();
      seen.push(currentSentinelClock()?.startedAtMs ?? null);
      expect(currentSentinelClock()).toBe(clock);
    });
    expect(seen).toEqual([1000, 1000]);
    expect(currentSentinelClock()).toBeNull();
  });

  it("two OVERLAPPING sweeps each keep their own start: the later one does not move the earlier one's budget", async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    const aSeen: number[] = [];
    const bSeen: number[] = [];

    const a = withSentinelClock({ startedAtMs: 1_000, phase: "checks" }, async () => {
      aSeen.push(currentSentinelClock()!.startedAtMs);
      await gateA; // B starts while A is mid-sweep
      aSeen.push(currentSentinelClock()!.startedAtMs);
    });
    await tick();
    const b = withSentinelClock({ startedAtMs: 61_000, phase: "checks" }, async () => {
      bSeen.push(currentSentinelClock()!.startedAtMs);
      releaseA();
      await a; // A ENDS while B is mid-sweep
      await tick();
      bSeen.push(currentSentinelClock()!.startedAtMs);
    });
    await Promise.all([a, b]);

    expect(aSeen).toEqual([1_000, 1_000]);
    expect(bSeen).toEqual([61_000, 61_000]);
    expect(currentSentinelClock()).toBeNull();
  });

  it("the earlier sweep flipping to 'terminal' does not put the later sweep's reads in the never-refuse phase", async () => {
    const opts = { wallMs: 180_000, reserveMs: 40_000, perQueryCapMs: 45_000 };
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    let bDeadline: ReturnType<typeof queryDeadline> | null = null;

    const a = withSentinelClock({ startedAtMs: 0, phase: "checks" }, async (clock) => {
      await gateA;
      clock.phase = "terminal";
    });
    await tick();
    const b = withSentinelClock({ startedAtMs: 0, phase: "checks" }, async () => {
      releaseA();
      await a;
      // B is 150 s into a 140 s checks budget: with its OWN clock this is a
      // refusal; on a shared clock now in "terminal" it would be an unbounded
      // terminal-phase read.
      bDeadline = queryDeadline(opts, currentSentinelClock(), 150_000);
    });
    await Promise.all([a, b]);

    expect(bDeadline).not.toBeNull();
    expect(bDeadline!.kind).toBe("refuse");
  });
});

describe("the sentinel route uses the per-invocation store, not module state", () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), "app/api/sentinel/route.ts"),
    "utf8",
  );

  it("passes the store's getter as the wall-budget clock", () => {
    expect(src).toMatch(/clock:\s*currentSentinelClock\b/);
    expect(src).toMatch(/withSentinelClock\(/);
  });

  it("holds NO mutable module-scope clock (the shape that broke under two callers)", () => {
    // Property: no `let`/`var` binding of the clock type at module scope. A
    // per-request clock in module state is the defect, whatever it is named.
    expect(src).not.toMatch(/^(let|var)\s+\w+\s*:\s*WallBudgetClock\b/m);
  });
});
