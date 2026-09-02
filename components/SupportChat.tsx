"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { track } from "@/lib/telemetry/track";
import { tierColorAlpha } from "@/lib/tier-color";
import { parseRichText, isExternalHref } from "@/lib/concierge/rich-text";

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
  // Cryptographically-random session id. It doubles as the capability token for
  // reading this anon conversation back (support_conversations RLS keys on it),
  // so it MUST be unguessable — the old Date.now()+Math.random() id was both.
  const gen = () =>
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? `rpc_${crypto.randomUUID()}`
      : `rpc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  if (typeof window === "undefined") return gen();
  const key = "rpc_chat_session";
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = gen();
    sessionStorage.setItem(key, id);
  }
  return id;
}

// Reads the shared `--tier-*` tokens. Until 2026-08-02 legendary/ultimate were
// the RETIRED #f59e0b / #ec4899, so a concierge moment card showed an Ultimate
// as pink while /dashboard and /packs showed it orange. rare/uncommon happened
// to already equal their tokens; they now READ them so a palette edit can't
// desync again. NOTE: the return value is alpha-composed by both call sites, so
// it must go through tierColorAlpha -- `var(--tier-ultimate)33` is invalid CSS
// and Chrome drops the declaration silently.
function tierColor(tier?: string): string {
  switch (tier?.toLowerCase()) {
    case "legendary": return "var(--tier-legendary)";
    case "rare": return "var(--tier-rare)";
    case "uncommon": return "var(--tier-uncommon)";
    case "ultimate": return "var(--tier-ultimate)";
    default: return "var(--rpc-text-muted)";
  }
}
// brand-exception: return value is concatenated with an alpha suffix (`${sourceColor()}18`) in a CSS background — must be a literal hex
function sourceColor(source?: string): string { return source === "flowty" ? "#06b6d4" : "#E03A2F"; }
function badgeIconUrl(name: string): string { return `https://nbatopshot.com/img/momentTags/static/${name}.svg`; }

