"use client";

import { useState, useRef, useEffect, useCallback } from "react";

/* ================================================================== */
/*  SupportChat — AI concierge + personal shopper widget for RPC       */
/*  Drop into collection layout for site-wide availability             */
/* ================================================================== */

interface MomentCard {
  playerName: string;
  setName?: string;
  tier?: string;
  series?: string;
  price: number;
  fmv?: number;
  discountPct?: number;
  badgeNames?: string[];
  serialNumber?: number;
  mintCount?: number;
  thumbnailUrl?: string;
  buyUrl?: string;
  source?: string;
  editionKey?: string;
}

interface ChatAction {
  type: "addToCart";
  label: string;
  editionKey?: string;
  price?: number;
  playerName?: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  escalated?: boolean;
  momentCards?: MomentCard[];
  actions?: ChatAction[];
  timestamp: Date;
}

function generateSessionId() {
  return `rpc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/* ── Badge icon URL helper ──────────────────────────────────────── */
function badgeIconUrl(name: string): string {
  return `https://nbatopshot.com/img/momentTags/static/${name}.svg`;
}

/* ── Tier color helper ──────────────────────────────────────────── */
function tierColor(tier?: string): string {
  switch (tier?.toLowerCase()) {
    case "legendary":
      return "#f59e0b";
    case "rare":
      return "#818cf8";
    case "ultimate":
      return "#ec4899";
    default:
      return "#6b7280";
  }
}

/* ── Source badge color ─────────────────────────────────────────── */
function sourceColor(source?: string): string {
  return source === "flowty" ? "#06b6d4" : "#E03A2F";
}

/* ── Moment Card Component ─────────────────────────────────────── */
function MomentCardUI({
  card,
  onAddToCart,
}: {
  card: MomentCard;
  onAddToCart?: (card: MomentCard) => void;
}) {
  return (
    <div
      style={{
        background: "#111",
        border: "1px solid #222",
        borderRadius: 12,
        overflow: "hidden",
        marginTop: 6,
        marginBottom: 4,
      }}
    >
      {/* Top row: thumbnail + info */}
      <div style={{ display: "flex", gap: 10, padding: "10px 12px 8px" }}>
        {/* Thumbnail */}
        {card.thumbnailUrl ? (
          <img
            src={card.thumbnailUrl}
            alt={card.playerName}
            style={{
              width: 52,
              height: 52,
              borderRadius: 8,
              objectFit: "cover",
              background: "#1a1a1a",
              flexShrink: 0,
            }}
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        ) : (
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: 8,
              background: `linear-gradient(135deg, ${tierColor(card.tier)}33, #1a1a1a)`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 20,
              flexShrink: 0,
            }}
          >
            🏀
          </div>
        )}

        {/* Info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: "#fff",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {card.playerName}
          </div>
          <div
            style={{
              fontSize: 11,
              color: "#888",
              marginTop: 2,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {card.setName || ""}
            {card.series ? ` · ${card.series}` : ""}
          </div>

          {/* Badges row */}
          {card.badgeNames && card.badgeNames.length > 0 && (
            <div
              style={{
                display: "flex",
                gap: 3,
                marginTop: 4,
                flexWrap: "wrap",
              }}
            >
              {card.badgeNames.slice(0, 4).map((b) => (
                <img
                  key={b}
                  src={badgeIconUrl(b)}
                  alt={b}
                  title={b}
                  style={{
                    width: 16,
                    height: 16,
                    opacity: 0.85,
                  }}
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = "none";
                  }}
                />
              ))}
            </div>
          )}
        </div>

        {/* Price column */}
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div
            style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}
          >
            ${card.price?.toFixed(2)}
          </div>
          {card.fmv && card.discountPct && card.discountPct > 0 ? (
            <div
              style={{
                fontSize: 11,
                color: "#4ade80",
                fontWeight: 600,
                marginTop: 2,
              }}
            >
              {card.discountPct}% below FMV
            </div>
          ) : card.fmv ? (
            <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>
              FMV ${card.fmv.toFixed(2)}
            </div>
          ) : null}
        </div>
      </div>

      {/* Bottom row: meta + actions */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "6px 12px 10px",
          gap: 6,
        }}
      >
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {/* Tier pill */}
          {card.tier && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: tierColor(card.tier),
                background: `${tierColor(card.tier)}18`,
                padding: "2px 7px",
                borderRadius: 4,
                textTransform: "uppercase",
                letterSpacing: "0.03em",
              }}
            >
              {card.tier}
            </span>
          )}
          {/* Source pill */}
          {card.source && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: sourceColor(card.source),
                background: `${sourceColor(card.source)}18`,
                padding: "2px 7px",
                borderRadius: 4,
              }}
            >
              {card.source === "flowty" ? "Flowty" : "TopShot"}
            </span>
          )}
          {/* Serial */}
          {card.serialNumber && (
            <span style={{ fontSize: 10, color: "#666" }}>
              #{card.serialNumber}
              {card.mintCount ? `/${card.mintCount}` : ""}
            </span>
          )}
        </div>

        {/* Action buttons */}
        <div style={{ display: "flex", gap: 6 }}>
          {card.buyUrl && (
            <a
              href={card.buyUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: "#ccc",
                background: "#1a1a1a",
                border: "1px solid #333",
                padding: "4px 10px",
                borderRadius: 6,
                textDecoration: "none",
                cursor: "pointer",
                transition: "background 0.15s",
              }}
              onMouseEnter={(e) => {
                (e.target as HTMLElement).style.background = "#222";
              }}
              onMouseLeave={(e) => {
                (e.target as HTMLElement).style.background = "#1a1a1a";
              }}
            >
              Buy →
            </a>
          )}
          {onAddToCart && (
            <button
              onClick={() => onAddToCart(card)}
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: "#fff",
                background:
                  "linear-gradient(135deg, #E03A2F 0%, #c43028 100%)",
                border: "none",
                padding: "4px 10px",
                borderRadius: 6,
                cursor: "pointer",
                transition: "opacity 0.15s",
              }}
              onMouseEnter={(e) => {
                (e.target as HTMLElement).style.opacity = "0.85";
              }}
              onMouseLeave={(e) => {
                (e.target as HTMLElement).style.opacity = "1";
              }}
            >
              + Cart
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ================================================================== */
/*  Main SupportChat Component                                         */
/* ================================================================== */

