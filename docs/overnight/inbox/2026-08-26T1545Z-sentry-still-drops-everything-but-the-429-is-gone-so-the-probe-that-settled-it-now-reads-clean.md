# 🚨 Sentry is STILL dropping everything — but the 429 is gone, so the probe that "SETTLED" it now returns a clean 200

**Filed 2026-08-26 (PT) by Claude Code.** ⛔ **This corrects a claim I made earlier in the
same session ("the blackout is over") and qualifies the 0525Z filing's `SETTLED` headline.**
The underlying situation has not improved; only the *symptom* has, and it changed in the
direction that makes it harder to detect.

---

## What the 0525Z filing established, and what has changed

That filing settled a seven-day investigation with one request: a POST of a minimal
envelope at the production DSN returned

```
HTTP/2 429
x-sentry-rate-limits: 60:default;error;security;attachment:organization:error_usage_exceeded
```

**That response is no longer reproducible.** Measured today from Trevor's box, twice:

| # | time (UTC) | envelope | status | `x-sentry-rate-limits` | body |
|---|---|---|---|---|---|
| 1 | 14:33 | minimal | **200** | *(absent)* | `{"id":"aaaa…"}` |
| 2 | 15:22 | well-formed error event, correct item headers + `length` | **200** | *(absent)* | `{"id":"3bb7a733…"}` |

**Both were accepted. Neither has ever appeared.** Searched by fingerprint
(`RpcPipelineProbe`), by issue list, and by event count, over 24 h and 90 d:

- issues in the last 24 h: **0**
- error events in the last 24 h: **0**
- **last stored event: `2026-08-18T13:21:59Z`** — unchanged, eight days ago

ⓘ Controls that rule out the boring explanations: the DSN's project id
(`4511283198623744`) resolves to the org's only project, `javascript-nextjs`, and that
project holds **5,386 events over 90 days** — so the DSN is right, the project is right,
and it has ingested normally in the recent past. The second probe was a properly-framed
envelope (item header with `content_type` and byte `length`), so a malformed payload is
not the explanation either.

## ⭐ The durable lesson, and it is one I nearly published the wrong way round

**A `200` from Sentry's envelope endpoint means RECEIVED, not STORED.** I read the 200 plus
the absent rate-limit header as "quota restored, blackout over", and said so. It was
wrong — the events were accepted at the edge and dropped downstream, exactly as before.

⭐ **Both halves of this investigation have now been decided on an EDGE signal:** the prior
session concluded from a 429, I nearly concluded the opposite from a 200. **Neither is a
storage signal. The only sound test is whether a probe event appears in the product** — and
that test is cheap, so there is no excuse for the shortcut.

⚠ **The new behaviour is strictly worse to operate against.** A 429 with
`error_usage_exceeded` is self-describing: any client can see it and say why. A 200
followed by a silent drop is **unfalsifiable from the emitter's side** — every SDK in the
estate now believes it is reporting successfully. This is the honesty canon's own shape,
one layer down: *a failed write must not report as a success.*

## 👉 What this changes for the operator

**Nothing about the action, only about the expectation.** Trevor still needs
**Sentry → Settings → Subscription** (raise the plan, or enable an on-demand budget).
What changes is:

1. ⛔ **Do not verify the fix by re-POSTing and reading the status code** — that is what
   produced this false positive. **Verify by sending a probe and then finding it in the
   Issues view.** A one-line check, and the only one that means anything.
2. The `error_usage_exceeded` diagnosis is **not refuted** by this — quota exhaustion is
   still much the most likely cause, and it explains everything observed. It is simply **no
   longer directly evidenced**, because the endpoint stopped saying so.
3. ⚠ **The 15,388-events-in-a-week figure attributed to the RPC-deadline signature should
   be re-derived before it is quoted again.** The project holds only **5,386 stored events
   across 90 days**, so that number cannot be a count of *stored* events; it presumably came
   from a different population (pre-drop volume, or an issue-level total). It does not
   change the argument for the sampling guard — one signature dominating a finite quota is
   still the right thing to bound — but the number itself is not corroborated here.

## ✅ Unchanged and still correct from the 0525Z filing

The durable half of that filing stands: **the quota guard is deployed and live**
(`lib/observability/sentry-quota-guard.ts`, verified running in production 2026-08-26), it
defaults to SEND, it stamps `sentry_sample_rate` on kept events, and raising the quota
without it would burn the new budget in about two days. **Nothing here argues for
reverting it** — it argues that we will not be able to tell it is working until events are
being stored again.

⚠ **And the gap the 0525Z filing named is still open and is now the more important half:
nothing watches this.** A collector that has been dropping for eight days looks exactly
like a quiet week. An arm on *"Sentry stored an event recently"* — not *"Sentry answered
200"* — is worth building, and this filing is the second demonstration in one week that the
distinction is the whole point.
