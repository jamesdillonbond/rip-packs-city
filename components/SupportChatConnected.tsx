"use client";

import SupportChat from "@/components/SupportChat";
import { useCart } from "@/lib/cart/CartContext";
import {
  cartEligibilityReason,
  cartIneligibleTooltip,
} from "@/lib/cart/eligibility";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

/* ------------------------------------------------------------------ */
/*  SupportChatConnected                                               */
/*  Thin client wrapper that bridges CartContext + route info into      */
/*  the SupportChat component. Also fetches userEmail so the concierge  */
/*  can greet signed-in users by identity.                             */
/* ------------------------------------------------------------------ */

export default function SupportChatConnected() {
  const { addToCart } = useCart();
  const pathname = usePathname();
  const [userEmail, setUserEmail] = useState<string | null>(null);

  // Extract collection + page from URL: /nba-top-shot/sniper → "sniper (nba-top-shot)"
  const segments = pathname.split("/").filter(Boolean);
  const collectionId = segments[0] || "";
  const pageContext = segments[1] || "overview";
  const pageLabel = collectionId ? `${pageContext} (${collectionId})` : pageContext;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/profile/me", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setUserEmail(data?.user?.email ?? null);
      } catch {
        /* not signed in or network failure — stay null */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAddToCart = (moment: any) => {
    try {
      const reason = cartEligibilityReason({
        listingResourceID: moment.listingResourceID,
        storefrontAddress: moment.storefrontAddress,
        expectedPrice: moment.expectedPrice,
        source: moment.source,
        paymentToken: moment.paymentToken,
      });
      if (reason !== "ok") {
        console.warn(
          "[concierge] skipping ineligible listing:",
          cartIneligibleTooltip(reason),
          moment
        );
        return;
      }
      addToCart({ ...moment, thumbnailUrl: moment.thumbnailUrl || null });
    } catch (err) {
      console.error("Failed to add to cart from concierge:", err);
    }
  };

  return (
    <SupportChat
      pageContext={pageLabel}
      collectionId={collectionId || null}
      userEmail={userEmail}
      walletConnected={false}
      onAddToCart={handleAddToCart}
    />
  );
}
