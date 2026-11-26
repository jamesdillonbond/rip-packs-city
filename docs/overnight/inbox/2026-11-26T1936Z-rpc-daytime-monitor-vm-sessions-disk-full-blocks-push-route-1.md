# VM /sessions scratch disk 100% full — blocks the scheduled-task VM push route (route 1); frugal sparse-clone fallback proven

**Source:** rpc-daytime-monitor 2026-11-26 ~19:05–19:37Z run. Device laptop-e3bdp9vs Cowork VM; `df /sessions` = 9.8G total / 9.2G used / 100%.

**What:** The laptop Cowork VM's scratch volume (`/sessions`, VM-local — NOT the mounted repo) is full of 82 orphaned ended-session dirs dating back to 2026-11-17 (e.g. ~20 all stamped 11-25 04:18 from a parallel fan-out). A full `git clone --filter=blob:none` + checkout (push route 1 / the nightly "LAPTOP VM" route) fails its checkout with `No space left on device`. The stale dirs are owned `nobody:nogroup` mode 0750, a different unix user than any session, so they CANNOT be deleted cross-user from a session shell (OS `Permission denied`, confirmed this run) — only Cowork host session-GC or a VM recycle reclaims them.

**Risk read:** LOW→MEDIUM, infra/ops. No platform impact, no data loss. The read-only health sweep ran fine off the mount + MCP connectors; platform GREEN. Route 3 (mount write) remains available, so inbox filings still reach the night pass locally. Only the live git-push-from-VM path degrades.

**WORKAROUND PROVEN THIS RUN (fits the ~120M headroom):** a shallow sparse clone pushes fine despite the full disk —
`git clone -q --filter=blob:none --no-checkout --depth 1 <repo> $HOME/rpcwork-lite` (.git ~650K), then `git sparse-checkout init --cone && git sparse-checkout set docs/overnight/inbox scripts && git checkout` (~44M), set identity, commit the inbox file + INDEX.md, push with the `.rpc-git-cred` store at the mount root. `git ls-remote origin refs/heads/main` == local HEAD confirms. THIS FILE WAS PUSHED THAT WAY.

**Suggested action (night pass / Trevor):** (1) recycle the Cowork VM to reclaim `/sessions` — most likely a desktop-app restart on the laptop, or it self-clears on the next VM cycle; (2) if it recurs, flag to Anthropic as a Cowork session-GC gap (orphaned dirs accumulate and are never GC'd); (3) consider teaching the push-route recipe (`docs/reference/autonomous-tasks.md`) to fall back to the shallow sparse-clone when a full checkout hits `No space left`. No RPC code/DB change. Do NOT attempt cross-user `rm` of the `nobody` dirs — denied by the OS, not the classifier.
