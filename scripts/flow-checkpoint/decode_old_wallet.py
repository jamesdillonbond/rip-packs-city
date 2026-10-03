"""Pre-atree (Mar-Oct 2021 spork roots) holdings. Each `storage\x1f<path>` collection register's value
holds the `ownedNFTs` dictionary, whose KEY ARRAY lists every NFT id (values may be deferred to other
registers). Encodings: v3 location {0:addr,1:name} (mainnet-6..8-ish), v5 [addr,name]."""
import json, glob, sys, collections
def uint(b, p):
    a = b[p] & 0x1f
    if a < 24: return a, p + 1
    n = {24: 1, 25: 2, 26: 4, 27: 8}[a]; return int.from_bytes(b[p+1:p+1+n], "big"), p + 1 + n
def location(v):
    i = v.find(b"\xd8\xc0")
    if i < 0: return None, None
    j = v.find(b"H", i, i + 8)
    addr = v[j+1:j+9].hex(); p = j + 9
    if v[p] == 0x01: p += 1            # v3 map key 1
    l, p = uint(v, p) if 0x60 <= v[p] <= 0x7b else (0, p)
    return addr, v[p:p+l].decode(errors="replace")
def keys(v):
    i = v.find(b"ownedNFTs\xd8\x81")
    if i < 0: return None
    for p in range(i + 11, min(len(v), i + 400)):
        b = v[p]
        if 0x80 <= b <= 0x9a:
            n, q = uint(v, p)
            if n == 0 and v[q] in (0x80, 0x01, 0x02):   # empty keys array (v5: followed by empty values; v3: next map key)
                return []
            if v[q:q+2] == b"\xd8\xa4":
                out = []
                for _ in range(n):
                    if v[q:q+2] != b"\xd8\xa4": return None
                    x, q = uint(v, q + 2); out.append(x)
                return out
    return None
def main(d, owner, out):
    nfts = {}; bad = []
    for f in glob.glob(f"{d}/*.jsonl"):
        for l in open(f):
            r = json.loads(l)
            if r["owner"] != owner: continue
            k = bytes.fromhex(r["key"]); v = bytes.fromhex(r["value"])
            if not k.startswith(b"storage\x1f") or k.count(b"\x1f") != 1 or b"ownedNFTs" not in v: continue
            ids = keys(v); addr, c = location(v)
            if ids is None: bad.append(k.decode(errors="replace")); continue
            if ids: nfts.setdefault(f"A.{addr}.{c}.NFT", set()).update(ids)
    json.dump({"nfts": {t: sorted(s) for t, s in nfts.items()}, "undecoded": bad}, open(out, "w"))
    print(d, owner[:4], {t.split(".")[2]: len(s) for t, s in nfts.items()}, "undecoded", bad)
if __name__ == "__main__": main(*sys.argv[1:4])
