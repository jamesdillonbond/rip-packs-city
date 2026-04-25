// lib/flowty-tx-classifier.ts
//
// Pure-function classifier for failed Flow transactions touching the Flowty
// or Dapper NFTStorefrontV2 surface. Used by app/api/flowty-tx-scanner to
// tag rows in the flowty_transactions table.

export type FailureCategory =
  | "STORAGE_CAPACITY_EXCEEDED"
  | "STOREFRONT_NOT_INITIALIZED"
  | "MISSING_COLLECTION_CAPABILITY"
  | "NFT_NOT_IN_STORAGE"
  | "LISTING_NOT_FOUND"
  | "LISTING_ALREADY_PURCHASED"
  | "PRICE_DRIFT"
  | "INSUFFICIENT_BALANCE"
  | "MISSING_DUC_VAULT"
  | "EXPIRED_LISTING"
  | "AUTH_FAILURE"
  | "PRECONDITION_FAILED"
  | "CADENCE_RUNTIME_ERROR"
  | "UNKNOWN_FAILURE"

export type Collection =
  | "topshot"
  | "allday"
  | "golazos"
  | "ufc"
  | "pinnacle"
  | "unknown"

// Order matters — most specific patterns first.
const RULES: Array<{ category: FailureCategory; pattern: RegExp }> = [
  {
    category: "STORAGE_CAPACITY_EXCEEDED",
    pattern:
      /storage capacity (?:exceeded|is)|storage used.*greater than.*capacity|account.*storage.*used.*storage.*capacity|storage.*limit.*reached/i,
  },
  {
    category: "STOREFRONT_NOT_INITIALIZED",
    pattern:
      /(?:could not|cannot|failed to) borrow.*Storefront|Storefront.*not.*(?:initialized|exist|found)|missing.*Storefront resource/i,
  },
  {
    category: "MISSING_DUC_VAULT",
    pattern:
      /(?:could not|cannot) borrow.*DapperUtilityCoin|dapperUtilityCoinVault.*(?:not.*found|missing)|DUC.*(?:vault|receiver).*(?:missing|not.*found)|missing.*dapperUtilityCoin/i,
  },
  {
    category: "MISSING_COLLECTION_CAPABILITY",
    pattern:
      /(?:could not|cannot|failed to) borrow.*(?:&\{?)?(?:NonFungibleToken\.)?Collection|Collection.*capability.*not.*(?:found|published)|missing.*Collection.*capability/i,
  },
  {
    category: "NFT_NOT_IN_STORAGE",
    pattern:
      /(?:could not|cannot) borrow.*NFT|NFT.*(?:does not exist|not.*found|missing)|missing reference to NFT|specified NFT.*not.*owned/i,
  },
  {
    category: "LISTING_NOT_FOUND",
    pattern:
      /(?:could not|cannot) (?:find|borrow).*[Ll]isting|listing.*(?:not.*found|does not exist|removed)|no listing with id/i,
  },
  {
    category: "LISTING_ALREADY_PURCHASED",
    pattern:
      /listing.*already.*purchased|already.*purchased|listing.*has been.*completed/i,
  },
  {
    category: "PRICE_DRIFT",
    pattern:
      /price.*(?:does not match|differs|changed)|expected price|price.*assertion.*failed|sale price.*mismatch/i,
  },
  {
    category: "INSUFFICIENT_BALANCE",
    pattern:
      /insufficient.*(?:balance|funds)|balance.*(?:not enough|too low)|amount.*greater than.*balance|cannot withdraw.*balance/i,
  },
  {
    category: "EXPIRED_LISTING",
    pattern: /listing.*expired|expir(?:y|ed).*passed|past.*expir/i,
  },
  {
    category: "AUTH_FAILURE",
    pattern:
      /\[Error Code:\s*1055\]|invalid.*signature|authentication.*failed|signature.*verification/i,
  },
  {
    category: "PRECONDITION_FAILED",
    pattern: /pre-condition.*failed|precondition.*failed/i,
  },
  {
    category: "CADENCE_RUNTIME_ERROR",
    pattern: /\[Error Code:\s*1101\]/i,
  },
]

/**
 * Classify a Flow transaction error message into a failure category.
 * Subcategory is the source location (e.g. "0b2a3299cc857e29.FastBreakV1:428")
 * extracted from the error trace, or null if absent.
 */
export function classifyError(msg: string | null | undefined): {
  category: FailureCategory
  subcategory: string | null
} {
  if (!msg || typeof msg !== "string") {
    return { category: "UNKNOWN_FAILURE", subcategory: null }
  }
  const locMatch = msg.match(/([0-9a-f]{16}\.\w+):(\d+)/i)
  const subcategory = locMatch ? `${locMatch[1]}:${locMatch[2]}` : null

  for (const rule of RULES) {
    if (rule.pattern.test(msg)) {
      return { category: rule.category, subcategory }
    }
  }
  if (/\[Error Code:\s*1101\]/i.test(msg)) {
    return { category: "CADENCE_RUNTIME_ERROR", subcategory }
  }
  return { category: "UNKNOWN_FAILURE", subcategory }
}

const COLLECTION_ADDRESSES: Array<{ collection: Collection; addr: string }> = [
  { collection: "topshot", addr: "0b2a3299cc857e29" },
  { collection: "allday", addr: "e4cf4bdc1751c65d" },
  { collection: "golazos", addr: "87ca73a41bb50ad5" },
  { collection: "ufc", addr: "329feb3ab062d289" },
  { collection: "pinnacle", addr: "edf9df96c92f4595" },
]

/**
 * Infer which collection a transaction targets from its script content.
 */
export function inferCollection(script: string | null | undefined): Collection {
  if (!script) return "unknown"
  const lower = script.toLowerCase()
  for (const { collection, addr } of COLLECTION_ADDRESSES) {
    if (lower.includes(addr)) return collection
  }
  return "unknown"
}

/**
 * Infer collection from a transaction's emitted events. Flowty's ListingCompleted
 * event carries an `nftType` field with the authoritative type string
 * (e.g. "A.0b2a3299cc857e29.TopShot.NFT"). Used for successful purchases where
 * the script imports the generic NFT interface and never references the
 * collection contract directly.
 *
 * Returns "unknown" if no usable ListingCompleted event found.
 */
export function inferCollectionFromEvents(
  events: Array<{ type: string; payload?: string }> | undefined | null,
): Collection {
  if (!events || events.length === 0) return "unknown"

  for (const e of events) {
    if (
      !/^A\.(3cdbb3d569211ff3|4eb8a10cb9f87357)\.NFTStorefrontV2\.ListingCompleted$/i.test(
        e.type,
      )
    ) {
      continue
    }
    if (!e.payload) continue

    try {
      const decoded = JSON.parse(
        Buffer.from(e.payload, "base64").toString("utf8"),
      )
      const fields = decoded?.value?.fields ?? []
      const nftTypeField = fields.find(
        (f: { name?: string }) => f?.name === "nftType",
      )
      if (!nftTypeField) continue

      // Flowty fork emits nftType as plain String; Dapper emits as Type
      const v = nftTypeField.value
      let typeStr: string | null = null
      if (v?.type === "String") {
        typeStr = String(v.value ?? "")
      } else if (v?.type === "Type") {
        typeStr = String(v.value?.staticType?.typeID ?? "")
      }
      if (!typeStr) continue

      // typeStr is like "A.0b2a3299cc857e29.TopShot.NFT"
      const m = typeStr.match(/^A\.([0-9a-f]{16})\./i)
      if (!m) continue
      const addr = m[1].toLowerCase()
      for (const known of COLLECTION_ADDRESSES) {
        if (addr === known.addr) return known.collection
      }
    } catch {
      // Continue to next event
    }
  }
  return "unknown"
}

export const FLOWTY_STOREFRONT_ADDR = "3cdbb3d569211ff3"
export const DAPPER_STOREFRONT_ADDR = "4eb8a10cb9f87357"

/**
 * Returns the storefront address (0x-prefixed) the script imports, or null.
 */
export function detectStorefront(
  script: string | null | undefined,
): string | null {
  if (!script) return null
  const lower = script.toLowerCase()
  if (lower.includes(FLOWTY_STOREFRONT_ADDR)) return `0x${FLOWTY_STOREFRONT_ADDR}`
  if (lower.includes(DAPPER_STOREFRONT_ADDR)) return `0x${DAPPER_STOREFRONT_ADDR}`
  return null
}

/**
 * Extract every "import X from 0xADDR" address from a Cadence script.
 * Returns a deduped array of 0x-prefixed lowercase 16-hex addresses.
 */
export function extractImportedAddresses(
  script: string | null | undefined,
): string[] {
  if (!script) return []
  const re = /from\s+(0x[0-9a-fA-F]{16})/g
  const set = new Set<string>()
  for (const m of script.matchAll(re)) {
    set.add(m[1].toLowerCase())
  }
  return Array.from(set)
}
