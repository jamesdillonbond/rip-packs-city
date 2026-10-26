// app/(collections)/[collection]/analytics/page.tsx
// Server shell. Behaviour lives in CollectionAnalyticsClient.tsx so the
// component coverage gate measures it — a `page.tsx` is in neither gate's
// include, so ~1,790 lines of card loaders (each with its own loading /
// failed / empty / data ladder) were unmeasured by construction.
//
// Panini (2026-09-28): its own arm. The shared client reads wallet and shared-sales
// tables Panini has no rows in; Panini's analytics read panini_sales (every sale
// the walk reads, kept since 2026-09-28) through panini_sales_analytics, which
// carries per-day coverage — server-read (bounded, lib/panini/sales-analytics-read.ts)
// and ISR-cached.

import CollectionAnalyticsClient from "./CollectionAnalyticsClient";
import PaniniAnalytics from "@/components/collection/PaniniAnalytics";
import { topProductsByVolume } from "@/lib/panini/product-volume";
import { listPaniniProducts } from "@/lib/panini/product";
import { fetchPaniniSalesAnalytics } from "@/lib/panini/sales-analytics-read";

// Panini's arm is a ~3 s aggregate; the other collections' shell is static, so
// ISR at five minutes costs them nothing.
export const revalidate = 300;

export default async function AnalyticsPage(props: { params: Promise<{ collection: string }> }) {
  const { collection } = await props.params;
  if (collection === "panini-blockchain") {
    // 2026-10-25: + top products by 30-day volume from the hourly product rollup (Top Shot's "Volume by Series").
    const [data, products] = await Promise.all([fetchPaniniSalesAnalytics(), listPaniniProducts().catch(() => null)]);
    return <PaniniAnalytics data={data} byProduct={topProductsByVolume(products === null ? null : products.map((r) => ({ name: r.name, slug: r.slug, sales_30d: r.sales_30d, sales_30d_volume_usd: r.sales_30d_volume_usd ?? null, sales_30d_median_usd: r.sales_30d_median_usd ?? null })))} />;
  }
  return <CollectionAnalyticsClient />;
}
