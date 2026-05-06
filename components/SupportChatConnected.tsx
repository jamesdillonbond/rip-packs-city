"use client";

import SupportChat from "@/components/SupportChat";
import { useCart } from "@/lib/cart/CartContext";
import {
  cartEligibilityReason,
  cartIneligibleTooltip,
} from "@/lib/cart/eligibility";
import { getOwnerKey, onOwnerKeyChange } from "@/lib/owner-key";
import { useFlowUser } from "@/lib/hooks/useFlowUser";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

export default function SupportChatConnected() {
  const { addToCart } = useCart();
  const pathname = usePathname();
  const { user } = useFlowUser();
  const [ownerKey, setOwnerKeyState] = useState<string>("");

  const segments = pathname.split("/").filter(Boolean);
  const collectionId = segments[0] || "";
  const pageContext = segments[1] || "overview";
  const pageLabel = collectionId ? `${pageContext} (${collectionId})` : pageContext;

  useEffect(() => {
    setOwnerKeyState(getOwnerKey());
    const unsub = onOwnerKeyChange((next) => setOwnerKeyState(next));
    return unsub;
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
      ownerKey={ownerKey || null}
      userWallet={user.addr}
      walletConnected={user.loggedIn}
      onAddToCart={handleAddToCart}
    />
  );
}
