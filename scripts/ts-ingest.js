#!/usr/bin/env node
"use strict";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TS_GQL = "https://public-api.nbatopshot.com/graphql";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

// Introspect the MomentListing type to find all available fields
const INTROSPECT_QUERY = `{
  __type(name: "MomentListing") {
    name
    fields {
      name
      type {
        name
        kind
        ofType { name kind }
      }
    }
  }
}`;

(async () => {
  try {
    console.log("Introspecting MomentListing type...");
    const res = await fetch(TS_GQL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        "Accept": "application/json",
        "Origin": "https://nbatopshot.com",
        "Referer": "https://nbatopshot.com/",
      },
      body: JSON.stringify({ query: INTROSPECT_QUERY }),
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    console.log("Response status:", res.status);
    console.log("MomentListing fields:");
    const json = JSON.parse(text);
    const fields = json?.data?.__type?.fields ?? [];
    fields.forEach(f => {
      const typeName = f.type?.ofType?.name ?? f.type?.name ?? f.type?.kind;
      console.log(`  ${f.name}: ${typeName}`);
    });
    if (fields.length === 0) {
      console.log("Raw response:", text.slice(0, 1000));
    }
  } catch (err) {
    console.error("Failed:", err.message);
    process.exit(1);
  }
})();
