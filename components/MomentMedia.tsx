"use client";

import { useEffect, useRef, useState } from "react";
import { proxyIpfsUrl } from "@/lib/ipfs-media";

export function getImageUrl(prefix: string | null | undefined): string | null {
  if (!prefix) return null;
  // UFC / legacy art lives on the slow ipfs.io gateway as a bare
  // https://ipfs.io/ipfs/<cid> (no extension, no TS-CDN resize semantics).
  // Serve it through the same-origin edge proxy AS-IS — never append the
  // TopShot Hero_/Animated_ suffixes below (that produced a broken URL).
  if (prefix.startsWith("https://ipfs.io/") || prefix.startsWith("http://ipfs.io/")) {
    return proxyIpfsUrl(prefix);
  }
  if (prefix.endsWith(".png") || prefix.endsWith(".webp") || prefix.endsWith(".jpg")) {
    return prefix;
  }
  const resizePrefix = prefix.replace(
    "https://assets.nbatopshot.com/editions/",
    "https://assets.nbatopshot.com/resize/editions/"
  );
  return `${resizePrefix}Hero_2880_2880_Transparent.png?format=webp&quality=80&width=600`;
}

export function getVideoUrl(prefix: string | null | undefined): string | null {
  if (!prefix) return null;
  // ipfs.io thumbnails carry no derivable animated variant (the video CID is a
  // separate field not passed here) — appending Animated_….mp4 would 404.
  if (prefix.startsWith("https://ipfs.io/") || prefix.startsWith("http://ipfs.io/")) {
    return null;
  }
  if (prefix.endsWith(".mp4")) return prefix;
  if (prefix.endsWith(".png") || prefix.endsWith(".webp") || prefix.endsWith(".jpg")) {
    return null;
  }
  return `${prefix}Animated_1080_1080_Black.mp4`;
}

export interface MomentMediaProps {
  thumbnailUrl: string | null | undefined;
  alt?: string;
  size?: number;
  rounded?: number;
  background?: string;
}

export default function MomentMedia({
  thumbnailUrl,
  alt = "",
  size,
  rounded = 6,
  background = "rgba(255,255,255,0.05)",
}: MomentMediaProps) {
  const [hovered, setHovered] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const imgUrl = getImageUrl(thumbnailUrl);
  const videoUrl = getVideoUrl(thumbnailUrl);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (hovered) v.play().catch(() => {});
    else {
      v.pause();
      v.currentTime = 0;
    }
  }, [hovered]);

  const dim = size ? { width: size, height: size } : { width: "100%", aspectRatio: "1 / 1" };

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: "relative",
        ...dim,
        background,
        borderRadius: rounded,
        overflow: "hidden",
        flexShrink: 0,
      }}
    >
      {imgUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imgUrl}
          alt={alt}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            opacity: hovered && videoUrl ? 0 : 1,
            transition: "opacity 0.15s ease",
          }}
        />
      ) : null}
      {videoUrl ? (
        <video
          ref={videoRef}
          src={videoUrl}
          muted
          loop
          playsInline
          preload="none"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            opacity: hovered ? 1 : 0,
            transition: "opacity 0.15s ease",
          }}
        />
      ) : null}
    </div>
  );
}
