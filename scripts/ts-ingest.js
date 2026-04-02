#!/usr/bin/env node
"use strict";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FLOWTY_ENDPOINT = "https://api2.flowty.io/collection/0x0b2a3299cc857e29/TopShot";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

(async () => {
  try {
    const res = await fetch(FLOWTY_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": "https://www.flowty.io",
        "Referer": "https://www.flowty.io/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146 Safari/537.36",
      },
      body: JSON.stringify({ from: 0, size: 3, filters: {}, sort: [{ field: "updated_at", order: "desc" }] }),
      signal: AbortSignal.timeout(12000),
    });
    console.log("Status:", res.status);
    const json = await res.json();
    const nfts = json?.nfts ?? json?.data ?? json?.items ?? [];
    console.log("Top-level keys:", Object.keys(json).join(", "));
    console.log("NFT count:", nfts.length);
    if (nfts.length > 0) {
      const first = nfts[0];
      console.log("First NFT keys:", Object.keys(first).join(", "));
      console.log("First NFT sample:", JSON.stringify(first).slice(0, 800));
    } else {
      console.log("Full response:", JSON.stringify(json).slice(0, 800));
    }
  } catch (err) {
    console.error("Failed:", err.message);
    process.exit(1);
  }
})();
