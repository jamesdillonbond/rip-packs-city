# Offline test: stubs HTTP, checks --verify / --names classification and the partial-walk refusal.
# Run: python3 scripts/flowty-export/test_flowty_export.py
import sys, json, importlib.util, os, csv, tempfile
spec=importlib.util.spec_from_file_location("fx",__import__("os").path.join(__import__("os").path.dirname(__file__), "flowty_export.py")); fx=importlib.util.module_from_spec(spec); spec.loader.exec_module(fx)
W="0x00000000000000aa"
def doc(name, f): return {"document":{"name":f"projects/p/databases/(default)/documents/storefrontEvents/{name}","fields":{k:{"stringValue":v} for k,v in f.items()}}}
buy=doc("1_STOREFRONT_PURCHASED",{"type":"STOREFRONT_PURCHASED","transactionId":"t_sealed","blockTimestamp":"2025-01-01T00:00:00Z","blockchainType":"A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted"})
buy["document"]["fields"]["data"]={"mapValue":{"fields":{"buyer":{"stringValue":W},"nftType":{"stringValue":"A.0b2a3299cc857e29.TopShot.NFT"},"nftID":{"stringValue":"7"},"salePrice":{"stringValue":"1"},"listingResourceID":{"stringValue":"1"}}}}
buy2=json.loads(json.dumps(buy).replace("1_STOREFRONT","2_STOREFRONT").replace("t_sealed","t_pending").replace('"listingResourceID": {"stringValue": "1"}','"listingResourceID": {"stringValue": "2"}'))
buy3=json.loads(json.dumps(buy).replace("1_STOREFRONT","3_STOREFRONT").replace("t_sealed","t_down").replace('"listingResourceID": {"stringValue": "1"}','"listingResourceID": {"stringValue": "3"}'))
def http(url, body=None, headers=None, tries=6):
    if ":runAggregationQuery" in url:
        n = 3 if body["structuredAggregationQuery"]["structuredQuery"]["where"]["fieldFilter"]["field"]["fieldPath"]=="data.buyer" and "storefrontEvents" in json.dumps(body) else 0
        return 200, [{"result":{"aggregateFields":{"n":{"integerValue":str(n)}}}}]
    if ":runQuery" in url: return 200, [buy,buy2,buy3]
    if "t_sealed" in url: return 200, {"status":"Sealed","error_message":""}
    if "t_pending" in url: return 200, {"status":"","execution":"Pending"}
    if "t_down" in url: return None, None
    if "api2.flowty.io/nft" in url: return 200, {"card":{"title":"Test Player","num":"12"},"nftView":{"serial":"12","traits":{"traits":[{"name":"SetName","value":"Base"},{"name":"Tier","value":"Common"}]}}}
    raise AssertionError(url)
fx.http=http; fx.time.sleep=lambda s: None
out=tempfile.mkdtemp(); os.environ["FLOWTY_FIREBASE_KEY"]="x"
sys.argv=["x", out, W, "--verify", "--names"]; fx.main()
rows=list(csv.DictReader(l for l in open(out+"/flowty_trades.csv") if not l.startswith("#")))
v={r["tx_hash"]:r["verification"] for r in rows}; print(v); print(rows[0]["title"], rows[0]["serial"])
assert v["t_sealed"]=="on_chain (sealed)" and v["t_pending"]=="NOT_FOUND_ON_CHAIN" and v["t_down"].startswith("flowty_record (not re-checked")
assert rows[0]["title"]=="Test Player"
# partial-walk refusal: count says 4, pages return 3
def http2(url, body=None, headers=None, tries=6):
    if ":runAggregationQuery" in url: return 200, [{"result":{"aggregateFields":{"n":{"integerValue":"4"}}}}]
    if ":runQuery" in url:
        return 200, ([buy,buy2,buy3] if "startAt" not in body["structuredQuery"] else [])
fx.http=http2
try: fx.main(); print("NO REFUSAL"); sys.exit(1)
except SystemExit as e: print("refused:", e)
