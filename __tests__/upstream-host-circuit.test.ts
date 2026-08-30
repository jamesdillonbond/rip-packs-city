// Contract tests for the in-process host circuit used on user-facing paths.
//
// The claim being defended is a NEGATIVE one — "this never suppresses a call
// that could have worked" — so it is asserted directly rather than described,
// and each positive is paired with the control that makes it non-vacuous.

import { describe, it, expect, beforeEach } from "vitest"
import {
  isUpstreamDown,
  noteUpstreamFailure,
  noteUpstreamSuccess,
  __resetUpstreamCircuits,
} from "@/lib/upstream/host-circuit"

const HOST = "public-api.nbatopshot.com"
const COOLDOWN = 5 * 60 * 1000
const T0 = 1_788_000_000_000

beforeEach(() => __resetUpstreamCircuits())

describe("host circuit — it cannot suppress a call that could have worked", () => {
  it("an UNKNOWN host is never down", () => {
    // Absence of a recorded failure is not evidence of anything. The safe
    // direction is to make the call.
    expect(isUpstreamDown(HOST, COOLDOWN, T0)).toBe(false)
    expect(isUpstreamDown("some-other-host.example", COOLDOWN, T0)).toBe(false)
  })

  it("a SUCCESS clears the circuit immediately, without waiting out the cooldown", () => {
    noteUpstreamFailure(HOST, T0)
    expect(isUpstreamDown(HOST, COOLDOWN, T0 + 1000)).toBe(true)
    noteUpstreamSuccess(HOST)
    // A recovery must not be penalised for the remainder of the window.
    expect(isUpstreamDown(HOST, COOLDOWN, T0 + 1000)).toBe(false)
  })

  it("is scoped PER HOST — one dead host does not disable another", () => {
    noteUpstreamFailure(HOST, T0)
    expect(isUpstreamDown(HOST, COOLDOWN, T0 + 1000)).toBe(true)
    expect(isUpstreamDown("studio.example", COOLDOWN, T0 + 1000)).toBe(false)
  })
})

describe("host circuit — POSITIVE CONTROL: it does suppress a dead host", () => {
  // Without this the suite above would pass on a function returning false always.
  it("is down immediately after a failure", () => {
    noteUpstreamFailure(HOST, T0)
    expect(isUpstreamDown(HOST, COOLDOWN, T0)).toBe(true)
  })

  it("stays down for the whole cooldown", () => {
    noteUpstreamFailure(HOST, T0)
    expect(isUpstreamDown(HOST, COOLDOWN, T0 + COOLDOWN - 1)).toBe(true)
  })
})

describe("host circuit — HALF-OPEN, so it reverses itself with no deploy", () => {
  it("is no longer down once the cooldown has elapsed", () => {
    noteUpstreamFailure(HOST, T0)
    expect(isUpstreamDown(HOST, COOLDOWN, T0 + COOLDOWN)).toBe(false)
  })

  it("pins the boundary in BOTH directions, so an off-by-one cannot pass", () => {
    noteUpstreamFailure(HOST, T0)
    expect(isUpstreamDown(HOST, COOLDOWN, T0 + COOLDOWN - 1)).toBe(true)
    expect(isUpstreamDown(HOST, COOLDOWN, T0 + COOLDOWN)).toBe(false)
  })

  it("a later failure re-arms it — an ongoing outage keeps buying windows", () => {
    noteUpstreamFailure(HOST, T0)
    expect(isUpstreamDown(HOST, COOLDOWN, T0 + COOLDOWN)).toBe(false) // probe window
    noteUpstreamFailure(HOST, T0 + COOLDOWN) // the probe failed too
    expect(isUpstreamDown(HOST, COOLDOWN, T0 + COOLDOWN + 1)).toBe(true)
  })

  it("cannot wedge: however many failures, one cooldown later it probes again", () => {
    for (let i = 0; i < 50; i++) noteUpstreamFailure(HOST, T0 + i)
    // Only the LAST failure counts — there is no counter to saturate.
    expect(isUpstreamDown(HOST, COOLDOWN, T0 + 49 + COOLDOWN)).toBe(false)
  })
})
