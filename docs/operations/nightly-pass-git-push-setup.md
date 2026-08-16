# Enable the nightly autonomous pass to push to git (one-time setup)

> ⛔ **REWRITTEN 2026-08-16 AFTER A TOKEN LEAK. The previous version of this document prescribed
> the method that caused it.** If you are reading a cached copy that tells you to run
> `git remote set-url --push origin https://<TOKEN>@github.com/...`, that copy is **wrong and
> harmful** — see [What changed](#what-changed-2026-08-16) below.

Goal: stop the nightly `rpc-nightly-autonomous-pass` from running in NO-PUSH mode. The pass already
*attempts* `git push` every run and falls back to NO-PUSH only when credentials are missing — so the
moment a working credential exists, it self-activates. **No change to the pass prompt is needed.**

---

## What changed 2026-08-16

The `rpc-nightly-pass-push` PAT was **leaked and revoked**. Two corrections came out of it, and the
second one had been blocking the right fix for weeks.

**1. ⛔ Never put the token in `remote.origin.pushurl`.**
The old STEP 2 embedded it as `https://<TOKEN>@github.com/...`. That is the leak vector: **any
routine `git config --get remote.origin.pushurl` prints a live token to the terminal** — into a
transcript, a log, a screenshot, a pasted diagnostic. It does not require a mistake, only a normal
diagnostic command.

⚠ **The old doc's threat model was wrong, and it is worth naming why.** It reasoned: *"It is never
committed (`.git/` isn't tracked), so it can't leak to GitHub"* and noted only `git remote -v` as an
exposure path. **The leak did not go through git at all.** A credential at rest is exposed by
everything that *reads* it, not only by what *commits* it. "It can't reach GitHub" is not the same
claim as "it can't reach a third party."

**2. ✅ `gh auth setup-git` works, and the reason it appeared not to was misdiagnosed.**
An earlier note asserted *"`gh auth setup-git` does NOT fix it — the cached PAT still wins."* That
diagnosis was **wrong**. `gh` was never losing to Windows Credential Manager. It was losing to the
embedded `token@host` in the push URL, which **bypasses the credential-helper chain entirely** — no
helper config of any kind could have beaten it. **Removing the pushurl is what let `gh` take over.**

Verified 2026-08-16: `git credential fill` for github.com returns a `gho_` token byte-identical
(md5-compared) to `gh auth token`, carrying `workflow` scope.

---

## STEP 1 — Authenticate the GitHub CLI (you; ~2 min)

    gh auth login          # HTTPS, authenticate in browser
    gh auth setup-git      # installs gh as git's credential helper for github.com

Request **`workflow`** scope alongside `repo` if you want the pass to be able to touch
`.github/workflows/**`; without it, pushes containing workflow changes are rejected by GitHub even
though every other file would go through.

**Why this instead of a PAT in a URL:** the token lives in the OS credential store, is refreshable
by `gh` without editing any repo, and is never printed by a routine git command.

## STEP 2 — Verify it authenticates (you; one command)

    git -C C:\Users\TDill\rip-packs-city push --dry-run origin HEAD:refs/heads/main

Expected: rc=0 with a normal dry-run summary. If you see "could not read Username", `gh auth
setup-git` did not take — re-run STEP 1.

⚠ **Check that no push URL is shadowing the helper.** If auth still fails, confirm the embedded form
is not present — **without printing it**:

    git config --get remote.origin.pushurl >/dev/null 2>&1 && echo "PRESENT - remove it" || echo "absent, good"
    git remote set-url --delete-push origin <the-url>   # only if PRESENT

## STEP 3 — Confirm the sandbox sees it

The scheduled sandbox reads the same mounted `.git/config` but **does not share your Windows global
git config or your OS credential store**. Whether a `gh`-based helper reaches it is environment-
dependent: **verify by checking that a nightly run actually pushes**, rather than assuming.

⛔ **If it does not reach, do NOT fall back to the in-URL token.** Prefer running the pass where the
credential exists (the desktop "Run this task → on your computer" path), or fix the credential in
that environment. The in-URL form is not a fallback; it is the thing that leaked.

---

## What happens after

The next nightly pass commits and pushes its own low-risk changes directly to `main` instead of
writing them to disk. Guardrails unchanged: stage by exact path (**never `git add -A`**),
`git pull --rebase --autostash` first, verify `git rev-list --count origin/main..HEAD == 0` after,
and the off-limits set (auth / wallet / secrets / destructive-SQL / pricing) still always queues. If
the credential stops working it falls back to NO-PUSH automatically — never an abort.

⚠ **That fallback is silent.** The pass reports "shipped to disk" and looks healthy, so a dead
credential goes unnoticed for days. The cloud-side scheduled task
*"RPC · nightly-pass push credential backstop"* exists for exactly this; keep its date in step with
the credential's expiry.

## Security notes

- **Least privilege still applies.** Scope any token to this repository only, Contents read/write
  (plus `workflow` if needed). Metadata read-only is auto-added.
- ⛔ **Never run a command that prints the credential.** `git config --get remote.origin.pushurl`,
  `git remote -v` (shows the push line), and `git config --list` all can. To test auth, use
  `git ls-remote` or `push --dry-run` — both prove reachability and reveal nothing.
- **To revoke / rotate:** GitHub → Settings → Developer settings → Fine-grained tokens →
  select the token → Revoke. Then re-run STEP 1. Keep it in the quarterly secret-rotation check in
  `docs/operations/README.md`.
- ⚠ **A revoked-and-re-minted token has a NEW expiry.** Update the backstop scheduled task and any
  memory note that records the old date; a stale expiry date is worse than none, because it reads as
  verified.

## ⛔ Rejected alternatives, and why (do not re-propose)

| approach | why not |
|---|---|
| token in `remote.origin.pushurl` | **the 2026-08-16 leak vector.** Printed by routine diagnostics; bypasses the credential-helper chain |
| `credential.helper store` + `~/.git-credentials` | plaintext token at rest in the home dir. Strictly worse than the OS credential store, and it was only ever proposed to dodge a `.git/config` corruption issue that `gh` also avoids |
| a longer expiry to reduce re-setup | trades a recurring 2-minute task for a longer blast radius on a credential that has already leaked once |
