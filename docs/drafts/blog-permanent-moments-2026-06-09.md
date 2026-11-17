# Your Moments Just Became Permanent. Here's What That Actually Means.

*June 9, 2026 · NBA Top Shot · 6 min read*

On June 8, Dapper Labs announced that every NBA Top Shot Moment — the video highlight, the artwork, the metadata — is now preserved on IPFS, the InterPlanetary File System. Retroactively, across every Series, and at the point of mint for everything going forward.

If you've been around digital collectibles long enough, you know why this matters. If you stepped away from Top Shot because you weren't sure what "owning" a highlight actually meant, this is the announcement that answers the question.

## The problem this solves

Your ownership record on Flow was always permanent. The blockchain entry saying you own serial #217 of a LeBron dunk was never going anywhere. But the dunk itself — the actual video file — lived on Dapper's servers, at Dapper's URLs, behind Dapper's CDN. The thing your Moment *is* depended on one company staying online and keeping that URL alive.

That's not a hypothetical risk. Multiple platforms in this space sold people digital assets and then shut down. The ownership records survived; the assets became wallpaper pointing at dead links. Collectors learned the hard way that a token referencing a file is not the same as a file you can prove and retrieve yourself.

## What content-addressing actually guarantees

IPFS stores files by what they *are*, not where they live. Every file gets a content identifier — a CID — that is a cryptographic fingerprint of the file's bytes. Same file, same CID, forever. Change one pixel and the CID changes.

That gives you three guarantees no CDN URL ever could:

**Tamper-evidence.** If anyone altered the video, the fingerprint wouldn't match. The content is its own proof of authenticity.

**No single point of failure.** Any node on the network can host the file. As long as one node pins it, it's retrievable — through Dapper's gateway, through public gateways like ipfs.io or dweb.link, or through your own node.

**Permissionless verification.** No account. No API key. No asking anyone. You can look up any Moment's media and confirm it's genuine with nothing but an internet connection.

Assets are pinned at the Set level — whether you hold serial #1 or serial #15,000, the video and artwork are identical, so one pinned copy covers every Moment in the edition.

## Verify a Moment yourself in 30 seconds

Dapper published a public reference app that maps every Top Shot play to its IPFS content: dapperlabs.github.io/dapperlabs-ipfs-reference-app. Search a player, find the play, and you get the CIDs for the video and artwork. Paste any CID after ipfs.io/ipfs/ (or any other gateway) and the file comes back from the decentralized network.

That's the whole point. Not "trust us" — verify it yourself.

The next step, per Dapper, is embedding those CIDs directly into the on-chain Edition Metadata on Flow. When that lands, the link between your Moment and its media will be fully independent — readable straight off the chain, no intermediary at all.

## What we did with it

Rip Packs City is an intelligence platform, so we did what we always do with a new public dataset: we indexed it.

Within a day of the announcement, the full IPFS catalog — 12,546 play-set-parallel combinations, each with video and artwork CIDs — is loaded into our database and joined against our edition catalog. Three things came out of it immediately:

**Verified-media on edition pages.** Top Shot edition pages on RPC now show the IPFS CIDs for the Moment's video and artwork, with direct gateway links, on roughly 80 percent of editions (the newest drops will appear as Dapper's catalog refreshes).

**Art recovery.** A couple dozen editions in our catalog had no usable artwork from the standard CDN paths — mostly parallels like Diced and Coded. The IPFS catalog filled them.

**A foundation for resilience.** Because the catalog is content-addressed, we're no longer dependent on any single image host for Top Shot media. If a CDN URL dies, the CID doesn't.

## Why this is bigger than Top Shot

Dapper says the same architecture is being built to extend across all of its products — which would put NFL All Day and Disney Pinnacle media on the same footing. And it sets a bar for the broader sports-collectibles space: if your platform can't show you a content hash, you're trusting a server.

For collectors who held through the quiet years: this is the infrastructure investment you were promised. For everyone who left: your collection is more provably yours today than it was the day you bought it.

Go verify a Moment. It's a good feeling.

---

*Rip Packs City is a Flow blockchain digital collectibles intelligence platform. We index the data so you don't have to trust anyone — including us.*
