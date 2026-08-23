# Pinnacle bulk ONE-WAY transfers are a real, untracked ownership change

**Filed 2026-08-22 (Claude Code, interactive). Measured, not shipped — this is a
new lane, not a defect in the trade lane.**

## What was measured

While diagnosing the first non-zero `unclassified` count on
`pinnacle-trades-indexer` (9 txs in one 50,000-block backfill tick), I re-scanned
the first 10,000 blocks of that range (161,983,001–161,993,000) directly against
Flow REST via `net.http_get`. Every one of the 80 reads returned HTTP 200, so the
counts below are real rather than partial:

| shape | txs | withdraws | senders | receivers |
|---|---|---|---|---|
| trade (2 wallets, both sides) | 227 | 522 | 2 | 2 |
| mint (deposit, no withdraw) | 132 | 0 | — | 1 |
| sale / single one-way | 29 | 29 | 1 | 1 |
| **bulk ONE-WAY transfer** | **3** | **9** | **1** | **1** |

**The `unclassified` bucket is entirely bulk one-way transfers** — three Pins
each, one wallet sending, one receiving, nothing coming back.

## The good news, stated first

✅ **No trades are being dropped.** The classifier's most debatable decision —
refusing to call a multi-Pin two-wallet ONE-WAY move a trade — is now validated
against real chain data, and the tx-shape census surfaced these rather than
silently absorbing them into a trade count. That is exactly what the census was
built for, on its first non-zero reading.

## The gap this names

A bulk one-way transfer is a **genuine change of ownership** that leaves:

- no `pinnacle_sales` row (no storefront event),
- no `pinnacle_mint_events` row (no `PinNFTMinted`),
- no `pinnacle_trade_events` row (correctly — it is not a trade),
- and therefore **no `moment_acquisitions` row at all.**

So it is the same shape of hole Pinnacle *trading* was in before 2026-08-22, one
size smaller: a Pin arrives in a wallet and the platform cannot say how.

## Size, and the honest bound on it

**3 txs / 9 Pins per 10,000 blocks in ONE sample.** Against 227 trades and 29
sales in the same window that is ~1% of transactions — real but small.

⚠ **DO NOT SIZE THIS FROM THE ONE SAMPLE.** The Pinnacle trade rate has already
proven to vary ~20× by epoch (see the six-window survey in
`docs/reference/database.md`), and this session revised its own write-rate
projection three times (87k → 203k → 570k rows) off short windows. Re-measure
across several separated ranges before acting.

## If it is built

The lane already computes the shape — `classifyPinnacleTradeTxs` returns
`unclassified` with sender/receiver counts — so the work is a `transfer` arm, not
a new scanner:

- write a `pinnacle_transfer_events` row for the `senders=1, receivers=1, nw>1`
  case (and the `nw=1` case, which today is indistinguishable from a sale on
  these two streams alone and would need the storefront stream to separate);
- `acquisition_method` would need a **new** value — `'transfer'`, NOT `'gift'`.
  ⚠ **`gift` asserts intent we cannot observe.** A one-way move is equally a
  gift, a wallet consolidation between two wallets the same person owns, or an
  off-platform sale settled elsewhere. Naming it `gift` would publish a motive
  from a geometry.
- like `trade`, it must carry **NO `buy_price`**.

⚠ **The self-transfer case needs care**: `from_wallet <> to_wallet` on chain does
not mean two different people. A "transfer in" badge on a Pin someone moved
between their own wallets would be noise at best.

## Do not confuse this with the trade lane

The trade lane is shipped and verified; nothing here is a bug in it. This file
exists so that "the unclassified bucket is non-zero" has a written answer, and so
the next person does not re-run the same 80-request diagnosis.
