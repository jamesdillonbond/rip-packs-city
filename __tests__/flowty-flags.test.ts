import { describe, it, expect, afterEach } from "vitest"
import {
  FLOWTY_MARKETPLACE_ENABLED,
  isFlowtyLoansEnabled,
  isFlowtyIngestEnabled,
  FLOWTY_MARKETPLACE_DISABLED_MESSAGE,
  FLOWTY_INCIDENT_URL,
} from "@/lib/flowty-flags"

// Locks the three-flag Flowty kill-switch semantics:
// - loans/ingest are server-only and default to ENABLED (only "false" turns off)
// - the marketplace constant is a strict === "true" boolean read at import time
// - the exported message + incident URL constants are fixed strings.

describe("isFlowtyLoansEnabled", () => {
  const orig = process.env.FLOWTY_LOANS_ENABLED
  afterEach(() => {
    if (orig === undefined) delete process.env.FLOWTY_LOANS_ENABLED
    else process.env.FLOWTY_LOANS_ENABLED = orig
  })

  it("defaults to true when unset (enabled unless explicitly false)", () => {
    delete process.env.FLOWTY_LOANS_ENABLED
    expect(isFlowtyLoansEnabled()).toBe(true)
  })

  it("is false only for the exact string 'false'", () => {
    process.env.FLOWTY_LOANS_ENABLED = "false"
    expect(isFlowtyLoansEnabled()).toBe(false)
  })

  it("stays true for other truthy-ish strings like 'true' or '0'", () => {
    process.env.FLOWTY_LOANS_ENABLED = "true"
    expect(isFlowtyLoansEnabled()).toBe(true)
    process.env.FLOWTY_LOANS_ENABLED = "0"
    expect(isFlowtyLoansEnabled()).toBe(true)
  })
})

describe("isFlowtyIngestEnabled", () => {
  const orig = process.env.FLOWTY_INGEST_ENABLED
  afterEach(() => {
    if (orig === undefined) delete process.env.FLOWTY_INGEST_ENABLED
    else process.env.FLOWTY_INGEST_ENABLED = orig
  })

  it("defaults to true when unset", () => {
    delete process.env.FLOWTY_INGEST_ENABLED
    expect(isFlowtyIngestEnabled()).toBe(true)
  })

  it("is false only for the exact string 'false'", () => {
    process.env.FLOWTY_INGEST_ENABLED = "false"
    expect(isFlowtyIngestEnabled()).toBe(false)
  })
})

describe("FLOWTY_MARKETPLACE_ENABLED constant", () => {
  it("is a boolean equal to whether the env var was exactly 'true' at import", () => {
    expect(typeof FLOWTY_MARKETPLACE_ENABLED).toBe("boolean")
    expect(FLOWTY_MARKETPLACE_ENABLED).toBe(
      process.env.NEXT_PUBLIC_FLOWTY_MARKETPLACE_ENABLED === "true"
    )
  })
})

describe("exported message constants", () => {
  it("has the fixed disabled message", () => {
    expect(FLOWTY_MARKETPLACE_DISABLED_MESSAGE).toBe(
      "Flowty marketplace temporarily unavailable"
    )
  })

  it("has the fixed incident URL", () => {
    expect(FLOWTY_INCIDENT_URL).toBe(
      "https://flowty.substack.com/p/announcement-suspension-of-flowty"
    )
  })
})
