#!/usr/bin/env python3
"""Find which ACCOUNT holds given Top Shot / All Day NFT ids in a spork-root checkpoint (any owner).
Streams a byte range; matches the atree field pair `"id": UInt64(<n>)` (b'\\x62id\\xd8\\xa4'+CBOR uint),
walks back to the enclosing payload to read its owner, and keeps hits whose payload references the
TopShot (0x0b2a3299cc857e29) or AllDay (0xe4cf4bdc1751c65d) contract.
Usage: ckpt_find.py <url> <ids.json {"topshot":[...],"allday":[...]}> <out.jsonl> <start> <end>"""
import sys, json, re, urllib.request, time
PREFIX = bytes.fromhex("0002" "0000000a" "0000")
TS, AD = bytes.fromhex("0b2a3299cc857e29"), bytes.fromhex("e4cf4bdc1751c65d")
CHUNK, OVER = 256 * 1024 * 1024, 8 * 1024 * 1024
def cbor(n):
    if n < 24: return bytes([n])
    if n < 256: return b"\x18" + bytes([n])
    if n < 65536: return b"\x19" + n.to_bytes(2, "big")
    if n < 2**32: return b"\x1a" + n.to_bytes(4, "big")
    return b"\x1b" + n.to_bytes(8, "big")
def fetch(url, a, b):
    for k in range(6):
        try: return urllib.request.urlopen(urllib.request.Request(url, headers={"Range": f"bytes={a}-{b}"}), timeout=300).read()
        except Exception: time.sleep(2 ** k)
    raise RuntimeError("fetch")
def payload_at(buf, p):
    """owner, key, value bounds of the leaf payload containing offset p (or None)."""
    lo = p
    for _ in range(64):
        i = buf.rfind(PREFIX, max(0, p - 2_000_000), lo)
        if i < 4: return None
        try:
            klen = int.from_bytes(buf[i-4:i], "big"); q = i + 2; parts = []
            for _ in range(2):
                plen = int.from_bytes(buf[q:q+4], "big"); parts.append(buf[q+6:q+4+plen]); q += 4 + plen
            if q - i == klen:
                vlen = int.from_bytes(buf[q:q+4], "big")
                if q + 4 <= p < q + 4 + vlen: return parts[0].hex(), parts[1].hex(), buf[q+4:q+4+vlen]
        except Exception: pass
        lo = i
    return None
def main(url, idsf, outp, a, b):
    ids = json.load(open(idsf)); want = {}
    for kind in ("topshot", "allday"):
        for n in ids.get(kind, []): want.setdefault(b"\x62id\xd8\xa4" + cbor(int(n)), []).append((kind, int(n)))
    rx = re.compile(b"\x62id\xd8\xa4(?:" + b"|".join(re.escape(k[5:]) for k in sorted(want, key=len, reverse=True)) + b")")
    a, b = int(a), int(b); pos = a; n = 0
    with open(outp, "a") as out:
        while pos < b:
            buf = fetch(url, pos, min(pos + CHUNK + OVER, b) - 1)
            for m in rx.finditer(buf):
                pl = payload_at(buf, m.start())
                if not pl: continue
                owner, key, val = pl
                for kind, nid in want.get(m.group(0), []):
                    if (kind == "topshot" and TS in val) or (kind == "allday" and AD in val):
                        out.write(json.dumps({"owner": owner, "key": key, "kind": kind, "nft_id": nid, "at": pos + m.start()}) + "\n"); n += 1
            out.flush(); pos += CHUNK
    print("DONE", url.rsplit("/", 2)[-2], a, n, flush=True)
if __name__ == "__main__": main(*sys.argv[1:6])
