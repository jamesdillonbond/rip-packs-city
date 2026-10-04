#!/usr/bin/env python3
"""Every Top Shot / All Day / Golazos / UFC Strike NFT in a spork-root checkpoint -> its edition
and serial, ANY owner. Holder-independent: the map RPC's sales lanes need to name a moment that
nobody we track holds (2026-10-03: Flowty-venue sales 2023-11..2025-12).

FORMAT (mainnet-28, post-Cadence-1.0 atree): a slab's extra data lists its type infos in order
(tag 249: qualified type id + field-name array); every NFT is an INLINED composite
  tag 252 [type_index, slab_id(8), [values in that type's field-name order]]
and Top Shot's MomentData is a nested inlined composite in the NFT's `data` field. Field order
differs slab to slab (all 6 permutations of setID/serialNumber/playID were seen in 128 MB), so
values are mapped by the slab's OWN name list, never by position. Pre-1.0 checkpoints use
named fields + separate MomentData slabs: decode_topshot_meta.py / decode_allday_meta.py.

Output JSONL, one record per NFT:
  {"c":"ts","id":..,"set":..,"play":..,"serial":..}
  {"c":"ad"|"gz","id":..,"ed":editionID,"serial":..}
  {"c":"ufc","id":..,"set":setId,"serial":editionNum}
  {"c":"tssub","id":..,"sub":subeditionID}   entries of TopShot's SubEditionAdmin.momentsSubedition
                                              {UInt64: UInt32} (payloads OWNED by 0x0b2a3299cc857e29);
                                              a moment absent from it is the Standard printing
Usage: ckpt_nftmeta.py <url|file> <out.jsonl> <start> <end>
"""
import sys, json, re, urllib.request, time
CHUNK, OVER = 256 * 1024 * 1024, 4 * 1024 * 1024
TYPES = {"TopShot.NFT": "ts", "TopShot.MomentData": "tsd", "AllDay.NFT": "ad", "Golazos.NFT": "gz", "UFC_NFT.NFT": "ufc"}
QID = re.compile(rb"[\x60-\x77]((?:TopShot|AllDay|Golazos|UFC_NFT)\.(?:NFT|MomentData))")
INL = re.compile(rb"\xd8\xfc\x83")
TI = re.compile(rb"\xd8\xf9\x83")


class Bad(Exception): pass


def item(b, p, depth=0):
    """Minimal CBOR decoder -> (value, next_pos). Tags return ('tag', n, value)."""
    if depth > 12 or p >= len(b): raise Bad()
    ib = b[p]; mt, ai = ib >> 5, ib & 0x1f; p += 1
    if ai < 24: n = ai
    elif ai in (24, 25, 26, 27):
        k = 1 << (ai - 24); n = int.from_bytes(b[p:p + k], "big"); p += k
    elif ai == 31 and mt in (2, 3, 4, 5): n = None
    else: raise Bad()
    if mt == 0: return n, p
    if mt == 1: return -1 - n, p
    if mt in (2, 3):
        if n is None or p + n > len(b): raise Bad()
        v = b[p:p + n]; return (v.decode("utf8", "replace") if mt == 3 else v), p + n
    if mt == 4:
        if n is None or n > 4096: raise Bad()
        out = []
        for _ in range(n):
            v, p = item(b, p, depth + 1); out.append(v)
        return out, p
    if mt == 5:
        if n is None or n > 4096: raise Bad()
        out = []
        for _ in range(n):
            k, p = item(b, p, depth + 1); v, p = item(b, p, depth + 1); out.append((k, v))
        return out, p
    if mt == 6:
        v, p = item(b, p, depth + 1); return ("tag", n, v), p
    if mt == 7: return ("simple", ai, n), p
    raise Bad()


def untag(v):
    while isinstance(v, tuple) and v and v[0] == "tag": v = v[2]
    return v


def type_infos(v):
    """Ordered [(type_kind or None, [field names])] from the slab's extra data."""
    out = []
    for m in TI.finditer(v):
        seg = v[m.start():m.start() + 400]
        q = QID.search(seg)
        name = TYPES.get(q.group(1).decode()) if q else None
        names = None
        if q:
            p = q.end()
            for _ in range(8):           # skip the small header items between the type id and the names
                if p >= len(seg): break
                ib = seg[p]
                if 0x81 <= ib <= 0x8f and p + 1 < len(seg) and 0x60 <= seg[p + 1] <= 0x77:
                    try:
                        arr, _ = item(seg, p)
                        if all(isinstance(x, str) for x in arr): names = arr
                    except Bad: pass
                    break
                try: _, p = item(seg, p)
                except Bad: break
        out.append((name, names))
    return out


