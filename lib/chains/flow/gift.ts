// lib/chains/flow/gift.ts  (server-only)
//
// Server-side reads for the parent-signed gifting flow. All on-chain reads go
// through the hybrid-custody-proxy worker (POST /script) — never direct to a
// Flow endpoint, and the proxy secret is never returned to the client.
//
// Two reads:
//   runLinkedChildren(parent)                     -> child addresses, live on-chain
//   runGiftQuote(parent, child, momentID, recip)  -> the 5 gift preconditions
//
// Both are verified against the live deployed contracts (see
// docs/design/parent-signed-gifting-fcl-flow-2026-07-13.md).

const PROXY_URL =
  process.env.HYBRID_CUSTODY_PROXY_URL ??
  "https://hybrid-custody-proxy.tdillonbond.workers.dev";
// The proxy secret == INGEST_SECRET_TOKEN (single rotation surface, per the
// worker README). HYBRID_CUSTODY_PROXY_SECRET wins if explicitly set.
const PROXY_SECRET =
  process.env.HYBRID_CUSTODY_PROXY_SECRET ?? process.env.INGEST_SECRET_TOKEN ?? "";

const PER_CALL_TIMEOUT_MS = 15_000;

// --- Cadence reads -----------------------------------------------------------

const LINKED_CHILDREN_SCRIPT = `
import HybridCustody from 0xd8a7e05a7ac670c0
access(all) fun main(parent: Address): [Address] {
    let mgr = getAuthAccount<auth(Storage) &Account>(parent).storage
        .borrow<&HybridCustody.Manager>(from: HybridCustody.ManagerStoragePath)
    if mgr == nil { return [] }
    return mgr!.getChildAddresses()
}
`;

const GIFT_QUOTE_SCRIPT = `
import HybridCustody from 0xd8a7e05a7ac670c0
import NonFungibleToken from 0x1d7e57aa55817448
import TopShot from 0x0b2a3299cc857e29

access(all) fun main(parent: Address, child: Address, momentID: UInt64, recipient: Address): {String: AnyStruct} {
    let out: {String: AnyStruct} = {}
    let provType = Type<auth(NonFungibleToken.Withdraw) &{NonFungibleToken.Provider}>()

    let mgr = getAuthAccount<auth(Storage) &Account>(parent).storage
        .borrow<auth(HybridCustody.Manage) &HybridCustody.Manager>(from: HybridCustody.ManagerStoragePath)
    if mgr == nil { out["parent_has_manager"] = false; return out }
    out["parent_has_manager"] = true
    let children = mgr!.getChildAddresses()
    out["child_is_linked"] = children.contains(child)
    if !children.contains(child) { return out }

    let childAcct = mgr!.borrowAccount(addr: child)
    if childAcct == nil { out["child_borrowable"] = false; return out }

    let cAcct = getAuthAccount<auth(Capabilities, Storage) &Account>(child)
    let controllers = cAcct.capabilities.storage.getControllers(forPath: /storage/MomentCollection)
    var provControllerID: UInt64? = nil
    for con in controllers {
        if con.capability.check<auth(NonFungibleToken.Withdraw) &{NonFungibleToken.Provider}>() {
            provControllerID = con.capabilityID
            break
        }
    }
    if provControllerID == nil { out["provider_controller_exists"] = false; out["withdraw_permitted"] = false; return out }
    out["provider_controller_exists"] = true
    out["provider_controller_id"] = provControllerID!

    let cap = childAcct!.getCapability(controllerID: provControllerID!, type: provType)
    out["withdraw_permitted"] = cap != nil

    let sCol = getAuthAccount<auth(Storage) &Account>(child).storage
        .borrow<&{NonFungibleToken.Collection}>(from: /storage/MomentCollection)
    out["child_owns_moment"] = sCol != nil ? (sCol!.borrowNFT(momentID) != nil) : false

    let recv = getAccount(recipient).capabilities
        .borrow<&{NonFungibleToken.Receiver}>(/public/MomentCollection)
    out["recipient_ready"] = recv != nil ? (recv!.getSupportedNFTTypes()[Type<@TopShot.NFT>()] ?? false) : false

    return out
}
`;

