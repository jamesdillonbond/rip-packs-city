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

fetch() {
  local url="$1" out="$2"
  echo "fetch $out"
  curl -fsSL "$url" -o "$DEST/$out"
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
