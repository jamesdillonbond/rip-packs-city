#!/usr/bin/env python3
"""Stream a checkpoint part and extract EVERY Flowty NFTStorefrontV2.ListingDetails (any owner).
Out jsonl: owner, purchased, nftID, salePrice, commission, vault, nftType, storefrontID, nftUUID
Usage: ckpt_listings.py <url> <out.jsonl> [start] [end]"""
import sys, json, time
from ckpt_extract import fetch, size_of, CHUNK, OVERLAP
from decode_wallet import field_uint, qid_after

MARK = b"H<\xdb\xb3\xd5i!\x1f\xf3oNFTStorefrontV2x\x1eNFTStorefrontV2.ListingDetails"
OWNERPFX = bytes.fromhex("0002" "0000000a" "0000")

def scan(buf, base, seen, out):
    n = 0; i = buf.find(MARK)
    while i != -1:
        k = buf.rfind(OWNERPFX, max(0, i - 200), i)
        if k >= 0:
            owner = buf[k+8:k+16].hex()
            nxt = buf.find(MARK, i + 1)
            seg = buf[i: nxt if nxt > 0 and nxt - i < 4096 else i + 4096]
            p = seg.find(b"ipurchased")
            rec = {"owner": owner, "purchased": (seg[p+10] == 0xf5) if p >= 0 else None,
                   "nftID": field_uint(seg, b"enftID"), "salePrice": (field_uint(seg, b"isalePrice") or 0) / 1e8,
                   "commission": (field_uint(seg, b"pcommissionAmount") or 0) / 1e8,
                   "vault": qid_after(seg, b"tsalePaymentVaultType"), "nftType": qid_after(seg, b"gnftType"),
                   "storefrontID": field_uint(seg, b"lstorefrontID"), "nftUUID": field_uint(seg, b"gnftUUID")}
            key = (owner, rec["nftUUID"], rec["storefrontID"], rec["salePrice"])
            if key not in seen:
                seen.add(key); out.write(json.dumps(rec) + "\n"); n += 1
        i = buf.find(MARK, i + 1)
    return n

def main():
    url, outp = sys.argv[1], sys.argv[2]
    total = size_of(url); start = int(sys.argv[3]) if len(sys.argv) > 3 else 0; end = int(sys.argv[4]) if len(sys.argv) > 4 else total
    seen = set(); found = 0; t0 = time.time()
    with open(outp, "a") as out:
        pos = start
        while pos < end:
            b = min(pos + CHUNK + OVERLAP, end) - 1
            found += scan(fetch(url, pos, b), pos, seen, out); out.flush(); pos += CHUNK
            print(f"{pos-start}/{end-start} found={found} {((pos-start)/1e6/(time.time()-t0)):.1f}MB/s", flush=True)
    print("DONE", url, found, flush=True)

if __name__ == "__main__":
    main()
