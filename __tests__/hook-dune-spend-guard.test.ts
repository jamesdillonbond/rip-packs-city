import { describe, it, expect } from "vitest"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"

// 2026-11-19: hand-run Dune queries spent the cycle to 430 % with no lane involved. The PreToolUse hook makes
// every SPENDING Dune call ask a human; reads stay free. Runs the real script (bash + jq, as Claude Code does).
const HOOK = path.join(process.cwd(), ".claude/hooks/dune-spend-guard.sh")
const run = (tool: string) => spawnSync("bash", [HOOK], { input: JSON.stringify({ tool_name: tool }), encoding: "utf8" })

describe("dune-spend-guard hook", () => {
  it.each([
    "mcp__Dune__createAndExecuteQuery",
    "mcp__Dune__executeQueryById",
    "mcp__Dune__refreshMaterializedView",
    "mcp__Dune__createMaterializedView",
    "mcp__Dune__updateMaterializedView",
    "mcp__Dune__setSchedule",
  ])("asks before %s (it spends)", (tool) => {
    const r = run(tool)
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse")
    expect(out.hookSpecificOutput.permissionDecision).toBe("ask")
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/Dune spend guard/)
  })

  it.each(["mcp__Dune__getUsage", "mcp__Dune__searchTables", "mcp__Dune__getExecutionResults", "mcp__Dune__searchDocs"])(
    "stays silent for %s (reading is free)",
    (tool) => {
      const r = run(tool)
      expect(r.status).toBe(0)
      expect(r.stdout).toBe("")
    },
  )

  it("is registered in .claude/settings.json for every Dune tool", () => {
    const s = JSON.parse(readFileSync(path.join(process.cwd(), ".claude/settings.json"), "utf8"))
    const pre = (s.hooks?.PreToolUse ?? []) as Array<{ matcher: string; hooks: Array<{ command: string }> }>
    const entry = pre.find((e) => e.hooks.some((h) => h.command.endsWith("/.claude/hooks/dune-spend-guard.sh")))
    expect(entry).toBeDefined()
    expect(new RegExp(`^(?:${entry!.matcher})$`).test("mcp__Dune__createAndExecuteQuery")).toBe(true)
  })
})
