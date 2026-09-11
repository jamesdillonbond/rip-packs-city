// __tests__/lane-egress-classification-guard.test.ts
//
// Proves scripts/check-lane-egress.mjs actually detects the thing it claims to.
//
// The claim under guard: `wmc-fmv-populate` and `cron/alerts-dispatch` reach NO
// external network, which is the entire justification for driving the former
// from pg_cron with no credential (`rpc_wmc_fmv_populate_backstop`). If someone
// adds a fetch into either lane's dependency tree, the pg_cron backstop silently
// does LESS than the route it stands in for, and nothing else in this repo
// would notice.
//
// ⚠ EVERY TEST HERE IS A MUTATION, not an assertion that today's tree passes.
// A guard that only ever sees the clean tree is indistinguishable from one whose
// predicate is `return true` — this repo has shipped that mistake. So each case
// breaks something and demands the red.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
// Plain .mjs guard — tsc resolves it through allowJs, so no directive is needed here.
import { lanesFromWorkflow, classifyLane, evaluateLanes } from "../scripts/check-lane-egress.mjs";

const ROOT = process.cwd();
const WORKFLOW = path.join(ROOT, ".github/workflows/dead-lane-backstop.yml");

/** Build a classifier over an in-memory file tree so mutations need no real files. */
function fakeTree(files: Record<string, string>) {
  return (entry: string) =>
    classifyLane(entry, {
      exists: (f: string) => Object.prototype.hasOwnProperty.call(files, f),
      readFile: (f: string) => files[f],
    });
}

describe("the lane list is derived, not curated", () => {
  it("reads every backstopped lane out of the workflow", () => {
    const lanes = lanesFromWorkflow(fs.readFileSync(WORKFLOW, "utf8"));
    // A count assertion, because a derivation that silently matches nothing is
    // the failure mode this repo has already shipped once. 10 -> 11 on 2026-09-10
    // when offers-sweep was added; the guard caught its own new lane as UNPINNED
    // rather than passing it silently, which is the behaviour this file pins.
    expect(lanes.length).toBe(11);
    expect(lanes.map((l: any) => l.lane)).toContain("wmc-fmv-populate");
    expect(lanes.map((l: any) => l.lane)).toContain("cron/alerts-dispatch");
    expect(lanes.map((l: any) => l.lane)).toContain("cron/offers-sweep");
  });

  it("MUTATION: a workflow whose url shape changed yields zero lanes, and zero lanes is RED", () => {
    const lanes = lanesFromWorkflow("jobs:\n  ingest:\n    steps:\n      - run: echo no urls here\n");
    expect(lanes.length).toBe(0);
    const { failures } = evaluateLanes(lanes, () => ({ klass: "pure-db", files: 1, calls: [], deps: [] }), {});
    // ⭐ The point: an empty inspection must NOT read as a clean one.
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.join(" ")).toMatch(/inspecting nothing/i);
  });

  it("does not double-count a lane the workflow drives twice", () => {
    const wf = [
      "          url: https://www.rippackscity.com/api/wmc-fmv-populate",
      "          url: https://www.rippackscity.com/api/wmc-fmv-populate",
    ].join("\n");
    expect(lanesFromWorkflow(wf).length).toBe(1);
  });
});

describe("classification counts call sites, not URL strings", () => {
  it("a route full of https:// constants and no fetch is pure-db", () => {
    // This is not hypothetical: lib/collections.ts carries 28 https:// lines and
    // zero fetches. Counting strings would misclassify wmc-fmv-populate and
    // throw away the one real finding the audit produced.
    const files = {
      "/r/route.ts": `
        import { CDN } from "./consts";
        export async function GET() { return Response.json({ ok: true }); }
      `,
      "/r/consts.ts": `
        export const CDN = "https://assets.nbatopshot.com";
        export const url = (id: string) => \`https://nbatopshot.com/moment/\${id}\`;
      `,
    };
    expect(fakeTree(files)("/r/route.ts").klass).toBe("pure-db");
  });

  it("MUTATION: a fetch added to the ROUTE flips it to needs-egress", () => {
    const files = {
      "/r/route.ts": `export async function GET() { const r = await fetch("https://x.test/a"); return r; }`,
    };
    const out = fakeTree(files)("/r/route.ts");
    expect(out.klass).toBe("needs-egress");
    expect(out.calls.length).toBe(1);
  });

  it("MUTATION: a fetch added to an IMPORTED LIB flips it too — the route-file grep misses this", () => {
    // snapshot-pack-asks and ownership-onchain-walk are both zero-fetch at the
    // route file and both reach the network anyway. That is why the walk is
    // transitive.
    const files = {
      "/r/route.ts": `import { load } from "./lib/remote";\nexport async function GET() { return Response.json(await load()); }`,
      "/r/lib/remote.ts": `export async function load() { const res = await fetch("https://api.test/graphql"); return res.json(); }`,
    };
    const out = fakeTree(files)("/r/route.ts");
    expect(out.klass).toBe("needs-egress");
    expect(out.files).toBe(2);
    expect(out.calls[0]).toMatch(/remote\.ts/);
  });

  it("MUTATION: a network-IO package flips it even with no visible call site", () => {
    // @onflow/fcl opens its own sockets; nothing in this repo's source shows a fetch.
    const files = {
      "/r/route.ts": `import * as fcl from "@onflow/fcl";\nexport async function GET() { return Response.json({}); }`,
    };
    const out = fakeTree(files)("/r/route.ts");
    expect(out.klass).toBe("needs-egress");
    expect(out.deps.length).toBe(1);
  });

  it("reports the TRUE line number — a stripper that collapses lines makes the evidence unclickable", () => {
    // Regression: the hand-rolled stripper this guard started with removed block
    // comments including their newlines, so it cited the snapshot-pack-asks fetch
    // 14 lines early (:219 for a call that lives at :233). The classification was
    // right and the evidence was wrong — the exact shape of "fix the guard without
    // fixing its record". Assert the NUMBER, not merely that a call was found.
    const files = {
      "/r/route.ts": ["/*", " * a block comment", " * spanning several lines", " */", "", "export async function GET() {", '  return fetch("https://x.test/a");', "}"].join("\n"),
    };
    const out = fakeTree(files)("/r/route.ts");
    expect(out.calls.length).toBe(1);
    expect(out.calls[0].endsWith(":7")).toBe(true);
  });

  it("a fetch inside a comment is not egress", () => {
    const files = {
      "/r/route.ts": `
        // historical: this used to await fetch("https://old.test/x")
        /* and a block comment with fetch("https://older.test/y") too */
        export async function GET() { return Response.json({}); }
      `,
    };
    expect(fakeTree(files)("/r/route.ts").klass).toBe("pure-db");
  });

  it("a method named .fetch() on a client is not a bare fetch call", () => {
    const files = { "/r/route.ts": `export async function GET() { return db.fetch(); }` };
    expect(fakeTree(files)("/r/route.ts").klass).toBe("pure-db");
  });

  it("an import cycle terminates instead of hanging", () => {
    const files = {
      "/r/route.ts": `import { a } from "./a";\nexport const x = a;`,
      "/r/a.ts": `import { b } from "./b";\nexport const a = b;`,
      "/r/b.ts": `import { a } from "./a";\nexport const b = a;`,
    };
    expect(fakeTree(files)("/r/route.ts").files).toBe(3);
  });
});