export default function SupportChat({
  pageContext,
  userWallet,
  walletConnected,
  onAddToCart,
}: {
  pageContext?: string;
  userWallet?: string | null;
  walletConnected?: boolean;
  onAddToCart?: (moment: any) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [sessionId] = useState(() => generateSessionId());
  const [hasNewMessage, setHasNewMessage] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 300);
      setHasNewMessage(false);
    }
  }, [isOpen]);

  // ── Welcome message ────────────────────────────────────────────
  useEffect(() => {
    if (isOpen && messages.length === 0) {
      const welcomeText = walletConnected
        ? "Hey! I'm your RPC concierge. I can find deals, analyze your portfolio, check FMV on any moment, or help you build your collection.\n\nWhat are you looking for today?"
        : "Welcome to Rip Packs City! I can help you find deals on NBA Top Shot moments, explain how the platform works, or just chat about collecting.\n\nAre you new to Top Shot, or looking for something specific?";

      setMessages([
        {
          id: "welcome",
          role: "system",
          text: welcomeText,
          timestamp: new Date(),
        },
      ]);
    }
  }, [isOpen, messages.length, walletConnected]);

  // ── Handle add to cart ─────────────────────────────────────────
  const handleAddToCart = useCallback(
    (card: MomentCard) => {
      if (onAddToCart) {
        onAddToCart({
          ...card,
          thumbnailUrl: card.thumbnailUrl || null,
        });
        // Show confirmation in chat
        setMessages((prev) => [
          ...prev,
          {
            id: `cart_${Date.now()}`,
            role: "system",
            text: `Added ${card.playerName} to your cart ($${card.price?.toFixed(2)})`,
            timestamp: new Date(),
          },
        ]);
      }
    },
    [onAddToCart]
  );

  // ── Send message ───────────────────────────────────────────────
  const sendMessage = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;

    const userMsg: ChatMessage = {
      id: `u_${Date.now()}`,
      role: "user",
      text: trimmed,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsLoading(true);

    try {
      const res = await fetch("/api/support-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          sessionId,
          userWallet: userWallet || null,
          pageContext: pageContext || null,
          walletConnected: !!walletConnected,
        }),
      });

      const data = await res.json();

      const botMsg: ChatMessage = {
        id: `b_${Date.now()}`,
        role: "assistant",
        text: data.response || "Sorry, I couldn't process that. Try again?",
        escalated: data.escalated,
        momentCards: data.momentCards,
        actions: data.actions,
        timestamp: new Date(),
      };

      setMessages((prev) => [...prev, botMsg]);
      if (!isOpen) setHasNewMessage(true);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: `e_${Date.now()}`,
          role: "assistant",
          text: "I'm having trouble connecting. Try again in a moment, or reach out to Trevor on Discord.",
          timestamp: new Date(),
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  }, [input, isLoading, sessionId, userWallet, pageContext, walletConnected, isOpen]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <>
      <style>{`
        @keyframes rpc-chat-slide-up {
          from { opacity: 0; transform: translateY(16px) scale(0.95); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes rpc-chat-fade-in {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes rpc-pulse {
          0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
          40% { opacity: 1; transform: scale(1); }
        }
        @keyframes rpc-badge-pop {
          0%   { transform: scale(0); }
          70%  { transform: scale(1.2); }
          100% { transform: scale(1); }
        }
        .rpc-chat-panel { animation: rpc-chat-slide-up 0.25s ease-out; }
        .rpc-msg-enter { animation: rpc-chat-fade-in 0.2s ease-out; }
        .rpc-typing-dot {
          width: 6px; height: 6px; border-radius: 50%;
          background: #888; display: inline-block; margin: 0 2px;
        }
        .rpc-typing-dot:nth-child(1) { animation: rpc-pulse 1.2s infinite 0s; }
        .rpc-typing-dot:nth-child(2) { animation: rpc-pulse 1.2s infinite 0.2s; }
        .rpc-typing-dot:nth-child(3) { animation: rpc-pulse 1.2s infinite 0.4s; }
        .rpc-badge-new { animation: rpc-badge-pop 0.3s ease-out; }
        .rpc-chat-input:focus {
          outline: none;
          box-shadow: 0 0 0 2px rgba(224, 58, 47, 0.4);
        }
        .rpc-chat-scrollbar::-webkit-scrollbar { width: 4px; }
        .rpc-chat-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .rpc-chat-scrollbar::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
      `}</style>

      {/* ── Chat Panel ────────────────────────────────────────── */}
      {isOpen && (
        <div
          className="rpc-chat-panel"
          style={{
            position: "fixed",
            bottom: 88,
            right: 16,
            width: "min(400px, calc(100vw - 32px))",
            height: "min(580px, calc(100vh - 120px))",
            background: "#0d0d0d",
            border: "1px solid #222",
            borderRadius: 16,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            zIndex: 9998,
            boxShadow:
              "0 24px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.05)",
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: "14px 16px",
              background:
                "linear-gradient(135deg, #1a0a09 0%, #0d0d0d 100%)",
              borderBottom: "1px solid #1a1a1a",
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexShrink: 0,
            }}
          >
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background:
                  "linear-gradient(135deg, #E03A2F 0%, #b82e25 100%)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 16,
                flexShrink: 0,
              }}
            >
              🏙️
            </div>
            <div style={{ flex: 1 }}>
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 700,
                  color: "#fff",
                  letterSpacing: "-0.01em",
                }}
              >
                RPC Concierge
              </div>
              <div style={{ fontSize: 11, color: "#666", marginTop: 1 }}>
                Personal shopper · Powered by Claude
              </div>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              aria-label="Close chat"
              style={{
                background: "none",
                border: "none",
                color: "#555",
                cursor: "pointer",
                padding: 4,
                fontSize: 18,
                lineHeight: 1,
                borderRadius: 6,
              }}
            >
              ✕
            </button>
          </div>

          {/* Messages */}
          <div
            className="rpc-chat-scrollbar"
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "12px 14px",
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            {messages.map((msg) => (
              <div
                key={msg.id}
                className="rpc-msg-enter"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems:
                    msg.role === "user" ? "flex-end" : "flex-start",
                }}
              >
                {/* Text bubble */}
                <div
                  style={{
                    maxWidth: "88%",
                    padding:
                      msg.role === "system"
                        ? "10px 14px"
                        : "10px 14px",
                    borderRadius:
                      msg.role === "user"
                        ? "14px 14px 4px 14px"
                        : "14px 14px 14px 4px",
                    background:
                      msg.role === "user"
                        ? "linear-gradient(135deg, #E03A2F 0%, #c43028 100%)"
                        : msg.role === "system"
                        ? "#0f1a0f"
                        : "#141414",
                    color: msg.role === "user" ? "#fff" : "#ccc",
                    fontSize: 13.5,
                    lineHeight: 1.5,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    border:
                      msg.role === "system"
                        ? "1px solid #1a2e1a"
                        : msg.role !== "user"
                        ? "1px solid #1e1e1e"
                        : "none",
                  }}
                >
                  {msg.text}
                  {msg.escalated && (
                    <div
                      style={{
                        marginTop: 8,
                        padding: "6px 10px",
                        background: "rgba(224, 58, 47, 0.1)",
                        border: "1px solid rgba(224, 58, 47, 0.25)",
                        borderRadius: 8,
                        fontSize: 12,
                        color: "#E03A2F",
                      }}
                    >
                      📋 Flagged for Trevor — he'll follow up
                    </div>
                  )}
                </div>

                {/* Moment Cards */}
                {msg.momentCards &&
                  msg.momentCards.length > 0 && (
                    <div
                      style={{
                        maxWidth: "88%",
                        width: "100%",
                        marginTop: 4,
                      }}
                    >
                      {msg.momentCards.map((card, i) => (
                        <MomentCardUI
                          key={`${msg.id}_card_${i}`}
                          card={card}
                          onAddToCart={
                            onAddToCart ? handleAddToCart : undefined
                          }
                        />
                      ))}
                    </div>
                  )}
              </div>
            ))}

            {/* Typing indicator */}
            {isLoading && (
              <div
                className="rpc-msg-enter"
                style={{ display: "flex" }}
              >
                <div
                  style={{
                    padding: "12px 16px",
                    borderRadius: "14px 14px 14px 4px",
                    background: "#141414",
                    border: "1px solid #1e1e1e",
                    display: "flex",
                    alignItems: "center",
                    gap: 2,
                  }}
                >
                  <span className="rpc-typing-dot" />
                  <span className="rpc-typing-dot" />
                  <span className="rpc-typing-dot" />
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Quick Action Pills */}
          {messages.length <= 1 && (
            <div
              style={{
                padding: "0 14px 8px",
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
              }}
            >
              {(walletConnected
                ? [
                    "Find me deals under $10",
                    "Analyze my portfolio",
                    "Best Rare moments right now",
                    "What should I buy?",
                  ]
                : [
                    "I'm new — where do I start?",
                    "Show me deals under $5",
                    "How does FMV work?",
                    "What are badges?",
                  ]
              ).map((suggestion) => (
                <button
                  key={suggestion}
                  onClick={() => {
                    setInput(suggestion);
                    setTimeout(() => {
                      const fakeEvent = { key: "Enter", shiftKey: false, preventDefault: () => {} };
                      // Trigger send
                      setInput(suggestion);
                    }, 50);
                  }}
                  onMouseUp={() => {
                    // Fire send after state update
                    setTimeout(async () => {
                      const trimmed = suggestion.trim();
                      if (!trimmed || isLoading) return;
                      const userMsg: ChatMessage = {
                        id: `u_${Date.now()}`,
                        role: "user",
                        text: trimmed,
                        timestamp: new Date(),
                      };
                      setMessages((prev) => [...prev, userMsg]);
                      setInput("");
                      setIsLoading(true);
                      try {
                        const res = await fetch("/api/support-chat", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            message: trimmed,
                            sessionId,
                            userWallet: userWallet || null,
                            pageContext: pageContext || null,
                            walletConnected: !!walletConnected,
                          }),
                        });
                        const data = await res.json();
                        setMessages((prev) => [
                          ...prev,
                          {
                            id: `b_${Date.now()}`,
                            role: "assistant",
                            text: data.response || "Sorry, try again?",
                            escalated: data.escalated,
                            momentCards: data.momentCards,
                            actions: data.actions,
                            timestamp: new Date(),
                          },
                        ]);
                      } catch {
                        setMessages((prev) => [
                          ...prev,
                          {
                            id: `e_${Date.now()}`,
                            role: "assistant",
                            text: "Connection issue. Try again in a moment.",
                            timestamp: new Date(),
                          },
                        ]);
                      } finally {
                        setIsLoading(false);
                      }
                    }, 100);
                  }}
                  style={{
                    fontSize: 12,
                    color: "#aaa",
                    background: "#141414",
                    border: "1px solid #222",
                    padding: "6px 12px",
                    borderRadius: 20,
                    cursor: "pointer",
                    transition: "border-color 0.15s, color 0.15s",
                    whiteSpace: "nowrap",
                  }}
                  onMouseEnter={(e) => {
                    (e.target as HTMLElement).style.borderColor = "#E03A2F";
                    (e.target as HTMLElement).style.color = "#fff";
                  }}
                  onMouseLeave={(e) => {
                    (e.target as HTMLElement).style.borderColor = "#222";
                    (e.target as HTMLElement).style.color = "#aaa";
                  }}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          )}

          {/* Input */}
          <div
            style={{
              padding: "10px 14px 14px",
              borderTop: "1px solid #1a1a1a",
              background: "#0a0a0a",
              flexShrink: 0,
            }}
          >
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                ref={inputRef}
                className="rpc-chat-input"
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  walletConnected
                    ? "Find deals, check FMV, analyze portfolio..."
                    : "Ask about deals, badges, FMV..."
                }
                maxLength={2000}
                disabled={isLoading}
                style={{
                  flex: 1,
                  padding: "10px 14px",
                  background: "#141414",
                  border: "1px solid #222",
                  borderRadius: 10,
                  color: "#eee",
                  fontSize: 13.5,
                  transition: "box-shadow 0.15s",
                }}
              />
              <button
                onClick={sendMessage}
                disabled={!input.trim() || isLoading}
                aria-label="Send message"
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 10,
                  border: "none",
                  background:
                    input.trim() && !isLoading
                      ? "linear-gradient(135deg, #E03A2F 0%, #c43028 100%)"
                      : "#1a1a1a",
                  color: input.trim() && !isLoading ? "#fff" : "#444",
                  cursor:
                    input.trim() && !isLoading
                      ? "pointer"
                      : "not-allowed",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 16,
                  flexShrink: 0,
                }}
              >
                ↑
              </button>
            </div>
            <div
              style={{
                marginTop: 6,
                fontSize: 10,
                color: "#444",
                textAlign: "center",
              }}
            >
              AI concierge · Prices are live · Not financial advice
            </div>
          </div>
        </div>
      )}

      {/* ── Floating Button ───────────────────────────────────── */}
      <button
        onClick={() => setIsOpen((o) => !o)}
        aria-label={isOpen ? "Close chat" : "Open RPC concierge"}
        style={{
          position: "fixed",
          bottom: 20,
          right: 16,
          width: 52,
          height: 52,
          borderRadius: 14,
          border: "none",
          background: isOpen
            ? "#1a1a1a"
            : "linear-gradient(135deg, #E03A2F 0%, #b82e25 100%)",
          color: "#fff",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 22,
          zIndex: 9999,
          boxShadow: isOpen
            ? "0 4px 20px rgba(0,0,0,0.3)"
            : "0 4px 24px rgba(224,58,47,0.35), 0 0 0 1px rgba(224,58,47,0.15)",
          transition: "transform 0.15s, background 0.2s, box-shadow 0.2s",
        }}
        onMouseEnter={(e) => {
          (e.target as HTMLElement).style.transform = "scale(1.06)";
        }}
        onMouseLeave={(e) => {
          (e.target as HTMLElement).style.transform = "scale(1)";
        }}
      >
        {isOpen ? "✕" : "💬"}

        {hasNewMessage && !isOpen && (
          <span
            className="rpc-badge-new"
            style={{
              position: "absolute",
              top: -4,
              right: -4,
              width: 14,
              height: 14,
              borderRadius: "50%",
              background: "#4ade80",
              border: "2px solid #0d0d0d",
            }}
          />
        )}
      </button>
    </>
  );
}
