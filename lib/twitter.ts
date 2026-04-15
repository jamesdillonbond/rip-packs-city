// lib/twitter.ts
// Simplified Twitter/X v2 client for the RPC bot endpoints.
// Wraps lib/twitter/post.ts with a single-brand interface, the
// TWITTER_BOT_ENABLED kill-switch, and graceful 429 handling.

import { postTweet as basePostTweet } from "@/lib/twitter/post"

const MAX_TWEET_LEN = 280

export type PostedTweet = { id: string; text: string }

function isEnabled(): boolean {
  return process.env.TWITTER_BOT_ENABLED === "true"
}

export async function postTweet(text: string): Promise<PostedTweet | null> {
  const trimmed = text.length > MAX_TWEET_LEN ? text.slice(0, MAX_TWEET_LEN - 1) + "…" : text

  if (!isEnabled()) {
    console.log(`[twitter] Bot disabled, would post: ${trimmed}`)
    return null
  }

  try {
    const res = await basePostTweet("rpc", trimmed)
    if (res?.data?.id) return { id: res.data.id, text: res.data.text }
    return null
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("429")) {
      console.warn("[twitter] Rate limited, skipping post")
      return null
    }
    console.error("[twitter] Post failed:", msg)
    return null
  }
}

/** Post a reply tweet that targets `inReplyToId`. Returns null on failure. */
export async function postReply(text: string, inReplyToId: string): Promise<PostedTweet | null> {
  if (!isEnabled()) {
    console.log(`[twitter] Bot disabled, would reply to ${inReplyToId}: ${text}`)
    return null
  }
  // Use the underlying base postTweet path with a reply field via direct fetch
  // Implemented inline to avoid expanding lib/twitter/post.ts surface.
  const trimmed = text.length > MAX_TWEET_LEN ? text.slice(0, MAX_TWEET_LEN - 1) + "…" : text
  try {
    const OAuth = (await import("oauth-1.0a")).default
    const crypto = await import("crypto")
    const apiKey = process.env.RPC_X_API_KEY!
    const apiSecret = process.env.RPC_X_API_SECRET!
    const accessToken = process.env.RPC_X_ACCESS_TOKEN!
    const accessSecret = process.env.RPC_X_ACCESS_SECRET!
    const oauth = new OAuth({
      consumer: { key: apiKey, secret: apiSecret },
      signature_method: "HMAC-SHA1",
      hash_function: (b: string, k: string) => crypto.createHmac("sha1", k).update(b).digest("base64"),
    })
    const url = "https://api.x.com/2/tweets"
    const token = { key: accessToken, secret: accessSecret }
    const authHeader = oauth.toHeader(oauth.authorize({ url, method: "POST" }, token)) as unknown as Record<string, string>

    const res = await fetch(url, {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ text: trimmed, reply: { in_reply_to_tweet_id: inReplyToId } }),
    })
    if (res.status === 429) {
      console.warn("[twitter] Rate limited on reply")
      return null
    }
    if (!res.ok) {
      console.error(`[twitter] Reply failed: ${res.status} ${await res.text()}`)
      return null
    }
    const json = await res.json()
    return json?.data ? { id: json.data.id, text: json.data.text } : null
  } catch (err) {
    console.error("[twitter] Reply error:", err instanceof Error ? err.message : String(err))
    return null
  }
}
