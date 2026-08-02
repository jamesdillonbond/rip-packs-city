import { promises as fs } from "fs"
import path from "path"
import { getOrSetCache } from "@/lib/cache"

const TTL_MS = 1000 * 60 * 5

export async function loadLocalJsonFeed<T>(filename: string): Promise<T[]> {
  const cacheKey = `local-json-feed:${filename}`

  return getOrSetCache(cacheKey, TTL_MS, async () => {
    const filePath = path.join(process.cwd(), "public", filename)

    try {
      const raw = await fs.readFile(filePath, "utf8")
      const parsed = JSON.parse(raw) as unknown

      if (!Array.isArray(parsed)) {
        return []
      }

      return parsed as T[]
    } catch {
      return []
    }
  })
}