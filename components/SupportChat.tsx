"use client";

import { useState, useRef, useEffect, useCallback } from "react";

/* ================================================================== */
/*  SupportChat v5 — instant welcome, async deal loading, polish pass  */
/* ================================================================== */

interface MomentCard {
  playerName: string; setName?: string; tier?: string; series?: string;
  price: number; fmv?: number; discountPct?: number; badgeNames?: string[];
  serialNumber?: number; mintCount?: number; thumbnailUrl?: string;
  buyUrl?: string; source?: string; editionKey?: string;
}

interface ChatMessage {
  id: string; dbId?: number;
  role: "user" | "assistant" | "system";
  text: string; escalated?: boolean;
  momentCards?: MomentCard[];
  feedback?: "up" | "down" | null;
  timestamp: Date;
}

function getOrCreateSessionId(): string {
  if (typeof window === "undefined") return `rpc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const key = "rpc_chat_session";
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = `rpc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    sessionStorage.setItem(key, id);
  }
  return id;
}

function tierColor(tier?: string): string {
  switch (tier?.toLowerCase()) {
    case "legendary": return "#f59e0b";
    case "rare": return "#818cf8";
    case "uncommon": return "#14b8a6";
    case "ultimate": return "#ec4899";
    default: return "#6b7280";
  }
}
function sourceColor(source?: string): string { return source === "flowty" ? "#06b6d4" : "#E03A2F"; }
function badgeIconUrl(name: string): string { return `https://nbatopshot.com/img/momentTags/static/${name}.svg`; }

