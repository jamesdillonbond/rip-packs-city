# For Trevor (later): switch the "Entity page sweep" firewall rule from Log to Challenge — and one display-name call

- **Source:** Cowork cloud, 2026-11-08 ~8:45–9:10 AM PT. Trevor: "Save this to our documentation for me to do later."
- **Owner:** Trevor (Vercel dashboard — a firewall action change is a standing-rule change; sessions read it but do not change it).

## 1. ✅ DONE 2026-11-08 ~10:05 PM PT — Trevor set "Entity page sweep" to CHALLENGE (read back in his Chrome; traffic read in #235). Original filing below.

### Firewall: "Entity page sweep" was LOG-only (known-issues #235)

- **What is live (read 11-08 in the Vercel dashboard; the MCP `get_firewall_config` 404s for this project):** Vercel → rip-packs-city → Firewall → Rules → **Entity page sweep** (`rule_entity_page_sweep_eNQlGa`, created ~11-07). IF path matches `^/[a-z0-9-]+/(edition|set|series|player|team)/` AND rate limit, fixed window **300 requests / 60 s**, key **JA4 digest** → **Log**. Past day: 212 requests logged. "Block sensitive paths" (Deny) is the other rule; Bot Protection is Off.
- **Why it matters:** Log records the sweep but does not stop it, so the ~30 s degraded windows #235 measured still reach real users.
- **Do (Trevor):**
  1. Optional first: after the next late-afternoon spike (sweeps have landed ~5 PM PT), open Firewall → Traffic, filter to this rule, and check the logged requests line up with the spike — that confirms 300/min catches the sweep and not a real collector.
  2. Firewall → Rules → **Entity page sweep** → change **Then: Log** to **Challenge** (gentler: a real browser passes the challenge) or **Deny** → **Save Rule**, then publish.
- **Verify:** the Overview's "Challenged" (or "Denied") count rises on the next sweep, and `vercel.function_invocation.count` no longer spikes to 500–1,400/min.
- **Revert:** set the action back to Log.

## 2. Display name for `alaskanninja` (left out of the 11-08 backfill)

- ⏳ **Still open (11-08 10:20 PM PT).** Also now open, same decision class: `mavhill` and `awesemo` show all-lowercase display names while their handles are `MavHill` / `Awesemo`; the new signup trigger would upgrade them the next time their handle row is written. Say "upgrade them" and any session runs the one write.

- The 11-08 `display_name` backfill (ledger 11-08) filled 40 profiles with their own handle's proper casing. One user was skipped on purpose: profile slug **alaskanninja**, Dapper handle **selanne8kariya9** — a different name, not a casing variant, so nothing was guessed.
- **Choose one:** show `selanne8kariya9`, show `alaskanninja`, or leave it empty (the site then shows the slug). Any session can run the one-line UPDATE once you say which.
