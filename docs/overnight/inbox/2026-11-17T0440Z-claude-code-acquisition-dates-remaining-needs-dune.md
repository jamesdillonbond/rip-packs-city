# Claude Code → night pass: remaining acquisition dates need chain history (Dune) — DO NOT START BEFORE 2026-12-14

**Filed 2026-11-16 ~8:40 PM PT by Claude Code cloud** (Trevor: "Keep going and working through those still open").
Dune is at **4,000 / 4,000 credits** for the period ending 2026-12-14 (`getUsage`, 11-16). No spend pre-revenue, so
nothing below is runnable until the reset. Everything our own tables could prove is already written — see ledger
2026-11-16 ~8:26 PM PT (`db5f1faff`) and ~9:15 PM / transfer-dates entries.

## What is still unproven (re-measure first — dated samples, 11-16 ~8:30 PM PT)

| set | count | why our tables can't date it |
|---|---|---|
| All Day pack pulls, undated | ~11.2k | proven via `pack_open_pulls` (no time column); not in `allday_pack_pull` |
| Top Shot pack pulls, undated | 110 | no `topshot_arrival_provenance` kind-P row |
| Pinnacle held, no acquisition row | 7,595 (5,614 one wallet) | pins predate `pinnacle_mint_events` floor (2025-10-22) |
| All Day held, no row | ~9.4k | no sale / pull / arrival record |
| UFC held, no row | 609 | same |
| Golazos held, no row | 157 | opened by ~30 OTHER wallets 2022–23 — not the holder's pulls; arrival into the holder unknown |
| Top Shot kind S (same-wallet re-deposit) | 684 | the arrival is not an acquisition; needs the PREVIOUS arrival |

## The method that already worked (Top Shot)

Dune `flow.cadence_events`: per held (wallet, nft), the LATEST `<Contract>.Deposit` into that wallet + what settled
in the same tx (see `app/api/cron/topshot-arrival-provenance-dune` header and `docs/reference/apis-and-cadence.md`
§ Dune — exact topics, `block_date`-bounded, key the second scan by `transaction_hash IN (...)`). Load into a
provenance table, then write DATE-ONLY rows (method `unknown`, price NULL) for anything without a settlement —
the shape of `apply_topshot_arrival_dates()` (migration `20261117170000`). Contracts: All Day `0xe4cf4bdc1751c65d`,
Pinnacle `0xedf9df96c92f4595`, Golazos `0x87ca73a41bb50ad5`, UFC `0x329feb3ab062d289` (`UFC_NFT`) — all four checked against `lib/collections.ts` 11-16. Cost first: run one wallet,
read `executionCostCredits` (a 102,800-row inequality join once cost 1,646 credits).

New pack pulls are dated at insert by `trg_moment_acq_pack_pull_date` wherever an open time exists, so this set
should not grow except via `pack_open_pulls`-only All Day pulls.
