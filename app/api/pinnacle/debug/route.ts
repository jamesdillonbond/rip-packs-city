// app/api/pinnacle/debug/route.ts
//
// Debug endpoint: fetches ONE listing from Flowty (offset 0, size 1)
// and returns the raw JSON response as-is for structure inspection.

import { NextResponse } from "next/server";

const FLOWTY_ENDPOINT = "https://api2.flowty.io/collection/0x0b2a3299cc857e29/TopShot";
const FLOWTY_HEADERS = {
  "Content-Type": "application/json",
  Origin: "https://www.flowty.io",
  Referer: "https://www.flowty.io/",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146 Safari/537.36",
};

export async function POST() {
  try {
    const body = {
      address: null,
      addresses: [],
      collectionFilters: [
        { collection: "0x0b2a3299cc857e29.TopShot", traits: [] },
      ],
      from: 0,
      includeAllListings: true,
      limit: 1,
      onlyUnlisted: false,
      orderFilters: [
        { conditions: [], kind: "storefront", paymentTokens: [] },
      ],
      sort: {
        direction: "desc",
        listingKind: "storefront",
        path: "blockTimestamp",
      },
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(FLOWTY_ENDPOINT, {
      method: "POST",
      headers: FLOWTY_HEADERS,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { error: `Flowty returned ${res.status}`, body: text },
        { status: 502 }
      );
    }

    const json = await res.json();
    return NextResponse.json(json);
  } catch (err) {
    return NextResponse.json(
      { error: "Fetch failed", detail: String(err) },
      { status: 500 }
    );
  }
}
