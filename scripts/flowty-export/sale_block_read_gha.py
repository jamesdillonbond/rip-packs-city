#!/usr/bin/env python3
"""Name sold NFTs that no checkpoint holds by reading the BUYER's collection at the sale's own block on the
history node of its spork, and land the result through public.ingest_sale_block_reads (migration
20261004161541) as checkpoint_nft_meta spork code 1.

Candidates (flowty_archive.sale_block_read_candidates) are paged by key and grouped by (node, block, buyer,
collection) so one script reads every id that buyer took in that block. mainnet24 runs pre-Cadence-1.0
scripts; later nodes take Cadence 1.0. Contract surfaces were read from the chain 2026-10-04 (TopShot,
AllDay, UFC_NFT) — see the migration header.

Only an HTTP 200 is a verdict: an id in the result is 'found' (with its record), an id missing from it is
'absent'. Anything else (429 / 5xx / timeouts retried; a 400 script or block error) leaves the candidate
unread for the next run.
Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RPS (default 5), WORKERS (default 12),
     MAX_MINUTES (default 0 = none).
Usage: sale_block_read_gha.py <shard> <of>
"""
import base64, hashlib, http.client, json, os, sys, time, urllib.request, urllib.error
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from chain_verify_tx_gha import Limiter, cdc, rpc

RPS = float(os.environ.get("RPS", "5"))
WORKERS = int(os.environ.get("WORKERS", "12"))
MAX_MINUTES = float(os.environ.get("MAX_MINUTES", "0"))

PRE, C1 = "pre", "c1"
SCRIPTS = {
    ("ts", PRE): """import TopShot from 0x0b2a3299cc857e29
pub fun main(owner: Address, ids: [UInt64]): {UInt64: [UInt32]} {
  let out: {UInt64: [UInt32]} = {}
  let col = getAccount(owner).getCapability(/public/MomentCollection).borrow<&{TopShot.MomentCollectionPublic}>()
  if col == nil { return out }
  for id in ids { if let m = col!.borrowMoment(id: id) { out[id] = [m.data.setID, m.data.playID, m.data.serialNumber, TopShot.getMomentsSubedition(nftID: id) ?? 0] } }
  return out
}""",
    ("ts", C1): """import TopShot from 0x0b2a3299cc857e29
access(all) fun main(owner: Address, ids: [UInt64]): {UInt64: [UInt32]} {
  let out: {UInt64: [UInt32]} = {}
  let col = getAccount(owner).capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
  if col == nil { return out }
  for id in ids { if let m = col!.borrowMoment(id: id) { out[id] = [m.data.setID, m.data.playID, m.data.serialNumber, TopShot.getMomentsSubedition(nftID: id) ?? 0] } }
  return out
}""",
    ("ad", PRE): """import AllDay from 0xe4cf4bdc1751c65d
pub fun main(owner: Address, ids: [UInt64]): {UInt64: [UInt64]} {
  let out: {UInt64: [UInt64]} = {}
  let col = getAccount(owner).getCapability(/public/AllDayNFTCollection).borrow<&{AllDay.MomentNFTCollectionPublic}>()
  if col == nil { return out }
  for id in ids { if let m = col!.borrowMomentNFT(id: id) { out[id] = [m.editionID, m.serialNumber] } }
  return out
}""",
    ("ad", C1): """import AllDay from 0xe4cf4bdc1751c65d
access(all) fun main(owner: Address, ids: [UInt64]): {UInt64: [UInt64]} {
  let out: {UInt64: [UInt64]} = {}
  let col = getAccount(owner).capabilities.borrow<&AllDay.Collection>(/public/AllDayNFTCollection)
  if col == nil { return out }
  for id in ids { if let m = col!.borrowMomentNFT(id: id) { out[id] = [m.editionID, m.serialNumber] } }
  return out
}""",
    ("ufc", PRE): """import UFC_NFT from 0x329feb3ab062d289
pub fun main(owner: Address, ids: [UInt64]): {UInt64: [UInt32]} {
  let out: {UInt64: [UInt32]} = {}
  let col = getAccount(owner).getCapability(/public/UFC_NFTCollection).borrow<&{UFC_NFT.UFC_NFTCollectionPublic}>()
  if col == nil { return out }
  for id in ids { if let m = col!.borrowUFC_NFT(id: id) { out[id] = [m.setId, m.editionNum] } }
  return out
}""",
    ("ufc", C1): """import UFC_NFT from 0x329feb3ab062d289
access(all) fun main(owner: Address, ids: [UInt64]): {UInt64: [UInt32]} {
  let out: {UInt64: [UInt32]} = {}
  let col = getAccount(owner).capabilities.borrow<&{UFC_NFT.UFC_NFTCollectionPublic}>(/public/UFC_NFTCollection)
  if col == nil { return out }
  for id in ids { if let m = col!.borrowUFC_NFT(id: id) { out[id] = [m.setId, m.editionNum] } }
  return out
}""",
}


