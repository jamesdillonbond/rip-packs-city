# Stripe go-live preflight — 2026-05-10

The Stripe webhook + checkout scaffold landed in commit `6e327ba`. This doc is the runbook Trevor needs to
walk through in the Stripe dashboard + Vercel env before flipping on real payments, plus an audit of the
current handler coverage in `app/api/stripe/*`.

## 1. Stripe account setup

1. **Switch from test mode to live mode** in the top-right dashboard toggle. Live-mode keys and webhooks are a
   completely separate set from test-mode — nothing copies across.
2. **Complete business verification.** Until verified, Stripe holds payouts in escrow:
   - Legal entity: Rip Packs City LLC (Oregon, filed 2026-05-03).
   - Tax ID: EIN.
   - Business model description: "SaaS analytics for digital collectibles markets."
   - Industry code: `7372` (Prepackaged Software) or `5734` (Computer Software Stores).
3. **Payout account.** Connect a checking account; default Stripe payout schedule is 2-day rolling.
4. **Statement descriptor.** Set to `RIPPACKSCITY` (max 22 chars) — this is what appears on customer cards.

## 2. Product + Price creation (live mode)

Stripe dashboard → Products → New product:

- Name: `RPC Pro`
- Description: `Rip Packs City — Pro subscription. Saved wallets, custom alerts, AI Concierge, API access.`
- Pricing model: `Standard pricing`
- Price: `$9.99` USD
- Billing period: `Monthly` (recurring)
- Tax behavior: `Inclusive` or `Exclusive` per Trevor's tax setup; default `Exclusive` is fine.

After save, copy the **Price ID** (format `price_1Nxxxx...`). This is the value for env var
`STRIPE_PRICE_ID_PRO_MONTHLY`.

## 3. Webhook endpoint

Stripe dashboard → Developers → Webhooks → Add endpoint:

- **Endpoint URL:** `https://www.rippackscity.com/api/stripe/webhook`
- **Events to send** (these are the ones the handler currently switches on — see audit below):
  - `invoice.payment_succeeded`
  - `checkout.session.completed`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
- **Recommended additional events to subscribe** (handler gap — see audit; subscribing now means we don't
  have to come back when we add the handler later):
  - `customer.subscription.created`
  - `invoice.payment_failed` (we don't handle this today but it's the canonical "dunning" signal)

After save, copy the **Signing secret** (format `whsec_...`). This is the value for env var
`STRIPE_WEBHOOK_SECRET`.

## 4. Vercel env vars (Production + Preview)

All four must be set in the `Production` environment. `Preview` should mirror with the **test-mode**
equivalents (a separate Stripe test webhook pointed at `*.vercel.app` preview URLs).

| Env var | Value source | Production scope | Preview scope |
|---|---|---|---|
| `STRIPE_SECRET_KEY` | Stripe dashboard → Developers → API keys → "Secret key" (live mode) | live `sk_live_...` | test `sk_test_...` |
| `STRIPE_WEBHOOK_SECRET` | The signing secret from step 3 | live `whsec_...` | a separate test-webhook `whsec_...` |
| `STRIPE_PRICE_ID_PRO_MONTHLY` | The Price ID from step 2 | live `price_...` | test `price_...` (recreate the product in test mode) |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Stripe → Developers → API keys → "Publishable key" | live `pk_live_...` | test `pk_test_...` |

Writes go via the PowerShell `Invoke-WebRequest` pattern in CLAUDE.md (Vercel MCP env-var endpoints are
read-only). After all four are set, trigger a fresh deployment so the lambdas pick them up — dashboard
"Redeploy" reuses build cache and will NOT re-bake env vars.

## 5. Pre-flip local test plan (Stripe CLI)

```bash
# Forward live-mode webhooks to localhost for an end-to-end smoke
stripe login                                          # use the dashboard pin code
stripe listen --forward-to localhost:3000/api/stripe/webhook
# (CLI prints a webhook signing secret for the listener — set STRIPE_WEBHOOK_SECRET=<that> in your
#  local .env.development and `npm run dev` so the local handler verifies signatures)

# In a second terminal, simulate the durable activation path:
stripe trigger invoice.payment_succeeded
```

Expected after `stripe trigger`:
- `stripe_payment_log` gets a new row with `stripe_event_id` = the triggered event id.
- `pro_users` either activates (if `metadata.user_id` resolves to a wallet) or logs the payment in
  `stripe_payment_log` with status `pending` (no wallet linked yet).

Other useful triggers:
- `stripe trigger checkout.session.completed`
- `stripe trigger customer.subscription.deleted`

## 6. Production smoke test (real $9.99 card)

1. Open an incognito window. Sign in to rippackscity.com as a non-Pro user. Confirm `pro_users` row absent
   (or `tier` ≠ `pro_paid`) before the test.
2. Click the `/pricing` CTA → `Checkout`. Should land on `checkout.stripe.com` with the `$9.99/mo`
   `RPC Pro` line item.
