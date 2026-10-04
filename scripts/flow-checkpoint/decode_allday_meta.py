#!/usr/bin/env python3
"""All Day moment id -> (editionID, serialNumber) from checkpoint payloads (mainnet-15..24 dirs in cwd);
join editionID to editions.external_id (nfl_all_day) for player/set/tier. Owners filtered to Trevor's wallets; edit for others."""
import json,glob,re,sys
def uint(b,p):
    a=b[p]&0x1f
    if a<24: return a,p+1
    n={24:1,25:2,26:4,27:8}[a]; return int.from_bytes(b[p+1:p+1+n],"big"),p+1+n
out={}
for d in ["mn%d"%n for n in range(15,25)]:
    for f in glob.glob(f"{d}/*.jsonl"):
        for l in open(f):
            r=json.loads(l)
            if r["owner"] not in ("bd94cade097e50ac","d96dc67ae64ee202"): continue
            v=bytes.fromhex(r["value"])
            if b"AllDay.NFT" not in v or b"ieditionID\xd8\xa4" not in v: continue
            for m in re.finditer(rb"bid\xd8\xa4", v):
                w0=max(0,m.start()-200); w=v[w0:m.start()+200]
                es=[x.start() for x in re.finditer(rb"ieditionID\xd8\xa4", w)]; ss=[x.start() for x in re.finditer(rb"lserialNumber\xd8\xa4", w)]
                if not es or not ss: continue
                e=min(es,key=lambda x:abs(w0+x-m.start())); s=min(ss,key=lambda x:abs(w0+x-m.start()))
                nid,_=uint(v,m.end()); out[str(nid)]=[uint(w,e+12)[0], uint(w,s+15)[0]]
print(len(out)); json.dump(out,open("ad_meta.json","w"))
