#!/usr/bin/env python3
"""Load ckpt_nftmeta.py JSONL into public.checkpoint_nft_meta via the service-role-only RPC
public.ingest_checkpoint_nft_meta(jsonb). Every batch must report back exactly the rows it
sent (an upsert counts updated rows too), or the run fails — a partial load never passes as
complete. Only NFTs in flowty_archive.checkpoint_nft_meta_wanted are kept (read through
public.checkpoint_nft_meta_wanted_page; Top Shot subedition rows follow the 'ts' set); a
checkpoint holds ~60M NFTs and the archive needs a few million. --all keeps everything.
Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
Usage: ckpt_nftmeta_load.py <spork> <file.jsonl> [batch]
"""
import json, os, sys, time, urllib.request, urllib.error

BATCH = 4000


def post(url, key, rows, arg="p_rows"):
    body = json.dumps({arg: rows} if arg else rows).encode()
    req = urllib.request.Request(url, data=body, headers={
        "apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    for k in range(7):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code < 500 and e.code != 429:
                sys.exit(f"HTTP {e.code}: {e.read()[:300]!r}")
        except (urllib.error.URLError, TimeoutError, OSError):
            pass
        time.sleep(2 ** k)
    sys.exit("RPC unreachable after retries")


def wanted(base, key):
    out = {}
    for c in ("ts", "ad", "gz", "ufc"):
        ids, after = set(), 0
        while True:
            page = post(base + "checkpoint_nft_meta_wanted_page", key, {"p_c": c, "p_after": after, "p_limit": 200000}, arg=None)
            if not page: break
            ids.update(page); after = page[-1]
        out[c] = ids
        print(f"wanted {c}: {len(ids)}", flush=True)
    out["tssub"] = out["ts"]
    return out


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    spork, path = int(args[0]), args[1]
    batch = int(args[2]) if len(args) > 2 else BATCH
    base = os.environ["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/") + "/rest/v1/rpc/"
    url = base + "ingest_checkpoint_nft_meta"
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    want = None if "--all" in sys.argv else wanted(base, key)
    if want is not None and not any(want.values()): sys.exit("wanted set is EMPTY — refusing to load nothing and call it done")
    sent = landed = skipped = 0; buf = {}
    def flush():
        nonlocal sent, landed
        if not buf: return
        rows = list(buf.values()); n = int(post(url, key, rows))
        if n != len(rows): sys.exit(f"batch landed {n} of {len(rows)} — refusing a partial load")
        sent += len(rows); landed += n; buf.clear()
    for line in open(path):
        r = json.loads(line); r["spork"] = spork
        if want is not None and r["id"] not in want.get(r["c"], ()):
            skipped += 1; continue
        buf[(r["c"], r["id"])] = r          # de-dupe inside a batch: ON CONFLICT cannot touch a row twice
        if len(buf) >= batch: flush()
    flush()
    print(f"loaded {landed}/{sent} rows from {path} ({skipped} outside the wanted set)")


if __name__ == "__main__":
    main()
