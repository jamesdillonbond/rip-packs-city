// app/profile/edit/page.tsx
//
// Thin server shell. The whole surface is client-side, and it used to live in
// this file as a `"use client"` page.tsx — a shape NEITHER coverage gate
// measures (the primary gate's include stops at `route.{ts,tsx}`; the component
// gate's is `components/**` + `app/**/*Client.tsx`).
//
// That mattered here more than on most pages, because the defect it hid was not
// a false claim but SILENT DATA LOSS: a failed profile read left the form at
// its EMPTY initial state with no failure branch, and `save()` POSTs every
// field unconditionally — so a collector who edited one thing would overwrite
// their display name, tagline, socials, avatar and favourite teams with nulls.
// Splitting it out puts the load/failure gating under the component gate, where
// a test can actually render it.

import type { Metadata } from "next"
import ProfileEditClient from "./ProfileEditClient"

// The tab read as the generic site title until 2026-09-02 (onboarding QA #9);
// a signed-in-only form should also never be indexed.
export const metadata: Metadata = {
  title: "Edit profile",
  robots: { index: false, follow: false },
}

export default function EditProfilePage() {
  return <ProfileEditClient />
}
