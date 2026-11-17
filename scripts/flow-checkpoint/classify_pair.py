#!/usr/bin/env python3
"""Pilot: classify the Top Shot moments that entered a wallet between two spork roots
by who held each one at the EARLIER root.
  from_issuer  - held by 0xe1f2a091f7bb5245 (TopshotAdminReceiver = unopened pack inventory)
  other        - existed (id <= max id the issuer or wallet held at root k) but held by neither
  unseen_new   - id above every id seen at root k (minted after it)
Usage: classify_pair.py <wallet_k.json> <issuer_k.json> <wallet_k1.json> <out.json>
(inputs are decode_wallet.py / decode_old_wallet.py outputs)"""
import json, sys

TS = "A.0b2a3299cc857e29.TopShot.NFT"

def ids(path):
    d = json.load(open(path))["nfts"]
    return set(d.get(TS, []))

wk, ik, wk1 = ids(sys.argv[1]), ids(sys.argv[2]), ids(sys.argv[3])
new = wk1 - wk
maxid = max(ik | wk) if (ik | wk) else 0
out = {"from_issuer": sorted(i for i in new if i in ik),
       "other": sorted(i for i in new if i not in ik and i <= maxid),
       "unseen_new": sorted(i for i in new if i not in ik and i > maxid)}
json.dump(out, open(sys.argv[4], "w"))
print({"wallet_k": len(wk), "issuer_k": len(ik), "wallet_k1": len(wk1), "new": len(new),
       "max_id_k": maxid, **{k: len(v) for k, v in out.items()}})