describe("the pinned map fails in both directions", () => {
  const lanes = [{ lane: "pure-lane", routeFile: "/x" }, { lane: "net-lane", routeFile: "/y" }];
  const classify = (l: any) =>
    l.lane === "pure-lane"
      ? { klass: "pure-db", files: 1, calls: [], deps: [] }
      : { klass: "needs-egress", files: 1, calls: ["/y:1"], deps: [] };

  it("passes when every lane matches its pin", () => {
    const { failures } = evaluateLanes(lanes, classify, { "pure-lane": "pure-db", "net-lane": "needs-egress" });
    expect(failures).toEqual([]);
  });

  it("MUTATION: a pure-db lane that gained egress is RED, and says the backstop's premise broke", () => {
    const gainedEgress = () => ({ klass: "needs-egress", files: 1, calls: ["/x:9"], deps: [] });
    const { failures } = evaluateLanes([lanes[0]], gainedEgress, { "pure-lane": "pure-db" });
    expect(failures.length).toBe(1);
    // Assert the ABSENCE of the false claim — the operator must be told the
    // credential-free claim is now false, not merely that something changed.
    expect(failures[0]).toMatch(/credential-free.*now false/i);
  });

  it("MUTATION: a lane that LOST its egress is also RED — drift is not one-directional", () => {
    const lostEgress = () => ({ klass: "pure-db", files: 1, calls: [], deps: [] });
    const { failures } = evaluateLanes([lanes[1]], lostEgress, { "net-lane": "needs-egress" });
    expect(failures.length).toBe(1);
    expect(failures[0]).toMatch(/movable to pg_cron/i);
  });

  it("MUTATION: a lane added to the backstop but never pinned is RED, not silently ok", () => {
    const { failures } = evaluateLanes(lanes, classify, { "pure-lane": "pure-db" });
    expect(failures.length).toBe(1);
    expect(failures[0]).toMatch(/net-lane.*not pinned/i);
  });

  it("MUTATION: a pin left behind after its lane was removed is RED, so pins cannot rot", () => {
    const { failures } = evaluateLanes([lanes[0]], classify, { "pure-lane": "pure-db", "deleted-lane": "needs-egress" });
    expect(failures.length).toBe(1);
    expect(failures[0]).toMatch(/deleted-lane.*no longer driven/i);
  });

  it("MUTATION: a backstopped lane whose route file is gone is RED", () => {
    const { failures } = evaluateLanes([lanes[0]], () => null, { "pure-lane": "pure-db" });
    expect(failures.length).toBe(1);
    expect(failures[0]).toMatch(/does not exist/i);
  });
});

describe("the live tree matches the pinned claim", () => {
  it("passes on the real repo, and the pure-db set is exactly the two audited lanes", () => {
    const lanes = lanesFromWorkflow(fs.readFileSync(WORKFLOW, "utf8"));
    const { rows, failures } = evaluateLanes(
      lanes,
      ({ routeFile }: any) => (fs.existsSync(routeFile) ? classifyLane(routeFile) : null),
      Object.fromEntries(lanes.map((l: any) => [l.lane, classifyLane(l.routeFile).klass]))
    );
    expect(failures).toEqual([]);
    const pure = rows.filter((r: any) => r.klass === "pure-db").map((r: any) => r.lane).sort();
    // ⚠ If this set grows, a lane became credential-free and may be worth moving
    // to pg_cron. If it shrinks, a backstop's premise died. Either way: read it.
    expect(pure).toEqual(["cron/alerts-dispatch", "wmc-fmv-populate"]);
  });
});
