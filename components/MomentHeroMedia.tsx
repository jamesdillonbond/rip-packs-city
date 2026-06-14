"use client";

import { useState, type ReactNode } from "react";

// MomentHeroMedia — resilient hero media for the /moment/[id] page.
//
// Why this exists (2026-06-13 audit, Item 1): the moment hero rendered
// editions.video_url / editions.thumbnail_url directly. Those are constructed
// `assets.nbatopshot.com/editions/<set>/<play>/…Transparent.png` (+ Animated mp4)
// URLs that 404 on the CDN for a large set of legacy (Series 1-4) Top Shot
// editions — ~30% of premium moment pages rendered a blank black hero. The
// per-moment `media/<momentId>/image` CDN form works on all of them (it's what
// the trophy slabs already use).
//
// Strategy: an ordered list of image candidates is the always-present base
// layer; on a load error we advance to the next candidate, finally falling to a
// "No media" placeholder. The edition video (when present) overlays the base
// image; if it 404s it hides itself, revealing the image underneath. So a
// failing video or a failing primary image never leaves an empty box.
export default function MomentHeroMedia({
  imageCandidates,
  videoUrl,
  alt,
  placeholder,
}: {
  imageCandidates: string[];
  videoUrl: string | null;
  alt: string;
  // Rendered when every image candidate has failed and there's no playable
  // video. Defaults to a "No media" text chip; the edition page passes its
  // branded "RPC / No preview" card so artless editions keep their styling.
  placeholder?: ReactNode;
}) {
  const candidates = imageCandidates.filter(Boolean);
  const [imgIdx, setImgIdx] = useState(0);
  const [videoFailed, setVideoFailed] = useState(false);

  const currentImg = imgIdx < candidates.length ? candidates[imgIdx] : null;
  const showVideo = !!videoUrl && !videoFailed;

  if (!currentImg && !showVideo) {
    if (placeholder !== undefined) return <>{placeholder}</>;
    return (
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--rpc-text-muted)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs, 12px)",
          letterSpacing: "0.2em",
          textTransform: "uppercase",
        }}
      >
        No media
      </div>
    );
  }

  return (
    <>
      {currentImg ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={currentImg}
          alt={alt}
          onError={() => setImgIdx((i) => i + 1)}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
        />
      ) : null}
      {showVideo ? (
        <video
          src={videoUrl!}
          poster={currentImg ?? undefined}
          autoPlay
          loop
          muted
          playsInline
          onError={() => setVideoFailed(true)}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
        />
      ) : null}
    </>
  );
}