3. Pay with a real card (Trevor's own — refund after). Card is charged $9.99; success_url redirects to
   `/dashboard?pro=success`.
4. Verify within 30s:
   - `pro_users` row exists with `wallet_address` = the signed-in user's wallet (if linked), `plan='monthly'`,
     `expires_at` ~ today + 30 days.
   - `stripe_payment_log` has a row with `stripe_event_id` = the `invoice.payment_succeeded` event id,
     `amount_usd=9.99`, `plan_name='pro_monthly'` (or whatever the price nickname/description is).
   - `/dashboard` UI reflects `Pro` badge + unlocked feature quotas (custom_alerts_max=25,
     concierge_messages quota etc.).
5. Open the customer portal: `/dashboard` → "Manage subscription" → "Cancel subscription".
6. Verify within 60s:
   - Stripe webhook fires `customer.subscription.updated` with `cancel_at_period_end=true` (subscription
     still active till period end), AND/OR `customer.subscription.deleted` if cancellation is immediate.
   - `pro_users.expires_at` updates to the period end (cancel_at_period_end=true) or to now()
     (immediate-cancel).
7. **Refund the $9.99 charge** from the Stripe dashboard → Payments → Refund.

## 7. Rollback plan

If the webhook is misconfigured or the activation RPC has a bug discovered post-flip:

```sql
-- Identify the affected wallets
SELECT wallet_address, plan, expires_at FROM pro_users WHERE subscribed_at > '2026-05-10' ORDER BY subscribed_at DESC;

-- Manually degrade all of them
UPDATE pro_users SET expires_at = now() WHERE subscribed_at > '2026-05-10' AND <criteria>;
```

For refunds: dashboard → Payments → bulk-refund. Stripe webhooks `charge.refunded` will fire — they currently
go unhandled (no handler defined) and that's fine, the manual UPDATE above is the source of truth.

If something is fundamentally broken with the webhook, take it offline:
1. Stripe dashboard → Webhooks → toggle the endpoint to **Disabled**.
2. New checkouts continue to work but no events get processed; backlog accumulates in Stripe.
3. Once fixed, re-enable. Stripe will replay queued events for ~30 days.

## 8. Handler coverage audit

Read of `app/api/stripe/{webhook,checkout,portal}/route.ts` and `lib/stripe.ts` against the events listed in
step 3.

| Event | Handler? | Notes |
|---|---|---|
| `invoice.payment_succeeded` | ✅ | Routes through SECDEF `activate_pro_from_stripe` — idempotent on event id, writes `stripe_payment_log`, graceful "pending" when wallet unlinked. The durable path. |
| `checkout.session.completed` | ✅ | Direct upsert to `pro_users` from `session.metadata.walletAddress`. ⚠️ **GAP**: `checkout/route.ts` writes `metadata.wallet_address` (snake_case) but the webhook reads `session.metadata.walletAddress` (camelCase). Today this case-mismatch means immediate activation never fires from `checkout.session.completed` — the `invoice.payment_succeeded` handler picks it up ~30s later via `subscription_data.metadata`. Not critical (still activates), but the immediate-activation path is dead code. |
| `customer.subscription.created` | ❌ **MISSING** | Stripe fires this BEFORE `checkout.session.completed`. Not strictly required because the two later handlers cover activation, but subscribing without handling means the webhook returns `{received: true}` silently. Fine to leave unhandled if the event is *also* not subscribed to in step 3. |
| `customer.subscription.updated` | ✅ | Looks up wallet by `stripe_customer_id`, sets `expires_at = current_period_end` if active/trialing, else `now()`. |
| `customer.subscription.deleted` | ✅ | Sets `expires_at = now()`. |
| `invoice.payment_failed` | ❌ | Recommended event in step 3 but no handler. When subscribed, it'll log `[stripe/webhook]` no-op. Worth adding before flipping if you want dunning email surfacing. |
| `charge.refunded` | ❌ | Manual rollback only — see step 7. |

### Additional inline gaps flagged (not for this commit — runbook only)

1. **`app/api/stripe/portal/route.ts` is unauthenticated.** Accepts `walletAddress` from request body with no
   `getCurrentUser()` check. Stripe will only show the customer their own subscription so the blast radius is
   limited to "anyone who guesses a wallet address can open that wallet's portal session." Should match
   `checkout/route.ts`'s auth gate. Low priority but a clean hardening.
2. **Webhook handler does not return non-200 on RPC failure.** When `activate_pro_from_stripe` errors, the
   webhook logs and returns 200 — Stripe sees success and won't retry. Acceptable today (the error logs are
   captured, and the SECDEF function is idempotent so a manual replay works), but in a future hardening
   pass return 500 on RPC failure so Stripe retries with exponential backoff for transient DB blips.
3. **`metadata.walletAddress` vs `metadata.wallet_address` inconsistency** — flagged inline above. Pick one
   canonical key and align checkout + webhook. The `invoice.payment_succeeded` handler already accepts both
   (`subMeta.wallet_address ?? subMeta.walletAddress`); easiest fix is the same accept-both shape in the
   `checkout.session.completed` branch.

These are gaps, not blockers. Trevor can flip on payments today with the current handler set — the durable
`invoice.payment_succeeded` path covers activation through the SECDEF RPC, and the subscription.updated +
subscription.deleted handlers cover lifecycle. Items (1)-(3) are next-pass hardening.
