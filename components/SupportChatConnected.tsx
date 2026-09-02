"use client";

import SupportChat from "@/components/SupportChat";
import { getCollection } from "@/lib/collections";
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

  // ⚠ This derivation used to assume every route is /<collection>/<page>, which
  // was true while the chat only lived under (collections) and (analytics).
  // The 2026-09-02 public mounts (/insights/*, home, /about, /blog,
  // /early-access) broke that assumption in two ways that both reached the
  // model: /insights/squeeze reported pageContext "squeeze (insights)" AND
  // collectionId "insights" — a slug no collection has, so every tool that
  // defaults to "the page's active collection" resolved it to a null UUID —
  // and home reported itself as plain "overview", which is the key for a
  // COLLECTION overview page, so a first-time anonymous visitor was handed the
  // Top Shot overview's quick-suggestion pills.
  // The rule now: a first segment is a collection only if lib/collections.ts
  // says so. Everything else gets an honest label and a null collectionId.
  const segments = pathname.split("/").filter(Boolean);
  const maybeCollection = segments[0] || "";
  const isCollectionRoute = !!maybeCollection && !!getCollection(maybeCollection);

  let collectionId = "";
  let pageLabel: string;
  if (isCollectionRoute) {
    collectionId = maybeCollection;
    pageLabel = `${segments[1] || "overview"} (${collectionId})`;
  } else if (maybeCollection === "insights") {
    // Keep the "(insights)" suffix: SupportChat's PAGE_DEFAULTS lookup splits on
    // "(" and the board name alone would collide with collection page keys
    // ("market" is both an insights board and a per-collection tab).
    pageLabel = `${segments[1] || "index"} (insights)`;
  } else if (segments.length === 0) {
    pageLabel = "home";
  } else {
    pageLabel = segments.join("/");
  }

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
