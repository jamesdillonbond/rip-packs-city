"use client";

import SupportChat from "@/components/SupportChat";
import { useCart } from "@/lib/cart/CartContext";
import { usePathname } from "next/navigation";

/* ------------------------------------------------------------------ */
/*  SupportChatConnected                                               */
/*  Thin client wrapper that bridges CartContext + route info into      */
/*  the SupportChat component. Used in the server layout.              */
/* ------------------------------------------------------------------ */

export default function SupportChatConnected() {
  const { addToCart } = useCart();
  const pathname = usePathname();

  // Extract page context from URL: /nba-top-shot/sniper → "sniper"
  const segments = pathname.split("/").filter(Boolean);
  const collectionId = segments[0] || "";
  const pageContext = segments[1] || "overview";

  // Build page label for the bot: "sniper (nba-top-shot)"
  const pageLabel = collectionId
    ? `${pageContext} (${collectionId})`
    : pageContext;

  const handleAddToCart = (moment: any) => {
    try {
      addToCart({
        ...moment,
        thumbnailUrl: moment.thumbnailUrl || null,
      });
    } catch (err) {
      console.error("Failed to add to cart from concierge:", err);
    }
  };

  return (
    <SupportChat
      pageContext={pageLabel}
      walletConnected={false}
      onAddToCart={handleAddToCart}
    />
  );
}