def composite(v, tinfo):
    """tag-252 inlined composite -> (kind, {field: value}) or None."""
    v = untag(v)
    if not (isinstance(v, list) and len(v) == 3 and isinstance(v[0], int) and isinstance(v[2], list)): return None
    if v[0] >= len(tinfo): return None
    kind, names = tinfo[v[0]]
    if not kind or not names or len(names) != len(v[2]): return None
    return kind, dict(zip(names, v[2]))


def decode_payload(v, out):
    if not QID.search(v): return 0
    tinfo = type_infos(v)
    if not any(k in ("ts", "ad", "gz", "ufc") for k, _ in tinfo): return 0
    n = 0
    for m in INL.finditer(v):
        try: val, _ = item(v, m.start())
        except Bad: continue
        c = composite(val, tinfo)
        if not c: continue
        kind, f = c
        uid = lambda x: untag(f.get(x))
        if kind == "ts":
            d = composite(f.get("data"), tinfo)
            if not d or d[0] != "tsd": continue
            md = {k: untag(x) for k, x in d[1].items()}
            rec = {"c": "ts", "id": uid("id"), "set": md.get("setID"), "play": md.get("playID"), "serial": md.get("serialNumber")}
        elif kind in ("ad", "gz"):
            rec = {"c": kind, "id": uid("id"), "ed": uid("editionID"), "serial": uid("serialNumber")}
        elif kind == "ufc":
            rec = {"c": "ufc", "id": uid("id"), "set": uid("setId"), "serial": uid("editionNum")}
        else:
            continue
        if all(isinstance(x, int) for x in rec.values() if x != rec["c"]):
            out.write(json.dumps(rec) + "\n"); n += 1
    return n


PREFIX = bytes.fromhex("0002" "0000000a" "0000")
TS_ACCT = bytes.fromhex("0b2a3299cc857e29")
U = rb"(\x1b.{8}|\x1a.{4}|\x19.{2}|\x18.|[\x00-\x17])"
SUBPAIR = re.compile(rb"\x82\xd8\xa4" + U + rb"\xd8\xa3" + U, re.S)


def subeditions(v, out):
    n = 0
    for m in SUBPAIR.finditer(v):
        mid = uint(m.group(1)); sub = uint(m.group(2))
        out.write(json.dumps({"c": "tssub", "id": mid, "sub": sub}) + "\n"); n += 1
    return n


def uint(b):
    a = b[0] & 0x1f
    return a if a < 24 else int.from_bytes(b[1:], "big")


def scan(buf, limit, out):
    n = 0; i = buf.find(PREFIX, 4)
    while i != -1 and i < limit:
        nxt = i + 1
        try:
            klen = int.from_bytes(buf[i - 4:i], "big"); q = i + 2; ok = True
            owner = buf[q + 6:q + 14]
            for _ in range(2):
                plen = int.from_bytes(buf[q:q + 4], "big"); q += 4 + plen
            if q - i == klen:
                vlen = int.from_bytes(buf[q:q + 4], "big")
                if q + 4 + vlen <= len(buf):
                    v = buf[q + 4:q + 4 + vlen]
                    if owner == TS_ACCT and not QID.search(v): n += subeditions(v, out)
                    else: n += decode_payload(v, out)
                    nxt = q + 4 + vlen
        except Exception:
            pass
        i = buf.find(PREFIX, nxt)
    return n


def fetch(src, a, b):
    if not src.startswith("http"):
        with open(src, "rb") as f: f.seek(a); return f.read(b - a + 1)
    for k in range(8):
        try: return urllib.request.urlopen(urllib.request.Request(src, headers={"Range": f"bytes={a}-{b}"}), timeout=300).read()
        except Exception: time.sleep(2 ** k)
    raise RuntimeError(f"fetch {a}-{b}")


def main(src, outp, a, b):
    a, b = int(a), int(b); pos = a; n = 0; t0 = time.time()
    with open(outp, "a") as out:
        while pos < b:
            hi = min(pos + CHUNK + OVER, b)
            buf = fetch(src, pos, hi - 1)
            # a payload STARTING in [pos, pos+CHUNK) is this chunk's; the overlap only completes it
            n += scan(buf, CHUNK if hi < b else len(buf), out); out.flush()
            pos += CHUNK
            print(f"{src.rsplit('/', 1)[-1]} {min(pos, b) - a}/{b - a} recs={n} {(min(pos, b) - a) / 1e6 / (time.time() - t0):.1f}MB/s", flush=True)
    print("DONE", src.rsplit("/", 1)[-1], a, b, n, flush=True)


if __name__ == "__main__":
    main(*sys.argv[1:5])
