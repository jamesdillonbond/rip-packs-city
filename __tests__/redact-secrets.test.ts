import { describe, it, expect } from "vitest"
import { redactSecrets, secretValues, type SecretEnv } from "../lib/redact-secrets"

// The sentinel now publishes WHY an alert channel failed — into its JSON
// response and into `pipeline_runs.extra`. That is only safe because of this.
// 🚨 The Telegram bot token is in the URL PATH (`/bot<TOKEN>/sendMessage`), so a
// thrown fetch that quotes the URL would otherwise write a live credential into
// a durable row.

const ENV = {
  TELEGRAM_BOT_TOKEN: "1234567890:AAFakeTokenForTestsOnly_notreal",
  TELEGRAM_CHAT_ID: "-1001234567890",
  RESEND_API_KEY: "re_FakeKeyForTestsOnly",
} as SecretEnv

describe("redactSecrets — arm 1, values this process holds", () => {
  it("removes the bot token from a message that quotes it", () => {
    const msg = `fetch failed for https://api.telegram.org/bot${ENV.TELEGRAM_BOT_TOKEN}/sendMessage`
    const out = redactSecrets(msg, ENV)
    expect(out).not.toContain(ENV.TELEGRAM_BOT_TOKEN)
    expect(out).toContain("***")
  })

  it("removes the chat id and the Resend key too", () => {
    const out = redactSecrets(`chat=${ENV.TELEGRAM_CHAT_ID} key=${ENV.RESEND_API_KEY}`, ENV)
    expect(out).not.toContain(ENV.TELEGRAM_CHAT_ID)
    expect(out).not.toContain(ENV.RESEND_API_KEY)
  })

  it("ignores a SHORT value rather than mangling the message with it", () => {
    // A 2-character token would replace those two characters everywhere and
    // destroy the diagnosis this whole change exists to provide.
    const out = redactSecrets("a status of 401 was returned", { TELEGRAM_CHAT_ID: "40" } as SecretEnv)
    expect(out).toBe("a status of 401 was returned")
  })
})

describe("redactSecrets — arm 2, shapes, which arm 1 cannot cover", () => {
  it("scrubs a /bot<token> path for a token this process does NOT hold", () => {
    // The rotation case: the value is gone from the env but still in a log line.
    const out = redactSecrets("GET https://api.telegram.org/bot999:ROTATEDAWAY/sendMessage 401", {} as SecretEnv)
    expect(out).not.toContain("ROTATEDAWAY")
    expect(out).toContain("/bot***")
  })

  it("scrubs a Bearer header echoed back in an error body", () => {
    const out = redactSecrets('unauthorized: Authorization: Bearer re_SomethingElseEntirely', {} as SecretEnv)
    expect(out).not.toContain("re_SomethingElseEntirely")
    expect(out).toContain("Bearer ***")
  })

  it("stops the /bot scrub at the path separator, so the rest stays diagnosable", () => {
    // Over-scrubbing would leave a reason nobody can act on, which is the same
    // failure as not reporting one.
    expect(redactSecrets("https://api.telegram.org/botABC123/sendMessage", {} as SecretEnv)).toContain(
      "/sendMessage",
    )
  })
})

describe("redactSecrets — it must stay USEFUL", () => {
  it("leaves an ordinary diagnosis untouched", () => {
    const msg = "http_401: {\"ok\":false,\"error_code\":401,\"description\":\"Unauthorized\"}"
    expect(redactSecrets(msg, ENV)).toBe(msg)
  })

  it("handles a non-string without throwing", () => {
    expect(redactSecrets(undefined, ENV)).toBe("")
    expect(redactSecrets(new Error("boom"), ENV)).toContain("boom")
  })
})

describe("secretValues", () => {
  it("collects only the values that are set and long enough to match safely", () => {
    expect(secretValues(ENV).sort()).toEqual(
      [ENV.TELEGRAM_BOT_TOKEN, ENV.TELEGRAM_CHAT_ID, ENV.RESEND_API_KEY].sort(),
    )
  })

  it("is empty on an empty environment rather than throwing", () => {
    expect(secretValues({} as SecretEnv)).toEqual([])
  })

  it("covers the ingest/admin tokens too — the class, not the instance", () => {
    // Every one of these has been observed ambient in a developer shell
    // (vitest.setup.ts deletes them for exactly that reason).
    const env = {
      INGEST_SECRET_TOKEN: "ingest-token-value-long-enough",
      CRON_SECRET: "cron-secret-value-long-enough",
      RPC_ADMIN_TOKEN: "admin-token-value-long-enough",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key-value-long-enough",
    } as SecretEnv
    expect(secretValues(env)).toHaveLength(4)
    expect(redactSecrets("leaked ingest-token-value-long-enough here", env)).not.toContain("ingest-token")
  })
})
