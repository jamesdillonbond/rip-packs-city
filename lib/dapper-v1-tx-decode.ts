// Back-compat shim — canonical impl at lib/chains/flow/dapper-v1-tx-decode.ts (chain-abstraction Phase D).
// TODO(chain-rename): in-repo callers all repointed to @/lib/chains/flow/dapper-v1-tx-decode (2026-07-19) — delete this shim
// after chain two ships.
export * from "@/lib/chains/flow/dapper-v1-tx-decode";
