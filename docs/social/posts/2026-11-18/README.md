# 2026-11-18 (Wed) — draft: look up your collection, no account needed

Wednesday's rookie slot is skipped this week (`SKIP_DATES`), so this is offered for the open day. **Draft only. Trevor posts.**

Why this post: the 11-10..11-17 activity review found X visits fell from 85 to 8 once Dame Time ended. The edition-page prompt now leads with a look-up that needs no account (shipped 11-17, `d001a83`). The link carries `utm_source=x` so its visits are counted by `scripts/demand-read.sql` (source `x`) and readable per campaign.

## Main post (attach `lookup-no-account.png`, no link) — 216 / 280

```
What's your Top Shot collection worth right now?

Open any Moment on Rip Packs City, type your username, and your whole binder loads with its value. No account needed.

All Day, Pinnacle and Panini work the same way.
```

## 2/2 reply (link preview card)

```
Try it here 👇 https://www.rippackscity.com/nba-top-shot/collection?utm_source=x&utm_medium=social&utm_campaign=lookup_1118
```

## Checked live (11-17, ~10:10 PM PT, signed out)

- Top Shot edition page prompt → `/nba-top-shot/collection?wallet=<username>` loaded a valued binder.
- All Day and Pinnacle `?wallet=<username>` loaded valued binders.
- Panini reads `?username=` (fixed in the prompt the same night). A username RPC has read loads a valued binder. One it has not read shows only what RPC has seen under that name.

## House rules

No collector is named, no FMV confidence is shown, the post says dollars only and makes no buy advice. The image is the live Graham Ike Rookie Debut edition page with a placeholder username typed in.
