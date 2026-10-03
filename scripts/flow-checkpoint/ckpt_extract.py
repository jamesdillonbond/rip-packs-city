#!/usr/bin/env python3
"""Stream a Flow execution-state checkpoint part from the public GCS bucket and
extract every ledger payload whose OWNER is one of the target addresses.

Leaf payload layout observed in checkpoint V6 parts (mainnet-24):
  [u32 keyLen][u16 nParts]{ [u32 partLen][u16 partType][bytes] }*[u32 valueLen][value]
  partType 0 = owner (8 bytes), 2 = register key.
We search for  00 02 | 00 00 00 0a | 00 00 | <owner8>  (2 parts, owner part first).
Usage: ckpt_extract.py <url> <out.jsonl> [start_byte] [end_byte]
"""
import sys, json, urllib.request, time

import os
# Owners to extract: env CKPT_OWNERS="hex,hex" overrides the defaults below.
OWNERS = {bytes.fromhex(a): a for a in (os.environ["CKPT_OWNERS"].split(",") if os.environ.get("CKPT_OWNERS") else [
    "5c57f79c6694797f",  # Flowty (loans + rentals marketplace)
    "d96dc67ae64ee202",  # Trevor Flow wallet (older)
    "bd94cade097e50ac",  # Trevor Dapper wallet
    "3d0b274c80263484",  # Trevor Flow wallet (newer)
])}
PREFIX = bytes.fromhex("0002" "0000000a" "0000")
PREFIX3 = bytes.fromhex("0003" "0000000a" "0000")
CHUNK = 256 * 1024 * 1024
OVERLAP = 4 * 1024 * 1024

def size_of(url):
    req = urllib.request.Request(url, method="HEAD")
    return int(urllib.request.urlopen(req, timeout=60).headers["Content-Length"])

def fetch(url, a, b):
    for attempt in range(6):
        try:
            req = urllib.request.Request(url, headers={"Range": f"bytes={a}-{b}"})
            return urllib.request.urlopen(req, timeout=300).read()
        except Exception as e:
            time.sleep(2 ** attempt)
    raise RuntimeError(f"fetch failed {a}-{b}")

def scan(buf, base, seen, out):
    n = 0
    for (owner, name), (pfx, nparts) in [((o, nm), pp) for o, nm in OWNERS.items() for pp in ((PREFIX, 2), (PREFIX3, 3))]:
        pat = pfx + owner
        i = buf.find(pat)
        while i != -1:
            try:
                klen = int.from_bytes(buf[i-4:i], "big")
                p = i + 2
                parts = []
                for _ in range(nparts):
                    plen = int.from_bytes(buf[p:p+4], "big"); ptype = int.from_bytes(buf[p+4:p+6], "big")
                    parts.append((ptype, buf[p+6:p+4+plen])); p += 4 + plen
                if p - i == klen:
                    vlen = int.from_bytes(buf[p:p+4], "big")
                    val = buf[p+4:p+4+vlen]
                    if len(val) == vlen and vlen < 64 * 1024 * 1024:
                        key = parts[-1][1].hex()
                        k = (name, key)
                        if k not in seen:
                            seen.add(k)
                            out.write(json.dumps({"owner": name, "key": key, "value": val.hex(), "at": base + i}) + "\n"); n += 1
            except Exception:
                pass
            i = buf.find(pat, i + 1)
    return n

def main():
    url, outp = sys.argv[1], sys.argv[2]
    total = size_of(url)
    start = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    end = int(sys.argv[4]) if len(sys.argv) > 4 else total
    seen = set(); found = 0; t0 = time.time()
    with open(outp, "a") as out:
        pos = start
        while pos < end:
            b = min(pos + CHUNK + OVERLAP, end) - 1
            buf = fetch(url, pos, b)
            found += scan(buf, pos, seen, out); out.flush()
            pos += CHUNK
            el = time.time() - t0
            print(f"{url.rsplit('/',1)[-1]} {pos-start}/{end-start} found={found} {((pos-start)/1e6/el):.1f}MB/s", flush=True)
    print("DONE", url, found, flush=True)

if __name__ == "__main__":
    main()
