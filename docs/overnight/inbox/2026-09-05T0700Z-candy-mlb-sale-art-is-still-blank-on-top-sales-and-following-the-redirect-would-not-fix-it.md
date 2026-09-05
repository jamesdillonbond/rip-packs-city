# Candy MLB sale art is STILL blank on `/insights/top-sales`, the fix that shipped today moved the failure instead of removing it, and the obvious next fix would not work either

**Filed 2026-09-05 07:00Z (2026-09-04 23:55 PT) · Claude Code on Trevor's box, interactive · VERIFIED IN PRODUCTION by rendered DOM · nothing shipped — the correct fix touches the CSP, and the obvious one is measurably wrong**

## The symptom, seen rather than inferred

Playwright against live `https://www.rippackscity.com/insights/top-sales`:

```
avatar-media requests: 1
   502  https://arweave.net/iKT2pAHeP1QA1jZn_HHigZzs0dPOHrq_5_2KD9xUZjU
img elements pointed at the proxy: 2
   naturalWidth=0 h=0   /api/public/avatar-media?src=…arweave.net%2FiKT2pAH…
   naturalWidth=0 h=0   /api/public/avatar-media?src=…arweave.net%2F-00lKHo…
```

**Both `<img>` elements report `naturalWidth = 0` — they did not paint.** That is precisely the symptom the change shipped earlier today set out to fix.

## Two locally-reasonable changes that are incompatible together

`TopSalesBoardClient.tsx` carries this, dated **2026-09-04**:

> *"chain-two (Candy MLB) sale art lives on arweave.net, which the CSP `img-src` deliberately does NOT carry — those hosts render through the same-origin avatar proxy. **Two cards per anon load were blocked by CSP and rendered blank**; route the URL through the proxy instead."*

`app/api/public/avatar-media/route.ts` carries this, dated **2026-08-16**:

> *"⚠ **REDIRECTS ARE REFUSED, NOT FOLLOWED.** An allowlisted host that 302s is the exact hole an allowlist would otherwise leave open — the check passes on the first URL and the fetch lands wherever the redirect says, including a private address."*

**`arweave.net` ALWAYS 302s.** Measured: `https://arweave.net/<txid>` → `302` → `https://<base32>.arweave.net/<txid>`. So every Arweave URL sent through this proxy is refused by its own SSRF guard. **The blank cards were not fixed; the failure moved from a CSP refusal to a 502.** Neither author was wrong locally — the proxy's redirect rule is correct, and routing a non-CSP host through a same-origin proxy is the established pattern here. They simply do not compose for this host.

## 🚨 And the obvious fix — follow the redirect — is MEASURABLY WRONG

The natural next move is "follow one hop, re-validate the target host". **It would not fix this**, and that is the part worth filing:

| | measured |
|---|---|
| `arweave.net/iKT2pAH…` followed to completion | **200, `image/png`, 6,872,443 bytes** |
| `MAX_AVATAR_BYTES` in the route | **4,194,304 bytes** |

**The asset is 6.87 MB against a 4 MB cap**, so it 502s on size even with the redirect followed. ⓘ The second image's id was truncated in my probe output and re-fetching the truncated form 404s, so **this is proven for one of the two, not both** — do not restate it as "both are oversize".

⭐ **The real mismatch is that full-size NFT sale ART is being routed through a proxy built for 80-pixel AVATARS** — its size cap, its content-type allowlist and its redirect refusal are all correctly sized for that job and none of them fits this one.

## The fix that probably is right, and why it was not shipped tonight

Put `arweave.net` (and its content subdomains) in the **CSP `img-src`** and hotlink, exactly as `ipfs.io` and `assets.nbatopshot.com` already are. That removes the server hop, the size cap and the redirect problem in one move, and the browser follows the 302 itself.

⚠ **It is a security-header change and it has a guard that will push back, correctly.** `__tests__/avatar-proxy-hosts.test.ts` asserts the CSP `img-src` list and `PROXYABLE_AVATAR_HOSTS` stay **DISJOINT** — so this is not "add a host", it is **move** one: add to the CSP, remove from the proxy allowlist, and change the board to stop calling `avatarDisplayUrl` for it. Three files, one invariant, and `proxy.ts` is a file CLAUDE.md names as off-limits to the autonomous pass.

