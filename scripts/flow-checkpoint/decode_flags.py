#!/usr/bin/env python3
"""For one spork snapshot dir: map Flowty.Funding uuid -> (repaid, settled) by following
Funding.details (an atree slab reference) to its FundingDetails slab.
Out: JSON {funding_id: [repaid, settled]}"""
import json, glob, sys
from decode_fundings import cbor_uint

def main(d, outp):
    slabs = {}
    fundings = []
    for f in glob.glob(f"{d}/*.jsonl"):
        for line in open(f):
            r = json.loads(line)
            if r["owner"] != "5c57f79c6694797f": continue
            v = bytes.fromhex(r["value"]); k = bytes.fromhex(r["key"])
            if k[:1] == b"$": slabs[k[1:9]] = v
            pos = 0
            while True:
                t = v.find(b"nFlowty.Funding\x02", pos)
                if t < 0: break
                end = v.find(b"nFlowty.Funding\x02", t + 1); seg = v[t: end if end > 0 else len(v)]; pos = t + 1
                u = seg.find(b"duuid\xd8\xa4")
                if u < 0: continue
                fid, _ = cbor_uint(seg, u + 7)
                dref = seg.find(b"gdetails\xd8\xffP")
                inline = seg.find(b"uFlowty.FundingDetails")
                fundings.append((fid, seg[dref+11+8:dref+11+16] if dref >= 0 else None, seg if inline >= 0 else None))
    out = {}
    for fid, ref, inline in fundings:
        v = slabs.get(ref) if ref else inline
        if v is None: continue
        i = v.find(b"frepaid"); j = v.find(b"gsettled")
        if i < 0 or j < 0: continue
        out[fid] = [v[i+7] == 0xf5, v[j+8] == 0xf5]
    json.dump(out, open(outp, "w"))
    print(d, "fundings", len(fundings), "with flags", len(out))

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
