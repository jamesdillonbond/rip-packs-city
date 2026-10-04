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
import base64, hashlib, http.client, json, os, re, sys, time, urllib.request, urllib.error
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
import threading
from chain_verify_tx_gha import cdc, rpc

RPS = float(os.environ.get("RPS", "5"))
# Nodes this job reads (comma-separated; empty = all). The history nodes throttle independently —
# mainnet26 answered 429 to two single script calls while the 6-shard run was on it (2026-10-04), so
# each node gets its own job set and its own adaptive limiter.
NODES = {n for n in os.environ.get("NODES", "").split(",") if n}
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
    # Many mainnet24-era wallets publish /public/AllDayNFTCollection as a GENERIC capability
    # (&AnyResource{NonFungibleToken.CollectionPublic, Receiver, MetadataViews.ResolverCollection}, read off one
    # 2026-10-04), so the typed borrow finds nothing. Fallback: the NFT's own MetadataViews — Medias[0] is
    # AllDay.assetPath() = "https://media.nflallday.com/editions/<editionID>/media/…", built by the contract from
    # self.editionID, and Serial is serialNumber. getIDs() first, so a missing id cannot panic the batch.
    ("ad", PRE): """import AllDay from 0xe4cf4bdc1751c65d
import NonFungibleToken from 0x1d7e57aa55817448
import MetadataViews from 0x1d7e57aa55817448
pub fun main(owner: Address, ids: [UInt64]): {UInt64: [String]} {
  let out: {UInt64: [String]} = {}
  let cap = getAccount(owner).getCapability(/public/AllDayNFTCollection)
  if let col = cap.borrow<&{AllDay.MomentNFTCollectionPublic}>() {
    for id in ids { if let m = col.borrowMomentNFT(id: id) { out[id] = [m.editionID.toString(), m.serialNumber.toString()] } }
    return out
  }
  let pub = cap.borrow<&{NonFungibleToken.CollectionPublic}>()
  let rc = cap.borrow<&{MetadataViews.ResolverCollection}>()
  if pub == nil || rc == nil { return out }
  let held = pub!.getIDs()
  for id in ids {
    if !held.contains(id) { continue }
    let v = rc!.borrowViewResolver(id: id)
    let medias = v.resolveView(Type<MetadataViews.Medias>())! as! MetadataViews.Medias
    let serial = v.resolveView(Type<MetadataViews.Serial>())! as! MetadataViews.Serial
    out[id] = [medias.items[0].file.uri(), serial.number.toString()]
  }
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


class AdaptiveLimiter:
    """Paces calls at <= rps; a 429 doubles the gap (to at most 10 s), each success shrinks it by 3 %."""
    def __init__(self, rps):
        self.floor = 1.0 / rps; self.gap = self.floor; self.next = time.monotonic(); self.lock = threading.Lock()

    def wait(self):
        with self.lock:
            now = time.monotonic(); t = max(now, self.next); self.next = t + self.gap
        time.sleep(max(0, t - now))

    def throttled(self):
        with self.lock: self.gap = min(self.gap * 2, 10.0)

    def ok(self):
        with self.lock: self.gap = max(self.gap * 0.97, self.floor)


EDITION_URL = re.compile(r"^https://media\.nflallday\.com/editions/([0-9]+)/media/")


def edition_of(v):
    """An integer field, or the edition id inside an All Day media URL (the view fallback)."""
    if isinstance(v, str) and v.startswith("https://"):
        m = EDITION_URL.match(v)
        if not m: raise ValueError(f"unrecognised media url {v!r}")
        return int(m.group(1))
    return int(v)


def records(c, value):
    """{nft_id: meta rows} from the decoded JSON-CDC dictionary a script returned."""
    out = {}
    for e in value or []:
        nid = int(cdc(e["key"]))
        vals = [edition_of(cdc(x)) for x in e["value"]["value"]]
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
    for k in range(12):
        lim.wait()
        try:
            req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=60) as r:
                res = json.loads(base64.b64decode(json.loads(r.read())))
                lim.ok()
                return records(c, res.get("value"))
        except urllib.error.HTTPError as e:
            if e.code == 429: lim.throttled(); continue
            if e.code not in (500, 502, 503, 504): return None
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
    lims = defaultdict(lambda: AdaptiveLimiter(RPS)); t0 = time.time(); deadline = t0 + MAX_MINUTES * 60 if MAX_MINUTES else None
    after = ""; seen = found_n = absent_n = unanswered = 0
    with ThreadPoolExecutor(WORKERS) as ex:
        while not deadline or time.time() < deadline:
            page = rpc(base, key, "sale_block_read_page", {"p_after": after, "p_limit": 1000})
            if not page: break
            after = page[-1]["k"]
            mine = [r for r in page if (not NODES or r["node"] in NODES)
                    and int(hashlib.md5(r["k"].encode()).hexdigest(), 16) % of == shard]
            gs = groups_of(mine)
            out = []
            for g, found in zip(gs, ex.map(lambda g: run_script(g, lims[g["key"][0]]), gs)):
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
