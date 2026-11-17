"use client";

import { useEffect } from "react";
import { setLastCollection } from "@/lib/active-collection";

export default function ActiveCollectionSync({ collectionId }: { collectionId: string }) {
  useEffect(() => {
    setLastCollection(collectionId);
  });

  return null;
}
