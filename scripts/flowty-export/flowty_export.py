#!/usr/bin/env python3
"""Export a wallet's complete Flowty history (loans, rentals, trades, listings, offers) as CSVs.

Source: Flowty's own event index. Flowty's web client read it from Firestore project
`flowty-prod`; its security rules still allow public reads of the event collections. Every
event carries the transaction hash and block time, back to Flowty's launch (2022).

Usage:
  FLOWTY_FIREBASE_KEY=<web api key> python3 flowty_export.py OUT_DIR 0xWALLET [0xWALLET ...]
      [--verify]   re-read post-2023-11-08 trade txs on Flow's history nodes (needs a network
                   that can reach access-001.mainnetNN.nodes.onflow.org:8070)
      [--names]    fill NFT titles/serials from api2.flowty.io/nft (1 request per NFT)

The key is the public Firebase web API key in Flowty's archived web bundle (main.*.js,
`apiKey:` next to `projectId:"flowty-prod"`). Standard library only. Times are written in
America/Los_Angeles. Background + controls: docs/reference/apis-and-cadence.md
("Flowty's own event index").
"""
import csv, json, os, sys, time, datetime, urllib.request, urllib.error, zoneinfo, collections

BASE = "https://firestore.googleapis.com/v1/projects/flowty-prod/databases/(default)/documents"
PT = zoneinfo.ZoneInfo("America/Los_Angeles")
FLOOR = "2023-11-08T16:07:03"   # mainnet24 root (block 65,264,619): older Flow history nodes are offline
# (collection, field) pairs whose value is a wallet address; an IN filter needs no composite index.
QUERIES = [
    ("storefrontEvents", "data.buyer"), ("storefrontEvents", "data.storefrontAddress"),
    ("storefrontEvents", "data.flowtyStorefrontAddress"), ("storefrontEvents", "accountAddress"),
    ("storefrontEvents", "data.taker"), ("storefrontEvents", "data.payer"),
    ("p2pEvents", "accountAddress"), ("p2pEvents", "data.lender"), ("p2pEvents", "data.borrower"),
    ("p2pEvents", "data.flowtyStorefrontAddress"),
    ("rentalEvents", "accountAddress"), ("rentalEvents", "data.flowtyStorefrontAddress"),
    ("rentalEvents", "data.renterAddress"),
    ("events", "data.lender"), ("events", "data.renter"),          # RENTAL_SETTLED lives only here
    ("rentalAvailable", "flowtyStorefrontAddress"),
]
SPORKS = [("2024-09-04T12:02:35", "http://access-001.mainnet24.nodes.onflow.org:8070"),
          ("2024-09-25T15:18:48", "http://access-001.mainnet25.nodes.onflow.org:8070"),
          ("2025-10-22T13:02:09", "http://access-001.mainnet26.nodes.onflow.org:8070"),
          ("2025-12-27T13:22:17", "http://access-001.mainnet27.nodes.onflow.org:8070"),
          ("9999", "https://rest-mainnet.onflow.org")]
SLUG = {"TopShot": "nba_top_shot", "AllDay": "nfl_all_day", "Golazos": "laliga_golazos",
        "UFC_NFT": "ufc_strike", "Pinnacle": "disney_pinnacle"}
TOKENS = {"FiatToken": "USDC", "USDCFlow": "USDC (USDCFlow)", "FlowToken": "FLOW", "DUC": "DUC (Dapper USD)",
          "DapperUtilityCoin": "DUC (Dapper USD)", "FlowUtilityToken": "FUT (Dapper FLOW)", "FUT": "FUT (Dapper FLOW)"}


def key_headers(key):
    # The web API key goes in a HEADER, never the query string: request logs
    # record full URLs (repo guard no-env-secret-in-fetch-url, 2026-10-03).
    return {"x-goog-api-key": key}


def http(url, body=None, headers=None, tries=6):
    data = json.dumps(body).encode() if body is not None else None
    h = {"Content-Type": "application/json", **(headers or {})}
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=h), timeout=120) as r:
                return r.status, json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503) and i < tries - 1:
                time.sleep(2 ** i); continue
            return e.code, None
        except (urllib.error.URLError, TimeoutError):
            if i < tries - 1: time.sleep(2 ** i); continue
            raise
    return None, None


def val(v):
    """Flatten a Firestore typed value."""
    if not isinstance(v, dict): return v
    for k in ("stringValue", "integerValue", "doubleValue", "booleanValue", "timestampValue"):
        if k in v: return v[k]
    if "mapValue" in v: return {k: val(x) for k, x in v["mapValue"].get("fields", {}).items()}
    if "arrayValue" in v: return [val(x) for x in v["arrayValue"].get("values", [])]
    return None


