# Enable the nightly autonomous pass to push to git (one-time setup)

Goal: stop the nightly `rpc-nightly-autonomous-pass` from running in NO-PUSH mode. The pass already *attempts* `git push` every run and only falls back to NO-PUSH when credentials are missing (its SKILL.md lines 69/84) — so the moment a credential exists in the repo's git config, it self-activates. **No change to the pass prompt is needed.**

Why a credential is needed: the repo's remote is HTTPS (`https://github.com/jamesdillonbond/rip-packs-city`) with no stored credential and no credential helper, so `git push` dies on "could not read Username." The scheduled sandbox reads the same mounted `.git/config`, so embedding a token in the **push** URL is the approach that reliably persists for it.

---

## STEP 1 — Create a fine-grained Personal Access Token (you; ~2 min)

Page is already open in your browser (`github.com/settings/personal-access-tokens/new`); complete GitHub's "Confirm access" check first. Then set:

- **Token name:** `rpc-nightly-pass-push`
- **Resource owner:** jamesdillonbond
- **Expiration:** your call — 1 year (or custom long) means less re-setup; shorter is more secure. Put a calendar note to rotate before it expires.
- **Repository access:** **Only select repositories** → choose **`rip-packs-city`** (NOT "All repositories").
- **Permissions → Repository permissions → Contents:** **Read and write.** (Metadata: Read-only is auto-added — leave it. Everything else stays "No access.")
- Click **Generate token**, then **copy it** (GitHub shows it once). Keep it to yourself — do not paste it into this chat.

This is least-privilege: the token can only read/write the contents of this one public repo. Even if it leaked, that's the entire blast radius.

## STEP 2 — Wire the token into the repo's push URL (you; one command)

Open a terminal (Git Bash / PowerShell) in `C:\Users\TDill\rip-packs-city` and run, replacing `<TOKEN>` with what you copied:

    git remote set-url --push origin https://<TOKEN>@github.com/jamesdillonbond/rip-packs-city.git

(Only the *push* URL gets the token; fetch stays anonymous, which is fine for a public repo.)

## STEP 3 — Verify it authenticates (you; one command)

    git push --dry-run origin main

Expected: `Everything up-to-date` (or a normal dry-run summary). If you still see "could not read Username," the token didn't take — re-check STEP 2. That's the whole setup.

---

## What happens after

- The next nightly pass (`01:02` local) will commit + push its own low-risk changes directly to `main` instead of writing them to disk for a later session. Its existing guardrails are unchanged: stage by exact path (never `git add -A`), `git pull --rebase --autostash` first, verify `git rev-list --count origin/main..HEAD == 0` after, and the off-limits set (auth/wallet/secrets/destructive-SQL/pricing) still always queues. If the token ever stops working it falls back to NO-PUSH automatically — never an abort.

## Security notes
- The token sits in plaintext in `.git/config` on this machine. It is **never committed** (`.git/` isn't tracked), so it can't leak to GitHub. Acceptable for a one-repo Contents token; if you'd rather it not be at rest in the repo dir, see the alternative below.
- It's visible to anyone who runs `git remote -v` on this machine (shows in the `(push)` line). The nightly digests don't dump that, but be aware.
- **To revoke / rotate:** GitHub → Settings → Developer settings → Fine-grained tokens → `rpc-nightly-pass-push` → Revoke. Then re-run STEP 2 with a new token. Add this token to the quarterly secret-rotation check in `docs/operations/README.md`.

## Alternative (more hygienic, only if the scheduled sandbox shares your home dir — test first)
Instead of STEP 2, keep the token out of the repo dir via a credential helper:

    git config --global credential.helper store
    printf 'https://jamesdillonbond:<TOKEN>@github.com\n' >> ~/.git-credentials  &&  chmod 600 ~/.git-credentials

This stores the token in `~/.git-credentials` (your home dir) instead of `.git/config`, dodging the occasional `.git/config` NUL-corruption on the Windows↔sandbox bridge. **Caveat:** only works if the scheduled task's environment shares that same home dir — verify by checking whether a nightly run can push after using this form; if not, fall back to STEP 2 (the in-URL token, which the sandbox definitely sees via the mounted `.git/config`).
