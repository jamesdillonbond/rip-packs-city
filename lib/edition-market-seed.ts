import {
  buildEditionScopeKey,
  normalizeParallel,
  normalizeSetName,
} from "@/lib/wallet-normalize"

export type SeedCandidateInput = {
  editionKey?: string | null
  setName?: string | null
  playerName?: string | null
  parallel?: string | null
  subedition?: string | null
}

export function buildEditionSeedCandidate(input: SeedCandidateInput) {
  const normalizedSet = normalizeSetName(input.setName ?? "")
  const normalizedParallelValue = normalizeParallel(input.parallel ?? input.subedition ?? "")
  const scopeKey = buildEditionScopeKey({
    editionKey: input.editionKey ?? null,
    setName: normalizedSet,
    playerName: input.playerName ?? null,
    parallel: normalizedParallelValue,
    subedition: normalizedParallelValue,
  })

  return {
    editionKey: input.editionKey ?? null,
    setName: normalizedSet || null,
    playerName: input.playerName ?? null,
    parallel: normalizedParallelValue,
    lowAsk: null,
    bestOffer: null,
    lastSale: null,
    source: "manual-seed",
    notes: [],
    aliases: [scopeKey],
    tags: [],
  }
}