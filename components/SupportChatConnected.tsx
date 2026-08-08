"use client";

import SupportChat from "@/components/SupportChat";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

type Identity = {
  email: string | null;
  username: string | null;
  walletAddr: string | null;
};

export default function SupportChatConnected() {
  const pathname = usePathname();
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

  // ownerKey is the canonical handle for the signed-in user. The old Flow-address
  // fallback (fcl.currentUser) went with the wallet-connect removal on
  // 2026-08-08 — with no connect surface it was permanently null anyway, and
  // /api/profile/me already carries the wallet.
  const ownerKey = identity.username ?? null;
  const userWallet = identity.walletAddr ?? null;
  const signedIn = !!identity.email;

  return (
    <SupportChat
      pageContext={pageLabel}
      collectionId={collectionId || null}
      ownerKey={ownerKey}
      userWallet={userWallet}
      walletConnected={signedIn}
      signedInLabel={identity.username ?? identity.email ?? null}
    />
  );
}
