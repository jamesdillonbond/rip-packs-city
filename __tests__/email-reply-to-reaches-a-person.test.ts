// __tests__/email-reply-to-reaches-a-person.test.ts
//
// Every email RPC sends through Resend carries `reply_to: REPLY_TO` (the
// mailbox a person reads), and no send names an @rippackscity.com reply-to.
//
// ── THE CASE THIS WAS WRITTEN FROM (2026-11-10) ────────────────────────────
// rippackscity.com has no inbound mail: no MX record, and Resend receiving is
// off. The "your request shipped" emails set reply_to to
// rpc-support@rippackscity.com, so a reader's reply BOUNCED; eleven other send
// sites set no reply_to at all, so a reply went to the @rippackscity.com
// sender and bounced the same way. Found while checking the Dame Time reward
// email before it went out.
//
// ── WHY A TREE WALK, AT ZERO ───────────────────────────────────────────────
// The population is every file under app/ and lib/ that posts to the Resend
// emails endpoint. A new send site joins it by being written; nothing to list.

import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import { REPLY_TO, SENDER_MAILBOX } from "@/lib/emails/sender-identity"

const ROOTS = ["app", "lib"].map((d) => join(process.cwd(), d))
const RESEND_SEND = /https:\/\/api\.resend\.com\/emails/g
const REPLY_TO_SET = /\breply_to:\s*REPLY_TO\b/g
const OWN_DOMAIN_REPLY = /\breply_to:\s*["'`][^"'`]*@rippackscity\.com/

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|mjs|js)$/.test(entry)) out.push(p)
  }
  return out
}

const files = ROOTS.flatMap((r) => walk(r)).map((p) => ({ path: relative(process.cwd(), p), src: stripComments(readFileSync(p, "utf8")) as string }))
const senders = files.filter((f) => (f.src.match(RESEND_SEND) ?? []).length > 0)

describe("a reply to an RPC email reaches a person", () => {
  it("REPLY_TO is the mailbox, not an address on our own (receive-less) domain", () => {
    expect(REPLY_TO).toBe(SENDER_MAILBOX)
    expect(REPLY_TO).not.toMatch(/@rippackscity\.com$/i)
  })

  it("the walk found the send sites (not vacuous)", () => {
    expect(senders.length).toBeGreaterThanOrEqual(15)
  })

  it("every Resend send sets reply_to: REPLY_TO — one per send", () => {
    const short = senders
      .map((f) => ({ path: f.path, sends: (f.src.match(RESEND_SEND) ?? []).length, replies: (f.src.match(REPLY_TO_SET) ?? []).length }))
      .filter((r) => r.replies < r.sends)
    expect(short).toEqual([])
  })

  it("every edge-function Resend send sets a reply_to too (they cannot import REPLY_TO), and none on our own domain", () => {
    const fnRoot = join(process.cwd(), "supabase", "functions")
    const fns = walk(fnRoot)
      .map((p) => ({ path: relative(process.cwd(), p), src: stripComments(readFileSync(p, "utf8")) as string }))
      .filter((f) => (f.src.match(RESEND_SEND) ?? []).length > 0)
    expect(fns.length).toBeGreaterThanOrEqual(1)
    const short = fns.filter((f) => (f.src.match(/\breply_to:/g) ?? []).length < (f.src.match(RESEND_SEND) ?? []).length).map((f) => f.path)
    expect(short).toEqual([])
    expect(fns.filter((f) => OWN_DOMAIN_REPLY.test(f.src)).map((f) => f.path)).toEqual([])
  })

  it("no send names an @rippackscity.com reply-to", () => {
    expect(files.filter((f) => OWN_DOMAIN_REPLY.test(f.src)).map((f) => f.path)).toEqual([])
  })
})
