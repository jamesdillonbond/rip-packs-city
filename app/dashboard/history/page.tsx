import type { Metadata } from "next";
import TransactionHistoryClient from "./TransactionHistoryClient"

// Server wrapper. The interactive body lives in TransactionHistoryClient.tsx so the component
// coverage gate measures it — a `page.tsx` is measured by NEITHER gate.
//
// This page reads no search params, so no Suspense boundary is required.
// 2026-11-06: the layout template gives "Transaction history | Rip Packs City"; without this the tab read "Dashboard".
export const metadata: Metadata = { title: "Transaction history", robots: { index: false, follow: false } };

export default function TransactionHistoryDashboard() {
  return <TransactionHistoryClient />
}
