// contracts/ExampleNFT2.cdc  (TEST FIXTURE — never deploy to a real network)
//
// A deliberately minimal second NonFungibleToken-conforming contract, existing
// only so RPCTradeEscrow_test.cdc can exercise the deposit-time type-mismatch
// rejection (audit scenario 3 / testTypeMismatchRejected): a trade that
// committed `ExampleNFT.NFT` must refuse a deposited `ExampleNFT2.NFT` even
// when the NFT id matches the committed id list.
//
// No metadata views, no royalties, no events beyond the standard's — the only
// job of this contract is to mint NFTs whose runtime Type differs from
// ExampleNFT's.

import "NonFungibleToken"
import "ViewResolver"

access(all) contract ExampleNFT2: NonFungibleToken {

    access(all) let CollectionStoragePath: StoragePath
    access(all) let CollectionPublicPath:  PublicPath
    access(all) let MinterStoragePath:     StoragePath

    access(all) resource NFT: NonFungibleToken.NFT {
        access(all) let id: UInt64

        init() {
            self.id = self.uuid
        }

        access(all) fun createEmptyCollection(): @{NonFungibleToken.Collection} {
            return <- ExampleNFT2.createEmptyCollection(nftType: Type<@ExampleNFT2.NFT>())
        }

        access(all) view fun getViews(): [Type] {
            return []
        }

        access(all) fun resolveView(_ view: Type): AnyStruct? {
            return nil
        }
    }

    access(all) resource Collection: NonFungibleToken.Collection {
        access(all) var ownedNFTs: @{UInt64: {NonFungibleToken.NFT}}

        init() {
            self.ownedNFTs <- {}
        }

        access(all) view fun getSupportedNFTTypes(): {Type: Bool} {
            return {Type<@ExampleNFT2.NFT>(): true}
        }

        access(all) view fun isSupportedNFTType(type: Type): Bool {
            return type == Type<@ExampleNFT2.NFT>()
        }

        access(NonFungibleToken.Withdraw) fun withdraw(withdrawID: UInt64): @{NonFungibleToken.NFT} {
            let token <- self.ownedNFTs.remove(key: withdrawID)
                ?? panic("ExampleNFT2.Collection.withdraw: missing NFT id ".concat(withdrawID.toString()))
            return <- token
        }

        access(all) fun deposit(token: @{NonFungibleToken.NFT}) {
            let token <- token as! @ExampleNFT2.NFT
            let id = token.id
            let old <- self.ownedNFTs[id] <- token
            destroy old
        }

        access(all) view fun getIDs(): [UInt64] {
            return self.ownedNFTs.keys
        }

        access(all) view fun borrowNFT(_ id: UInt64): &{NonFungibleToken.NFT}? {
            return &self.ownedNFTs[id]
        }

        access(all) fun createEmptyCollection(): @{NonFungibleToken.Collection} {
            return <- create Collection()
        }
    }

    // Minter mirrors ExampleNFT's shape (resource held by the contract
    // account) so the test's mint helper looks the same for both fixtures.
    access(all) resource NFTMinter {
        access(all) fun mintNFT(recipient: &{NonFungibleToken.Receiver}) {
            recipient.deposit(token: <- create NFT())
        }
    }

    access(all) fun createEmptyCollection(nftType: Type): @{NonFungibleToken.Collection} {
        return <- create Collection()
    }

    access(all) view fun getContractViews(resourceType: Type?): [Type] {
        return []
    }

    access(all) fun resolveContractView(resourceType: Type?, viewType: Type): AnyStruct? {
        return nil
    }

    init() {
        self.CollectionStoragePath = /storage/exampleNFT2Collection
        self.CollectionPublicPath  = /public/exampleNFT2Collection
        self.MinterStoragePath     = /storage/exampleNFT2Minter

        self.account.storage.save(<- create NFTMinter(), to: self.MinterStoragePath)
    }
}
