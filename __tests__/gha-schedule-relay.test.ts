import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SKIP, cronMatches, cronsOf, dueBetween, expandField, loadSchedule, parseCron } from "../scripts/gha-schedule-relay.mjs";

const at = (iso: string) => new Date(iso);

describe("gha-schedule-relay cron matching", () => {
  it("matches the m-m minute form this repo's workflows use", () => {
    const p = parseCron("3-3,19,33,49 * * * *");
    expect(cronMatches(p, at("2026-11-18T05:03:10Z"))).toBe(true);
    expect(cronMatches(p, at("2026-11-18T05:49:00Z"))).toBe(true);
    expect(cronMatches(p, at("2026-11-18T05:04:00Z"))).toBe(false);
  });

  it("honours step and hour lists in UTC", () => {
    const p = parseCron("15-15 */6 * * *");
    expect(cronMatches(p, at("2026-11-18T12:15:00Z"))).toBe(true);
    expect(cronMatches(p, at("2026-11-18T13:15:00Z"))).toBe(false);
    const q = parseCron("38-38 2,8,14,20 * * *");
    expect(cronMatches(q, at("2026-11-18T14:38:00Z"))).toBe(true);
    expect(cronMatches(q, at("2026-11-18T15:38:00Z"))).toBe(false);
  });

  it("restricts by weekday", () => {
    const p = parseCron("41-41 17 * * 1"); // Mondays
    expect(cronMatches(p, at("2026-11-16T17:41:00Z"))).toBe(true); // a Monday
    expect(cronMatches(p, at("2026-11-17T17:41:00Z"))).toBe(false);
  });

  it("returns null for a cron it cannot parse instead of matching nothing silently", () => {
    expect(parseCron("@daily")).toBeNull();
    expect(parseCron("61 * * * *")).toBeNull();
    expect(parseCron("* * * *")).toBeNull();
    expect(expandField("5-2", [0, 59])).toBeNull();
  });

  it("reads cron lines but not commented-out ones", () => {
    expect(cronsOf(`on:\n  schedule:\n    - cron: "5 * * * *"\n    # - cron: "6 * * * *"\n`)).toEqual(["5 * * * *"]);
  });

  it("collects every workflow due inside a window, once each", () => {
    const schedule = [
      { file: "a.yml", parsed: [parseCron("5,6 * * * *")] },
      { file: "b.yml", parsed: [parseCron("30 * * * *")] },
    ];
    const due = dueBetween(schedule, Date.parse("2026-11-18T05:03:30Z"), Date.parse("2026-11-18T05:07:10Z"));
    expect(due).toEqual(["a.yml"]);
    expect(dueBetween(schedule, Date.parse("2026-11-18T05:06:00Z"), Date.parse("2026-11-18T05:06:59Z"))).toEqual([]);
  });
});

describe("gha-schedule-relay against the real workflow tree", () => {
  const schedule = loadSchedule(".github/workflows");

  it("parses every scheduled workflow and never targets itself or the probe", () => {
    expect(schedule.length).toBeGreaterThan(20);
    for (const skipped of SKIP) expect(schedule.map((w) => w.file)).not.toContain(skipped);
  });

  it("the relay workflow has no schedule trigger and may write Actions", () => {
    const yml = readFileSync(".github/workflows/schedule-relay.yml", "utf8");
    expect(cronsOf(yml)).toEqual([]);
    expect(yml).toMatch(/^\s*actions: write$/m);
    expect(yml).toMatch(/!cancelled\(\) && steps\.relay\.outputs\.native != 'true'/);
  });
});
