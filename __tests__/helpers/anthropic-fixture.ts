// Scripted Anthropic client for driving tool-use loops in tests (Phase 1 of the
// deep-loop response-fixture layer — see docs/audits/
// test-coverage-deep-loop-fixture-layer-2026-07-17.md).
//
// A handler that runs the Anthropic tool-use loop calls the model repeatedly:
// each response is either a `tool_use` turn (the handler executes the tool and
// feeds the result back) or an `end_turn` text turn (the loop finishes). Static
// mocks can't express that sequence; this stub replays an ordered SCRIPT of turns
// so the handler's real dispatch / result-assembly / finalize logic runs.
//
// Grounded in the seam app/api/support-chat/route.ts uses:
//   anthropic.messages.create(args)          -> Message { stop_reason, content }
//   anthropic.messages.stream(args)          -> { on("text", cb), finalMessage() }
// content blocks: { type:"text", text } | { type:"tool_use", id, name, input }
//
// Usage (vi.mock must reference a vi.hoisted holder for the mutable script):
//   const A = vi.hoisted(() => ({ state: { script: [] as ScriptTurn[], cursor: 0 } }))
//   vi.mock("@anthropic-ai/sdk", async () => {
//     const { buildAnthropicClass } = await import("./helpers/anthropic-fixture")
//     return { default: buildAnthropicClass(A.state) }
//   })
//   // per test: A.state.script = [...]; A.state.cursor = 0

export type ScriptTurn =
  | { tools: Array<{ id?: string; name: string; input: unknown }> }
  | { text: string }
  // Throw from the model call itself (create() rejects; stream().finalMessage()
  // rejects) — drives the handler's classifyAnthropicError / canned-message path.
  | { error: { message: string; status?: number; name?: string; type?: string } }

export interface ScriptState {
  script: ScriptTurn[]
  cursor: number
}

interface FakeMessage {
  stop_reason: "tool_use" | "end_turn"
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
  >
}

function turnError(turn: ScriptTurn | undefined): Error | null {
  if (turn && "error" in turn) {
    return Object.assign(new Error(turn.error.message), {
      status: turn.error.status,
      name: turn.error.name ?? "Error",
      type: turn.error.type,
    })
  }
  return null
}

function turnToMessage(turn: ScriptTurn | undefined, idx: number): FakeMessage {
  // Past the end of the script -> a benign empty end_turn (so a loop that
  // over-calls terminates instead of hanging).
  if (!turn || "text" in turn || "error" in turn) {
    return { stop_reason: "end_turn", content: [{ type: "text", text: turn && "text" in turn ? turn.text : "" }] }
  }
  return {
    stop_reason: "tool_use",
    content: turn.tools.map((t, j) => ({
      type: "tool_use" as const,
      id: t.id ?? `tool_${idx}_${j}`,
      name: t.name,
      input: t.input,
    })),
  }
}

/**
 * Build the class that `vi.mock("@anthropic-ai/sdk")` returns as its `default`.
 * Each `messages.create` / `messages.stream().finalMessage()` consumes the next
 * scripted turn from `state`; streaming replays a `text` turn through `on("text")`.
 * Reset `state.cursor = 0` (and set `state.script`) before each test.
 */
export function buildAnthropicClass(state: ScriptState) {
  return class {
    messages = {
      create: async (_args: unknown): Promise<FakeMessage> => {
        const turn = state.script[state.cursor]
        const msg = turnToMessage(turn, state.cursor)
        state.cursor++
        const err = turnError(turn)
        if (err) throw err
        return msg
      },
      stream: (_args: unknown) => {
        const idx = state.cursor
        const turn = state.script[idx]
        const msg = turnToMessage(turn, idx)
        state.cursor++
        const handlers: Record<string, (x: unknown) => void> = {}
        const s = {
          on(event: string, cb: (x: unknown) => void) {
            handlers[event] = cb
            return s
          },
          async finalMessage(): Promise<FakeMessage> {
            const err = turnError(turn)
            if (err) throw err
            if (turn && "text" in turn && handlers.text) handlers.text(turn.text)
            return msg
          },
        }
        return s
      },
    }
  }
}
