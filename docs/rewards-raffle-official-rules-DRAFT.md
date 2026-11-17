# Rip Packs City Rewards — Raffle/Sweepstakes Official Rules (DRAFT)

> ⚠️ **DRAFT — NOT LEGAL ADVICE.** This is a working template to lower legal risk and to take to a qualified attorney before any raffle goes live to users. Sweepstakes/lottery law varies by US state (and country) and turns on the combination of **prize + chance + consideration**. The live raffle shop item was deactivated on 2026-06-04 (`shop_items.active=false`, `held_reason='awaiting_official_rules'`) and should stay off until these rules are finalized and reviewed. Bracketed `[...]` fields are placeholders for Trevor/counsel.

## Why this matters (plain English)

A prize awarded by chance becomes a regulated **lottery** when entrants must give "consideration" (typically money or significant effort) to enter. The standard way consumer sweepstakes stay legal is to **remove consideration** — by guaranteeing a genuine, equal **free method of entry ("AMOE" — Alternate Method of Entry)** and by publishing official rules. Because RPC raffle entries are bought with **Credits that are earned for free** (no purchase is ever required to obtain Credits), RPC is well-positioned — but this must be explicit, and a no-purchase path must be real and equal.

## 1. Sponsor

[Rip Packs City LLC, Oregon], "Sponsor." Contact: [support handle / email].

## 2. Eligibility

Open to individuals who are [18+] (or the age of majority in their jurisdiction) at time of entry, except where prohibited. Void where prohibited or restricted by law. [List any excluded states/countries after counsel review — sweepstakes are commonly void in jurisdictions with onerous registration/bonding such as NY/FL above prize-value thresholds.] Employees of the Sponsor and immediate family are ineligible.

## 3. Entry Period

The raffle runs from [start date/time] to [end date/time] ("Entry Period"). The drawing occurs on or about [draw date].

## 4. How to Enter

**(a) Standard entry.** Redeem Rewards Credits in the RPC Rewards shop to receive raffle entries. Credits are earned **for free** through ordinary use of the platform (e.g., verifying a wallet, daily check-ins, completing profile actions, referrals, engagement quests). **No purchase is necessary to obtain Credits or to enter.**

**(b) Free Alternate Method of Entry (AMOE).** Without earning or spending any Credits, you may obtain **one (1) free entry** by [sending an email / submitting a form] to [AMOE address] with your [name, account email, and the statement "Free Raffle Entry – {raffle name}"]. Limit [one] AMOE entry per person per [day/raffle]. AMOE entries have an **equal chance of winning** as standard entries. [Counsel: confirm AMOE mechanics, frequency, and parity with paid/credit entries.]

Each entry (standard or AMOE) is one unit of chance. [Decide and state whether multiple Credit-entries by one person increase odds — if yes, the AMOE parity statement must still hold and odds language in §6 must reflect it.]

## 5. Prize

[Describe the prize, e.g., "one (1) NBA Top Shot Moment, approximate retail value (ARV) $[X]"]. One (1) winner. The prize is non-transferable; no cash equivalent except at Sponsor's discretion. Winner is responsible for all applicable taxes; prizes with ARV ≥ $600 may require a [W-9 and issuance of a 1099]. [Counsel: tax + ARV disclosure.]

## 6. Odds

Odds of winning depend on the total number of eligible entries received. [If credit-weighted entries are used, state how weighting affects odds; the draw mechanism `draw_raffle()` selects a winner with probability proportional to entries held.]

## 7. Winner Selection & Notification

A winner will be selected in a **random drawing** from all eligible entries via Sponsor's audited `draw_raffle` function (recorded in `raffle_draws` for transparency). Winner notified via [account email / platform message] within [X days]. If a winner does not respond within [X days] or is ineligible, an alternate may be drawn.

## 8. General Conditions

Sponsor may disqualify any entrant who tampers with the entry process, uses bots/multiple accounts, or violates these rules. [Sybil/multi-account abuse is also mitigated technically — high-value redemptions require a verified wallet.] Sponsor reserves the right to cancel/modify/suspend the raffle if fraud or technical failure compromises integrity, subject to applicable law. By entering, entrants agree to these rules and [Sponsor's privacy policy].

## 9. Privacy

Information collected is used only to administer the raffle per [RPC Privacy Policy URL]. [Do not place personal data in URLs; collect AMOE data via a secure form/email.]

## 10. Winners List

For a winners list, [contact / visit URL] after [date].

---

### Implementation checklist before reactivating the raffle

- [ ] Counsel reviews these rules + your specific prize and entry mechanics.
- [ ] AMOE (free entry) path is actually built and equal — not just stated.
- [ ] Decide eligibility/excluded jurisdictions; add age gate.
- [ ] Publish the finalized rules at a stable URL linked from the raffle item.
- [ ] Confirm tax handling for prizes ≥ $600 ARV.
- [ ] Only then: `UPDATE shop_items SET active=true WHERE type='raffle';` (or toggle in /admin/rewards).
- [ ] Keep the `draw_raffle` result (`raffle_draws`) as the auditable record of each drawing.

*Again: this is a starting template, not legal advice. Have a lawyer confirm before any raffle is exposed to users.*