⛔ **Do not "fix" this by raising `MAX_AVATAR_BYTES`.** The cap's comment records why it is 4 MB (edge-cache ceiling, measured against ipfs-media at 4.03 MB caching and 16.75 MB not). Raising it to admit a 6.87 MB PNG trades a blank card for an uncacheable one on every anon load of a public board.

## Falsifiers / re-derive

```bash
# 1. the symptom
node -e "…playwright…"   # or: curl -o /dev/null -w '%{http_code}' \
  'https://www.rippackscity.com/api/public/avatar-media?src=https%3A%2F%2Farweave.net%2FiKT2pAHeP1QA1jZn_HHigZzs0dPOHrq_5_2KD9xUZjU'   # -> 502

# 2. the redirect (the reason the proxy refuses it)
curl -sD - -o /dev/null https://arweave.net/iKT2pAHeP1QA1jZn_HHigZzs0dPOHrq_5_2KD9xUZjU | grep -i '^location'

# 3. the size (the reason following it would not help)
curl -sL -o /dev/null -w '%{size_download}\n' https://arweave.net/iKT2pAHeP1QA1jZn_HHigZzs0dPOHrq_5_2KD9xUZjU
```

⚠ **Scope check before anyone sizes this as a user-facing outage:** it is **2 cards on one public board**, and **zero user avatars are affected** — `profile_bio` + `user_profiles` hold 46 empty and exactly 1 avatar, on `seadn.io`. The avatar proxy is doing its actual job fine; this is chain-two sale art borrowing it.

---

## ADDENDUM 2026-09-05 07:30Z — a second `proxy.ts` media-host item, found while fixing the IPFS gateway, and it is the same kind of decision

⛔ **Not the same defect, and it is not urgent — but it belongs in the same edit**, because it is one line in the same CSP directive and Trevor is the only one who can make it.

**`https://cloudflare-ipfs.com` is in both `img-src` and `media-src`, and the host no longer exists.** Measured 2026-09-05 against 8 CIDs taken live off `/nba-top-shot/market`:

```
ipfs.dapperlabs.com   8/8   0.2–1.9 s
gateway.pinata.cloud  8/8   3.5–7.0 s
ipfs.filebase.io      7/8   0.0–0.9 s
ipfs.io               2/8   (six 12 s timeouts)
cloudflare-ipfs.com   0/8   DNS failure in <0.1 s — decommissioned
```

⚠ **This causes no user-facing failure today**, because nothing in the tree emits a `cloudflare-ipfs.com` URL — `app/api/public/ipfs-media/[cid]/route.ts` only ever redirects to a gateway it just heard from, and both of those (`ipfs.dapperlabs.com`, `ipfs.io`) are separately allowed. So the entry is inert, not broken.

⭐ **The cost is that it is MISLEADING, and a CSP is read as a claim.** A future session sizing "which gateways may we redirect to?" reads five hosts in `img-src` and reasonably concludes it has five options; two of them (`cloudflare-ipfs.com`, and `ipfs.io` at 2/8) cannot serve. That is how the single-gateway assumption survived for months in the first place — the route's own header attributed a **~76% failure rate** to "a slow gateway" and never asked whether another one would answer.

**Suggested edit (Trevor's call, `proxy.ts` is off-limits for autonomous shipping):** delete `https://cloudflare-ipfs.com` from `img-src` and `media-src`. Nothing references it, so this is a pure narrowing.

ⓘ **Deliberately NOT suggested: adding Pinata or Filebase.** Both outperform `ipfs.io` and both are absent from the CSP, which is exactly why they were left out of the gateway list that shipped — the oversize path 302s the browser at whichever gateway answered, so adding one to the fetch list without adding it to the CSP would fix the proxy leg and break the redirect leg in the same change. `ipfs.dapperlabs.com` was chosen *because* it was already allowed. If the CSP is being edited anyway, adding Filebase is a reasonable second fallback — but it is a widening, and it should be a separate decision from the deletion above.
