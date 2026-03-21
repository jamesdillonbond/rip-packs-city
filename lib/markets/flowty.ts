export type FlowtyQuote = {
  momentId: string;
  flowtyAsk: number | null;
  listingUrl: string | null;
  updatedAt: string | null;
};

async function getFlowtyQuoteForMoment(momentId: string): Promise<FlowtyQuote> {
  const prerenderUrl = `https://bot-page-prerender.flowty.io/asset/0x0b2a3299cc857e29/TopShot/NFT/${momentId}`;
  const listingUrl = `https://www.flowty.io/asset/0x0b2a3299cc857e29/TopShot/NFT/${momentId}`;

  try {
    const response = await fetch(prerenderUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 sports-collectible-tool/0.1",
      },
      cache: "no-store",
    });

    if (!response.ok) {
      return {
        momentId,
        flowtyAsk: null,
        listingUrl,
        updatedAt: new Date().toISOString(),
      };
    }

    const html = await response.text();

    const prices = [...html.matchAll(/\$([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?)/g)]
      .map((match) => Number(match[1].replace(/,/g, "")))
      .filter((value) => Number.isFinite(value));

    const lowestAsk = prices.length > 0 ? Math.min(...prices) : null;

    return {
      momentId,
      flowtyAsk: lowestAsk,
      listingUrl,
      updatedAt: new Date().toISOString(),
    };
  } catch {
    return {
      momentId,
      flowtyAsk: null,
      listingUrl,
      updatedAt: null,
    };
  }
}

export async function getFlowtyQuotes(
  momentIds: string[]
): Promise<FlowtyQuote[]> {
  const settled = await Promise.allSettled(
    momentIds.map((momentId) => getFlowtyQuoteForMoment(momentId))
  );

  return settled.map((result, index) => {
    if (result.status === "fulfilled") {
      return result.value;
    }

    const momentId = momentIds[index];
    return {
      momentId,
      flowtyAsk: null,
      listingUrl: `https://www.flowty.io/asset/0x0b2a3299cc857e29/TopShot/NFT/${momentId}`,
      updatedAt: null,
    };
  });
}