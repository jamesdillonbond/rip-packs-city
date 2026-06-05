"use client";

// components/RefCapture.tsx
//
// Captures a ?ref=<referrer-user-uuid> off the landing URL and stashes it in
// localStorage ("rpc_ref") so it survives the user navigating to /profile and
// signing in. SignInWithDapper reads it and passes it into the fcl-verify call,
// where the server credits referral_verified to the referrer on the minted
// (genuinely-new-user) path only. Renders nothing.

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
