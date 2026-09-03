# Supabase auth email templates — Rip Packs City

**Status (2026-09-02 evening PT): DONE, live.** Both sign-in templates are branded and link to our own domain. This file is the record of what is in the Supabase dashboard (Authentication → Emails → Templates), which is not in this repo.

**What was wrong.** The 2026-09-02 onboarding walkthrough read the real *first-time* signup email out of the Resend log: subject **"Confirm Your Signup"**, body *"Follow this link to confirm your user: Confirm your mail"* — Supabase's stock template — while `/login` had just promised a "magic link". The *Magic link or OTP* template (returning addresses) had already been branded earlier, with a link to `{{ .SiteURL }}/api/auth/callback?token_hash=…&type=magiclink`; only *Confirm signup* was stock. A brand-new address hits *Confirm signup* (because `signInWithOtp` runs with `shouldCreateUser: true`), so every campaign signup got the stock one.

**What is live now.**

| Template | Subject | Link |
|---|---|---|
| Confirm signup | `Sign in to Rip Packs City` | `{{ .SiteURL }}/api/auth/callback?token_hash={{ .TokenHash }}&type=signup` |
| Magic link or OTP | `Sign in to Rip Packs City` | `{{ .SiteURL }}/api/auth/callback?token_hash={{ .TokenHash }}&type=magiclink` |

The two bodies are byte-identical apart from `type=`: dark table layout, RPC logo, "Tap the button below to sign in. This link expires in 1 hour and can only be used once.", red "Sign in to RPC" button, the URL in plain text under it, the "didn't request this?" line, footer with rippackscity.com · @rippackscity. `app/api/auth/callback/route.ts` accepts both `signup` and `magiclink` (`verifyOtp` with `token_hash`) and redirects to `/dashboard`.

**Verified 2026-09-02:** requested a link for a fresh `+tag` address on `/login` → Resend shows subject `Sign in to Rip Packs City`, branded HTML, link on `www.rippackscity.com/api/auth/callback?…&type=signup`; opening it signed the new account in and landed on `/dashboard` (`/api/profile/me` answered the new user).

**Not changed, on purpose.** *Change email / Reset password / Invite / Reauthentication* — not on the sign-in path; the product has no password and no invites. A custom auth domain is not needed: the link is already on our domain via the token-hash flow.

**If a template ever reverts** (the dashboard has a "Reset template" button): copy the *Magic link or OTP* body, replace `type=magiclink` with `type=signup`, paste into *Confirm signup*, set the subject above.
