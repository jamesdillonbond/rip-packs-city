// The wall budget refuses whatever is LAST. This pins that "last" moves.
//
// ⚠ The property under test is FAIRNESS, not throughput. Rotation refuses the
// same NUMBER of arms; it changes which. A test asserting "fewer arms blind"
// would be asserting something this change does not do and cannot deliver.
import { describe, it, expect } from "vitest";
import { rotateStarvedTail, ROTATION_STEP_MS } from "@/lib/sentinel/tail-rotation";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../scripts/lib/strip-comments.mjs";

const ARMS = ["alert", "zero-yield", "cadence", "wall-kills", "pg-net"] as const;
const T0 = Date.UTC(2026, 8, 19, 18, 0, 0);

describe("rotateStarvedTail", () => {
  it("returns a permutation — never drops, duplicates or invents an arm", () => {
    for (let i = 0; i < 24; i++) {
      const got = rotateStarvedTail(ARMS, T0 + i * ROTATION_STEP_MS);
      expect(got.length).toBe(ARMS.length);
      expect([...got].sort()).toEqual([...ARMS].sort());
    }
  });

  it("is deterministic — the same sweep start always yields the same order", () => {
    const a = rotateStarvedTail(ARMS, T0);
    const b = rotateStarvedTail(ARMS, T0);
    expect(a).toEqual(b);
    // And a DIFFERENT sweep does not, or nothing rotates at all.
    expect(rotateStarvedTail(ARMS, T0 + ROTATION_STEP_MS)).not.toEqual(a);
  });

  // ⭐ THE LOAD-BEARING ONE. Over `n` consecutive scheduled sweeps every arm
  // must hold every position exactly once — that is what "no arm is the one
  // always starved" means, and it is the assertion a constant offset, an
  // off-by-one, or a step that aliases against the arm count all fail.
  it("gives every arm every position exactly once over one full cycle", () => {
    const n = ARMS.length;
    const seen = new Map<string, Set<number>>(ARMS.map((a) => [a, new Set<number>()]));
    for (let sweep = 0; sweep < n; sweep++) {
      rotateStarvedTail(ARMS, T0 + sweep * ROTATION_STEP_MS).forEach((arm, pos) =>
        seen.get(arm)!.add(pos),
      );
    }
    for (const arm of ARMS) {
      expect(`${arm}:${seen.get(arm)!.size}`).toBe(`${arm}:${n}`);
    }
  });

  // The same property stated as the thing operators actually care about: the
  // LAST slot is the one the wall budget refuses first, and no arm may own it.
  it("never lets one arm own the last slot across a cycle", () => {
    const last = new Set(
      Array.from({ length: ARMS.length }, (_, i) =>
        rotateStarvedTail(ARMS, T0 + i * ROTATION_STEP_MS).at(-1),
      ),
    );
    expect(last.size).toBe(ARMS.length);
  });

  // ⚠ Satisfiable at a population of ZERO and at one — a guard that punishes
  // its own success is how three checks in this repo have died on a rename.
  it("is safe at 0 and 1 arms", () => {
    expect(rotateStarvedTail([], T0)).toEqual([]);
    expect(rotateStarvedTail(["only"], T0)).toEqual(["only"]);
  });

  // A NaN clock must not index into the array and return nothing: the sweep
  // would then run NO tail arms at all and report no findings for them, which
  // reads exactly like "those arms were fine".
  it("falls back to declared order on an unusable clock, never to an empty order", () => {
    for (const bad of [NaN, Infinity, -Infinity, -1]) {
      expect(rotateStarvedTail(ARMS, bad)).toEqual([...ARMS]);
    }
  });

  it("does not mutate its input", () => {
    const input = [...ARMS];
    rotateStarvedTail(input, T0 + 3 * ROTATION_STEP_MS);
    expect(input).toEqual([...ARMS]);
  });
});

// ── THE WIRING, NOT JUST THE FUNCTION ──────────────────────────────────────
//
// `rotateStarvedTail` being correct is not the same as the route using it
// correctly. The realistic regression is a SIXTH rotating arm added later that
// pushes straight to `checks`: it would then run in declaration order (never
// rotated), and — because the canonical re-append below only copies arms it
// knows about — it would also land in the report ahead of the five that are.
// Neither symptom reds any behavioural test; both are visible in the source.
//
// ⚠ Comments are stripped first, with the repo's shared stripper rather than a
// fresh regex: the block above quotes `checks.push(` and `tailChecks.push(` in
// prose, and a guard anchored on raw text would punish the documentation that
// makes it legible.
describe("the route wires the rotation, not just imports it", () => {
  const src = stripComments(
    readFileSync(join(process.cwd(), "app/api/sentinel/route.ts"), "utf8"),
  )

  it("registers every rotating arm through tailArms.push", () => {
    const registered = [...src.matchAll(/tailArms\.push\(\{\s*name:\s*([^,]+),/g)].map((m) =>
      m[1].trim(),
    )
    expect(registered).toEqual([
      '"Alert Delivery"',
      '"Zero-Yield Lanes"',
      "CADENCE_CHECK_NAME",
      "WALL_KILLS_CHECK_NAME",
      "PG_NET_CHECK_NAME",
    ])
  })

  // ⭐ The load-bearing one. Inside a rotating arm's body, a push to `checks`
  // instead of `tailChecks` silently opts that arm out of the rotation.
  it("has no arm pushing straight to checks inside the rotated block", () => {
    const start = src.indexOf("const tailArms")
    const end = src.indexOf("for (const arm of rotateStarvedTail")
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const block = src.slice(start, end)
    // Count the bare `checks.push(` — `tailChecks.push(` must not match it.
    const bare = [...block.matchAll(/(?<!tail)checks\.push\(/g)]
    expect(`bare checks.push in rotated block: ${bare.length}`).toBe(
      "bare checks.push in rotated block: 0",
    )
    // Positive control: the block really does contain pushes, so a zero above
    // cannot come from having matched nothing at all.
    expect([...block.matchAll(/tailChecks\.push\(/g)].length).toBeGreaterThan(10)
  })

  it("re-appends the tail in canonical order, so the rotation cannot reorder the report", () => {
    expect(src).toMatch(/for \(const arm of tailArms\)\s*\{\s*for \(const c of tailChecks\)/)
  })

  // ⛔ Ops Probe Cost must stay OUT of the rotation and LAST: it reads
  // pg_stat_statements for the arms above it, so an earlier slot would make its
  // reading a sweep stale. Trading a measured blind spot for a silently wrong
  // number is the worse defect, and this pins the decision.
  it("keeps Ops Probe Cost out of the rotation and after it", () => {
    const rotateAt = src.indexOf("for (const arm of rotateStarvedTail")
    const probeAt = src.indexOf("sentinel_probe_cost")
    expect(probeAt).toBeGreaterThan(rotateAt)
    expect(src.slice(src.indexOf("const tailArms"), rotateAt)).not.toContain("PROBE_COST_CHECK_NAME")
  })
})
