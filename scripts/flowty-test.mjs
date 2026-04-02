// Quick script to fetch one Flowty listing and log the raw structure
const res = await fetch("https://api2.flowty.io/collection/0xedf9df96c92f4595/Pinnacle", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ from: 0, size: 1, includeAllListings: true }),
});

const data = await res.json();
const first = data.results?.[0] || data.data?.[0] || data[0];
console.log(JSON.stringify(first, null, 2));