def b64(s): return base64.b64encode(s.encode()).decode()


def records(c, value):
    """{nft_id: meta rows} from the decoded JSON-CDC dictionary a script returned."""
    out = {}
    for e in value or []:
        nid = int(cdc(e["key"]))
        vals = [int(cdc(x)) for x in e["value"]["value"]]
        if c == "ts":
            rows = [{"c": "ts", "id": nid, "set": vals[0], "play": vals[1], "serial": vals[2]}]
            if vals[3] > 0: rows.append({"c": "tssub", "id": nid, "sub": vals[3]})
        elif c == "ad":
            rows = [{"c": "ad", "id": nid, "ed": vals[0], "serial": vals[1]}]
        else:
            rows = [{"c": "ufc", "id": nid, "set": vals[0], "serial": vals[1]}]
        out[nid] = rows
    return out


def run_script(group, lim):
    """(found {id: rows}) for one (node, block, buyer, c) group, or None when there is no verdict."""
    node, block_id, height, buyer, c = group["key"]
    era = PRE if node == "mainnet24" else C1
    q = f"block_id={block_id}" if block_id else f"block_height={height}"
    url = f"http://access-001.{node}.nodes.onflow.org:8070/v1/scripts?{q}"
    args = [b64(json.dumps({"type": "Address", "value": buyer})),
            b64(json.dumps({"type": "Array", "value": [{"type": "UInt64", "value": str(i)} for i in group["ids"]]}))]
    body = json.dumps({"script": b64(SCRIPTS[(c, era)]), "arguments": args}).encode()
    for k in range(8):
        lim.wait()
        try:
            req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=60) as r:
                res = json.loads(base64.b64decode(json.loads(r.read())))
                return records(c, res.get("value"))
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503, 504): return None
        except (urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError, ValueError):
            pass
        time.sleep(min(60, 2 ** k))
    return None


def groups_of(rows):
    g = defaultdict(lambda: {"ids": [], "ks": []})
    for r in rows:
        key = (r["node"], r.get("block_id"), r.get("block_height"), r["buyer"], r["c"])
        g[key]["key"] = key; g[key]["ids"].append(int(r["id"])); g[key]["ks"].append((r["k"], int(r["id"])))
    return list(g.values())


def verdict_rows(group, found):
    out = []
    for k, nid in group["ks"]:
        out.append({"k": k, "found": nid in found, "meta": found.get(nid, [])})
    return out


def main():
    shard, of = int(sys.argv[1]), int(sys.argv[2])
    base = os.environ["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/") + "/rest/v1/rpc/"
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    lim = Limiter(RPS); t0 = time.time(); deadline = t0 + MAX_MINUTES * 60 if MAX_MINUTES else None
    after = ""; seen = found_n = absent_n = unanswered = 0
    with ThreadPoolExecutor(WORKERS) as ex:
        while not deadline or time.time() < deadline:
            page = rpc(base, key, "sale_block_read_page", {"p_after": after, "p_limit": 1000})
            if not page: break
            after = page[-1]["k"]
            mine = [r for r in page if int(hashlib.md5(r["k"].encode()).hexdigest(), 16) % of == shard]
            gs = groups_of(mine)
            out = []
            for g, found in zip(gs, ex.map(lambda g: run_script(g, lim), gs)):
                if found is None: unanswered += len(g["ks"]); continue
                rows = verdict_rows(g, found)
                found_n += sum(r["found"] for r in rows); absent_n += sum(not r["found"] for r in rows)
                out.extend(rows)
            seen += len(mine)
            if out:
                res = rpc(base, key, "ingest_sale_block_reads", {"p_rows": out})
                if res.get("candidates", 0) > len(out): sys.exit(f"RPC marked {res} for {len(out)} rows")
            print(f"shard {shard}/{of}: {seen} rows, {found_n} found, {absent_n} absent, {unanswered} unanswered, {seen / (time.time() - t0):.1f} rows/s", flush=True)
    print(f"DONE shard {shard}/{of}: {seen} rows, {found_n} found, {absent_n} absent, {unanswered} unanswered")


if __name__ == "__main__":
    main()
