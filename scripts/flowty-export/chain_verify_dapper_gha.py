#!/usr/bin/env python3
"""Verify the Dapper-contract sales in Flowty's index (Dapper storefront ListingCompleted and
OffersV2 OfferCompleted, TS/AD/GZ/UFC, USD-pegged, not already in `sales`) against their OWN
transactions, and write verdicts through public.ingest_dapper_tx_verdicts (migration
20261004114808).

Flowty's index is not trusted for the parties on these rows (OffersV2: the offer maker is written as
both buyer and seller; storefront: buyer NULL, seller ''), so they are read from the chain:
  listing: the ListingCompleted for the row's listing id (purchased, nftID, salePrice, vault equal);
           seller = the NFT's Withdraw(from), buyer = its Deposit(to) in that transaction.
  offer:   the OfferCompleted for the row's offer id (purchased, nftId, offerAmount, vault equal);
           seller = acceptingAddress, buyer = offerAddress, and the NFT must be withdrawn from the
           seller and deposited to the buyer in that transaction.
The node is chosen by the row's timestamp; a 404 there is re-asked on every other node before it
counts as 'not_found'. 429 / 5xx / timeouts are retried; a row with no answer gets no verdict.
Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RPS (default 5), WORKERS (default 16),
     MAX_MINUTES (default 0 = none).
Usage: chain_verify_dapper_gha.py <shard> <of>
"""
import base64, hashlib, http.client, json, os, sys, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
from chain_verify_tx_gha import Limiter, cdc, num, rpc

LISTING = "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted"
OFFER = "A.b8ea91944fd51c43.OffersV2.OfferCompleted"
# (first timestamp served, node) — spork roots measured from flowty_chain_listing_completed; mainnet28
# is the live spork (2026-10-04). Boundaries are approximate: a 404 falls through to the other nodes.
SPORKS = [("2023-11-08T16:07:03", "mainnet24"), ("2024-09-04T12:02:35", "mainnet25"), ("2024-09-25T17:00:00", "mainnet26"),
          ("2025-10-22T16:30:00", "mainnet27"), ("2025-12-28T12:00:00", "mainnet28")]
RPS = float(os.environ.get("RPS", "5"))
WORKERS = int(os.environ.get("WORKERS", "16"))
MAX_MINUTES = float(os.environ.get("MAX_MINUTES", "0"))


def nodes_for(ts):
    t = (ts or "")[:19].replace(" ", "T")
    first = SPORKS[0][1]
    for start, node in SPORKS:
        if t >= start: first = node
    return [first] + [n for _, n in SPORKS if n != first]


def type_id(v):
    """typeID of a JSON-CDC Type value (Resource, or a Capability / Reference to one); a String passes through."""
    if isinstance(v, str): return v
    if isinstance(v, dict):
        # Pre-Cadence-1.0 restricted types (Capability<&Vault{Provider,Balance}>) carry their own
        # typeID "…Vault{…}" on the Restriction node: the resource is the inner type.
        if v.get("kind") == "Restriction" and isinstance(v.get("type"), dict): return type_id(v["type"])
        if isinstance(v.get("typeID"), str) and v["typeID"]: return v["typeID"]
        for k in ("value", "staticType", "type"):
            if k in v:
                r = type_id(v[k])
                if r: return r
    return None


def fields(e):
    raw = json.loads(base64.b64decode(e["payload"]))["value"]["fields"]
    return {x["name"]: (type_id(x["value"]["value"]) if x["value"].get("type") == "Type" else cdc(x["value"])) for x in raw}


def transfers(events, nft_type, nft_id):
    """(from of the first Withdraw, to of the last Deposit) of this NFT in the transaction, using the
    contract's own Withdraw/Deposit events and the Cadence-1.0 NonFungibleToken.Withdrawn/Deposited."""
    base = nft_type.rsplit(".", 1)[0]
    w = d = None
    for e in events:
        t = e.get("type")
        if t not in (base + ".Withdraw", base + ".Deposit", "A.1d7e57aa55817448.NonFungibleToken.Withdrawn",
                     "A.1d7e57aa55817448.NonFungibleToken.Deposited"): continue
        f = fields(e)
        if str(f.get("id")) != str(nft_id): continue
        if t.startswith("A.1d7e57aa55817448") and f.get("type") != nft_type: continue
        if t.endswith("Withdraw") or t.endswith("Withdrawn"):
            if w is None and f.get("from"): w = f["from"].lower()
        elif f.get("to"):
            d = f["to"].lower()
    return w, d