/* ── Moment Card ───────────────────────────────────────────────── */
function MomentCardUI({ card, onAddToCart }: { card: MomentCard; onAddToCart?: (c: MomentCard) => void }) {
  return (
    <div style={{ background: "#111", border: "1px solid #222", borderRadius: 12, overflow: "hidden", marginTop: 6, marginBottom: 4 }}>
      <div style={{ display: "flex", gap: 10, padding: "10px 12px 8px" }}>
        {card.thumbnailUrl ? (
          <img src={card.thumbnailUrl} alt={card.playerName} style={{ width: 52, height: 52, borderRadius: 8, objectFit: "cover", background: "#1a1a1a", flexShrink: 0 }} onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
        ) : (
          <div style={{ width: 52, height: 52, borderRadius: 8, background: `linear-gradient(135deg, ${tierColor(card.tier)}33, #1a1a1a)`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>🏀</div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{card.playerName}</div>
          <div style={{ fontSize: 11, color: "#888", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{card.setName || ""}{card.series ? ` · ${card.series}` : ""}</div>
          {card.badgeNames && card.badgeNames.length > 0 && (
            <div style={{ display: "flex", gap: 3, marginTop: 4, flexWrap: "wrap" }}>
              {card.badgeNames.slice(0, 4).map((b) => (<img key={b} src={badgeIconUrl(b)} alt={b} title={b} style={{ width: 16, height: 16, opacity: 0.85 }} onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />))}
            </div>
          )}
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}>${card.price?.toFixed(2)}</div>
          {card.fmv && card.discountPct && card.discountPct > 0 ? (
            <div style={{ fontSize: 11, color: "#4ade80", fontWeight: 600, marginTop: 2 }}>{card.discountPct}% below FMV</div>
          ) : card.fmv ? (<div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>FMV ${card.fmv.toFixed(2)}</div>) : null}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 12px 10px", gap: 6 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {card.tier && <span style={{ fontSize: 10, fontWeight: 600, color: tierColor(card.tier), background: `${tierColor(card.tier)}18`, padding: "2px 7px", borderRadius: 4, textTransform: "uppercase" }}>{card.tier}</span>}
          {card.source && <span style={{ fontSize: 10, fontWeight: 600, color: sourceColor(card.source), background: `${sourceColor(card.source)}18`, padding: "2px 7px", borderRadius: 4 }}>{card.source === "flowty" ? "Flowty" : "TopShot"}</span>}
          {card.serialNumber && <span style={{ fontSize: 10, color: "#666" }}>#{card.serialNumber}{card.mintCount ? `/${card.mintCount}` : ""}</span>}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {card.buyUrl && <a href={card.buyUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, fontWeight: 600, color: "#ccc", background: "#1a1a1a", border: "1px solid #333", padding: "4px 10px", borderRadius: 6, textDecoration: "none", cursor: "pointer" }}>Buy →</a>}
          {onAddToCart && <button onClick={() => onAddToCart(card)} style={{ fontSize: 11, fontWeight: 600, color: "#fff", background: "linear-gradient(135deg, #E03A2F 0%, #c43028 100%)", border: "none", padding: "4px 10px", borderRadius: 6, cursor: "pointer" }}>+ Cart</button>}
        </div>
      </div>
    </div>
  );
}

/* ── Feedback Buttons ──────────────────────────────────────────── */
function FeedbackButtons({ messageId, sessionId, dbId, feedback: initialFeedback }: { messageId: string; sessionId: string; dbId?: number; feedback?: "up" | "down" | null }) {
  const [feedback, setFeedback] = useState<"up" | "down" | null>(initialFeedback || null);
  const [sent, setSent] = useState(false);
  const sendFeedback = async (value: "up" | "down") => {
    if (sent) return;
    setFeedback(value); setSent(true);
    try { await fetch("/api/support-chat/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messageId: dbId || null, sessionId, feedback: value }) }); } catch { /* silent */ }
  };
  return (
    <div style={{ display: "flex", gap: 4, marginTop: 6, opacity: sent ? 0.5 : 1 }}>
      <button onClick={() => sendFeedback("up")} disabled={sent} style={{ background: feedback === "up" ? "rgba(74,222,128,0.15)" : "transparent", border: feedback === "up" ? "1px solid rgba(74,222,128,0.3)" : "1px solid #222", borderRadius: 6, padding: "3px 8px", cursor: sent ? "default" : "pointer", fontSize: 13, color: feedback === "up" ? "#4ade80" : "#666" }} aria-label="Helpful">👍</button>
      <button onClick={() => sendFeedback("down")} disabled={sent} style={{ background: feedback === "down" ? "rgba(224,58,47,0.15)" : "transparent", border: feedback === "down" ? "1px solid rgba(224,58,47,0.3)" : "1px solid #222", borderRadius: 6, padding: "3px 8px", cursor: sent ? "default" : "pointer", fontSize: 13, color: feedback === "down" ? "#E03A2F" : "#666" }} aria-label="Not helpful">👎</button>
    </div>
  );
}

/* ── Default quick suggestions by page + collection ────────────── */
const PAGE_DEFAULTS: Record<string, string[]> = {
  // NBA Top Shot
  "sniper (nba-top-shot)": ["Best deals right now", "Rare moments under $20", "Find me a LeBron deal", "What badges are hot?"],
  "badges (nba-top-shot)": ["Most valuable badges?", "Rookie Year moments under $15", "Check badges for Wembanyama", "What is Top Shot Debut?"],
  "collection (nba-top-shot)": ["Analyze my portfolio", "What should I sell?", "My most undervalued moment?", "Sets I'm close to completing?"],
  "sets (nba-top-shot)": ["Cheapest set to complete?", "What's in Run It Back?", "Best investment sets?", "Show me S8 sets"],
  "packs (nba-top-shot)": ["Are packs worth buying?", "How does Pack EV work?", "Best value pack right now?", "What's inside the latest drop?"],
  "overview (nba-top-shot)": ["Top sales today", "Hottest editions", "Market pulse", "Where do I start?"],
  "market (nba-top-shot)": ["Show top discounts", "Lookup an edition", "Liquidity leaderboard", "Cheapest legendaries"],
  "analytics (nba-top-shot)": ["What's my clarity score?", "Liquid vs locked breakdown", "Acquisition origin breakdown", "Tier breakdown"],

  // NFL All Day
  "sniper (nfl-all-day)": ["Best All Day deals", "Cheap legendaries", "Find me a Mahomes deal", "Rookie moments under $10"],
  "collection (nfl-all-day)": ["Analyze my All Day wallet", "What should I sell?", "My best moments", "Set completion progress"],
  "packs (nfl-all-day)": ["All Day pack EV", "Best value pack", "What tiers drop in this pack?", "Skip or buy?"],
  "sets (nfl-all-day)": ["Cheapest All Day set", "Set bottlenecks", "Series 4 sets", "Playoffs sets"],
  "badges (nfl-all-day)": ["Rookie badges", "Super Bowl badges", "Pro Bowl premiums", "First Touchdown moments"],
  "overview (nfl-all-day)": ["Top All Day sales", "Market pulse", "Hottest editions", "Where do I start?"],
  "analytics (nfl-all-day)": ["My All Day clarity score", "Liquid vs locked", "Tier breakdown", "Acquisition origin"],

  // LaLiga Golazos
  "sniper (laliga-golazos)": ["Best Golazos deals", "Cheap legendaries", "Find me a Messi moment", "El Clásico badges"],
  "collection (laliga-golazos)": ["Analyze my Golazos wallet", "What should I sell?", "My best moments", "Set completion"],
  "packs (laliga-golazos)": ["Golazos pack EV", "Best value pack", "Tier odds", "Skip or buy?"],
  "sets (laliga-golazos)": ["Cheapest Golazos set", "Set bottlenecks", "Ídolos sets", "Estrellas sets"],
  "overview (laliga-golazos)": ["Top Golazos sales", "Market pulse", "Hottest editions", "Where do I start?"],
  "analytics (laliga-golazos)": ["My clarity score", "Liquid vs locked", "Tier breakdown", "Acquisition origin"],

  // Disney Pinnacle
  "sniper (disney-pinnacle)": ["Best Pinnacle deals", "Cheap variant pins", "Star Wars pins under $10", "Pixar pins"],
  "collection (disney-pinnacle)": ["Analyze my Pinnacle wallet", "What should I sell?", "Variant breakdown", "My best pins"],
  "overview (disney-pinnacle)": ["Top Pinnacle sales", "Hottest pins", "What is Pinnacle?", "Where do I start?"],
  "analytics (disney-pinnacle)": ["My clarity score", "Variant breakdown", "Liquid vs locked", "Acquisition origin"],

  // UFC Strike
  "sniper (ufc)": ["Best UFC deals", "Cheap moments", "Find me a McGregor moment", "Title fights"],
  "collection (ufc)": ["Analyze my UFC wallet", "My best moments", "What about the Aptos migration?"],
  "overview (ufc)": ["UFC Strike status", "Aptos migration", "Hottest moments", "Where do I start?"],

  // Generic fallbacks (page only)
  sniper: ["Best deals right now", "Rare moments under $20", "Find me a deal", "What badges are hot?"],
  badges: ["Most valuable badges?", "Rookie moments under $15", "Badge premiums", "What is Top Shot Debut?"],
  collection: ["Analyze my portfolio", "What should I sell?", "My most undervalued moment?", "Set progress"],
  sets: ["Cheapest set to complete?", "Best investment sets?", "Set bottlenecks", "Latest sets"],
  packs: ["Are packs worth buying?", "How does Pack EV work?", "Best value pack right now?", "Tier odds"],
  overview: ["Top sales today", "Hottest editions", "Market pulse", "Where do I start?"],
  market: ["Show top discounts", "Lookup an edition", "Liquidity leaderboard", "Cheapest by tier"],
  analytics: ["What's my clarity score?", "Liquid vs locked", "Tier breakdown", "Acquisition origin"],
};
const DEFAULT_SUGGESTIONS = ["Find me deals under $10", "How does FMV work?", "What are badges?", "Show me top discounts"];

/* ================================================================== */
/*  Main Component                                                     */
/* ================================================================== */

export default function SupportChat({ pageContext, collectionId, userWallet, walletConnected, onAddToCart }: {
  pageContext?: string; collectionId?: string | null; userWallet?: string | null; walletConnected?: boolean; onAddToCart?: (moment: any) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [sessionId] = useState(() => getOrCreateSessionId());
  const [hasNewMessage, setHasNewMessage] = useState(false);
  const [contextLoaded, setContextLoaded] = useState(false);
  const [quickSuggestions, setQuickSuggestions] = useState<string[]>([]);
  const [inputFocused, setInputFocused] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);
  useEffect(() => { if (isOpen) { setTimeout(() => inputRef.current?.focus(), 300); setHasNewMessage(false); } }, [isOpen]);

  // Hide FAB when a text input/textarea is focused (mobile keyboard open)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    function handleFocusIn(e: FocusEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") {
        if (timer) clearTimeout(timer);
        setInputFocused(true);
      }
    }
    function handleFocusOut(e: FocusEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") {
        timer = setTimeout(() => setInputFocused(false), 150);
      }
    }
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("focusout", handleFocusOut);
    return () => {
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("focusout", handleFocusOut);
      if (timer) clearTimeout(timer);
    };
  }, []);

  // ── Instant welcome on open, then async context enrichment ─────
  useEffect(() => {
    if (!isOpen || contextLoaded || messages.length > 0) return;
    setContextLoaded(true);

    // Try full "page (collection)" key first, then fall back to page-only
    const fullKey = (pageContext || "").trim().toLowerCase();
    const pageName = fullKey.split("(")[0].trim();
    const defaultSuggestions = PAGE_DEFAULTS[fullKey] || PAGE_DEFAULTS[pageName] || DEFAULT_SUGGESTIONS;
    setQuickSuggestions(defaultSuggestions);

    // Show instant static welcome — no waiting
    const instantWelcome = walletConnected
      ? "Hey! I'm your RPC concierge. I can find deals, analyze your portfolio, check FMV, or help you build your collection.\n\nWhat are you looking for today?"
      : "Welcome to Rip Packs City! I can help you find deals on NBA Top Shot moments, explain how the platform works, or just chat about collecting.\n\nWhat can I help you with?";

    setMessages([{ id: "welcome", role: "system", text: instantWelcome, timestamp: new Date() }]);

    // Async: fetch context and append deal + memory if available
    (async () => {
      try {
        const params = new URLSearchParams({ sessionId });
        if (pageContext) params.set("pageContext", pageContext);
        if (collectionId) params.set("collectionId", collectionId);
        const res = await fetch(`/api/support-chat/context?${params}`);
        if (!res.ok) return;
        const ctx = await res.json();

        // Update suggestions from server if available
        if (ctx.pageSuggestions && ctx.pageSuggestions.length > 0) {
          setQuickSuggestions(ctx.pageSuggestions);
        }

        // Build enrichment message parts
        const parts: string[] = [];

        if (ctx.returningUser && ctx.lastTopics?.length > 0) {
          // Replace welcome with returning user version
          setMessages((prev) => {
            const updated = [...prev];
            if (updated[0]?.id === "welcome") {
              updated[0] = {
                ...updated[0],
                text: `Welcome back! Last time we chatted about ${ctx.lastTopics.join(", ")}.\n\nWhat can I help with today?`,
              };
            }
            return updated;
          });
        }

        if (ctx.dailyDeal) {
          const d = ctx.dailyDeal;
          const playerName = d.player_name;
          const price = d.low_ask;
          const discountPct = d.discount_pct;
          if (playerName && price != null && discountPct != null) {
            const priceStr = typeof price === "number" ? price.toFixed(2) : parseFloat(price).toFixed(2);
            const source = d.source === "flowty" ? "Flowty" : "TopShot";
            const seriesStr = d.series ? `, ${d.series}` : "";
            const setStr = d.set_name ? `, ${d.set_name}` : "";
            let dealLine = `🔥 Top deal: ${playerName}${seriesStr}${setStr} — $${priceStr}, ${Math.round(discountPct)}% below FMV on ${source}`;
            if (d.buy_url) dealLine += `\n${d.buy_url}`;
            parts.push(dealLine);
          }
        }
        if (ctx.marketPulse) {
          parts.push(`📊 ${ctx.marketPulse}`);
        }

        if (parts.length > 0) {
          setMessages((prev) => [
            ...prev,
            { id: "market_pulse", role: "system", text: parts.join("\n"), timestamp: new Date() },
          ]);
        }
      } catch { /* context fetch failed silently — static welcome already shown */ }
    })();
  }, [isOpen, contextLoaded, messages.length, walletConnected, sessionId, pageContext]);

  const handleAddToCart = useCallback((card: MomentCard) => {
    if (onAddToCart) {
      onAddToCart({ ...card, thumbnailUrl: card.thumbnailUrl || null });
      setMessages((prev) => [...prev, { id: `cart_${Date.now()}`, role: "system", text: `Added ${card.playerName} to your cart ($${card.price?.toFixed(2)})`, timestamp: new Date() }]);
    }
  }, [onAddToCart]);

  const sendMessage = useCallback(async (overrideText?: string) => {
    const trimmed = (overrideText || input).trim();
    if (!trimmed || isLoading) return;
    setMessages((prev) => [...prev, { id: `u_${Date.now()}`, role: "user", text: trimmed, timestamp: new Date() }]);
    setInput(""); setIsLoading(true);
    const history = messages
      .filter((m) => m.id !== "typing" && m.text !== "...")
      .map((m) => ({
        role: (m.role === "system" ? "user" : m.role) as "user" | "assistant",
        content: m.role === "system" ? `[system] ${m.text}` : m.text,
      }));
    setMessages((prev) => [...prev, { id: "typing", role: "system", text: "...", timestamp: new Date() }]);
    try {
      const res = await fetch("/api/support-chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed, sessionId, userWallet: userWallet || null, pageContext: pageContext || null, collectionId: collectionId || null, walletConnected: !!walletConnected, conversationHistory: history, stream: true }),
      });
      if (res.status === 429) {
        setMessages((prev) => prev.filter((m) => m.id !== "typing"));
        setMessages((prev) => [...prev, { id: `e_${Date.now()}`, role: "assistant", text: "You\u2019ve sent a lot of messages \u2014 I need a short break. Come back in an hour and I\u2019ll be ready to help again.", timestamp: new Date() }]);
        return;
      }

      const isStream = res.headers.get("x-rpc-stream") === "1" && res.body;
      if (!isStream) {
        const data = await res.json();
        setMessages((prev) => prev.filter((m) => m.id !== "typing"));
        setMessages((prev) => [...prev, { id: `b_${Date.now()}`, dbId: data.messageId, role: "assistant", text: data.response || "Sorry, try again?", escalated: data.escalated, momentCards: data.momentCards, feedback: null, timestamp: new Date() }]);
        if (!isOpen) setHasNewMessage(true);
        return;
      }

      // Streaming path: replace the typing placeholder with an assistant msg
      // and append text chunks as they arrive. Trailing JSON-on-its-own-line
      // payload (prefixed with \x1e) carries metadata (escalated, momentCards).
      const msgId = `b_${Date.now()}`;
      setMessages((prev) => prev.filter((m) => m.id !== "typing"));
      setMessages((prev) => [...prev, { id: msgId, role: "assistant", text: "", feedback: null, timestamp: new Date() }]);

      const reader = (res.body as ReadableStream).getReader();
      const decoder = new TextDecoder();
      let textSoFar = "";
      let metaJson = "";
      let metaSeen = false;
      let meta: any = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (metaSeen) {
          metaJson += chunk;
          continue;
        }
        const sep = chunk.indexOf("\x1e");
        if (sep === -1) {
          textSoFar += chunk;
          setMessages((prev) => prev.map((m) => m.id === msgId ? { ...m, text: textSoFar } : m));
        } else {
          textSoFar += chunk.slice(0, sep);
          setMessages((prev) => prev.map((m) => m.id === msgId ? { ...m, text: textSoFar } : m));
          metaJson = chunk.slice(sep + 1);
          metaSeen = true;
        }
      }
      if (metaSeen && metaJson.trim()) {
        try { meta = JSON.parse(metaJson); } catch { meta = null; }
      }
      if (meta) {
        setMessages((prev) => prev.map((m) => m.id === msgId ? { ...m, dbId: meta.messageId, escalated: meta.escalated, momentCards: meta.momentCards } : m));
      }
      if (!isOpen) setHasNewMessage(true);
    } catch {
      setMessages((prev) => prev.filter((m) => m.id !== "typing"));
      setMessages((prev) => [...prev, { id: `e_${Date.now()}`, role: "assistant", text: "Connection issue. Try again in a moment.", timestamp: new Date() }]);
    } finally { setIsLoading(false); }
  }, [input, isLoading, sessionId, userWallet, pageContext, walletConnected, isOpen, messages]);

  // External "ask" event from ExplainButton or other components
  useEffect(() => {
    function handleAsk(e: Event) {
      const detail = (e as CustomEvent).detail as { text?: string } | undefined;
      const text = detail?.text?.trim();
      if (!text) return;
      setIsOpen(true);
      // Wait a tick so the chat is open / context loaded before sending
      setTimeout(() => { sendMessage(text); }, 80);
    }
    window.addEventListener("rpc-concierge-ask", handleAsk);
    return () => window.removeEventListener("rpc-concierge-ask", handleAsk);
  }, [sendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } };

  return (
    <>
      <style>{`
        @keyframes rpc-chat-slide-up { from { opacity: 0; transform: translateY(16px) scale(0.95); } to { opacity: 1; transform: translateY(0) scale(1); } }
        @keyframes rpc-chat-fade-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes rpc-pulse { 0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); } 40% { opacity: 1; transform: scale(1); } }
        @keyframes rpc-badge-pop { 0% { transform: scale(0); } 70% { transform: scale(1.2); } 100% { transform: scale(1); } }
        .rpc-chat-panel { animation: rpc-chat-slide-up 0.25s ease-out; }
        .rpc-msg-enter { animation: rpc-chat-fade-in 0.2s ease-out; }
        .rpc-typing-dot { width: 6px; height: 6px; border-radius: 50%; background: #888; display: inline-block; margin: 0 2px; }
        .rpc-typing-dot:nth-child(1) { animation: rpc-pulse 1.2s infinite 0s; }
        .rpc-typing-dot:nth-child(2) { animation: rpc-pulse 1.2s infinite 0.2s; }
        .rpc-typing-dot:nth-child(3) { animation: rpc-pulse 1.2s infinite 0.4s; }
        .rpc-badge-new { animation: rpc-badge-pop 0.3s ease-out; }
        .rpc-chat-input:focus { outline: none; box-shadow: 0 0 0 2px rgba(224, 58, 47, 0.4); }
        .rpc-chat-scrollbar::-webkit-scrollbar { width: 4px; }
        .rpc-chat-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .rpc-chat-scrollbar::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
        .rpc-hide-scrollbar::-webkit-scrollbar { display: none; }
        @media (max-width: 768px) {
          .rpc-chat-bubble { bottom: 76px !important; right: 16px !important; }
          .rpc-chat-panel { bottom: 140px !important; }
        }
      `}</style>

      {isOpen && (
        <div className="rpc-chat-panel" style={{ position: "fixed", bottom: 88, right: 16, width: "min(400px, calc(100vw - 32px))", height: "min(580px, calc(100vh - 120px))", background: "#0d0d0d", border: "1px solid #222", borderRadius: 16, display: "flex", flexDirection: "column", overflow: "hidden", zIndex: 9998, boxShadow: "0 24px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.05)" }}>
          {/* Header */}
          <div style={{ padding: "14px 16px", background: "linear-gradient(135deg, #1a0a09 0%, #0d0d0d 100%)", borderBottom: "1px solid #1a1a1a", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: "linear-gradient(135deg, #E03A2F 0%, #b82e25 100%)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0 }}>🏙️</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#fff", letterSpacing: "-0.01em" }}>RPC Concierge</div>
              <div style={{ fontSize: 11, color: "#666", marginTop: 1 }}>Personal shopper · Powered by Claude</div>
            </div>
            <button onClick={() => setIsOpen(false)} aria-label="Close" style={{ background: "none", border: "none", color: "#555", cursor: "pointer", padding: 4, fontSize: 18, lineHeight: 1, borderRadius: 6 }}>✕</button>
          </div>

          {/* Messages */}
          <div className="rpc-chat-scrollbar" style={{ flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
            {messages.map((msg) => (
              <div key={msg.id} className="rpc-msg-enter" style={{ display: "flex", flexDirection: "column", alignItems: msg.role === "user" ? "flex-end" : "flex-start" }}>
                <div style={{
                  maxWidth: "88%", padding: "10px 14px",
                  borderRadius: msg.role === "user" ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
                  background: msg.role === "user" ? "linear-gradient(135deg, #E03A2F 0%, #c43028 100%)" : msg.role === "system" ? "#0f1a0f" : "#141414",
                  color: msg.role === "user" ? "#fff" : "#ccc", fontSize: 13.5, lineHeight: 1.5,
                  whiteSpace: "pre-wrap", wordBreak: "break-word",
                  border: msg.role === "system" ? "1px solid #1a2e1a" : msg.role !== "user" ? "1px solid #1e1e1e" : "none",
                }}>
                  {msg.id === "typing" ? (
                    <span style={{ display: "inline-flex", alignItems: "center", padding: "4px 0" }}>
                      <span className="rpc-typing-dot" /><span className="rpc-typing-dot" /><span className="rpc-typing-dot" />
                    </span>
                  ) : msg.text}
                  {msg.escalated && (
                    <div style={{ marginTop: 8, padding: "6px 10px", background: "rgba(224,58,47,0.1)", border: "1px solid rgba(224,58,47,0.25)", borderRadius: 8, fontSize: 12, color: "#E03A2F" }}>📋 Flagged for Trevor — he'll follow up</div>
                  )}
                </div>
                {msg.momentCards && msg.momentCards.length > 0 && (
                  <div style={{ maxWidth: "88%", width: "100%", marginTop: 4 }}>
                    {msg.momentCards.map((card, i) => (<MomentCardUI key={`${msg.id}_c${i}`} card={card} onAddToCart={onAddToCart ? handleAddToCart : undefined} />))}
                  </div>
                )}
                {msg.role === "assistant" && !msg.escalated && (
                  <FeedbackButtons messageId={msg.id} sessionId={sessionId} dbId={msg.dbId} feedback={msg.feedback} />
                )}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Quick Action Pills — always visible */}
          {quickSuggestions.length > 0 && (
            <div style={{ overflowX: "auto", whiteSpace: "nowrap", padding: "8px 12px", display: "flex", gap: 6, scrollbarWidth: "none", flexShrink: 0 }} className="rpc-hide-scrollbar">
              {quickSuggestions.map((suggestion) => (
                <button key={suggestion} onClick={() => sendMessage(suggestion)} disabled={isLoading} style={{ fontSize: 12, color: "#aaa", background: "#141414", border: "1px solid #222", padding: "6px 12px", borderRadius: 20, cursor: isLoading ? "default" : "pointer", transition: "border-color 0.15s, color 0.15s", whiteSpace: "nowrap", flexShrink: 0 }}
                  onMouseEnter={(e) => { (e.target as HTMLElement).style.borderColor = "#E03A2F"; (e.target as HTMLElement).style.color = "#fff"; }}
                  onMouseLeave={(e) => { (e.target as HTMLElement).style.borderColor = "#222"; (e.target as HTMLElement).style.color = "#aaa"; }}>
                  {suggestion}
                </button>
              ))}
            </div>
          )}

          {/* Input */}
          <div style={{ padding: "10px 14px 14px", borderTop: "1px solid #1a1a1a", background: "#0a0a0a", flexShrink: 0 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input ref={inputRef} className="rpc-chat-input" type="text" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
                placeholder={walletConnected ? "Find deals, check FMV, analyze portfolio..." : "Ask about deals, badges, FMV..."}
                maxLength={2000} disabled={isLoading}
                style={{ flex: 1, padding: "10px 14px", background: "#141414", border: "1px solid #222", borderRadius: 10, color: "#eee", fontSize: 13.5, transition: "box-shadow 0.15s" }} />
              <button onClick={() => sendMessage()} disabled={!input.trim() || isLoading} aria-label="Send"
                style={{ width: 38, height: 38, borderRadius: 10, border: "none", background: input.trim() && !isLoading ? "linear-gradient(135deg, #E03A2F 0%, #c43028 100%)" : "#1a1a1a", color: input.trim() && !isLoading ? "#fff" : "#444", cursor: input.trim() && !isLoading ? "pointer" : "not-allowed", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0 }}>↑</button>
            </div>
            <div style={{ marginTop: 6, fontSize: 10, color: "#444", textAlign: "center" }}>AI concierge · Prices are live · Not financial advice</div>
          </div>
        </div>
      )}

      {/* Floating Button */}
      <button onClick={() => setIsOpen((o) => !o)} aria-label={isOpen ? "Close chat" : "Open RPC concierge"}
        className={`rpc-chat-bubble${inputFocused ? " hidden" : ""}`}
        style={{ position: "fixed", bottom: 20, right: 16, width: 52, height: 52, borderRadius: 14, border: "none", background: isOpen ? "#1a1a1a" : "linear-gradient(135deg, #E03A2F 0%, #b82e25 100%)", color: "#fff", cursor: "pointer", display: inputFocused ? "none" : "flex", alignItems: "center", justifyContent: "center", fontSize: 22, zIndex: 9999, boxShadow: isOpen ? "0 4px 20px rgba(0,0,0,0.3)" : "0 4px 24px rgba(224,58,47,0.35), 0 0 0 1px rgba(224,58,47,0.15)", transition: "transform 0.15s, background 0.2s, box-shadow 0.2s" }}
        onMouseEnter={(e) => { (e.target as HTMLElement).style.transform = "scale(1.06)"; }}
        onMouseLeave={(e) => { (e.target as HTMLElement).style.transform = "scale(1)"; }}>
        {isOpen ? "✕" : "💬"}
        {hasNewMessage && !isOpen && (<span className="rpc-badge-new" style={{ position: "absolute", top: -4, right: -4, width: 14, height: 14, borderRadius: "50%", background: "#4ade80", border: "2px solid #0d0d0d" }} />)}
      </button>
    </>
  );
}
