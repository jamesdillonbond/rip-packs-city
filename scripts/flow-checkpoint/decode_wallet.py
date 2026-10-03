#!/usr/bin/env python3
"""Decode an account's NFT holdings and storefront listings from extracted checkpoint payloads.
Usage: decode_wallet.py <snapdir> <owner_hex> <out.json>"""
import json, glob, re, sys
from decode_fundings import cbor_uint

COMPOSITE = re.compile(rb"\xd8\xc0\x82H(.{8})([\x60-\x77])", re.S)

def strs_at(v, i):
    """read a CBOR text string at i -> (str, next)"""
    t = v[i]
    if 0x60 <= t <= 0x77: L, s = t - 0x60, i + 1
    elif t == 0x78: L, s = v[i+1], i + 2
    else: return None, i
    return v[s:s+L].decode("utf-8", "replace"), s + L

def field_uint(seg, name):
    k = seg.find(name)
    if k < 0: return None
    j = k + len(name)
    if seg[j:j+2] in (b"\xd8\xa4", b"\xd8\xa3", b"\xd8\xa2", b"\xd8\xbc"):   # UInt64/32/16, UFix64
        val, _ = cbor_uint(seg, j + 2); return val
    return None


def qid_after(seg, name):
    k = seg.find(name)
    if k < 0: return None
    m = COMPOSITE.search(seg, k)
    if not m or m.start() - k > 40: return None
    c, j = strs_at(seg, m.end() - 1); q, _ = strs_at(seg, j)
    return f"A.{m.group(1).hex()}.{q}" if q else None

def main(d, owner, outp):
    nfts, listings = {}, []
    for f in glob.glob(f"{d}/*.jsonl"):
        for line in open(f):
            r = json.loads(line)
            if r["owner"] != owner: continue
            v = bytes.fromhex(r["value"])
            for m in COMPOSITE.finditer(v):
                loc = m.group(1).hex()
                contract, j = strs_at(v, m.end() - 1)
                qid, j = strs_at(v, j)
                if not qid: continue
                if qid.endswith("ListingDetails"):
                    nxt = v.find(b"ListingDetails", j); seg = v[j: nxt if nxt > 0 else len(v)]
                else:
                    nxt = COMPOSITE.search(v, j); seg = v[j: nxt.start() if nxt else len(v)]
                if qid.endswith(".NFT"):
                    nid = field_uint(seg, b"\x82bid")
                    if nid is not None: nfts.setdefault(f"A.{loc}.{qid}", set()).add(nid)
                elif qid.endswith("ListingDetails"):
                    p = seg.find(b"ipurchased")
                    listings.append({"contract": f"A.{loc}.{qid}",
                                     "purchased": (seg[p+10] == 0xf5) if p >= 0 else None,
                                     "nftID": field_uint(seg, b"enftID"),
                                     "salePrice": (field_uint(seg, b"isalePrice") or 0) / 1e8,
                                     "storefrontID": field_uint(seg, b"lstorefrontID"),
                                     "commission": (field_uint(seg, b"pcommissionAmount") or 0) / 1e8,
                                     "nftUUID": field_uint(seg, b"gnftUUID"),
                                     "expiry": field_uint(seg, b"fexpiry"),
                                     "vault": qid_after(seg, b"tsalePaymentVaultType"),
                                     "nftType": qid_after(seg, b"gnftType")})
    out = {"nfts": {k: sorted(v) for k, v in nfts.items()}, "listings": listings}
    json.dump(out, open(outp, "w"))
    print(d, owner, {k.split('.')[-2]: len(v) for k, v in nfts.items()}, "listings", len(listings),
          "purchased", sum(1 for l in listings if l["purchased"]))

if __name__ == "__main__":
    main(*sys.argv[1:4])
