# Supabase auth email templates — Rip Packs City

**Why this file exists.** The 2026-09-02 onboarding walkthrough read the real signup email out of the Resend log: subject **"Confirm Your Signup"**, body *"Follow this link to confirm your user: Confirm your mail"* — Supabase's stock template, unbranded, and contradicting the `/login` page that had just promised a "magic link". Templates live in the Supabase dashboard (Authentication → Email Templates), not in this repo, so this file is the source of truth to paste from and to diff against. Sender is already correct (`Rip Packs City <noreply@rippackscity.com>` via Resend SMTP).

Two templates matter for the sign-in flow. A brand-new address hits **Confirm signup** (because `signInWithOtp` runs with `shouldCreateUser: true`); a returning address hits **Magic Link**. Both must say the same thing, because the user cannot tell which one they will get.

Variables Supabase substitutes: `{{ .ConfirmationURL }}` (the link — keep it exactly), `{{ .Email }}`, `{{ .SiteURL }}`. Do not add the token to any other URL.

## Confirm signup

**Subject:** `Your Rip Packs City sign-in link`

```html
<div style="background:#0a0a0a;padding:32px 16px;font-family:Menlo,Consolas,'Courier New',monospace;color:#e7e7e7">
  <div style="max-width:520px;margin:0 auto;background:#121212;border:1px solid #2a2a2a;border-radius:12px;padding:28px">
    <div style="font-size:11px;letter-spacing:0.22em;color:#E03A2F;text-transform:uppercase;margin-bottom:14px">Rip Packs City · Sign in</div>
    <h1 style="font-family:'Arial Black',Impact,Arial,sans-serif;font-size:26px;line-height:1.1;letter-spacing:0.02em;text-transform:uppercase;color:#ffffff;margin:0 0 14px">Tap to sign in</h1>
    <p style="font-size:13px;line-height:1.7;color:#b8b8b8;margin:0 0 22px">This link signs you in on the device you open it on. It works once and expires in 1 hour.</p>
    <a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#E03A2F;color:#ffffff;text-decoration:none;font-weight:700;font-size:13px;letter-spacing:0.16em;text-transform:uppercase;padding:14px 24px;border-radius:6px">Sign in to Rip Packs City →</a>
    <p style="font-size:11px;line-height:1.7;color:#7a7a7a;margin:24px 0 0">Didn't ask for this? Ignore it — nothing happens unless the link is opened. If the button doesn't work, copy this into your browser:<br><span style="word-break:break-all;color:#9a9a9a">{{ .ConfirmationURL }}</span></p>
  </div>
  <div style="max-width:520px;margin:14px auto 0;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#5a5a5a;text-align:center">Rip Packs City · Collector intelligence · Flow blockchain</div>
</div>
```

## Magic Link

**Subject:** `Your Rip Packs City sign-in link`

Body: identical to *Confirm signup* above (same HTML). The two exist as separate templates in Supabase only because Supabase distinguishes first-time from returning addresses; the product does not.

## Not changed, on purpose

- **Link hostname.** `{{ .ConfirmationURL }}` points at `bxcqstmqfzmuolpuynti.supabase.co/auth/v1/verify`. A custom auth domain (link on `rippackscity.com`) is a paid Supabase add-on — declined under the cost-flat gate unless deliverability data says otherwise. The branded body and sender are what recipients actually read.
- **Change email / Reset password / Invite templates.** Not on the sign-in path; the product has no password and no invites.

## Verify after pasting

Request a link for a fresh `+tag` address on `/login`, then read it back from the Resend log (`list-emails` → `get-email`): subject and the red button should appear; the plain-text part should still carry the URL.
