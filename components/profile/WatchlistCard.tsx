"use client";

import { useState, useEffect, useCallback } from "react";
import { monoFont, condensedFont, labelStyle, btnBase, fmtDollars } from "./_shared";

interface WatchlistItem {
  id: string;
  edition_id: string | null;
  player_name: string | null;
  set_name: string | null;
  tier: string | null;
  target_price: number | null;
  current_fmv: number | null;
  current_ask: number | null;
  below_target: boolean;
  notes: string | null;
  created_at: string;
}

interface EditionSearchResult {
  id: string;
  external_id: string;
  player_name: string | null;
  set_name: string | null;
  tier: string | null;
  collection_id: string | null;
}

function WatchlistAddModal(props: { ownerKey: string; onClose: () => void; onAdded: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<EditionSearchResult[]>([]);
  const [picked, setPicked] = useState<EditionSearchResult | null>(null);
  const [targetStr, setTargetStr] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(function() {
    const q = query.trim();
    if (!q || picked) { setResults([]); return; }
    const t = setTimeout(function() {
      fetch("/api/edition-search?q=" + encodeURIComponent(q))
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(d) { if (d?.results) setResults(d.results); })
        .catch(function() {});
    }, 220);
    return function() { clearTimeout(t); };
  }, [query, picked]);

  async function handleSave() {
    if (!picked) return;
    setSaving(true);
    try {
      const targetPrice = targetStr.trim() ? Number(targetStr) : null;
      await fetch("/api/profile/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerKey: props.ownerKey,
          editionId: picked.id,
          collectionId: picked.collection_id,
          targetPrice: Number.isFinite(targetPrice ?? NaN) ? targetPrice : null,
        }),
      });
      props.onAdded();
      props.onClose();
    } finally { setSaving(false); }
  }

  return (
    <div onClick={props.onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={function(e) { e.stopPropagation(); }} style={{ background: "#0a0a0a", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 10, padding: 20, width: "100%", maxWidth: 480 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <span style={Object.assign({}, labelStyle, { fontSize: 12 })}>Add to Watchlist</span>
          <button onClick={props.onClose} style={Object.assign({}, btnBase, { fontSize: 9 })}>Close</button>
        </div>
        {!picked ? (
          <div>
            <input
              autoFocus
              value={query}
              onChange={function(e) { setQuery(e.target.value); }}
              placeholder="Player name or edition key (e.g., 84:2892)"
              style={{ width: "100%", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, padding: "10px 12px", color: "#fff", fontFamily: monoFont, fontSize: 12, marginBottom: 10 }}
            />
            {results.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 320, overflowY: "auto" }}>
                {results.map(function(r) {
                  return (
                    <button key={r.id} onClick={function() { setPicked(r); setResults([]); }} style={{ textAlign: "left", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 6, padding: "8px 10px", color: "#fff", cursor: "pointer" }}>
                      <div style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 13 }}>{r.player_name ?? "Unknown"}</div>
                      <div style={{ fontFamily: monoFont, fontSize: 10, color: "rgba(255,255,255,0.5)", marginTop: 2 }}>
                        {(r.set_name ?? "") + (r.tier ? " · " + r.tier : "") + " · " + r.external_id}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <div>
            <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 6, padding: "10px 12px", marginBottom: 12 }}>
              <div style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 14, color: "#fff" }}>{picked.player_name ?? "Unknown"}</div>
              <div style={{ fontFamily: monoFont, fontSize: 10, color: "rgba(255,255,255,0.5)", marginTop: 2 }}>
                {(picked.set_name ?? "") + (picked.tier ? " · " + picked.tier : "")}
              </div>
            </div>
            <label style={Object.assign({}, labelStyle, { display: "block", marginBottom: 6 })}>Target Price (USD)</label>
            <input
              value={targetStr}
              onChange={function(e) { setTargetStr(e.target.value); }}
              placeholder="e.g., 25.00"
              inputMode="decimal"
              style={{ width: "100%", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, padding: "10px 12px", color: "#fff", fontFamily: monoFont, fontSize: 12, marginBottom: 14 }}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={function() { setPicked(null); setTargetStr(""); }} style={Object.assign({}, btnBase, { flex: 1 })}>Back</button>
              <button disabled={saving} onClick={handleSave} style={Object.assign({}, btnBase, { flex: 1, background: "rgba(224,58,47,0.15)", color: "#E03A2F", borderColor: "rgba(224,58,47,0.4)" })}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function WatchlistCard(props: { ownerKey: string }) {
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(function() {
    if (!props.ownerKey) return;
    setLoading(true);
    fetch("/api/profile/watchlist?ownerKey=" + encodeURIComponent(props.ownerKey))
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(d) { if (d?.items) setItems(d.items); })
      .catch(function() {})
      .finally(function() { setLoading(false); });
  }, [props.ownerKey]);

  useEffect(function() { load(); }, [load]);

  async function handleRemove(id: string) {
    await fetch("/api/profile/watchlist", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ownerKey: props.ownerKey, itemId: id }),
    });
    setItems(function(prev) { return prev.filter(function(i) { return i.id !== id; }); });
  }

  return (
    <section style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 8, padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={labelStyle}>👁 Watchlist</span>
          <span style={{ background: "rgba(224,58,47,0.15)", border: "1px solid rgba(224,58,47,0.3)", color: "#E03A2F", fontSize: 9, fontFamily: monoFont, padding: "1px 6px", borderRadius: 3 }}>{items.length}</span>
        </div>
        <button onClick={function() { setShowAdd(true); }} style={Object.assign({}, btnBase, { fontSize: 9 })}>+ Add</button>
      </div>
      {loading ? (
        <div style={{ fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.3)", padding: "18px 0", textAlign: "center" }}>Loading…</div>
      ) : items.length === 0 ? (
        <div style={{ fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.25)", textAlign: "center", padding: "20px 0" }}>
          Nothing watched yet. Add an edition to track price.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {items.map(function(it) {
            return (
              <div key={it.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 6 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontFamily: condensedFont, fontWeight: 700, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {it.player_name ?? "Unknown"}
                  </div>
                  <div style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.45)", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {(it.set_name ?? "") + (it.tier ? " · " + it.tier : "")}
                  </div>
                </div>
                <div style={{ textAlign: "right", fontFamily: monoFont, fontSize: 10, color: "rgba(255,255,255,0.65)", minWidth: 90 }}>
                  <div>Ask {it.current_ask != null ? fmtDollars(it.current_ask) : "—"}</div>
                  <div style={{ color: "rgba(255,255,255,0.4)", marginTop: 1 }}>FMV {it.current_fmv != null ? fmtDollars(it.current_fmv) : "—"}</div>
                </div>
                <div style={{ textAlign: "right", fontFamily: monoFont, fontSize: 10, minWidth: 68 }}>
                  <div style={{ color: "rgba(255,255,255,0.4)" }}>Target</div>
                  <div style={{ color: "#fff" }}>{it.target_price != null ? fmtDollars(it.target_price) : "—"}</div>
                </div>
                {it.below_target && (
                  <span style={{ background: "rgba(16,185,129,0.15)", border: "1px solid rgba(16,185,129,0.35)", color: "#10B981", fontSize: 8, fontFamily: monoFont, padding: "2px 6px", borderRadius: 3, letterSpacing: "0.12em", textTransform: "uppercase" }}>Below Target</span>
                )}
                <button onClick={function() { handleRemove(it.id); }} style={Object.assign({}, btnBase, { fontSize: 9, padding: "3px 8px" })}>Remove</button>
              </div>
            );
          })}
        </div>
      )}
      {showAdd && (
        <WatchlistAddModal
          ownerKey={props.ownerKey}
          onClose={function() { setShowAdd(false); }}
          onAdded={function() { load(); }}
        />
      )}
    </section>
  );
}