def verdict(row, res):
    """(ok, detail) for one index row given its transaction result body."""
    d = {"block_id": res.get("block_id"), "status": res.get("status")}
    if res.get("status") != "Sealed": return False, {**d, "reason": "not_sealed"}
    if res.get("error_message"): return False, {**d, "reason": "tx_error"}
    events = res.get("events") or []
    want = OFFER if row["kind"] == "offer" else LISTING
    for e in events:
        if e.get("type") != want: continue
        f = fields(e)
        key = f.get("offerId") if row["kind"] == "offer" else f.get("listingResourceID")
        if str(key) != str(row["listing"]): continue
        d["event_index"] = int(e.get("event_index", -1))
        diffs = []
        if f.get("purchased") is not True: diffs.append("purchased")
        price = f.get("offerAmount") if row["kind"] == "offer" else f.get("salePrice")
        vault = f.get("paymentVaultType") if row["kind"] == "offer" else f.get("salePaymentVaultType")
        nft = f.get("nftId") if row["kind"] == "offer" else f.get("nftID")
        if str(nft) != str(row["nft_id"]): diffs.append("nft_id")
        if num(price) is None or row["price"] is None or abs(num(price) - float(row["price"])) > 1e-8: diffs.append("price")
        if vault != row["vault"]: diffs.append("vault")
        w, dep = transfers(events, row["nft_type"], row["nft_id"])
        if row["kind"] == "offer":
            seller, buyer = (f.get("acceptingAddress") or "").lower(), (f.get("offerAddress") or "").lower()
            if w != seller or dep != buyer: diffs.append("transfer")
        else:
            seller, buyer = w, dep
            d["custom_id"] = f.get("customID")
            if not seller or not buyer: diffs.append("transfer")
        if seller and buyer and seller == buyer: diffs.append("self_trade")
        d.update(seller=seller or None, buyer=buyer or None)
        return (not diffs), ({**d, "mismatch": diffs} if diffs else d)
    return False, {**d, "reason": "no_event_for_id"}


def get_result(tx, ts, lim):
    """The transaction result from the node of its era; {"status": "NotFound"} only if every node says 404."""
    for node in nodes_for(ts):
        url = f"http://access-001.{node}.nodes.onflow.org:8070/v1/transaction_results/{tx}"
        for k in range(10):
            lim.wait()
            try:
                with urllib.request.urlopen(url, timeout=60) as r:
                    body = json.loads(r.read())
                    body["_node"] = node
                    return body
            except urllib.error.HTTPError as e:
                if e.code == 404: break
                if e.code not in (429, 500, 502, 503, 504): return None
            except (urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError, ValueError):
                pass
            time.sleep(min(60, 2 ** k))
        else:
            return None
    return {"status": "NotFound"}


def main():
    shard, of = int(sys.argv[1]), int(sys.argv[2])
    base = os.environ["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/") + "/rest/v1/rpc/"
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    lim = Limiter(RPS); t0 = time.time(); deadline = t0 + MAX_MINUTES * 60 if MAX_MINUTES else None
    after = ""; seen = sealed = mismatch = unanswered = 0
    with ThreadPoolExecutor(WORKERS) as ex:
        while not deadline or time.time() < deadline:
            page = rpc(base, key, "flowty_index_dapper_unverified_page", {"p_after_doc": after, "p_limit": 500})   # a cold 2000-row page took 27 s of the 30 s service_role timeout
            if not page: break
            after = page[-1]["doc_id"]
            mine = [r for r in page if int(hashlib.md5(r["doc_id"].encode()).hexdigest(), 16) % of == shard]
            out = []
            for row, res in zip(mine, ex.map(lambda r: get_result(r["tx"], r["ts"], lim), mine)):
                if res is None: unanswered += 1; continue
                ok, detail = verdict(row, res)
                if res.get("_node"): detail["node"] = res["_node"]
                out.append({"doc_id": row["doc_id"], "ok": ok, "detail": detail})
                sealed += ok; mismatch += (not ok)
            seen += len(mine)
            if out:
                n = rpc(base, key, "ingest_dapper_tx_verdicts", {"p_rows": out})
                if n > len(out): sys.exit(f"RPC wrote {n} verdicts for {len(out)} rows")
            print(f"shard {shard}/{of}: {seen} rows, {sealed} sealed, {mismatch} mismatch, {unanswered} unanswered, {seen / (time.time() - t0):.1f} rows/s", flush=True)
    print(f"DONE shard {shard}/{of}: {seen} rows, {sealed} sealed, {mismatch} mismatch, {unanswered} unanswered")


if __name__ == "__main__":
    main()
