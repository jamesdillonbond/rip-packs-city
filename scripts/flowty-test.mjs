const res = await fetch("https://api2.flowty.io/collection/0xedf9df96c92f4595/Pinnacle", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    address: null,
    addresses: [],
    collectionFilters: [{ collection: "0xedf9df96c92f4595.Pinnacle", traits: [] }],
    from: 0,
    includeAllListings: true,
    limit: 1,
    onlyUnlisted: false,
    orderFilters: [{ conditions: [], kind: "storefront", paymentTokens: [] }],
    sort: { direction: "desc", listingKind: "storefront", path: "blockTimestamp" }
  }),
});
const data = await res.json();
console.log("nfts:", data.nfts?.length, "total:", data.total);
if (data.nfts?.length > 0) {
  console.log(JSON.stringify(data.nfts[0], null, 2));
}