def pull(key, wallets):
    """Every document matching any QUERY, de-duplicated by document name. Asserts each query's
    page walk returned exactly its server-side count."""
    docs = {}
    inlist = {"arrayValue": {"values": [{"stringValue": w} for w in wallets]}}
    for coll, field in QUERIES:
        where = {"fieldFilter": {"field": {"fieldPath": field}, "op": "IN", "value": inlist}}
        st, agg = http(f"{BASE}:runAggregationQuery", {"structuredAggregationQuery": {
            "aggregations": [{"alias": "n", "count": {}}],
            "structuredQuery": {"from": [{"collectionId": coll}], "where": where}}}, headers=key_headers(key))
        if st != 200: sys.exit(f"count failed {coll}/{field}: HTTP {st}")
        want = int(agg[0]["result"]["aggregateFields"]["n"]["integerValue"])
        got, cursor = 0, None
        while got < want:
            q = {"from": [{"collectionId": coll}], "where": where, "limit": 300,
                 "orderBy": [{"field": {"fieldPath": "__name__"}, "direction": "ASCENDING"}]}
            if cursor: q["startAt"] = {"values": [{"referenceValue": cursor}], "before": False}
            st, page = http(f"{BASE}:runQuery", {"structuredQuery": q}, headers=key_headers(key))
            if st != 200: sys.exit(f"page failed {coll}/{field}: HTTP {st}")
            rows = [p["document"] for p in page if "document" in p]
            if not rows: break
            for d in rows:
                docs.setdefault(d["name"], {"coll": coll, "f": {k: val(v) for k, v in d["fields"].items()}})
            got += len(rows); cursor = rows[-1]["name"]
        if got != want: sys.exit(f"{coll}/{field}: walked {got}, server count {want} - refusing a partial export")
        print(f"  {coll:17s} {field:30s} {want:6d}", file=sys.stderr)
    return docs


def ts(f):
    t = f.get("blockTimestamp")
    if isinstance(t, (int, float)) or (isinstance(t, str) and t.isdigit()):
        return datetime.datetime.fromtimestamp(int(t) / 1000, datetime.timezone.utc).isoformat()
    return t or ""


def pt(t):
    if not t: return ""
    return datetime.datetime.fromisoformat(t.replace("Z", "+00:00")).astimezone(PT).strftime("%Y-%m-%d %H:%M:%S")


def tok(v):
    if not v: return ""
    p = str(v).split("{")[0].split(".")
    n = p[2] if len(p) >= 3 else p[0]
    return TOKENS.get(n, n)


