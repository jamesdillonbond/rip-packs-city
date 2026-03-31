# CLAUDE.md — rip-packs-city

## Project Overview
A Next.js web app for Flow blockchain digital collectibles. Users can browse packs, collect badges, complete sets, manage a wallet, and use a sniper tool. Built as a solo project.

## Tech Stack
- **Framework:** Next.js 16 (App Router) with TypeScript
- **Styling:** Tailwind CSS 4
- **Database:** Supabase
- **Blockchain:** Flow (via @onflow/fcl and @onflow/react-sdk)
- **State/Data:** TanStack React Query
- **Charts:** Recharts
- **Validation:** Zod
- **CI/CD:** GitHub Actions (fmv-recalc.yml, ingest-cron.yml)

## Project Structure
- `app/` — Next.js App Router pages and API routes
  - `packs/`, `badges/`, `sets/`, `collections/`, `profile/`, `wallet/`, `sniper/` — feature routes
  - `api/` — backend API routes
- `components/` — shared React components (auth, cart, support chat)
- `lib/` — utilities and shared logic
- `scripts/` — standalone scripts (badge fixes, series patches)
- `public/` — static assets
- `.github/workflows/` — GitHub Actions for FMV recalculation and data ingestion

## Commands
- `npm run dev` — local dev server
- `npm run build` — production build
- `npm run lint` — run ESLint

## Preferences
- Write clean, well-commented TypeScript
- Use descriptive variable and function names
- Prefer simple solutions over clever ones
- Always explain what you're doing before making changes
- Ask for confirmation before deleting or overwriting files
- Use 2-space indentation for all JS/TS/HTML/CSS files

## Conventions
- Use the Next.js App Router pattern (page.tsx, layout.tsx, route.ts)
- Use Tailwind utility classes for styling — no separate CSS files unless necessary
- Use Zod for any input validation or schema definitions
- Use TanStack React Query for server state and data fetching
- Use Supabase client from `lib/` — don't create new instances
- Flow blockchain interactions go through FCL — don't call Flow APIs directly

## Git
- Write clear commit messages using conventional commits (feat:, fix:, docs:, chore:)
- Don't commit without asking first
- Don't modify GitHub Actions workflows without explaining the change

## Things to Avoid
- Don't install global packages without asking
- Don't modify files outside the project directory
- Don't create new Supabase client instances — use the existing one in lib/
- Don't bypass FCL for blockchain calls
- Don't use inline styles when Tailwind classes will work
