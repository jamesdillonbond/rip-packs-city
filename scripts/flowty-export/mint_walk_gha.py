#!/usr/bin/env python3
"""Walk Top Shot / All Day MINT events on a Flow history node over a block range (250-block
windows) and land the moment -> edition/serial records in public.checkpoint_nft_meta (spork code
128 = mainnet28 mint events) through public.ingest_mint_walk, with per-stream coverage written in
the same statement (migration 20261004034824). For NFTs minted after the newest checkpoint.
Streams (event signatures read from the deployed contracts, 2026-10-03):
  ts_minted      A.0b2a3299cc857e29.TopShot.MomentMinted(momentID, playID, setID, serialNumber, subeditionID)
  ts_subedition  A.0b2a3299cc857e29.TopShot.SubeditionAddedToMoment(momentID, subeditionID, setID, playID)
  ad_minted      A.e4cf4bdc1751c65d.AllDay.MomentNFTMinted(id, editionID, serialNumber)
Resumable (skips covered windows); a window that never answers fails the run.
Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RPS, WORKERS, MAX_MINUTES.
Usage: mint_walk_gha.py <stream> <node> <start_height> <end_height>
"""
import base64, json, os, sys, time
from concurrent.futures import ThreadPoolExecutor
import chain_walk_gha as W

EVENTS = {"ts_minted": "A.0b2a3299cc857e29.TopShot.MomentMinted",
          "ts_subedition": "A.0b2a3299cc857e29.TopShot.SubeditionAddedToMoment",
          "ad_minted": "A.e4cf4bdc1751c65d.AllDay.MomentNFTMinted"}


def records(stream, body):
    """(n_events, [checkpoint_nft_meta-shaped records]) for one window's response."""
    out = {}; n = 0
    for blk in body:
        for e in blk.get("events") or []:
            n += 1
            f = {x["name"]: W.cdc(x["value"]) for x in json.loads(base64.b64decode(e["payload"]))["value"]["fields"]}
            if stream == "ts_minted":
                i = int(f["momentID"])
                out[("ts", i)] = {"c": "ts", "id": i, "set": int(f["setID"]), "play": int(f["playID"]), "serial": int(f["serialNumber"])}
                if int(f.get("subeditionID") or 0) > 0:
                    out[("tssub", i)] = {"c": "tssub", "id": i, "sub": int(f["subeditionID"])}
            elif stream == "ts_subedition":
                i = int(f["momentID"])
                if int(f.get("subeditionID") or 0) > 0:
                    out[("tssub", i)] = {"c": "tssub", "id": i, "sub": int(f["subeditionID"])}
            else:
                i = int(f["id"])
                out[("ad", i)] = {"c": "ad", "id": i, "ed": int(f["editionID"]), "serial": int(f["serialNumber"])}
    return n, list(out.values())


def get_window(node, event, a, b, lim):
    W.EVENT = event                      # chain_walk_gha.get_window reads the module-level EVENT
    return W.get_window(node, a, b, lim)


def main():
    stream, node, start, end = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
    event = EVENTS[stream]
    base = os.environ["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/") + "/rest/v1/rpc/"
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    wins = [(a, min(a + 249, end)) for a in range(start, end + 1, 250)]
    done = set(W.rpc(base, key, "mint_walk_covered", {"p_stream": stream, "p_from": start, "p_to": end}) or [])
    todo = [w for w in wins if w[0] not in done]
    print(f"{stream} {node} {start}-{end}: {len(wins)} windows, {len(done)} covered, {len(todo)} to walk", flush=True)
    lim = W.Limiter(W.RPS); t0 = time.time(); deadline = t0 + W.MAX_MINUTES * 60 if W.MAX_MINUTES else None
    pend_meta, pend_win = {}, []; tot_win = tot_rec = 0

    def flush():
        nonlocal pend_meta, pend_win, tot_win, tot_rec
        if not pend_win: return
        res = W.rpc(base, key, "ingest_mint_walk", {"p_meta": list(pend_meta.values()), "p_windows": pend_win, "p_stream": stream})
        if res.get("windows") != len(pend_win) or res.get("meta") != len(pend_meta):
            sys.exit(f"RPC landed {res} for {len(pend_meta)} records / {len(pend_win)} windows")
        tot_win += len(pend_win); tot_rec += len(pend_meta); pend_meta, pend_win = {}, []

    def one(w):
        if deadline and time.time() > deadline: return w, None, None
        return (w,) + records(stream, get_window(node, event, w[0], w[1], lim))

    with ThreadPoolExecutor(W.WORKERS) as ex:
        for w, n, recs in ex.map(one, todo):
            if n is None: continue
            for r in recs: pend_meta[(r["c"], r["id"])] = r
            pend_win.append({"win_start": w[0], "win_end": w[1], "n_events": n})
            if len(pend_win) >= 40: flush()
            if tot_win and tot_win % 2000 == 0: print(f"{stream} {tot_win}/{len(todo)} windows, {tot_rec} records", flush=True)
    flush()
    left = len(todo) - tot_win
    print(f"DONE {stream} {node} {start}-{end}: {tot_win}/{len(todo)} windows, {tot_rec} records; {left} left")
    if left and not deadline: sys.exit("incomplete")


if __name__ == "__main__":
    main()
