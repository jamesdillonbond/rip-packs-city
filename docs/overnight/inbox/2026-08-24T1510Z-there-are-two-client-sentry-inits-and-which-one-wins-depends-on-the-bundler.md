# There are TWO client `Sentry.init()` calls in this repo, and which one wins depends on the BUNDLER — under production's turbopack the richer config is INERT

**Filed:** 2026-08-24 15:10Z (08:10 PT) · **By:** Claude Opus 5, Claude Code on Trevor's Windows box · **Status:** MEASURED from the installed SDK's own resolution code. **Deliberately NOT fixed** — see the last section; the fix wants a live Sentry to verify against.

⚠ **This does NOT explain the ingest outage** (`2026-08-23T0250Z`, `2026-08-23T1930Z`). Those two ruled out the app-side causes correctly and the quota hypothesis still stands. **What this does is close the last app-side branch they left open, and surface a separate defect found on the way.**

## The two inits

| file | DSN | extra config |
|---|---|---|
| `instrumentation-client.ts` | **hardcoded literal** | `tracesSampleRate`, `sendDefaultPii`, `onRouterTransitionStart` |
| `sentry.client.config.ts` | `process.env.NEXT_PUBLIC_SENTRY_DSN \|\| ""` | `enabled: NODE_ENV==="production"`, `environment`, `release`, `replaysSessionSampleRate 0.01`, `replaysOnErrorSampleRate 1.0`, `replayIntegration()` |

**The SDK knows this is wrong and says so in as many words** (`@sentry/nextjs@10.50.0`, `build/cjs/client/index.js:47`):

> *"You are calling `Sentry.init()` more than once on the client. This can happen if you have both a `sentry.client.config.ts` and a `instrumentation-client.ts` file with `Sentry.init()` calls. It is recommended to call `Sentry.init()` once in `instrumentation-client.ts`."*

## 🚨 Which one loads is BUNDLER-DEPENDENT — that is the part worth knowing

Read from the installed SDK, not from the docs:

- **webpack** — `build/cjs/config/webpack.js:542` *"Searches for a `sentry.client.config.ts|js` file"*, `possibilities = ['sentry.client.config.ts','sentry.client.config.js']`, and injects it into the client entry **in addition to** `instrumentation-client`. ⇒ **both run, `Sentry.init()` twice**, which is the warning above.
- **turbopack** — `build/cjs/config/turbopack/generateValueInjectionRules.js:54` injects on `matcher: '**/instrumentation-client.*'` **only**, and `withSentryConfig/buildTime.js:100-103` enumerates exactly four candidate paths — `src/instrumentation-client.{ts,js}`, `instrumentation-client.{ts,js}` — **none of them `sentry.client.config.*`.** ⇒ **the legacy file is never bundled.**

✅ **Production is turbopack.** Four READY Vercel deploys on 2026-08-24 (`d2101312`, `e8cbbfe8`, `b36c942f`, `3cbaac46`) all report `"bundler": "turbopack"` in their deployment metadata.

## What is therefore silently NOT applied in production

Everything only `sentry.client.config.ts` sets:

- **`environment`** — client events carry no environment tag, so preview and production cannot be told apart.
- **`release`** (`NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA`) — **no client event is attributable to a deploy**, which is exactly the field you want when asking *"did my fix work?"*
- **Session replay** — `replayIntegration()` with 1% session / 100% on-error. **The repo reads as though replay is on. It is not.**
- **`enabled: NODE_ENV === "production"`** — the live init has no gate, so the client SDK initialises in dev too.

## ⛔ AND IT CORRECTS A PARENTHETICAL IN BOTH SENTRY FILINGS

`2026-08-23T0250Z` says: *"`sentry.client.config.ts` does read `NEXT_PUBLIC_SENTRY_DSN`, so a browser-side outage could be env-driven; the server side cannot be."* ⚠ **Under turbopack that branch does not exist either.** The live client init hardcodes the DSN, so **`NEXT_PUBLIC_SENTRY_DSN` is inert** and *no* runtime — client, server or edge — can be silenced by unsetting an env var. **That strengthens their conclusion rather than weakening it: every app-side cause is now eliminated, not just the server-side ones.**

## ⛔ NOT FIXED HERE, and the reason is the same one the prior filing gave

The obvious fix is to consolidate into `instrumentation-client.ts` and delete the legacy file. **Two reasons to wait:**

1. 🚨 **Turning replay ON while a QUOTA-EXHAUSTION hypothesis is live would be actively harmful.** Replay is the single heaviest thing Sentry ingests. If the leading hypothesis is right, this change makes the outage worse and confounds the falsifiable prediction (*"ingest resumes at the billing reset"*) that the 08-23 filing is waiting on.
2. **A change to the error reporter cannot be verified while the reporter is dark.** `environment` and `release` are pure metadata and safe in isolation, but *"shipped and unverifiable"* on an instrument is how this repo got #31.

➡ **Do it as ONE change once ingest resumes**, so each part can be confirmed against real events — and **decide replay deliberately** (bundle weight + quota), rather than inheriting it from a file nobody knew was dead.

⚠ **If the bundler ever changes back to webpack, this stops being a dead file and becomes a double-`init()`** — same repo, opposite failure. **Delete it rather than leaving it as a latent switch.**

## Re-derive before acting

Every claim above is read from `node_modules/@sentry/nextjs@10.50.0` and from Vercel deployment metadata on 2026-08-24. **Re-check the SDK version and the deploys' `bundler` field first** — this whole finding hinges on which resolution path runs.
