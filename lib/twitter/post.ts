/**
 * lib/twitter/post.ts
 *
 * Shared Twitter/X posting utility for RPC + Flowty social bots.
 * Uses X API v2 for tweets, v1.1 for media uploads.
 * OAuth 1.0a signing via the `oauth-1.0a` npm package.
 *
 * SETUP:
 *   npm install oauth-1.0a
 *
 * ENV VARS (add to Vercel):
 *   RPC_X_API_KEY, RPC_X_API_SECRET, RPC_X_ACCESS_TOKEN, RPC_X_ACCESS_SECRET
 *   FLOWTY_X_API_KEY, FLOWTY_X_API_SECRET, FLOWTY_X_ACCESS_TOKEN, FLOWTY_X_ACCESS_SECRET
 */

import OAuth from "oauth-1.0a";
import crypto from "crypto";

// ─── Types ────────────────────────────────────────────────────────

export type Brand = "rpc" | "flowty";

interface XCredentials {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
}

interface TweetResponse {
  data?: { id: string; text: string };
  errors?: Array<{ message: string; type: string }>;
}

type HeaderRecord = Record<string, string>;

// ─── Credential Loader ────────────────────────────────────────────

function getCredentials(brand: Brand): XCredentials {
  const prefix = brand === "rpc" ? "RPC" : "FLOWTY";
  const apiKey = process.env[`${prefix}_X_API_KEY`];
  const apiSecret = process.env[`${prefix}_X_API_SECRET`];
  const accessToken = process.env[`${prefix}_X_ACCESS_TOKEN`];
  const accessSecret = process.env[`${prefix}_X_ACCESS_SECRET`];

  if (!apiKey || !apiSecret || !accessToken || !accessSecret) {
    throw new Error(
      `Missing X API credentials for brand "${brand}". ` +
        `Expected env vars: ${prefix}_X_API_KEY, ${prefix}_X_API_SECRET, ` +
        `${prefix}_X_ACCESS_TOKEN, ${prefix}_X_ACCESS_SECRET`
    );
  }

  return { apiKey, apiSecret, accessToken, accessSecret };
}

// ─── OAuth Helper ─────────────────────────────────────────────────

function createOAuthClient(brand: Brand) {
  const creds = getCredentials(brand);

  const oauth = new OAuth({
    consumer: { key: creds.apiKey, secret: creds.apiSecret },
    signature_method: "HMAC-SHA1",
    hash_function(baseString: string, key: string) {
      return crypto.createHmac("sha1", key).update(baseString).digest("base64");
    },
  });

  const token = { key: creds.accessToken, secret: creds.accessSecret };

  return { oauth, token };
}

/**
 * Helper to generate an OAuth Authorization header as a plain object.
 * oauth-1.0a's toHeader() returns a `Header` type that doesn't directly
 * satisfy Record<string, string>, so we cast through unknown.
 */
function getAuthHeader(
  oauth: OAuth,
  url: string,
  method: string,
  token: { key: string; secret: string }
): HeaderRecord {
  return oauth.toHeader(
    oauth.authorize({ url, method }, token)
  ) as unknown as HeaderRecord;
}

// ─── Post Text Tweet ──────────────────────────────────────────────

/**
 * Post a text-only tweet to X.
 *
 * @param brand  - 'rpc' or 'flowty' (selects credential set)
 * @param text   - Tweet text (max 280 chars)
 * @returns      - X API response with tweet ID
 */
export async function postTweet(
  brand: Brand,
  text: string
): Promise<TweetResponse> {
  const { oauth, token } = createOAuthClient(brand);
  const url = "https://api.x.com/2/tweets";
  const authHeader = getAuthHeader(oauth, url, "POST", token);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`[twitter/post] Tweet failed (${brand}): ${res.status}`, errText);
    throw new Error(`Tweet failed: ${res.status} ${errText}`);
  }

  const data: TweetResponse = await res.json();
  console.log(`[twitter/post] Posted tweet for ${brand}: ${data.data?.id}`);
  return data;
}

// ─── Post Tweet with Media ────────────────────────────────────────

/**
 * Post a tweet with an image attachment.
 * Downloads the image from `imageUrl`, uploads via v1.1 media endpoint,
 * then attaches the media_id to a v2 tweet.
 *
 * @param brand    - 'rpc' or 'flowty'
 * @param text     - Tweet text
 * @param imageUrl - Public URL of the image (e.g. OG image endpoint)
 * @returns        - X API response with tweet ID
 */
export async function postTweetWithMedia(
  brand: Brand,
  text: string,
  imageUrl: string
): Promise<TweetResponse> {
  const { oauth, token } = createOAuthClient(brand);

  // 1. Download image to buffer
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) {
    throw new Error(`Failed to fetch image: ${imgRes.status} ${imageUrl}`);
  }
  const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
  const base64 = imgBuffer.toString("base64");

  // 2. Upload via v1.1 media/upload (form-encoded)
  const uploadUrl = "https://upload.twitter.com/1.1/media/upload.json";
  const uploadAuth = getAuthHeader(oauth, uploadUrl, "POST", token);

  const form = new URLSearchParams();
  form.append("media_data", base64);

  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      ...uploadAuth,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });

  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    console.error(`[twitter/post] Media upload failed (${brand}):`, errText);
    throw new Error(`Media upload failed: ${uploadRes.status} ${errText}`);
  }

  const uploadData = await uploadRes.json();
  const mediaId: string = uploadData.media_id_string;

  if (!mediaId) {
    throw new Error("Media upload succeeded but no media_id_string returned");
  }

  console.log(`[twitter/post] Uploaded media for ${brand}: ${mediaId}`);

  // 3. Post tweet with media attached
  const tweetUrl = "https://api.x.com/2/tweets";
  const tweetAuth = getAuthHeader(oauth, tweetUrl, "POST", token);

  const res = await fetch(tweetUrl, {
    method: "POST",
    headers: {
      ...tweetAuth,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      media: { media_ids: [mediaId] },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`[twitter/post] Tweet+media failed (${brand}):`, errText);
    throw new Error(`Tweet+media failed: ${res.status} ${errText}`);
  }

  const data: TweetResponse = await res.json();
  console.log(`[twitter/post] Posted tweet+media for ${brand}: ${data.data?.id}`);
  return data;
}

// ─── Post Thread (2-tweet max) ────────────────────────────────────

/**
 * Post a 2-tweet thread. First tweet posts normally, second replies to it.
 * Useful for City Report threads or extended deal analysis.
 *
 * @param brand   - 'rpc' or 'flowty'
 * @param tweets  - Array of 1-2 tweet texts
 * @returns       - Array of X API responses
 */
export async function postThread(
  brand: Brand,
  tweets: string[]
): Promise<TweetResponse[]> {
  if (tweets.length === 0) throw new Error("Thread must have at least 1 tweet");

  const results: TweetResponse[] = [];

  // Post first tweet
  const first = await postTweet(brand, tweets[0]);
  results.push(first);

  // Post reply if there's a second tweet
  if (tweets.length > 1 && first.data?.id) {
    const { oauth, token } = createOAuthClient(brand);
    const url = "https://api.x.com/2/tweets";
    const authHeader = getAuthHeader(oauth, url, "POST", token);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: tweets[1],
        reply: { in_reply_to_tweet_id: first.data.id },
      }),
    });

    if (res.ok) {
      results.push(await res.json());
    } else {
      console.error("[twitter/post] Thread reply failed:", await res.text());
    }
  }

  return results;
}