#!/usr/bin/env bash
# fetch-cadence-escrow-test-deps.sh
#
# Populates the gitignored cadence/contracts/imports/ directory with the
# standard-contract sources the RPCTradeEscrow test suite compiles against
# (see cadence/tests/README.md). Idempotent; safe to re-run.
#
# ExampleNFT is PINNED to flow-nft's lib/go/contracts/v1.2.2 tag:
#   - master's ExampleNFT imports CrossVMMetadataViews + EVM, which don't
#     exist in the `flow test` environment;
#   - flow-nft >=v1.2.x changed NFTMinter.mintNFT to RETURN the NFT, which
#     is the shape transactions/mint_example_nft.cdc is written against.
#
# Usage (from the repo root):
#   bash scripts/fetch-cadence-escrow-test-deps.sh
# Then:
#   flow test -f cadence/tests/flow.test.json cadence/tests/RPCTradeEscrow_test.cdc

set -euo pipefail

cd "$(dirname "$0")/.."
DEST="cadence/contracts/imports"
mkdir -p "$DEST"

# ⚠ RETRIES ARE NOT OPTIONAL HERE. These are seven sequential unauthenticated
# fetches from raw.githubusercontent.com, which rate-limits — and a bare
# `curl -fsSL` turned a single HTTP 429 into a RED `cadence-escrow-tests` job on
# `main`, on a commit that touched no Cadence at all (2026-08-17, run
# 32037307518: "fetch NonFungibleToken.cdc / curl: (22) ... error: 429" on the
# FIRST fetch). That is the worst shape of CI flake: it fails during dependency
# install, before any test body runs, so it says nothing about the diff while
# looking exactly like a real failure to anyone reading the badge.
#
# Backoff is 2s/4s/8s, matching the git-push retry convention in CLAUDE.md.
# `--retry-all-errors` is deliberately NOT used instead of this loop: it needs
# curl >= 7.71, and the explicit loop also lets the message name the file, which
# is what makes a genuine outage diagnosable rather than just "exit 22".
fetch() {
  local url="$1" out="$2" attempt=1 delay=2
  local max=4
  echo "fetch $out"
  while true; do
    if curl -fsSL --connect-timeout 10 --max-time 120 "$url" -o "$DEST/$out"; then
      # A truncated body would compile as garbage much later, in `flow test`,
      # where the cause is unrecognisable. Fail here instead.
      if [ -s "$DEST/$out" ]; then
        return 0
      fi
      echo "  $out came back EMPTY" >&2
    fi
    if [ "$attempt" -ge "$max" ]; then
      echo "::error::failed to fetch $out after $max attempts — $url" >&2
      return 1
    fi
    echo "  attempt $attempt/$max failed; retrying in ${delay}s" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

FLOW_NFT="https://raw.githubusercontent.com/onflow/flow-nft"
FLOW_FT="https://raw.githubusercontent.com/onflow/flow-ft"

fetch "$FLOW_NFT/master/contracts/NonFungibleToken.cdc"                 NonFungibleToken.cdc
fetch "$FLOW_NFT/master/contracts/MetadataViews.cdc"                    MetadataViews.cdc
fetch "$FLOW_NFT/master/contracts/ViewResolver.cdc"                     ViewResolver.cdc
fetch "$FLOW_NFT/lib/go/contracts/v1.2.2/contracts/ExampleNFT.cdc"      ExampleNFT.cdc
fetch "$FLOW_FT/master/contracts/FungibleToken.cdc"                     FungibleToken.cdc
fetch "$FLOW_FT/master/contracts/FungibleTokenMetadataViews.cdc"        FungibleTokenMetadataViews.cdc
fetch "$FLOW_FT/master/contracts/utility/Burner.cdc"                    Burner.cdc

echo "done — $DEST populated"
