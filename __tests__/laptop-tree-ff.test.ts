import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { launcherChanges, parseOverwrittenPaths } from "../scripts/laptop-tree-ff.mjs";

describe("laptop-tree-ff: which files block a fast-forward", () => {
  it("reads the untracked-files refusal (the 11-13 laptop case, outside docs/)", () => {
    const stderr = [
      "Updating 7727d446b..6ce5bca43",
      "error: The following untracked working tree files would be overwritten by merge:",
      "\t__tests__/lib-candy-edition-rarity-label.test.ts",
      "\tlib/candy/edition-rarity-label.ts",
      "Please move or remove them before you merge.",
      "Aborting",
    ].join("\n");
    expect(parseOverwrittenPaths(stderr)).toEqual([
      "__tests__/lib-candy-edition-rarity-label.test.ts",
      "lib/candy/edition-rarity-label.ts",
    ]);
  });

  it("reads the local-changes refusal and unquotes a path with spaces", () => {
    const stderr =
      "error: Your local changes to the following files would be overwritten by merge:\r\n" +
      '\t"docs/overnight/a b.md"\r\n\tdocs/overnight/ledger.md\r\n' +
      "Please commit your changes or stash them before you merge.\r\n";
    expect(parseOverwrittenPaths(stderr)).toEqual(["docs/overnight/a b.md", "docs/overnight/ledger.md"]);
  });

  it("returns nothing for a refusal that is not about overwritten files (so nothing gets cleared)", () => {
    expect(parseOverwrittenPaths("fatal: Not possible to fast-forward, aborting.")).toEqual([]);
    expect(parseOverwrittenPaths("fatal: Unable to create '.git/index.lock': File exists.")).toEqual([]);
  });
});

describe("laptop-tree-ff: a running launcher is never rewritten mid-run", () => {
  it("flags .bat/.cmd/.ps1 directly under scripts/ and nothing else", () => {
    expect(
      launcherChanges([
        "scripts/panini-run.bat",
        "scripts/panini-keep-awake.ps1",
        "scripts\\panini-team-walk.bat",
        "scripts/ingest-panini-runner.mjs",
        "lib/foo.ts",
        "docs/x.cmd",
      ]),
    ).toEqual(["scripts/panini-run.bat", "scripts/panini-keep-awake.ps1", "scripts\\panini-team-walk.bat"]);
  });

  it("panini-run.bat pulls in launcher mode BEFORE it runs the ingest", () => {
    const bat = readFileSync("scripts/panini-run.bat", "utf8");
    const pull = bat.indexOf("node scripts\\laptop-tree-ff.mjs --from-launcher");
    const ingest = bat.indexOf("node scripts\\ingest-panini-runner.mjs");
    expect(pull).toBeGreaterThan(-1);
    expect(ingest).toBeGreaterThan(pull);
  });
});
