import { describe, it, expect, vi } from "vitest"
import { FlowScriptError, addr, arrayOf, panicMessage, runFlowScript, u64 } from "@/lib/giveaways/flow-script"
import { FLOW_SCRIPTS_URL } from "@/lib/giveaways/topshot-holdings"

// The error body below is VERBATIM from mainnet (2026-09-29, pg_net), from simulating a
// delivery of a LOCKED moment. Parsing it is how the admin learns why a plan was refused.
const LOCKED_BODY =
  '{\n\t"code": 400,\n\t"message": "Invalid Flow argument: failed to execute script: [Error Code: 1101] failed to execute script at block (480fe524f0548479d35e1fc880774f45f820f163d6a9f63080e2bf4189436716): [Error Code: 1101] error caused by: 1 error occurred:\\n\\t* [Error Code: 1101] cadence runtime error: Execution failed:\\n  --\\u003e 510da5b77f1f0c9b889da671364f086812feada941fe27cb2221a77f90fd8629:26:26\\n   |\\n26 |             let moment \\u003c- provider.withdraw(withdrawID: momentIDs[i])\\n   |                           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^\\n\\nerror: panic: Cannot withdraw: Moment is locked\\n    --\\u003e 0b2a3299cc857e29.TopShot:1189:16\\n     |\\n1189 |                 panic(\\\\\\"Cannot withdraw: Moment is locked\\\\\\")\\n     |                 ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^\\n\\nWas this error unhelpful?\\nConsider suggesting an improvement here: https://github.com/onflow/cadence/issues.\\n\\n\\n"\n}'

function ok(value: unknown) {
  return new Response(JSON.stringify(Buffer.from(JSON.stringify(value)).toString("base64")) + "\n", { status: 200 })
}

describe("giveaways/flow-script", () => {
  it("posts base64 script + JSON-CDC args and decodes the result", async () => {
    const f = vi.fn(async () => ok({ type: "Array", value: [{ type: "Bool", value: true }] }))
    const r = await runFlowScript("access(all) fun main(): Bool { return true }", [addr("0x01"), u64("7"), arrayOf([u64("1")])], f)
    expect(r).toEqual({ type: "Array", value: [{ type: "Bool", value: true }] })
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(FLOW_SCRIPTS_URL)
    const body = JSON.parse(init.body as string)
    expect(Buffer.from(body.script, "base64").toString()).toContain("fun main()")
    expect(body.arguments.map((a: string) => JSON.parse(Buffer.from(a, "base64").toString()))).toEqual([
      { type: "Address", value: "0x01" },
      { type: "UInt64", value: "7" },
      { type: "Array", value: [{ type: "UInt64", value: "1" }] },
    ])
  })

  it("a Cadence panic surfaces as its own message (the real mainnet body)", async () => {
    expect(panicMessage(LOCKED_BODY)).toBe("Cannot withdraw: Moment is locked")
    const err = await runFlowScript("x", [], async () => new Response(LOCKED_BODY, { status: 400 })).catch((e) => e)
    expect(err).toBeInstanceOf(FlowScriptError)
    expect(err.message).toBe("Cadence: Cannot withdraw: Moment is locked")
    expect(err.status).toBe(400)
  })

  it("an assertion failure is parsed too; any other failure is the HTTP status", async () => {
    expect(panicMessage('error: assertion failed: a batch holds 1 to 50 moments\\n')).toBe("a batch holds 1 to 50 moments")
    await expect(runFlowScript("x", [], async () => new Response("<html>gateway</html>", { status: 503 }))).rejects.toThrow("Flow script HTTP 503")
  })

  it("an undecodable 200 is an error, never a value", async () => {
    await expect(runFlowScript("x", [], async () => new Response('"%%%"', { status: 200 }))).rejects.toThrow(/undecodable/)
  })
})
