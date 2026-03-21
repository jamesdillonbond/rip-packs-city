import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto max-w-5xl p-8">
      <h1 className="mb-4 text-4xl font-bold">Top Shot Wallet Analyzer</h1>
      <p className="mb-6 text-gray-600 dark:text-gray-300">
        Search by Flow wallet address or Top Shot username.
      </p>

      <Link
        href="/wallet"
        className="inline-flex rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
      >
        Open Wallet Analyzer
      </Link>
    </main>
  );
}