def coll_of(t):
    p = (t or "").split("{")[0].split(".")
    return SLUG.get(p[2], p[2]) if len(p) >= 3 else (t or "")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) < 2: sys.exit(__doc__)
    key = os.environ.get("FLOWTY_FIREBASE_KEY") or sys.exit("set FLOWTY_FIREBASE_KEY (see docstring)")
    out, wallets = args[0], [w.lower() for w in args[1:]]
    W = set(wallets)
    os.makedirs(out, exist_ok=True)
    print(f"pulling Flowty's index for {len(W)} wallet(s)", file=sys.stderr)
    raw = pull(key, wallets)
    ev = []
    for name, d in raw.items():
        f = d["f"]; data = f.get("data") if isinstance(f.get("data"), dict) else {}
        ev.append({"id": name.split("/")[-1], "coll": d["coll"], "typ": f.get("type") or "", "ts": ts(f) or f.get("updatedAt") or "",
                   "tx": f.get("transactionId") or data.get("transactionId") or "", "chain": f.get("blockchainType") or "",
                   "tok": f.get("paymentTokenType") or f.get("paymentTokenName") or "",
                   "d": {k: v for k, v in (data or {k: v for k, v in f.items() if not isinstance(v, (dict, list))}).items()
                         if k not in ("card", "valuations", "derivations", "filterGroup")}})
    # 'events' mirrors the typed collections under the same document ids: keep the typed copy
    typed = {e["id"] for e in ev if e["coll"] != "events"}
    ev = [e for e in ev if e["coll"] != "events" or e["id"] not in typed]

    names = {}
    if "--names" in sys.argv:
        want = {(e["d"].get("nftType", "").split("{")[0], str(e["d"].get("nftID"))) for e in ev if e["d"].get("nftType") and e["d"].get("nftID")}
        print(f"fetching {len(want)} NFT titles from api2.flowty.io", file=sys.stderr)
        for t, i in want:
            p = t.split(".")
            if len(p) < 3: continue
            st, j = http(f"https://api2.flowty.io/nft/0x{p[1]}/{p[2]}/{i}", headers={"Origin": "https://www.flowty.io"}, tries=3)
            if st == 200 and j:
                traits = {x.get("name"): x.get("value") for x in ((j.get("nftView") or {}).get("traits") or {}).get("traits") or []}
                names[(t, i)] = [(j.get("card") or {}).get("title") or "", traits.get("SetName", ""), traits.get("Tier", ""),
                                 (j.get("nftView") or {}).get("serial") or (j.get("card") or {}).get("num") or ""]
            time.sleep(0.15)

    def nm(d):
        return names.get(((d.get("nftType") or "").split("{")[0], str(d.get("nftID"))), ["", "", "", ""])

    chain_ok = {}
    if "--verify" in sys.argv:
        txs = {e["tx"]: e["ts"] for e in ev if e["typ"] in ("STOREFRONT_PURCHASED", "STOREFRONT_OFFER_ACCEPTED") and e["ts"] >= FLOOR and e["tx"]}
        print(f"verifying {len(txs)} trade txs on chain", file=sys.stderr)
        for tx, t in txs.items():
            node = next(n for end, n in SPORKS if t < end)
            st, j = http(f"{node}/v1/transaction_results/{tx}", tries=4)
            chain_ok[tx] = bool(st == 200 and j and j.get("status") == "Sealed" and not j.get("error_message"))
            time.sleep(0.1)

    def verif(e):
        if e["ts"] < FLOOR: return "flowty_record_only (before 2023-11-08: Flow history nodes offline)"
        if e["tx"] in chain_ok: return "on_chain (sealed)" if chain_ok[e["tx"]] else "NOT_FOUND_ON_CHAIN"
        return "flowty_record (not re-checked; run with --verify)"

    def wr(fn, header, rows, note):
        with open(os.path.join(out, fn), "w", newline="") as fh:
            fh.write(f"# {note} Times Pacific. Source: Flowty's own event index (Firestore flowty-prod).\n")
            w = csv.writer(fh); w.writerow(header); w.writerows(sorted(rows, key=lambda r: str(r[0])))
        print(f"{fn}: {len(rows)} rows", file=sys.stderr)

    by = collections.defaultdict(dict)
    for e in ev:
        d = e["d"]
        for k in ("listingResourceID", "fundingResourceID", "offerResourceID", "offerId"):
            if d.get(k): by[(e["typ"], k)][str(d[k])] = e

    # trades
    resolved = {str(e["d"].get("offerResourceID") or e["d"].get("offerId")) for e in ev
                if e["typ"] == "STOREFRONT_OFFER_CREATED" and e["d"].get("resolverKind") == "FlowtyNFT"}
    trades = []
    for e in ev:
        d = e["d"]
        if e["typ"] == "STOREFRONT_PURCHASED":
            if d.get("buyer") in W: side, mine, cp = "BUY", d["buyer"], d.get("storefrontAddress")
            elif d.get("storefrontAddress") in W: side, mine, cp = "SELL", d["storefrontAddress"], d.get("buyer")
            else: continue
            method = "listing (Flowty storefront)" if "3cdbb3d569211ff3" in e["chain"] else "listing (Dapper storefront)"
            price, tk, comm, rid = d.get("salePrice"), tok(d.get("salePaymentVaultType")), d.get("commissionAmount"), d.get("listingResourceID")
        elif e["typ"] == "STOREFRONT_OFFER_ACCEPTED":
            maker = d.get("payer") or d.get("offerAddress")
            if maker in W: side, mine, cp = "BUY", maker, d.get("taker")
            elif d.get("taker") in W: side, mine, cp = "SELL", d["taker"], maker
            else: continue
            rid = d.get("offerResourceID") or d.get("offerId")
            method = "offer (Flowty Offers)" if "3c1c4b041ad18279" in e["chain"] else (
                "offer (Dapper OffersV2, made on Flowty)" if str(rid) in resolved else "offer (Dapper OffersV2, origin not recorded)")
            price, tk, comm = d.get("offeredAmount") or d.get("amount"), tok(d.get("paymentTokenType") or d.get("paymentTokenName")), ""
        else: continue
        n = nm(d)
        trades.append([pt(e["ts"]), side, method, coll_of(d.get("nftType")), *n, d.get("nftID"), price, tk, comm, cp, mine, rid, e["tx"], verif(e)])
    wr("flowty_trades.csv", ["date_pt", "side", "method", "collection", "title", "set", "tier", "serial", "nft_id", "price", "token",
       "flowty_commission", "counterparty", "your_wallet", "listing_or_offer_id", "tx_hash", "verification"], trades,
       "Every Flowty storefront purchase/sale and accepted offer on these wallets.")

    # loans
    loans = []
    for e in ev:
        d = e["d"]
        if e["coll"] != "p2pEvents" or e["typ"] != "FUNDED": continue
        fid = str(d.get("fundingResourceID"))
        end = by[("REPAID", "fundingResourceID")].get(fid) or by[("SETTLED", "fundingResourceID")].get(fid)
        lender = d.get("lender") in W
        out_ = "NO END EVENT IN FLOWTY INDEX (check the chain)" if not end else "REPAID" if end["typ"] == "REPAID" else (
            "DEFAULTED - collateral went to you" if lender else "DEFAULTED - your collateral went to the lender")
        lst = by[("LISTED", "listingResourceID")].get(str(d.get("listingResourceID")))
        n = nm(d)
        loans.append([pt(e["ts"]), "LENDER" if lender else "BORROWER", out_, pt(end["ts"]) if end else "", coll_of(d.get("nftType")), *n,
                      d.get("nftID"), (lst or {}).get("d", {}).get("amount", ""), d.get("repaymentAmount"), tok(e["tok"]),
                      d.get("lender"), d.get("borrower"), fid, d.get("listingResourceID"), e["tx"], end["tx"] if end else "", verif(e)])
    wr("flowty_loans.csv", ["funded_at_pt", "your_role", "outcome", "ended_at_pt", "collection", "title", "set", "tier", "serial", "nft_id",
       "principal_if_your_listing", "repayment_amount", "token", "lender", "borrower", "funding_resource_id", "listing_resource_id",
       "funding_tx", "end_tx", "verification"], loans, "Every Flowty loan these wallets funded or took.")

    # rentals
    rentals = []
    for e in ev:
        d = e["d"]
        if e["coll"] != "rentalEvents" or e["typ"] != "RENTAL_RENTED": continue
        lid = str(d.get("listingResourceID"))
        end = by[("RENTAL_RETURNED", "listingResourceID")].get(lid) or by[("RENTAL_SETTLED", "listingResourceID")].get(lid)
        out_ = ("RETURNED" if end["typ"] == "RENTAL_RETURNED" else "SETTLED - renter kept the NFT, owner kept the deposit") if end else "NO END EVENT IN FLOWTY INDEX"
        n = nm(d)
        rentals.append([pt(e["ts"]), "OWNER" if d.get("flowtyStorefrontAddress") in W else "RENTER", out_, pt(end["ts"]) if end else "",
                        coll_of(d.get("nftType")), *n, d.get("nftID"), d.get("amount"), d.get("deposit"), d.get("flowtyStorefrontAddress"),
                        d.get("renterAddress"), lid, e["tx"], end["tx"] if end else "", verif(e)])
    wr("flowty_rentals.csv", ["rented_at_pt", "your_role", "outcome", "ended_at_pt", "collection", "title", "set", "tier", "serial", "nft_id",
       "rental_fee", "deposit", "owner", "renter", "listing_resource_id", "rent_tx", "end_tx", "verification"], rentals,
       "Every Flowty rental on these wallets (fee/deposit token: see the matching RENTAL_LISTED row in flowty_all_events.csv).")

    # offers made
    offers = []
    for e in ev:
        d = e["d"]
        if e["typ"] != "STOREFRONT_OFFER_CREATED" or (d.get("payer") or d.get("offerAddress") or d.get("storefrontAddress")) not in W: continue
        oid = str(d.get("offerResourceID") or d.get("offerId"))
        a = by[("STOREFRONT_OFFER_ACCEPTED", "offerResourceID")].get(oid) or by[("STOREFRONT_OFFER_ACCEPTED", "offerId")].get(oid)
        c = by[("STOREFRONT_OFFER_CANCELLED", "offerResourceID")].get(oid) or by[("STOREFRONT_OFFER_CANCELLED", "offerId")].get(oid)
        fin = a or c
        offers.append([pt(e["ts"]), "ACCEPTED" if a else "CANCELLED" if c else "NO FURTHER EVENT", pt(fin["ts"]) if fin else "",
                       coll_of(d.get("nftType") or (a or {}).get("d", {}).get("nftType")), d.get("nftID") or (a or {}).get("d", {}).get("nftID", ""),
                       d.get("offeredAmount") or d.get("amount"), tok(d.get("paymentTokenType") or d.get("paymentTokenName")),
                       (a or {}).get("d", {}).get("taker", ""), oid, e["tx"], fin["tx"] if fin else ""])
    wr("flowty_offers.csv", ["offered_at_pt", "outcome", "ended_at_pt", "collection", "nft_id", "offer_amount", "token", "accepted_by",
       "offer_id", "offer_tx", "end_tx"], offers, "Every offer these wallets made on Flowty.")

    wr("flowty_all_events.csv", ["time_pt", "collection", "event", "nft_id", "fields_json", "tx_hash", "chain_event_type", "flowty_doc_id"],
       [[pt(e["ts"]), e["coll"], e["typ"], e["d"].get("nftID", ""), json.dumps(e["d"], sort_keys=True, default=str), e["tx"], e["chain"], e["id"]] for e in ev],
       "RAW: every Flowty event record touching these wallets.")


if __name__ == "__main__":
    main()
