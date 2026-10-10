#!/usr/bin/env python3
"""Pre-atree sharded issuer: ids = last key segment of storage/<Sharded*>/collections/v/<shard>/ownedNFTs/v/<id>
registers with a NON-empty value (empty = tombstone). Usage: <snapdir> <owner_hex> <out.json>"""
import json, glob, sys, collections
d, owner, out = sys.argv[1:4]
ids, tomb, per = set(), 0, collections.Counter()
for f in glob.glob(f"{d}/*.jsonl"):
    for l in open(f):
        r = json.loads(l)
        if r["owner"] != owner: continue
        k = bytes.fromhex(r["key"]).split(b"\x1f")
        if len(k) == 8 and k[0] == b"storage" and k[2] == b"collections" and k[5] == b"ownedNFTs":
            if not r["value"]: tomb += 1; continue
            ids.add(int(k[7])); per[k[1].decode()] += 1
json.dump({"nfts": {"A.0b2a3299cc857e29.TopShot.NFT": sorted(ids)}}, open(out, "w"))
print(d, owner[:4], len(ids), "tombstones", tomb, dict(per))
