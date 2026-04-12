# LiveToken API Intelligence

Reverse-engineered April 9, 2026. All endpoints require session cookie auth.

## Authentication

Log into https://livetoken.co in browser. Copy the full `Cookie` header from any `/api/` request in DevTools → Network tab. The session expires periodically — rotate as needed.

## Portfolio Endpoint

```
GET https://livetoken.co/api/topshot/portfolio/{walletAddress}
```

- `walletAddress` includes `0x` prefix (e.g., `0xbd94cade097e50ac`)
- Returns JSON array of moment objects

### Response Shape

```json
[
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
    "playCategory": "Dunk",
    "playType": "Dunk",

    "valueFMV": 3.50,
    "dealRating": 0.72,
    "liquidityRating": 3,

    "buyPrice": 2.00,
    "acquiredDate": "2024-11-09T01:00:00.000Z",

    "lowestAsk": 3.00,
    "highestOffer": 2.50,
    "avgSale": 3.25,
    "lastSalePrice": 3.10,

    "badges": ["tsd", "ry"],
    "locked": false,
    "retired": false,
    "forSale": false
  }
]
```

### Key Fields

| Field | Type | Description |
|-------|------|-------------|
| `flowID` | string | On-chain moment NFT ID |
| `setID` | integer | On-chain set ID |
| `playID` | integer | On-chain play ID |
| `serial` | integer | Serial number |
| `circulation` | integer | Edition mint count |
| `valueFMV` | number | Per-serial fair market value (USD) — LiveToken's proprietary calc |
| `dealRating` | number | 0-1 score (1 = best deal) |
| `liquidityRating` | number | 0-5 (5 = most liquid) |
| `buyPrice` | number\|null | What the holder paid (marketplace purchases only, null for pack pulls) |
| `acquiredDate` | string\|null | ISO timestamp of acquisition |
| `lowestAsk` | number\|null | Current lowest ask on Top Shot marketplace |
| `highestOffer` | number\|null | Current highest offer |
| `badges` | string[] | Badge slugs: "tsd" (Top Shot Debut), "ry" (Rookie Year), "champ" (Championship), etc. |

### Notes

- `valueFMV` is per-serial — serial #1 will have a higher FMV than serial #39999
- For edition-level FMV, take the median of `valueFMV` across all serials in a wallet (or across all serials if available)
- `buyPrice` is null for pack-pulled moments — LiveToken can't determine individual pack pull cost
- `acquiredDate` may also be null for very old moments
- The array can be large (14K+ items for heavy collectors)
- Response is NOT paginated — entire portfolio in one response

## Deals Endpoint

```
GET https://livetoken.co/api/topshot/deals
```

Returns current marketplace deals sorted by deal rating. Same auth. Fields include `gone` (boolean — already sold) and `goneInSec` (how fast it sold for "Fast Fingers" tracking). 127 expired challenges tracked.

## WebSocket Feed

```
wss://livetoken.co/socket.io/?...
```

Real-time feed of new listings, sales, and deal alerts. Same session cookie auth via handshake.

## Edge vs Public Data

LiveToken's "edge" is computed fields on top of public blockchain/marketplace data:
- `valueFMV` — proprietary per-serial valuation model
- `dealRating` — scoring model combining FMV, ask price, liquidity, time-on-market
- `liquidityRating` — based on sales velocity and listing depth
- `buyPrice` / `acquiredDate` — enriched from on-chain transaction history

The raw marketplace data (asks, offers, sales) is public. LiveToken's value-add is the computed intelligence layer.
