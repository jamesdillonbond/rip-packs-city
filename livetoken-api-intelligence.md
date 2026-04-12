# LiveToken API Intelligence

Reverse-engineered April 9–12, 2026. All endpoints require custom header auth (not cookies).

## Authentication

LiveToken uses custom request headers, NOT cookies or Bearer tokens.

Log into https://livetoken.co → DevTools → Network → find any `/api/topshot/` request → copy these headers:

| Header | Example | Notes |
|--------|---------|-------|
| `sessionid` | `o0197nr1wwz7` | Session identifier, rotates on login |
| `token` | `e7c8f37009108ff28ea930ff9778747147295df0` | Auth token |
| `userid` | `608166543299e1a70865915c` | LiveToken user ID |
| `ucid` | `6589579015296496` | Unknown context ID |
| `av` | `2.97` | App version — may increment over time |

Also include the standard cookie header (for Cloudflare `cf_clearance`).

Set these in `.env.local`:
```
LIVETOKEN_SESSION_ID=o0197nr1wwz7
LIVETOKEN_TOKEN=e7c8f37009108ff28ea930ff9778747147295df0
LIVETOKEN_USER_ID=608166543299e1a70865915c
LIVETOKEN_UCID=6589579015296496
LIVETOKEN_COOKIE=<full cookie string including cf_clearance>
```

## Portfolio Endpoint

```
GET https://livetoken.co/api/topshot/portfolio/{walletAddress}?page={N}&sortOrder=AcquiredDate_DESC&sc=true&useCS2bForSorting=true
```

- `walletAddress` does **NOT** include `0x` prefix (e.g., `bd94cade097e50ac`)
- **Paginated** — increment `page` param (1-indexed) until empty response
- `sortOrder` options: `AcquiredDate_DESC`, likely others
- `sc=true` and `useCS2bForSorting=true` — include these as-is

### Account Summary Endpoint

```
GET https://livetoken.co/api/topshot/account/{walletAddress}
```

Returns summary stats (total FMV, cost basis, etc.). Same auth headers.

### Response Shape (Portfolio)

Based on the UI displaying: FMV, Paid, Player, Set, Serial, Circulation, TSS.

Expected fields per moment (verify on first run via key logging):
```json
{
  "flowID": "12345678",
  "setID": 26,
  "playID": 504,
  "serial": 42,
  "circulation": 40000,
  "tier": "common",
  "setName": "Base Set",
  "playerName": "LeBron James",
  "teamAtMoment": "Los Angeles Lakers",

  "valueFMV": 3.50,
  "dealRating": 0.72,
  "liquidityRating": 3,

  "buyPrice": 2.00,
  "acquiredDate": "2024-11-09T01:00:00.000Z",

  "lowestAsk": 3.00,
  "highestOffer": 2.50,

  "topshotScore": 53,
  "locked": false,
  "retired": false,
  "forSale": false
}
```

**IMPORTANT**: Field names above are best-guesses from UI + Flowty integration code. The script logs actual keys on first run — update mappings if different.

### Key Fields

| Field | Type | Description |
|-------|------|-------------|
| `valueFMV` | number | Per-serial fair market value (USD) — LiveToken's proprietary calc |
| `buyPrice` | number\|null | What the holder paid (null for pack pulls) |
| `dealRating` | number | 0-1 score |
| `liquidityRating` | number | 0-5 |
| `lowestAsk` | number\|null | Current lowest ask on Top Shot |

### Notes

- `valueFMV` is per-serial — serial #1 will have higher FMV than serial #39999
- For edition-level FMV, take the median of `valueFMV` across all serials
- Response is paginated (not all-at-once like originally assumed)
- 14,183 moments for Trevor's wallet per the UI
- The `t` header should be set to `Date.now()` for each request

## Deals Endpoint

```
GET https://livetoken.co/api/topshot/deals
```

Returns current marketplace deals. Same auth headers.

## LiveToken in Flowty Data

Flowty's API embeds LiveToken FMV at `item.valuations.blended.usdValue` and `item.valuations.livetoken.usdValue`. This data is free but only covers actively listed moments, not full portfolios.
