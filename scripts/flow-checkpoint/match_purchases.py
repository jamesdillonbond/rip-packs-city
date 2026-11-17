#!/usr/bin/env python3
"""Pre-floor Flowty purchases by Trevor: a moment that ENTERED his wallet between snapshots A and B,
matched to a PURCHASED Flowty NFTStorefrontV2 listing of the same (nftType, nftID) owned by someone else,
seen in snapshot B or later. Out: CSV."""
import json, glob, csv, collections

SNAPS = [(17, "2022-04-06"), (18, "2022-06-15"), (19, "2022-08-24"), (20, "2022-11-02"), (21, "2023-01-18"),
         (22, "2023-02-22"), (23, "2023-06-21"), (24, "2023-11-08")]
LISTING_SNAPS = {20, 21, 22, 23, 24}
W = {"bd94cade097e50ac": "Dapper 0xbd94cade097e50ac", "d96dc67ae64ee202": "Flow 0xd96dc67ae64ee202"}
import sys
OUT = sys.argv[1] if len(sys.argv) > 1 else "flowty_purchases_pre2023_snapshots.csv"

def held(s, o):
    try: n = json.load(open(f"w{s}_{o}.json"))["nfts"]
    except FileNotFoundError: return None
    return {(t, i) for t, ids in n.items() for i in ids}

listings = collections.defaultdict(list)      # (nftType, nftID) -> [(snap, rec)]
for s in sorted(LISTING_SNAPS):
    for f in glob.glob(f"L{s}/*.jsonl"):
        for line in open(f):
            r = json.loads(line)
            if r["purchased"] and r["nftType"] and r["nftID"] is not None:
                listings[(r["nftType"], r["nftID"])].append((s, r))

rows = []; stats = collections.Counter()
for o, label in W.items():
    prev = None
    for s, d in SNAPS:
        h = held(s, o)
        if h is None: continue
        if prev is not None:
            ps, pd, ph = prev
            for k in sorted(h - ph):
                stats[(label, d, "arrived")] += 1
                cands = [(ls, r) for ls, r in listings.get(k, []) if ls >= s and r["owner"] not in W]
                if not cands: continue
                ls, r = min(cands, key=lambda x: x[0])
                stats[(label, d, "matched")] += 1
                rows.append([label, pd, d, k[0].split(".")[-2], k[1], r["salePrice"],
                             (r["vault"] or "").split(".")[-2], r["commission"], "0x" + r["owner"], f"mainnet-{ls}", len(cands)])
        prev = (s, d, h)

H = ["wallet", "arrived_after", "arrived_by", "collection", "nft_id", "price", "token", "flowty_commission", "seller", "listing_seen_in", "matching_listings"]
with open(OUT, "w") as f:
    f.write("# Pre-2023-11-08 Flowty purchases INFERRED from Flow's public spork-root ledger snapshots (no Dune): a moment that entered Trevor's wallet between two snapshots,\n"
            "# matched to a Flowty NFTStorefrontV2 listing for the same NFT that was flagged PURCHASED in a seller's storefront. Buyer field is not recorded on-chain in this era, so this is a match, not a receipt.\n")
    w = csv.writer(f); w.writerow(H); w.writerows(rows)
print("matched purchases", len(rows))
for k, v in sorted(stats.items()): print(k, v)
print("listings indexed (purchased)", sum(len(v) for v in listings.values()))
