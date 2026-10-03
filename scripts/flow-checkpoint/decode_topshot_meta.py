#!/usr/bin/env python3
"""Top Shot moment id -> (setID, playID, serialNumber) from checkpoint payloads (ckpt_extract.py output).
Atree snapshots (mainnet-15+): the NFT composite holds `id` and a `data` slab ref -> TopShot.MomentData slab.
Pre-atree (mainnet-6..14): the fields sit next to `id` in the same value. Join (setID, playID) to
editions.external_id 'set:play' for player/set/tier. Usage: decode_topshot_meta.py [--merge] DIR [DIR ...]
(writes/merges ts_meta.json in cwd). Owners are filtered to the wallets in OWNERS below; edit for others."""
import json, glob, re, sys
OWNERS = ("bd94cade097e50ac", "d96dc67ae64ee202")
def uint(b,p):
    a=b[p]&0x1f
    if a<24: return a,p+1
    n={24:1,25:2,26:4,27:8}[a]; return int.from_bytes(b[p+1:p+1+n],"big"),p+1+n
def field(seg, name):
    i=seg.find(name)
    return uint(seg, i+len(name))[0] if i>=0 else None
out=json.load(open("ts_meta.json")) if len(sys.argv)>1 and sys.argv[1]=="--merge" else {}
dirs=[a for a in sys.argv[1:] if not a.startswith("--")]
for d in dirs:
    slabs={}; nfts=[]
    for f in glob.glob(f"{d}/*.jsonl"):
        for l in open(f):
            r=json.loads(l)
            if r["owner"] not in OWNERS: continue
            k=bytes.fromhex(r["key"]); v=bytes.fromhex(r["value"])
            if k[:1]==b"$": slabs[(r["owner"],k[1:9])]=v
            for m in re.finditer(rb"bid\xd8\xa4", v):
                nid,_=uint(v, m.end())
                w=v[m.start():m.start()+120]
                j=w.find(b"ddata\xd8\xffP")
                if j>=0: nfts.append((r["owner"], nid, w[j+8+8:j+8+16], None))
                else:
                    w2=v[max(0,m.start()-200):m.start()+200]
                    s,p,n=field(w2,b"esetID\xd8\xa3"),field(w2,b"fplayID\xd8\xa3"),field(w2,b"lserialNumber\xd8\xa3")
                    if None not in (s,p,n): out[str(nid)]=[s,p,n]
    hit=0
    for o,nid,ref,_ in nfts:
        dv=slabs.get((o,ref))
        if not dv: continue
        s,p,n=field(dv,b"esetID\xd8\xa3"),field(dv,b"fplayID\xd8\xa3"),field(dv,b"lserialNumber\xd8\xa3")
        if None not in (s,p,n): out[str(nid)]=[s,p,n]; hit+=1
    print(d, "refs", len(nfts), "resolved", hit, file=sys.stderr)
json.dump(out, open("ts_meta.json","w")); print("total", len(out), file=sys.stderr)
