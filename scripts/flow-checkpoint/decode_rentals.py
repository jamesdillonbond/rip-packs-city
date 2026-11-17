#!/usr/bin/env python3
"""Decode FlowtyRentals.Rental resources (Flowty account payloads) from one snapshot dir.
Out JSON list: rental_id, renter, owner, returned, settled, start, term, amount, deposit, nftID, nftType"""
import json, glob, sys
from decode_fundings import cbor_uint, cap_addr
from decode_wallet import field_uint, qid_after

def ref_after(seg, name):
    k = seg.find(name + b"\xd8\xffP")
    return seg[k+len(name)+3+8: k+len(name)+3+16] if k >= 0 else None

def main(d, outp):
    slabs, rentals = {}, []
    for f in glob.glob(f"{d}/*.jsonl"):
        for line in open(f):
            r = json.loads(line)
            if r["owner"] != "5c57f79c6694797f": continue
            v = bytes.fromhex(r["value"]); k = bytes.fromhex(r["key"])
            if k[:1] == b"$": slabs[k[1:9]] = v
            pos = 0
            while True:
                t = v.find(b"FlowtyRentals.Rental\x02", pos)
                if t < 0: break
                nxt = v.find(b"FlowtyRentals.Rental\x02", t + 1); seg = v[t: nxt if nxt > 0 else len(v)]; pos = t + 1
                u = seg.find(b"duuid\xd8\xa4")
                if u < 0: continue
                rid, _ = cbor_uint(seg, u + 7)
                renter, _ = cap_addr(seg, b"renterFungibleTokenReceiver")
                renter_nft, _ = cap_addr(seg, b"renterNFTCollection")
                owner, _ = cap_addr(seg, b"ownerFungibleTokenReceiver")
                rentals.append({"rental_id": rid, "renter": renter or renter_nft, "owner": owner,
                                "dref": ref_after(seg, b"gdetails"), "lref": ref_after(seg, b"nlistingDetails"), "inline": seg})
    out = []; seen = set()
    for x in rentals:
        if x["rental_id"] in seen: continue
        seen.add(x["rental_id"])
        dv = slabs.get(x["dref"]) if x["dref"] else x["inline"]
        lv = slabs.get(x["lref"]) if x["lref"] else x["inline"]
        rec = {"rental_id": x["rental_id"], "renter": x["renter"], "owner": x["owner"]}
        if dv:
            i = dv.find(b"hreturned"); j = dv.find(b"gsettled")
            rec["returned"] = (dv[i+9] == 0xf5) if i >= 0 else None
            rec["settled"] = (dv[j+8] == 0xf5) if j >= 0 else None
            st = field_uint(dv, b"istartTime"); tm = field_uint(dv, b"dterm")
            rec["start"] = st / 1e8 if st else None; rec["term"] = tm / 1e8 if tm else None
        if lv:
            a = field_uint(lv, b"famount"); dp = field_uint(lv, b"gdeposit")
            rec["amount"] = a / 1e8 if a is not None else None; rec["deposit"] = dp / 1e8 if dp is not None else None
            rec["nftID"] = field_uint(lv, b"enftID"); rec["nftType"] = qid_after(lv, b"gnftType")
            rec["vault"] = qid_after(lv, b"ppaymentVaultType")
        out.append(rec)
    json.dump(out, open(outp, "w"))
    print(d, "rentals", len(out), "with details", sum(1 for r in out if r.get("returned") is not None),
          "with listing", sum(1 for r in out if r.get("nftID") is not None))

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
