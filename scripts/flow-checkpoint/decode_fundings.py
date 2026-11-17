#!/usr/bin/env python3
"""Decode Flowty.Funding resources from extracted checkpoint payloads.
Out: CSV funding_id,lender_nft,borrower_nft,lender_ft,nft_path"""
import json, re, sys, glob, csv

def cbor_uint(b, i):
    ai = b[i] & 0x1f
    if ai < 24: return ai, i + 1
    n = {24: 1, 25: 2, 26: 4, 27: 8}[ai]
    return int.from_bytes(b[i+1:i+1+n], "big"), i + 1 + n

def cap_addr(v, field):
    i = v.find(field)
    if i < 0: return None, None
    j = v.find(b"\xd8\x83H", i, i + 80)   # address-location tag + 8-byte string
    if j < 0: return None, None
    addr = "0x" + v[j+3:j+11].hex()
    m = re.match(rb"\xd8\xc8\x82\x03[\x60-\x77\x78](.)?", v[j+11:j+16])
    path = None
    k = v.find(b"\xd8\xc8\x82\x03", j + 11, j + 20)
    if k >= 0:
        t = v[k+4]
        if 0x60 <= t <= 0x77: L, s = t - 0x60, k + 5
        elif t == 0x78: L, s = v[k+5], k + 6
        else: L, s = 0, k
        path = v[s:s+L].decode("utf-8", "replace")
    return addr, path

def main(pattern, outp):
    out = csv.writer(open(outp, "w")); out.writerow(["funding_id", "lender_nft", "borrower_nft", "lender_ft", "nft_path", "ft_path"])
    n = 0; seen = set()
    for f in sorted(glob.glob(pattern)):
        for line in open(f):
            r = json.loads(line)
            if r["owner"] != "5c57f79c6694797f": continue
            v = bytes.fromhex(r["value"])
            pos = 0
            while True:
                t = v.find(b"nFlowty.Funding\x02", pos)
                if t < 0: break
                end = v.find(b"nFlowty.Funding\x02", t + 1); seg = v[t: end if end > 0 else len(v)]
                pos = t + 1
                u = seg.find(b"duuid\xd8\xa4")
                if u < 0: continue
                fid, _ = cbor_uint(seg, u + 7)
                if fid in seen: continue
                lender, npath = cap_addr(seg, b"slenderNFTCollection")
                borrower, _ = cap_addr(seg, b"rownerNFTCollection")
                lft, fpath = cap_addr(seg, b"lenderFungibleTokenReceiver")
                seen.add(fid); n += 1
                out.writerow([fid, lender, borrower, lft, npath, fpath])
    print("fundings decoded", n)

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
