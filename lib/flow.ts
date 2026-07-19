// Back-compat shim — canonical impl at lib/chains/flow/flow.ts (chain-abstraction Phase D).
// TODO(chain-rename): in-repo callers all repointed to @/lib/chains/flow/flow (2026-07-19) — delete this shim
// after chain two ships.
// NOTE: flow.ts is the only Tier-1 file with a default export; `export *` does NOT carry
// the default, so the second line below is required for callers that default-import this module.
export * from "@/lib/chains/flow/flow";
export { default } from "@/lib/chains/flow/flow";