function MomentCardUI({ card }: { card: MomentCard }) {
  return (
    <div style={{ background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)", borderRadius: 12, overflow: "hidden", marginTop: 6, marginBottom: 4 }}>
      <div style={{ display: "flex", gap: 10, padding: "10px 12px 8px" }}>
        {card.thumbnailUrl ? (
          <img src={card.thumbnailUrl} alt={card.playerName} style={{ width: 52, height: 52, borderRadius: 8, objectFit: "cover", background: "var(--rpc-surface-hover)", flexShrink: 0 }} onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
        ) : (
          <div style={{ width: 52, height: 52, borderRadius: 8, background: `linear-gradient(135deg, ${tierColorAlpha(tierColor(card.tier), 20)}, var(--rpc-surface-hover))`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>🏀</div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--rpc-text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{card.playerName}</div>
          <div style={{ fontSize: 11, color: "var(--rpc-text-secondary)", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{card.setName || ""}{card.series ? ` · ${card.series}` : ""}</div>
          {card.badgeNames && card.badgeNames.length > 0 && (
            <div style={{ display: "flex", gap: 3, marginTop: 4, flexWrap: "wrap" }}>
              {card.badgeNames.slice(0, 4).map((b) => (<img key={b} src={badgeIconUrl(b)} alt={b} title={b} style={{ width: 16, height: 16, opacity: 0.85 }} onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />))}
            </div>
          )}
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--rpc-text-primary)" }}>${card.price?.toFixed(2)}</div>
          {card.fmv && card.discountPct && card.discountPct > 0 ? (
            <div style={{ fontSize: 11, color: "var(--rpc-success)", fontWeight: 600, marginTop: 2 }}>{card.discountPct}% below FMV</div>
          ) : card.fmv ? (<div style={{ fontSize: 11, color: "var(--rpc-text-secondary)", marginTop: 2 }}>FMV ${card.fmv.toFixed(2)}</div>) : null}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 12px 10px", gap: 6 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {card.tier && <span style={{ fontSize: 10, fontWeight: 600, color: tierColor(card.tier), background: tierColorAlpha(tierColor(card.tier), 9), padding: "2px 7px", borderRadius: 4, textTransform: "uppercase" }}>{card.tier}</span>}
          {card.source && <span style={{ fontSize: 10, fontWeight: 600, color: sourceColor(card.source), background: `${sourceColor(card.source)}18`, padding: "2px 7px", borderRadius: 4 }}>{card.source === "flowty" ? "Flowty" : "TopShot"}</span>}
          {card.serialNumber && <span style={{ fontSize: 10, color: "var(--rpc-text-muted)" }}>#{card.serialNumber}{card.mintCount ? `/${card.mintCount}` : ""}</span>}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {card.buyUrl && <a href={card.buyUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, fontWeight: 600, color: "var(--rpc-text-primary)", background: "var(--rpc-surface-hover)", border: "1px solid var(--rpc-border)", padding: "4px 10px", borderRadius: 6, textDecoration: "none", cursor: "pointer" }}>Buy →</a>}
        </div>
      </div>
    </div>
  );
}

// Renders a concierge message as text + clickable links instead of one inert
// string. The tokenizer lives in lib/ (measured by the primary coverage gate)
// and returns TOKENS, never markup — see the security note in that file. There
// is deliberately no dangerouslySetInnerHTML here: the message quotes tool
// results, which carry values RPC does not control.
function MessageText({ text }: { text: string }) {
  const tokens = parseRichText(text);
  return (
    <>
      {tokens.map((t, i) => {
        if (t.type === "bold") return <strong key={i} style={{ fontWeight: 700 }}>{t.text}</strong>;
        if (t.type === "link") {
          const external = isExternalHref(t.href);
          return (
            <a
              key={i}
              href={t.href}
              {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
              style={{ color: "var(--rpc-red)", textDecoration: "underline", textUnderlineOffset: 2, wordBreak: "break-word" }}
            >
              {t.text}
            </a>
          );
        }
        return <span key={i}>{t.text}</span>;
      })}
    </>
  );
}

function FeedbackButtons({ messageId, sessionId, dbId, feedback: initialFeedback }: { messageId: string; sessionId: string; dbId?: number; feedback?: "up" | "down" | null }) {
  const [feedback, setFeedback] = useState<"up" | "down" | null>(initialFeedback || null);
  const [sent, setSent] = useState(false);
  const sendFeedback = async (value: "up" | "down") => {
    if (sent) return;
    setFeedback(value); setSent(true);
    try {
      await fetch("/api/support-chat/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId: dbId ?? null, sessionId, feedback: value }),
      });
    } catch { /* silent */ }
  };
  return (
    <div style={{ display: "flex", gap: 4, marginTop: 6, opacity: sent ? 0.5 : 1 }}>
      <button onClick={() => sendFeedback("up")} disabled={sent} style={{ background: feedback === "up" ? "rgba(52,211,153,0.15)" : "transparent", border: feedback === "up" ? "1px solid rgba(52,211,153,0.3)" : "1px solid var(--rpc-border)", borderRadius: 6, padding: "3px 8px", cursor: sent ? "default" : "pointer", fontSize: 13, color: feedback === "up" ? "var(--rpc-success)" : "var(--rpc-text-muted)" }} aria-label="Helpful">👍</button>
      <button onClick={() => sendFeedback("down")} disabled={sent} style={{ background: feedback === "down" ? "rgba(224,58,47,0.15)" : "transparent", border: feedback === "down" ? "1px solid rgba(224,58,47,0.3)" : "1px solid var(--rpc-border)", borderRadius: 6, padding: "3px 8px", cursor: sent ? "default" : "pointer", fontSize: 13, color: feedback === "down" ? "var(--rpc-red)" : "var(--rpc-text-muted)" }} aria-label="Not helpful">👎</button>
    </div>
  );
}

// Beta-flavored quick-suggestion pills. The dominant feel is feedback intake;
// one or two deal-flavored prompts remain so users can still escape into the
// concierge when they need it.
// ⚠ NO NARRATIVE-SEARCH DISCOVERY PILL HERE — one was added and REMOVED the
// same night, and the reason must not be re-discovered the hard way.
//
// "Find a game winner" looked like the perfect demo of narrative catalog
// search. It is the opposite: measured against production, the query returns a
// roster of the "For The Win" SET (including Blocks, which are not game
// winners) and does NOT return either of the two most famous Blazers game
// winners — Lillard's 2014 0.9-second series winner (Archive Set, `48:1652`)
// or the 2019 37-footer (Run It Back: Legacies, `121:4255`) — even though BOTH
// carry descriptions and one literally contains the word "game-winning".
//
// ⚠ THE "LENGTH-NORMALIZED TRIGRAM RANKING" EXPLANATION THAT USED TO SIT HERE
// WAS WRONG, and so was the fix built on it. Root cause, found on the third
// attempt (2026-08-14): rpc_search_catalog required EVERY query token, so one
// word the prose never uses annihilated the query. The prose says
// "game-winning" and "buzzer"; it never says "winner" or "beater".
//
// Fixed at the DB layer: a 3-or-more-token query may now miss one token, so
// "lillard buzzer beater" reaches `121:4255` at rank 6 and "lillard game
// winner" reaches `48:1652` at rank 20. A one- or two-word query still must
// match every word — relaxing there would degrade "lillard buzzer" into every
// Lillard moment.
//
// The pill STAYS OUT, because it would fire a bare two-word phrase and that is
// exactly the shape still unreachable: `game winner` cannot reach a moment
// whose prose says "game-winning", and there is no stemming to bridge it. The
// honest discovery hint is "player name + a distinctive word", which lives in
// the search empty-state copy and the concierge prompt instead. Re-add a
// narrative pill only if a phrase query is verified against BOTH slugs.
const PAGE_DEFAULTS: Record<string, string[]> = {
  "sniper (nba-top-shot)": ["Bug on this page?", "Confusing on this page?", "Best deals right now", "Find me a LeBron deal"],
  "badges (nba-top-shot)": ["Bug on this page?", "How does X work?", "Most valuable badges?", "Check badges for Wembanyama"],
  "collection (nba-top-shot)": ["Bug with my collection view?", "Suggest a feature", "Analyze my portfolio", "Sets I'm close to completing?"],
  "sets (nba-top-shot)": ["Bug on this page?", "Confusing on this page?", "Cheapest set to complete?", "Best investment sets?"],
  "packs (nba-top-shot)": ["Pack EV looks wrong?", "Suggest a feature", "Best value pack right now?", "How does Pack EV work?"],
  "overview (nba-top-shot)": ["Report a bug", "Suggest a feature", "Top sales today", "Where do I start?"],
  "market (nba-top-shot)": ["Bug on this page?", "Confusing filter?", "Show everything under $20", "Cheapest legendary right now"],
  "analytics (nba-top-shot)": ["A number looks off?", "Suggest a feature", "Top sales this week", "Hottest player this month"],

  "sniper (nfl-all-day)": ["Bug on this page?", "Suggest a feature", "Best All Day deals", "Find me a Mahomes deal"],
  "collection (nfl-all-day)": ["Bug with my collection view?", "Suggest a feature", "Analyze my All Day wallet", "Set completion progress"],
  "packs (nfl-all-day)": ["Pack EV looks wrong?", "Suggest a feature", "All Day pack EV", "Skip or buy?"],
  "sets (nfl-all-day)": ["Bug on this page?", "Confusing on this page?", "Cheapest All Day set", "Set bottlenecks"],
  "badges (nfl-all-day)": ["Bug on this page?", "How does X work?", "Rookie badges", "First Touchdown moments"],
  "overview (nfl-all-day)": ["Report a bug", "Suggest a feature", "Top All Day sales", "Where do I start?"],
  "market (nfl-all-day)": ["Bug on this page?", "Confusing filter?", "Show everything under $20", "Cheapest legendary right now"],
  "analytics (nfl-all-day)": ["A number looks off?", "Suggest a feature", "Top sales this week", "Hottest player this month"],

  "sniper (laliga-golazos)": ["Bug on this page?", "Suggest a feature", "Best Golazos deals", "Find me a Messi moment"],
  "collection (laliga-golazos)": ["Bug with my collection view?", "Suggest a feature", "Analyze my Golazos wallet", "Set completion"],
  "packs (laliga-golazos)": ["Pack EV looks wrong?", "Suggest a feature", "Golazos pack EV", "Skip or buy?"],
  "sets (laliga-golazos)": ["Bug on this page?", "Confusing on this page?", "Cheapest Golazos set", "Ídolos sets"],
  "overview (laliga-golazos)": ["Report a bug", "Suggest a feature", "Top Golazos sales", "Where do I start?"],
  "market (laliga-golazos)": ["Bug on this page?", "Confusing filter?", "Show everything under $20", "Cheapest legendary right now"],
  "analytics (laliga-golazos)": ["A number looks off?", "Suggest a feature", "Top sales this week", "Hottest player this month"],

  "sniper (disney-pinnacle)": ["Bug on this page?", "Suggest a feature", "Best Pinnacle deals", "Star Wars pins under $10"],
  "collection (disney-pinnacle)": ["Bug with my collection view?", "Suggest a feature", "Analyze my Pinnacle wallet", "Variant breakdown"],
  "overview (disney-pinnacle)": ["Report a bug", "Suggest a feature", "Top Pinnacle sales", "What is Pinnacle?"],
  "market (disney-pinnacle)": ["Bug on this page?", "Confusing filter?", "Show everything under $20", "Cheapest legendary right now"],
  "analytics (disney-pinnacle)": ["A number looks off?", "Suggest a feature", "Top sales this week", "Hottest player this month"],

  "sniper (ufc)": ["Bug on this page?", "Suggest a feature", "Best UFC deals", "Find me a McGregor moment"],
  "collection (ufc)": ["Bug with my collection view?", "Suggest a feature", "Analyze my UFC wallet", "What about the Aptos migration?"],
  "overview (ufc)": ["Report a bug", "Suggest a feature", "UFC Strike status", "Aptos migration"],

  sniper: ["Bug on this page?", "Suggest a feature", "Best deals right now", "Find me a deal"],
  badges: ["Bug on this page?", "How does X work?", "Most valuable badges?", "Badge premiums"],
  collection: ["Bug with my collection view?", "Suggest a feature", "Analyze my portfolio", "Set progress"],
  sets: ["Bug on this page?", "Confusing on this page?", "Cheapest set to complete?", "Best investment sets?"],
  packs: ["Pack EV looks wrong?", "Suggest a feature", "Best value pack right now?", "How does Pack EV work?"],
  overview: ["Report a bug", "Suggest a feature", "Top sales today", "Where do I start?"],
  market: ["Bug on this page?", "Confusing filter?", "Show everything under $20", "Cheapest legendary right now"],
  analytics: ["A number looks off?", "Suggest a feature", "Top sales this week", "Hottest player this month"],
};
const DEFAULT_SUGGESTIONS = ["Report a bug", "Suggest a feature", "Something looks off", "How does FMV work?"];

export default function SupportChat({ pageContext, collectionId, userWallet, ownerKey, walletConnected, signedInLabel }: {
  pageContext?: string; collectionId?: string | null; userWallet?: string | null; ownerKey?: string | null; walletConnected?: boolean; signedInLabel?: string | null;
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
  const panelRef = useRef<HTMLDivElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  // Did this mount ever send a user message? Drives concierge_closed_without_send.
  // A ref, not state: it must not re-render anything and must survive the close.
  const sentAnyRef = useRef(false);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);
  useEffect(() => { if (isOpen) { setTimeout(() => inputRef.current?.focus(), 300); setHasNewMessage(false); } }, [isOpen]);

  // ── Funnel instrumentation ────────────────────────────────────────────────
  // Until 2026-09-02 the ONLY event this component emitted was
  // chat-message-sent, so a period with no conversations was ambiguous between
  // "nobody ever saw the launcher" and "people opened it and could not think of
  // a question" — which need opposite fixes. Open and abandon are the two reads
  // that separate them. Cheap: `track` coalesces by feature name per debounce
  // window, and failures are silent by design.
  const openedRef = useRef(false);
  useEffect(() => {
    if (isOpen) {
      openedRef.current = true;
      track("concierge_opened", { page: pageContext ?? null, collection: collectionId ?? null, signed_in: !!walletConnected });
      return;
    }
    // Only an actual close counts as an abandon — not the initial closed render.
    if (openedRef.current && !sentAnyRef.current) {
      track("concierge_closed_without_send", { page: pageContext ?? null, collection: collectionId ?? null, suggestions_shown: quickSuggestions.length });
    }
    // quickSuggestions is read, not depended on: re-firing this effect when the
    // pills arrive would emit a spurious abandon while the panel is still shut.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, pageContext, collectionId, walletConnected]);

  // Escape closes the panel and returns focus to the launcher. Every other
  // overlay on the site already does this (MomentDetailModal, PaywallModal,
  // GlobalSearch); the chat was the outlier, so a keyboard user who opened it
  // had no way back out and lost their place in the page.
  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // Don't steal Escape from a nested overlay that is handling it.
      if (!panelRef.current?.contains(document.activeElement)) return;
      e.stopPropagation();
      setIsOpen(false);
      // The launcher hides itself (display:none) whenever an input is focused —
      // a mobile-keyboard affordance — and a hidden element cannot take focus.
      // Escape is almost always pressed FROM the input, so clearing that flag
      // first is what makes the restore actually land; without it focus falls
      // to <body> and a keyboard user is dumped at the top of the page.
      setInputFocused(false);
      setTimeout(() => launcherRef.current?.focus(), 0);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen]);

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

  useEffect(() => {
    if (!isOpen || contextLoaded || messages.length > 0) return;
    setContextLoaded(true);

    const fullKey = (pageContext || "").trim().toLowerCase();
    const pageName = fullKey.split("(")[0].trim();
    const defaultSuggestions = PAGE_DEFAULTS[fullKey] || PAGE_DEFAULTS[pageName] || DEFAULT_SUGGESTIONS;
    setQuickSuggestions(defaultSuggestions);

    // ⚠ Discovery for narrative search lives in the PILLS, not here. An earlier
    // pass added a sentence to both variants explaining that you can describe a
    // moment rather than name it; it was the right instinct in the wrong place.
    // This is the first thing a user reads, the prompt's own guidance is "one
    // tight, human line, not a menu dump", and most users are on mobile — every
    // clause added here is read by everyone and acted on by almost nobody. A
    // pill costs no reading, is one tap, and DEMONSTRATES the capability by
    // running it, which is strictly better teaching than describing it.
    const instantWelcome = ownerKey
      ? `Hey ${ownerKey} — RPC is in free beta, so I'm mostly here to help you get unstuck, answer how-things-work questions, and pass feedback to the team. I can also pull deals, check FMV, break down a wallet, and surface live market data — biggest sales, what's moving, rookies, scarcity — whenever you want.\n\nWhat's up?`
      : `Welcome to Rip Packs City — we're in free beta. I'm here to help you get unstuck, answer questions, and capture bug reports or feature requests for the team. I can also find deals, check FMV, analyze a wallet, and pull live market data — biggest sales, what's moving, rookie trends, scarcity, and more.\n\nWhat can I help with?`;

    setMessages([{ id: "welcome", role: "system", text: instantWelcome, timestamp: new Date() }]);

    (async () => {
      try {
        const params = new URLSearchParams({ sessionId });
        if (pageContext) params.set("pageContext", pageContext);
        if (collectionId) params.set("collectionId", collectionId);
        if (ownerKey) params.set("ownerKey", ownerKey);
        const res = await fetch(`/api/support-chat/context?${params}`);
        if (!res.ok) return;
        const ctx = await res.json();

        // ⚠ The server's list is GENERIC ("Report a bug", "Suggest a feature",
        // …) and it is returned on every open, so assigning it straight over
        // the page defaults made the 35-entry PAGE_DEFAULTS map dead on every
        // session: a user on /packs never saw "Best value pack right now?",
        // they saw the same four pills as everyone else about 200ms after
        // opening. Page-specific prompts lead — they are what this screen
        // actually affords — and the server's contribution fills the tail.
        if (ctx.pageSuggestions && ctx.pageSuggestions.length > 0) {
          setQuickSuggestions((prev) => {
            const merged = [...prev];
            for (const s of ctx.pageSuggestions as string[]) {
              if (!merged.includes(s)) merged.push(s);
            }
            return merged.slice(0, 6);
          });
        }

        // Returning beta tester: rewrite the welcome with a warmer, status-aware message.
        if (ctx.returningBetaTester) {
          const open = ctx.lastOpenFeedback;
          let nameLine = ownerKey ? `Welcome back, ${ownerKey}.` : "Welcome back.";
          let statusLine: string | null = null;
          if (open?.feedback_summary) {
            const status = String(open.feedback_status ?? "new");
            if (status === "shipped") {
              statusLine = `Your last feedback ("${open.feedback_summary}") shipped — thanks for the catch.`;
            } else if (status === "in_progress") {
              statusLine = `Your last feedback ("${open.feedback_summary}") is in progress — the team is on it.`;
            } else if (status === "wontfix" || status === "duplicate") {
              statusLine = `Your last feedback ("${open.feedback_summary}") was triaged as ${status}.`;
            } else {
              statusLine = `Your last feedback ("${open.feedback_summary}") is still in the queue.`;
            }
          } else if (typeof ctx.conversationCount === "number" && ctx.conversationCount > 0) {
            statusLine = `${ctx.conversationCount} prior session${ctx.conversationCount === 1 ? "" : "s"} on file.`;
          }
          const text = [nameLine, statusLine, "What's up today?"].filter(Boolean).join(" ");
          setMessages((prev) => {
            const updated = [...prev];
            if (updated[0]?.id === "welcome") {
              updated[0] = { ...updated[0], text };
            }
            return updated;
          });
        } else if (ctx.returningUser && ctx.lastTopics?.length > 0) {
          setMessages((prev) => {
            const updated = [...prev];
            if (updated[0]?.id === "welcome") {
              updated[0] = {
                ...updated[0],
                text: `Welcome back! Last time we touched on ${ctx.lastTopics.join(", ")}. What's up today?`,
              };
            }
            return updated;
          });
        }

        // Beta posture: do NOT auto-fire a market-pulse / dailyDeal follow-up
        // after the greeting. The first thing the user sees is the personalized
        // welcome plus quick-suggestion pills, full stop. The bot can fetch
        // live market context via search_live_deals / get_fmv when the user
        // asks (e.g. clicks the "Pull live deals" pill or asks for a player).
      } catch { /* context fetch failed silently — static welcome already shown */ }
    })();
  }, [isOpen, contextLoaded, messages.length, walletConnected, ownerKey, sessionId, pageContext, collectionId]);


  const sendMessage = useCallback(async (overrideText?: string) => {
    const trimmed = (overrideText || input).trim();
    if (!trimmed || isLoading) return;
    track("chat-message-sent", { length: trimmed.length });
    sentAnyRef.current = true;
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
        body: JSON.stringify({
          message: trimmed,
          sessionId,
          ownerKey: ownerKey || null,
          userWallet: userWallet || null,
          pageContext: pageContext || null,
          collectionId: collectionId || null,
          walletConnected: !!walletConnected,
          conversationHistory: history,
          stream: true,
        }),
      });
      if (res.status === 429) {
        setMessages((prev) => prev.filter((m) => m.id !== "typing"));
        setMessages((prev) => [...prev, { id: `e_${Date.now()}`, role: "assistant", text: "You’ve sent a lot of messages — I need a short break. Come back in an hour and I’ll be ready to help again.", timestamp: new Date() }]);
        return;
      }

      const isStream = res.headers.get("x-rpc-stream") === "1" && res.body;
      if (!isStream) {
        const data = await res.json();
        setMessages((prev) => prev.filter((m) => m.id !== "typing"));
        // Coerce escalated || escalate so the concierge_unavailable case
        // (server emits escalate=true, escalated=false) reuses the existing
        // "Flagged for Trevor" banner and suppresses thumbs-up/down on a
        // message the bot didn't actually answer.
        setMessages((prev) => [...prev, { id: `b_${Date.now()}`, dbId: data.messageId, role: "assistant", text: data.response || "Sorry, try again?", escalated: !!(data.escalated || data.escalate), momentCards: data.momentCards, feedback: null, timestamp: new Date() }]);
        if (!isOpen) setHasNewMessage(true);
        return;
      }

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
        setMessages((prev) => prev.map((m) => m.id === msgId ? { ...m, dbId: meta.messageId, escalated: !!(meta.escalated || meta.escalate), momentCards: meta.momentCards } : m));
      }
      if (!isOpen) setHasNewMessage(true);
    } catch {
      setMessages((prev) => prev.filter((m) => m.id !== "typing"));
      setMessages((prev) => [...prev, { id: `e_${Date.now()}`, role: "assistant", text: "Connection issue. Try again in a moment.", timestamp: new Date() }]);
    } finally { setIsLoading(false); }
  }, [input, isLoading, sessionId, ownerKey, userWallet, pageContext, collectionId, walletConnected, isOpen, messages]);

  useEffect(() => {
    function handleAsk(e: Event) {
      const detail = (e as CustomEvent).detail as { text?: string } | undefined;
      const text = detail?.text?.trim();
      if (!text) return;
      setIsOpen(true);
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
        <div
          ref={panelRef}
          className="rpc-chat-panel"
          role="dialog"
          aria-modal="false"
          aria-label="RPC Concierge chat"
          style={{ position: "fixed", bottom: 88, right: 16, width: "min(400px, calc(100vw - 32px))", height: "min(580px, calc(100vh - 120px))", background: "var(--rpc-surface)", border: "1px solid var(--rpc-border)", borderRadius: 16, display: "flex", flexDirection: "column", overflow: "hidden", zIndex: 9998, boxShadow: "var(--shadow-elevated, 0 24px 80px rgba(0,0,0,0.6))" }}>
          <div style={{ padding: "14px 16px", background: "linear-gradient(135deg, var(--rpc-red-bg) 0%, var(--rpc-surface) 100%)", borderBottom: "1px solid var(--rpc-border-subtle)", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: "linear-gradient(135deg, var(--rpc-red) 0%, #b82e25 100%)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0 }}>🏙️</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--rpc-text-primary)", letterSpacing: "-0.01em" }}>RPC Concierge</div>
              <div style={{ fontSize: 11, color: "var(--rpc-text-muted)", marginTop: 1 }}>
                {signedInLabel ? `Signed in as ${signedInLabel}` : "Beta support · Powered by Claude"}
              </div>
            </div>
            <button onClick={() => setIsOpen(false)} aria-label="Close chat" style={{ background: "none", border: "none", color: "var(--rpc-text-muted)", cursor: "pointer", padding: 4, fontSize: 18, lineHeight: 1, borderRadius: 6 }}>✕</button>
          </div>

          {/* aria-live so a screen reader hears the reply. "polite" rather than
              "assertive" because the answer streams token by token and an
              assertive region would interrupt on every chunk. */}
          <div
            className="rpc-chat-scrollbar"
            aria-live="polite"
            aria-atomic="false"
            style={{ flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
            {messages.map((msg) => (
              <div key={msg.id} className="rpc-msg-enter" style={{ display: "flex", flexDirection: "column", alignItems: msg.role === "user" ? "flex-end" : "flex-start" }}>
                <div style={{
                  maxWidth: "88%", padding: "10px 14px",
                  borderRadius: msg.role === "user" ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
                  background: msg.role === "user" ? "linear-gradient(135deg, var(--rpc-red) 0%, #c43028 100%)" : msg.role === "system" ? "var(--rpc-success-bg, rgba(52,211,153,0.08))" : "var(--rpc-surface-raised)",
                  color: msg.role === "user" ? "#fff" : "var(--rpc-text-primary)", fontSize: 13.5, lineHeight: 1.5,
                  whiteSpace: "pre-wrap", wordBreak: "break-word",
                  border: msg.role === "system" ? "1px solid rgba(52,211,153,0.22)" : msg.role !== "user" ? "1px solid var(--rpc-border-subtle)" : "none",
                }}>
                  {msg.id === "typing" ? (
                    <span style={{ display: "inline-flex", alignItems: "center", padding: "4px 0" }}>
                      <span className="rpc-typing-dot" /><span className="rpc-typing-dot" /><span className="rpc-typing-dot" />
                    </span>
                  ) : msg.role === "user" ? (
                    // The user's own text is never marked up — echoing their
                    // input back through a linkifier would be surprising.
                    msg.text
                  ) : (
                    <MessageText text={msg.text} />
                  )}
                  {msg.escalated && (
                    <div style={{ marginTop: 8, padding: "6px 10px", background: "rgba(224,58,47,0.1)", border: "1px solid rgba(224,58,47,0.25)", borderRadius: 8, fontSize: 12, color: "var(--rpc-red)" }}>📋 Flagged for the team — we'll follow up</div>
                  )}
                </div>
                {msg.momentCards && msg.momentCards.length > 0 && (
                  <div style={{ maxWidth: "88%", width: "100%", marginTop: 4 }}>
                    {msg.momentCards.map((card, i) => (<MomentCardUI key={`${msg.id}_c${i}`} card={card} />))}
                  </div>
                )}
                {msg.role === "assistant" && !msg.escalated && (
                  <FeedbackButtons messageId={msg.id} sessionId={sessionId} dbId={msg.dbId} feedback={msg.feedback} />
                )}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          {quickSuggestions.length > 0 && (
            <div style={{ overflowX: "auto", whiteSpace: "nowrap", padding: "8px 12px", display: "flex", gap: 6, scrollbarWidth: "none", flexShrink: 0 }} className="rpc-hide-scrollbar">
              {quickSuggestions.map((suggestion) => (
                <button key={suggestion} onClick={() => { track("concierge_suggestion_clicked", { suggestion }); sendMessage(suggestion); }} disabled={isLoading} style={{ fontSize: 12, color: "var(--rpc-text-secondary)", background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)", padding: "6px 12px", borderRadius: 20, cursor: isLoading ? "default" : "pointer", transition: "border-color 0.15s, color 0.15s", whiteSpace: "nowrap", flexShrink: 0 }}
                  onMouseEnter={(e) => { (e.target as HTMLElement).style.borderColor = "var(--rpc-red)"; (e.target as HTMLElement).style.color = "var(--rpc-text-primary)"; }}
                  onMouseLeave={(e) => { (e.target as HTMLElement).style.borderColor = "var(--rpc-border)"; (e.target as HTMLElement).style.color = "var(--rpc-text-secondary)"; }}>
                  {suggestion}
                </button>
              ))}
            </div>
          )}

          <div style={{ padding: "10px 14px 14px", borderTop: "1px solid var(--rpc-border-subtle)", background: "var(--rpc-bg-elev)", flexShrink: 0 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input ref={inputRef} className="rpc-chat-input" type="text" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
                aria-label="Message the RPC concierge"
                placeholder={ownerKey ? "Report a bug, ask a question, or look up a moment…" : "Ask a question, report a bug, or hunt deals…"}
                maxLength={2000} disabled={isLoading}
                style={{ flex: 1, padding: "10px 14px", background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)", borderRadius: 10, color: "var(--rpc-text-primary)", fontSize: 13.5, transition: "box-shadow 0.15s" }} />
              <button onClick={() => sendMessage()} disabled={!input.trim() || isLoading} aria-label="Send"
                style={{ width: 38, height: 38, borderRadius: 10, border: "none", background: input.trim() && !isLoading ? "linear-gradient(135deg, var(--rpc-red) 0%, #c43028 100%)" : "var(--rpc-surface-hover)", color: input.trim() && !isLoading ? "#fff" : "var(--rpc-text-ghost)", cursor: input.trim() && !isLoading ? "pointer" : "not-allowed", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0 }}>↑</button>
            </div>
            <div style={{ marginTop: 6, fontSize: 10, color: "var(--rpc-text-ghost)", textAlign: "center" }}>Free beta · Feedback goes to the team · Not financial advice</div>
          </div>
        </div>
      )}

      {/* The launcher and the panel's header ✕ are two different controls, so
          they must not share an accessible name — "Close chat" on both left a
          screen-reader user with two identical targets and no way to tell them
          apart. */}
      <button ref={launcherRef} onClick={() => setIsOpen((o) => !o)} aria-label={isOpen ? "Close RPC concierge" : "Open RPC concierge"}
        aria-expanded={isOpen}
        data-tour-anchor="chatbot-launcher"
        className={`rpc-chat-bubble${inputFocused ? " hidden" : ""}`}
        style={{ position: "fixed", bottom: 20, right: 16, width: 52, height: 52, borderRadius: 14, border: "none", background: isOpen ? "var(--rpc-surface-hover)" : "linear-gradient(135deg, var(--rpc-red) 0%, #b82e25 100%)", color: isOpen ? "var(--rpc-text-primary)" : "#fff", cursor: "pointer", display: inputFocused ? "none" : "flex", alignItems: "center", justifyContent: "center", fontSize: 22, zIndex: 9999, boxShadow: isOpen ? "0 4px 20px rgba(0,0,0,0.3)" : "0 4px 24px rgba(224,58,47,0.35), 0 0 0 1px rgba(224,58,47,0.15)", transition: "transform 0.15s, background 0.2s, box-shadow 0.2s" }}
        onMouseEnter={(e) => { (e.target as HTMLElement).style.transform = "scale(1.06)"; }}
        onMouseLeave={(e) => { (e.target as HTMLElement).style.transform = "scale(1)"; }}>
        {isOpen ? "✕" : "💬"}
        {hasNewMessage && !isOpen && (<span className="rpc-badge-new" style={{ position: "absolute", top: -4, right: -4, width: 14, height: 14, borderRadius: "50%", background: "var(--rpc-success)", border: "2px solid var(--rpc-surface)" }} />)}
      </button>
    </>
  );
}
