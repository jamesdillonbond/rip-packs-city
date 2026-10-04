#!/usr/bin/env python3
"""Offline test for chain_walk_gha.parse on a REAL mainnet26 /v1/events response (blocks
100,000,011 and 100,000,016, read 2026-10-03): one purchased listing, one delisted one.
Run: python3 scripts/flowty-export/test_chain_walk_gha.py"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from chain_walk_gha import parse

P1 = "eyJ2YWx1ZSI6eyJpZCI6IkEuM2NkYmIzZDU2OTIxMWZmMy5ORlRTdG9yZWZyb250VjIuTGlzdGluZ0NvbXBsZXRlZCIsImZpZWxkcyI6W3sidmFsdWUiOnsidmFsdWUiOiI0NjE3OTQ4OTYwMTQ4OCIsInR5cGUiOiJVSW50NjQifSwibmFtZSI6Imxpc3RpbmdSZXNvdXJjZUlEIn0seyJ2YWx1ZSI6eyJ2YWx1ZSI6IjEyMTg4NDQ2NzgiLCJ0eXBlIjoiVUludDY0In0sIm5hbWUiOiJzdG9yZWZyb250UmVzb3VyY2VJRCJ9LHsidmFsdWUiOnsidmFsdWUiOnsidmFsdWUiOiIweGU0ZGI5YzY0MGM2ZTUwYmEiLCJ0eXBlIjoiQWRkcmVzcyJ9LCJ0eXBlIjoiT3B0aW9uYWwifSwibmFtZSI6InN0b3JlZnJvbnRBZGRyZXNzIn0seyJ2YWx1ZSI6eyJ2YWx1ZSI6dHJ1ZSwidHlwZSI6IkJvb2wifSwibmFtZSI6InB1cmNoYXNlZCJ9LHsidmFsdWUiOnsidmFsdWUiOiJBLjBiMmEzMjk5Y2M4NTdlMjkuVG9wU2hvdC5ORlQiLCJ0eXBlIjoiU3RyaW5nIn0sIm5hbWUiOiJuZnRUeXBlIn0seyJ2YWx1ZSI6eyJ2YWx1ZSI6Ijc0NzY2NzkxODQ1MDQ4IiwidHlwZSI6IlVJbnQ2NCJ9LCJuYW1lIjoibmZ0VVVJRCJ9LHsidmFsdWUiOnsidmFsdWUiOiI0NzkwNjIzMiIsInR5cGUiOiJVSW50NjQifSwibmFtZSI6Im5mdElEIn0seyJ2YWx1ZSI6eyJ2YWx1ZSI6IkEuZWFkODkyMDgzYjNlMmM2Yy5EYXBwZXJVdGlsaXR5Q29pbi5WYXVsdCIsInR5cGUiOiJTdHJpbmcifSwibmFtZSI6InNhbGVQYXltZW50VmF1bHRUeXBlIn0seyJ2YWx1ZSI6eyJ2YWx1ZSI6IjAuMjYwMDAwMDAiLCJ0eXBlIjoiVUZpeDY0In0sIm5hbWUiOiJzYWxlUHJpY2UifSx7InZhbHVlIjp7InZhbHVlIjpudWxsLCJ0eXBlIjoiT3B0aW9uYWwifSwibmFtZSI6ImN1c3RvbUlEIn0seyJ2YWx1ZSI6eyJ2YWx1ZSI6IjAuMDA2NTAwMDAiLCJ0eXBlIjoiVUZpeDY0In0sIm5hbWUiOiJjb21taXNzaW9uQW1vdW50In0seyJ2YWx1ZSI6eyJ2YWx1ZSI6eyJ2YWx1ZSI6IjB4M2NkYmIzZDU2OTIxMWZmMyIsInR5cGUiOiJBZGRyZXNzIn0sInR5cGUiOiJPcHRpb25hbCJ9LCJuYW1lIjoiY29tbWlzc2lvblJlY2VpdmVyIn0seyJ2YWx1ZSI6eyJ2YWx1ZSI6IjE3MzkyNTA1NTQiLCJ0eXBlIjoiVUludDY0In0sIm5hbWUiOiJleHBpcnkifSx7InZhbHVlIjp7InZhbHVlIjp7InZhbHVlIjoiMHgwZDc0NGQyMzE2NWJmYjZjIiwidHlwZSI6IkFkZHJlc3MifSwidHlwZSI6Ik9wdGlvbmFsIn0sIm5hbWUiOiJidXllciJ9XX0sInR5cGUiOiJFdmVudCJ9Cg=="
P2 = "eyJ2YWx1ZSI6eyJpZCI6IkEuM2NkYmIzZDU2OTIxMWZmMy5ORlRTdG9yZWZyb250VjIuTGlzdGluZ0NvbXBsZXRlZCIsImZpZWxkcyI6W3sidmFsdWUiOnsidmFsdWUiOiIxNzgxMjA4ODQ5MzQ4MjAiLCJ0eXBlIjoiVUludDY0In0sIm5hbWUiOiJsaXN0aW5nUmVzb3VyY2VJRCJ9LHsidmFsdWUiOnsidmFsdWUiOiIxMjE4ODQ0Njc4IiwidHlwZSI6IlVJbnQ2NCJ9LCJuYW1lIjoic3RvcmVmcm9udFJlc291cmNlSUQifSx7InZhbHVlIjp7InZhbHVlIjpudWxsLCJ0eXBlIjoiT3B0aW9uYWwifSwibmFtZSI6InN0b3JlZnJvbnRBZGRyZXNzIn0seyJ2YWx1ZSI6eyJ2YWx1ZSI6ZmFsc2UsInR5cGUiOiJCb29sIn0sIm5hbWUiOiJwdXJjaGFzZWQifSx7InZhbHVlIjp7InZhbHVlIjoiQS4wYjJhMzI5OWNjODU3ZTI5LlRvcFNob3QuTkZUIiwidHlwZSI6IlN0cmluZyJ9LCJuYW1lIjoibmZ0VHlwZSJ9LHsidmFsdWUiOnsidmFsdWUiOiI1OTM3MzYyOTEyNTMwMCIsInR5cGUiOiJVSW50NjQifSwibmFtZSI6Im5mdFVVSUQifSx7InZhbHVlIjp7InZhbHVlIjoiNDgyNzcxNDIiLCJ0eXBlIjoiVUludDY0In0sIm5hbWUiOiJuZnRJRCJ9LHsidmFsdWUiOnsidmFsdWUiOiJBLmVhZDg5MjA4M2IzZTJjNmMuRGFwcGVyVXRpbGl0eUNvaW4uVmF1bHQiLCJ0eXBlIjoiU3RyaW5nIn0sIm5hbWUiOiJzYWxlUGF5bWVudFZhdWx0VHlwZSJ9LHsidmFsdWUiOnsidmFsdWUiOiI0My42MzAwMDAwMCIsInR5cGUiOiJVRml4NjQifSwibmFtZSI6InNhbGVQcmljZSJ9LHsidmFsdWUiOnsidmFsdWUiOm51bGwsInR5cGUiOiJPcHRpb25hbCJ9LCJuYW1lIjoiY3VzdG9tSUQifSx7InZhbHVlIjp7InZhbHVlIjoiMS4wOTA3NTAwMCIsInR5cGUiOiJVRml4NjQifSwibmFtZSI6ImNvbW1pc3Npb25BbW91bnQifSx7InZhbHVlIjp7InZhbHVlIjpudWxsLCJ0eXBlIjoiT3B0aW9uYWwifSwibmFtZSI6ImNvbW1pc3Npb25SZWNlaXZlciJ9LHsidmFsdWUiOnsidmFsdWUiOiIxNzM5MDQ5NDY1IiwidHlwZSI6IlVJbnQ2NCJ9LCJuYW1lIjoiZXhwaXJ5In0seyJ2YWx1ZSI6eyJ2YWx1ZSI6bnVsbCwidHlwZSI6Ik9wdGlvbmFsIn0sIm5hbWUiOiJidXllciJ9XX0sInR5cGUiOiJFdmVudCJ9Cg=="
BODY = [
    {"block_height": "100000011", "block_timestamp": "2025-01-12T23:06:08.184692711Z", "events": [
        {"type": "A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted", "payload": P1, "event_index": "18",
         "transaction_id": "54bbbb8bb284d17a116a7dbcc9ef1078db536a9c395f2df604663a448af4e075"}]},
    {"block_height": "100000016", "block_timestamp": "2025-01-12T23:06:11.895246621Z", "events": [
        {"type": "A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted", "payload": P2, "event_index": "0",
         "transaction_id": "83fc986d35619d278ad480a73204a827a3f870de70417875ea060dd41b85c386"}]},
    {"block_height": "100000017", "block_timestamp": "2025-01-12T23:06:12Z", "events": []},
]

n_all, ev = parse(BODY)
assert n_all == 2, n_all                         # both events counted toward the window
assert len(ev) == 1, ev                          # the delisting (purchased=false) is NOT a sale
e = ev[0]
assert e["tx_hash"].startswith("54bbbb8b") and e["event_index"] == 18 and e["block_height"] == 100000011
assert e["listing_resource_id"] == "46179489601488" and e["nft_id"] == "47906232"
assert e["seller"] == "0xe4db9c640c6e50ba" and e["buyer"] == "0x0d744d23165bfb6c"   # Optional<Address> unwrapped
assert e["price"] == "0.26000000" and e["payment_vault"].endswith("DapperUtilityCoin.Vault")
assert e["custom_id"] is None and e["commission_receiver"] == "0x3cdbb3d569211ff3"
assert parse([]) == (0, [])                      # an empty window is a real, recordable answer
print("ok")

# ── chain_verify_tx_gha.verdict on the same real event, as a /v1/transaction_results body ──
from chain_verify_tx_gha import verdict
res = {"block_id": "6a4c", "status": "Sealed", "error_message": "",
       "events": [{"type": "A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted", "payload": P1, "event_index": "18"}]}
row = {"listing": "46179489601488", "nft_id": "47906232", "price": 0.26, "buyer": "0x0d744d23165bfb6c",
       "seller": "0xe4db9c640c6e50ba", "vault": "A.ead892083b3e2c6c.DapperUtilityCoin.Vault"}
ok, d = verdict(row, res); assert ok and d["event_index"] == 18, d
ok, d = verdict({**row, "price": 0.27}, res); assert not ok and d["mismatch"] == ["price"], d
ok, d = verdict({**row, "buyer": "0x0000000000000001"}, res); assert not ok and d["mismatch"] == ["buyer"], d
ok, d = verdict(row, {**res, "status": "Pending"}); assert not ok and d["reason"] == "not_sealed", d   # wrong-spork answer
ok, d = verdict({**row, "listing": "1"}, res); assert not ok and d["reason"] == "no_listing_completed_for_listing", d
ok, d = verdict(row, {**res, "error_message": "panic"}); assert not ok and d["reason"] == "tx_error", d
print("verdict ok")

# ── mint_walk_gha.records: JSON-CDC events shaped like the deployed signatures (read 2026-10-03) ──
import base64 as _b64, json as _json
from mint_walk_gha import records
def _ev(eid, fields):
    p = {"value": {"id": eid, "fields": [{"name": k, "value": {"type": t, "value": v}} for k, t, v in fields]}, "type": "Event"}
    return {"type": eid, "payload": _b64.b64encode(_json.dumps(p).encode()).decode()}
TSM = "A.0b2a3299cc857e29.TopShot.MomentMinted"
body = [{"block_height": "140000001", "events": [
    _ev(TSM, [("momentID", "UInt64", "50800001"), ("playID", "UInt32", "9001"), ("setID", "UInt32", "300"), ("serialNumber", "UInt32", "17"), ("subeditionID", "UInt32", "0")]),
    _ev(TSM, [("momentID", "UInt64", "50800002"), ("playID", "UInt32", "9001"), ("setID", "UInt32", "300"), ("serialNumber", "UInt32", "4"), ("subeditionID", "UInt32", "3")])]}]
n, recs = records("ts_minted", body)
assert n == 2 and {"c": "ts", "id": 50800001, "set": 300, "play": 9001, "serial": 17} in recs
assert {"c": "tssub", "id": 50800002, "sub": 3} in recs
assert not any(r["c"] == "tssub" and r["id"] == 50800001 for r in recs)      # subedition 0 = Standard: no tssub row
n, recs = records("ts_subedition", [{"events": [_ev("A.0b2a3299cc857e29.TopShot.SubeditionAddedToMoment",
    [("momentID", "UInt64", "50800001"), ("subeditionID", "UInt32", "5"), ("setID", "UInt32", "300"), ("playID", "UInt32", "9001")])]}])
assert recs == [{"c": "tssub", "id": 50800001, "sub": 5}]
n, recs = records("ad_minted", [{"events": [_ev("A.e4cf4bdc1751c65d.AllDay.MomentNFTMinted",
    [("id", "UInt64", "11000001"), ("editionID", "UInt64", "4500"), ("serialNumber", "UInt64", "88")])]}])
assert recs == [{"c": "ad", "id": 11000001, "ed": 4500, "serial": 88}]
assert records("ad_minted", []) == (0, [])
print("mint records ok")

# A truncated chunked body (http.client.IncompleteRead, not an OSError) is a free retry, not a crash:
# it killed the mainnet26 88.2M job on 2026-10-04 with 963 windows unwalked.
import http.client as _hc, chain_walk_gha as _W, chain_verify_tx_gha as _V
class _R:
    def __init__(self, b): self.b = b
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def read(self): return self.b
def _flaky(body):
    calls = []
    def urlopen(*a, **k):
        calls.append(1)
        if len(calls) == 1: raise _hc.IncompleteRead(b"x" * 10)
        return _R(body)
    return urlopen, calls
class _L:
    def wait(self): pass
_orig_sleep = _W.time.sleep; _W.time.sleep = lambda s: None
try:
    _W.urllib.request.urlopen, c = _flaky(b"[]")
    assert _W.get_window("mainnet26", 1, 250, _L()) == [] and len(c) == 2
    _V.urllib.request.urlopen, c = _flaky(b'{"status": "Sealed"}')
    assert _V.get_result("ab", _L()) == {"status": "Sealed"} and len(c) == 2
finally:
    _W.time.sleep = _orig_sleep
print("incomplete-read retry ok")