// --- JSON-CDC helpers --------------------------------------------------------

type CdcArg = { type: string; value: unknown };

function encodeArg(a: CdcArg): string {
  return Buffer.from(JSON.stringify(a)).toString("base64");
}

// Flow REST /v1/scripts returns either a raw base64 string or {"value":"<b64>"}.
function extractResultB64(rawText: string): string | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
      if (parsed && typeof parsed === "object" && typeof (parsed as any).value === "string") {
        return (parsed as any).value;
      }
      return null;
    } catch {
      /* fall through: raw base64 */
    }
  }
  return trimmed;
}

async function callProxyScript(script: string, args: CdcArg[]): Promise<any> {
  if (!PROXY_SECRET) throw new Error("gift_proxy_secret_unconfigured");
  const res = await fetch(`${PROXY_URL}/script`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${PROXY_SECRET}`,
    },
    body: JSON.stringify({
      script: Buffer.from(script).toString("base64"),
      arguments: args.map(encodeArg),
    }),
    signal: AbortSignal.timeout(PER_CALL_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`proxy_http_${res.status}:${text.slice(0, 200)}`);
  }
  const b64 = extractResultB64(text);
  if (!b64) throw new Error(`no_result_b64:${text.slice(0, 120)}`);
  return JSON.parse(Buffer.from(b64, "base64").toString());
}

// Decode a JSON-CDC {String: AnyStruct} Dictionary into a plain object of
// primitive values (Bool -> boolean, Int/UInt64 -> string, Address -> string).
function decodeDict(node: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!node || node.type !== "Dictionary" || !Array.isArray(node.value)) return out;
  for (const kv of node.value) {
    const key = kv?.key?.value;
    if (typeof key !== "string") continue;
    out[key] = kv?.value?.value;
  }
  return out;
}

// --- Public API --------------------------------------------------------------

export async function runLinkedChildren(parent: string): Promise<string[]> {
  const node = await callProxyScript(LINKED_CHILDREN_SCRIPT, [{ type: "Address", value: parent }]);
  if (!node || node.type !== "Array" || !Array.isArray(node.value)) return [];
  return node.value
    .filter((n: any) => n?.type === "Address" && typeof n.value === "string")
    .map((n: any) => String(n.value).toLowerCase());
}

export interface GiftQuoteChain {
  parentHasManager: boolean;
  childIsLinked: boolean;
  providerControllerExists: boolean;
  providerControllerID: number | null;
  withdrawPermitted: boolean;
  childOwnsMoment: boolean;
  recipientReady: boolean;
}

export async function runGiftQuote(
  parent: string,
  child: string,
  momentID: string,
  recipient: string,
): Promise<GiftQuoteChain> {
  const node = await callProxyScript(GIFT_QUOTE_SCRIPT, [
    { type: "Address", value: parent },
    { type: "Address", value: child },
    { type: "UInt64", value: String(momentID) },
    { type: "Address", value: recipient },
  ]);
  const d = decodeDict(node);
  const cid = d["provider_controller_id"];
  return {
    parentHasManager: d["parent_has_manager"] === true,
    childIsLinked: d["child_is_linked"] === true,
    providerControllerExists: d["provider_controller_exists"] === true,
    providerControllerID: typeof cid === "string" ? Number(cid) : cid == null ? null : Number(cid),
    withdrawPermitted: d["withdraw_permitted"] === true,
    childOwnsMoment: d["child_owns_moment"] === true,
    recipientReady: d["recipient_ready"] === true,
  };
}

// First failing precondition -> a stable machine reason for the client.
export function quoteFailureReason(q: GiftQuoteChain): string | null {
  if (!q.parentHasManager) return "no_manager";
  if (!q.childIsLinked) return "not_your_link";
  if (!q.providerControllerExists || !q.withdrawPermitted) return "withdraw_not_permitted";
  if (!q.childOwnsMoment) return "moment_not_owned";
  if (!q.recipientReady) return "recipient_needs_setup";
  return null;
}
