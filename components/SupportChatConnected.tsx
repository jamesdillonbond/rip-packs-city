"use client";

import SupportChat from "@/components/SupportChat";
import { useCart } from "@/lib/cart/CartContext";
import {
  cartEligibilityReason,
  cartIneligibleTooltip,
} from "@/lib/cart/eligibility";
import { useFlowUser } from "@/lib/hooks/useFlowUser";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

type Identity = {
  email: string | null;
  username: string | null;
  walletAddr: string | null;
};

export default function SupportChatConnected() {
  const { addToCart } = useCart();
  const pathname = usePathname();
  const { user } = useFlowUser();
  const [identity, setIdentity] = useState<Identity>({
    email: null,
    username: null,
    walletAddr: null,
  });

  const segments = pathname.split("/").filter(Boolean);
  const collectionId = segments[0] || "";
  const pageContext = segments[1] || "overview";
  const pageLabel = collectionId ? `${pageContext} (${collectionId})` : pageContext;

  // Pull the canonical identity from the cookie-backed /api/profile/me. The
  // server is the trust boundary for support_conversations rows; this fetch
  // exists so the client UI can show "signed in as {username}" without
  // claiming Flow-wallet connection state.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/profile/me", { cache: "no-store", credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return;
        const u = d?.user;
        if (!u) {
          setIdentity({ email: null, username: null, walletAddr: null });
          return;
        }
        setIdentity({
          email: u.email ?? null,
          username: u.username ?? null,
          walletAddr: u.wallet_addr ?? null,
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pathname]);

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
      console.error("[concierge] add to cart failed:", err);
    }
  };

  // ownerKey defaults to the allow_list username (the canonical handle for the
  // signed-in user). Fall back to the Flow address only when no username has
  // been linked yet so the bot can still address them by something.
  const ownerKey = identity.username ?? user.addr ?? null;
  const userWallet = identity.walletAddr ?? user.addr ?? null;
  const signedIn = !!identity.email;

  return (
    <SupportChat
      pageContext={pageLabel}
      collectionId={collectionId || null}
      ownerKey={ownerKey}
      userWallet={userWallet}
      walletConnected={signedIn || user.loggedIn}
      signedInLabel={identity.username ?? identity.email ?? null}
      onAddToCart={handleAddToCart}
    />
  );
}
