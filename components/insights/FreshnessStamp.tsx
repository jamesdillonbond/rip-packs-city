"use client";

import { useEffect, useState } from "react";

/**
 * Renders a server-stamped ISO timestamp as a localized "medium date / short time"
 * string — but only AFTER mount. `toLocaleString` formats in the runtime timezone
 * (UTC on the Vercel server, local in the browser), so rendering it during SSR /
 * first hydration produces server-vs-client text drift = React #418. By emitting a
 * stable placeholder ("—") on the server and the first client render, then filling
 * in the localized value in an effect, the hydrated subtree always matches.
 */
export function FreshnessStamp({ iso }: { iso: string | null | undefined }) {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    if (iso) {
      setText(
        new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }),
      );
    } else {
      setText(null);
    }
  }, [iso]);

  return <>{text ?? "—"}</>;
}
