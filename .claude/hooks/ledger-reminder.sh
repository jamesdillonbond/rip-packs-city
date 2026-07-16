#!/bin/bash
# PostToolUse(Bash) hook: after any Bash command that runs `git push`, inject a
# reminder to log the change to the ledger (docs/overnight/ledger.md) with a
# revert path, per the CLAUDE.md "log every change that touches main or prod
# state" rule.
#
# Why a git-push trigger (not a blanket Stop hook): a push is the moment `main`
# actually changes, and this fires mid-turn so the reminder lands while there's
# still a turn to act in — instead of nagging on every conversational turn. It
# only emits on commands containing `git push` (compound commands like
# `git commit && git push` included, via substring match), so ordinary git
# reads (status/log/diff) stay silent.
#
# The reminder is advisory context, not a block: it never fails the tool call.

cmd="$(jq -r '.tool_input.command // ""' 2>/dev/null)"

case "$cmd" in
  *"git push"*)
    printf '%s' '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"Ledger reminder: a git push just ran. Per CLAUDE.md, if this changed main or prod state beyond docs (code, migration, data mutation), append a docs/overnight/ledger.md entry now in the same turn — date · what shipped · revert path."}}'
    ;;
esac

exit 0
