#!/usr/bin/env python3
"""Walk Flowty's NFTStorefrontV2 ListingCompleted events on a Flow history node over a block
range, in 250-block windows (the node maximum), and land them through the service-role-only
RPC public.ingest_flowty_chain_walk(p_events, p_windows) — events and the windows that
produced them in ONE statement, so coverage is never recorded without its rows.

A window counts only on HTTP 200 with a JSON array body; 429 / 5xx / timeouts are retried with
backoff (a free retry, not a failed read). A window that never answers fails the run, and the
windows it did not cover stay absent from flowty_archive.flowty_chain_walk_coverage.
Rate: RPS requests/second per process (default 6; the nodes throttle per-second bursts —
docs/reference/apis-and-cadence.md), WORKERS in flight (default 12).
Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
Usage: chain_walk_gha.py <node: mainnet24..27> <start_height> <end_height>
"""
import base64, json, os, sys, threading, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

EVENT = "A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted"
RPS = float(os.environ.get("RPS", "6"))
WORKERS = int(os.environ.get("WORKERS", "12"))
POST_EVERY = 40


class Limiter:
    def __init__(self, rps):
        self.gap, self.next, self.lock = 1.0 / rps, time.monotonic(), threading.Lock()

    def wait(self):
        with self.lock:
            now = time.monotonic(); t = max(now, self.next); self.next = t + self.gap
        time.sleep(max(0, t - now))


def cdc(v):
    """JSON-CDC value -> python scalar (Optional unwrapped, Address/UInt/UFix as strings)."""
    if v is None: return None
    if v.get("type") == "Optional":
        return cdc(v.get("value")) if v.get("value") is not None else None
    x = v.get("value")
    return x if not isinstance(x, dict) else cdc(x)


def parse(body):
    out = []; n_all = 0
    for blk in body:
        for e in blk.get("events") or []:
            n_all += 1
            p = json.loads(base64.b64decode(e["payload"]))
            f = {x["name"]: cdc(x["value"]) for x in p["value"]["fields"]}
            if f.get("purchased") is not True: continue
            out.append({"tx_hash": e["transaction_id"], "event_index": int(e["event_index"]),
                        "block_height": int(blk["block_height"]), "block_ts": blk["block_timestamp"],
                        "listing_resource_id": f.get("listingResourceID"), "storefront_resource_id": f.get("storefrontResourceID"),
                        "seller": f.get("storefrontAddress"), "buyer": f.get("buyer"), "nft_type": f.get("nftType"),
                        "nft_id": f.get("nftID"), "nft_uuid": f.get("nftUUID"), "price": f.get("salePrice"),
                        "payment_vault": f.get("salePaymentVaultType"), "commission_amount": f.get("commissionAmount"),
                        "commission_receiver": f.get("commissionReceiver"), "custom_id": f.get("customID"),
                        "expiry": f.get("expiry")})
    return n_all, out


def get_window(node, a, b, lim):
    url = f"http://access-001.{node}.nodes.onflow.org:8070/v1/events?type={EVENT}&start_height={a}&end_height={b}"
    for k in range(10):
        lim.wait()
        try:
            with urllib.request.urlopen(url, timeout=90) as r:
                body = json.loads(r.read())
            if isinstance(body, list): return body
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503, 504): raise RuntimeError(f"HTTP {e.code} on {a}-{b}: {e.read()[:200]!r}")
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            pass
        time.sleep(min(60, 2 ** k))
    raise RuntimeError(f"window {a}-{b} never answered")


def post(base, key, events, windows):
    body = json.dumps({"p_events": events, "p_windows": windows}).encode()
    req = urllib.request.Request(base + "ingest_flowty_chain_walk", data=body, headers={
        "apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    for k in range(7):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                res = json.loads(r.read())
            if res.get("windows") != len(windows): sys.exit(f"RPC recorded {res.get('windows')} of {len(windows)} windows")
            return res
        except urllib.error.HTTPError as e:
            if e.code < 500 and e.code != 429: sys.exit(f"RPC HTTP {e.code}: {e.read()[:300]!r}")
        except (urllib.error.URLError, TimeoutError, OSError):
            pass
        time.sleep(2 ** k)
    sys.exit("RPC unreachable after retries")


def main():
    node, start, end = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    base = os.environ["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/") + "/rest/v1/rpc/"
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    wins = [(a, min(a + 249, end)) for a in range(start, end + 1, 250)]
    lim = Limiter(RPS); t0 = time.time()
    pend_ev, pend_win = [], []; tot_ev = tot_win = tot_new = 0; lock = threading.Lock()

    def one(w):
        body = get_window(node, w[0], w[1], lim)
        n_all, ev = parse(body)
        return w, n_all, ev

    with ThreadPoolExecutor(WORKERS) as ex:
        for w, n_all, ev in ex.map(one, wins):
            pend_ev.extend(ev); pend_win.append({"win_start": w[0], "win_end": w[1], "n_events": n_all, "n_purchased": len(ev)})
            if len(pend_win) >= POST_EVERY:
                res = post(base, key, pend_ev, pend_win)
                tot_win += len(pend_win); tot_ev += len(pend_ev); tot_new += res["events"]; pend_ev, pend_win = [], []
                if tot_win % 2000 == 0:
                    print(f"{node} {tot_win}/{len(wins)} windows, {tot_ev} purchases ({tot_new} new) {tot_win / (time.time() - t0):.1f} win/s", flush=True)
    if pend_win:
        res = post(base, key, pend_ev, pend_win)
        tot_win += len(pend_win); tot_ev += len(pend_ev); tot_new += res["events"]
    print(f"DONE {node} {start}-{end}: {tot_win}/{len(wins)} windows, {tot_ev} purchases ({tot_new} new)")
    if tot_win != len(wins): sys.exit("incomplete")


if __name__ == "__main__":
    main()
