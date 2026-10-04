#!/usr/bin/env python3
"""Verify Flowty's index rows of the mainnet24 era (2023-11-08 .. 2024-09-04) against their OWN
transactions on the mainnet24 history node, and write the verdicts through the service-role-only
RPC public.ingest_flowty_tx_verdicts (migration 20261004031134).

A row is 'chain_sealed' only if /v1/transaction_results/{tx} is Sealed with no error AND carries an
A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted event with purchased=true, the row's listing
id, and the same nftID, salePrice, buyer, storefrontAddress (seller) and vault. Anything else is
'chain_mismatch' with the reason. 429 / 5xx / timeouts are retried (a free retry, not a verdict); a
row that never gets an answer gets NO verdict and stays for the next run.
Rows are sharded by md5(doc_id) so N jobs split the work without overlap.
Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RPS (default 5), WORKERS (default 16),
     MAX_MINUTES (default 0 = none).
Usage: chain_verify_tx_gha.py <shard> <of>
"""
import base64, hashlib, json, os, sys, threading, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

NODE = "http://access-001.mainnet24.nodes.onflow.org:8070"
EVENT = "A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted"
RPS = float(os.environ.get("RPS", "5"))
WORKERS = int(os.environ.get("WORKERS", "16"))
MAX_MINUTES = float(os.environ.get("MAX_MINUTES", "0"))


class Limiter:
    def __init__(self, rps):
        self.gap, self.next, self.lock = 1.0 / rps, time.monotonic(), threading.Lock()

    def wait(self):
        with self.lock:
            now = time.monotonic(); t = max(now, self.next); self.next = t + self.gap
        time.sleep(max(0, t - now))


def cdc(v):
    if v is None: return None
    if v.get("type") == "Optional":
        return cdc(v.get("value")) if v.get("value") is not None else None
    x = v.get("value")
    return x if not isinstance(x, dict) else cdc(x)


def num(x):
    try: return float(x)
    except (TypeError, ValueError): return None


def verdict(row, res):
    """(ok, detail) for one index row given its transaction result body."""
    d = {"block_id": res.get("block_id"), "status": res.get("status")}
    if res.get("status") != "Sealed": return False, {**d, "reason": "not_sealed"}
    if res.get("error_message"): return False, {**d, "reason": "tx_error"}
    for e in res.get("events") or []:
        if e.get("type") != EVENT: continue
        f = {x["name"]: cdc(x["value"]) for x in json.loads(base64.b64decode(e["payload"]))["value"]["fields"]}
        if str(f.get("listingResourceID")) != str(row["listing"]): continue
        d["event_index"] = int(e.get("event_index", -1))
        diffs = []
        if f.get("purchased") is not True: diffs.append("purchased")
        if str(f.get("nftID")) != str(row["nft_id"]): diffs.append("nft_id")
        if num(f.get("salePrice")) is None or row["price"] is None or abs(num(f.get("salePrice")) - float(row["price"])) > 1e-8: diffs.append("price")
        if (f.get("buyer") or "").lower() != (row["buyer"] or ""): diffs.append("buyer")
        if (f.get("storefrontAddress") or "").lower() != (row["seller"] or ""): diffs.append("seller")
        if f.get("salePaymentVaultType") != row["vault"]: diffs.append("vault")
        return (not diffs), ({**d, "mismatch": diffs} if diffs else d)
    return False, {**d, "reason": "no_listing_completed_for_listing"}


def get_result(tx, lim):
    for k in range(10):
        lim.wait()
        try:
            with urllib.request.urlopen(f"{NODE}/v1/transaction_results/{tx}", timeout=60) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 404: return {"status": "NotFound"}
            if e.code not in (429, 500, 502, 503, 504): return None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            pass
        time.sleep(min(60, 2 ** k))
    return None


def rpc(base, key, fn, args):
    req = urllib.request.Request(base + fn, data=json.dumps(args).encode(), headers={
        "apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    for k in range(7):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code < 500 and e.code != 429: sys.exit(f"RPC {fn} HTTP {e.code}: {e.read()[:300]!r}")
        except (urllib.error.URLError, TimeoutError, OSError):
            pass
        time.sleep(2 ** k)
    sys.exit(f"RPC {fn} unreachable after retries")


def main():
    shard, of = int(sys.argv[1]), int(sys.argv[2])
    base = os.environ["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/") + "/rest/v1/rpc/"
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    lim = Limiter(RPS); t0 = time.time(); deadline = t0 + MAX_MINUTES * 60 if MAX_MINUTES else None
    after = ""; seen = sealed = mismatch = unanswered = 0
    with ThreadPoolExecutor(WORKERS) as ex:
        while not deadline or time.time() < deadline:
            page = rpc(base, key, "flowty_index_unverified_page", {"p_after_doc": after, "p_limit": 5000})
            if not page: break
            after = page[-1]["doc_id"]
            mine = [r for r in page if int(hashlib.md5(r["doc_id"].encode()).hexdigest(), 16) % of == shard]
            out = []
            for row, res in zip(mine, ex.map(lambda r: get_result(r["tx"], lim), mine)):
                if res is None: unanswered += 1; continue
                ok, detail = verdict(row, res)
                out.append({"doc_id": row["doc_id"], "ok": ok, "detail": detail})
                sealed += ok; mismatch += (not ok)
            seen += len(mine)
            if out:
                n = rpc(base, key, "ingest_flowty_tx_verdicts", {"p_rows": out})
                if n > len(out): sys.exit(f"RPC wrote {n} verdicts for {len(out)} rows")
            print(f"shard {shard}/{of}: {seen} rows, {sealed} sealed, {mismatch} mismatch, {unanswered} unanswered, {seen / (time.time() - t0):.1f} rows/s", flush=True)
    print(f"DONE shard {shard}/{of}: {seen} rows, {sealed} sealed, {mismatch} mismatch, {unanswered} unanswered")


if __name__ == "__main__":
    main()
