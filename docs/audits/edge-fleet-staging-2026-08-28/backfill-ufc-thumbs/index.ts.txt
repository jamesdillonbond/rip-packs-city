import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const UFC_COLLECTION_ID = "9b4824a8-736d-4a96-b450-8dcc0c46b023";
const FLOW_API = "https://rest-mainnet.onflow.org/v1/scripts";

function b64(s: string): string { return btoa(unescape(encodeURIComponent(s))); }
function argB64(obj: any): string { return btoa(JSON.stringify(obj)); }

async function runScript(script: string, args: string[]): Promise<any> {
  const res = await fetch(`${FLOW_API}?block_height=final`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ script: b64(script), arguments: args }),
  });
  if (!res.ok) throw new Error(`Flow ${res.status}`);
  const raw = await res.text();
  return JSON.parse(atob(raw.replace(/[\r\n"]/g, "")));
}

// Minimal script — just get Display thumbnail
const GET_THUMB = `
import NonFungibleToken from 0x1d7e57aa55817448
import MetadataViews from 0x1d7e57aa55817448
import UFC_NFT from 0x329feb3ab062d289

access(all) fun main(addr: Address, id: UInt64): String {
  let acct = getAccount(addr)
  let ref = acct.capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(UFC_NFT.CollectionPublicPath)!
  let nft = ref.borrowNFT(id)!
  if let display = nft.resolveView(Type<MetadataViews.Display>()) {
    let d = display as! MetadataViews.Display
    return d.thumbnail.uri()
  }
  return ""
}
`;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  const wallet = url.searchParams.get("wallet") || "0xbd94cade097e50ac";
  const authToken = Deno.env.get("INGEST_SECRET_TOKEN") || "";
  if (authToken && token !== authToken) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Get editions missing thumbnails
  const { data: editions } = await supabase
    .from("editions")
    .select("id, external_id")
    .eq("collection_id", UFC_COLLECTION_ID)
    .is("thumbnail_url", null)
    .limit(200);

  if (!editions?.length) return new Response(JSON.stringify({ ok: true, message: "All editions have thumbnails", remaining: 0 }));

  // For each edition, find one moment from wallet cache
  const editionToMoment = new Map<string, { editionId: string; momentId: string }>();
  for (const ed of editions) {
    const { data: moment } = await supabase
      .from("wallet_moments_cache")
      .select("moment_id")
      .eq("collection_id", UFC_COLLECTION_ID)
      .eq("edition_key", ed.external_id)
      .limit(1)
      .single();
    if (moment) {
      editionToMoment.set(ed.external_id, { editionId: ed.id, momentId: moment.moment_id });
    }
  }

  // Fetch thumbnails via Cadence (5 concurrent)
  const CONC = 5;
  let updated = 0, errors = 0;
  const entries = Array.from(editionToMoment.entries());
  const sampleData: any[] = [];

  for (let i = 0; i < entries.length; i += CONC) {
    const batch = entries.slice(i, i + CONC);
    const results = await Promise.allSettled(batch.map(async ([extId, { editionId, momentId }]) => {
      const result = await runScript(GET_THUMB, [
        argB64({ type: "Address", value: wallet }),
        argB64({ type: "UInt64", value: momentId }),
      ]);
      const thumbUrl = result?.value ?? "";
      if (thumbUrl) {
        await supabase.from("editions").update({ thumbnail_url: thumbUrl }).eq("id", editionId);
        return { extId, thumbUrl, momentId };
      }
      return null;
    }));

    for (const r of results) {
      if (r.status === "fulfilled" && r.value) {
        updated++;
        if (sampleData.length < 5) sampleData.push({ edition: r.value.extId, thumb: r.value.thumbUrl.substring(0, 60) });
      } else {
        errors++;
      }
    }
    if (i + CONC < entries.length) await sleep(200);
  }

  const remaining = editions.length - editionToMoment.size;

  return new Response(JSON.stringify({
    ok: true,
    editionsWithoutThumb: editions.length,
    momentsFound: editionToMoment.size,
    thumbnailsUpdated: updated,
    errors,
    noMomentMatch: remaining,
    sampleData,
  }), { headers: { "Content-Type": "application/json" } });
});
