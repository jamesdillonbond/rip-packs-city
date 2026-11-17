"use client";

// components/RefCapture.tsx
//
// Captures a ?ref=<referrer-user-uuid> off the landing URL and stashes it in
// localStorage ("rpc_ref") so it survives the user navigating to /profile and
// signing in. The dashboard's verify step reads it and passes it into the
// listing-challenge check, where the server credits referral_verified to the
// referrer. Renders nothing.
//
// (It used to travel via SignInWithDapper → fcl-verify; that wallet-connect path
// was removed 2026-08-08 and the listing challenge is now the only consumer.)

import { useEffect } from "react";

export default function RefCapture() {
  useEffect(() => {
    try {
      const ref = new URLSearchParams(window.location.search).get("ref");
      if (ref && /^[0-9a-f-]{36}$/i.test(ref) && !localStorage.getItem("rpc_ref")) {
        localStorage.setItem("rpc_ref", ref);
      }
    } catch {
      // localStorage / URL parsing can throw in private mode — non-fatal.
    }
  }, []);
  return null;
}
