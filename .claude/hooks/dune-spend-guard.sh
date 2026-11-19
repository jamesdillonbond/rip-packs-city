#!/bin/bash
# PreToolUse(mcp__Dune__*) hook: a Dune call that SPENDS (runs or schedules a query) needs a human's approval.
#
# Why (2026-11-19): the Dune cycle was spent to 430 % of its datapoint allowance by queries run BY HAND through
# the Dune connector -- no budgeted lane had spent anything (sentinel "Dune Spend", ledger 11-19 ~12:45 PM PT).
# The lanes' budget (dune_budget_state) cannot see the connector, so nothing stopped one session from emptying
# the month. Lanes run server-side and are untouched by this hook; reading Dune (search, usage, results, docs)
# stays free. Only the spending calls below ask -- a person sees the query before credits go.
#
# Answers "ask", never "deny": a deliberate, approved query still runs.

tool="$(jq -r '.tool_name // ""' 2>/dev/null)"

case "$tool" in
  mcp__Dune__createAndExecuteQuery|mcp__Dune__executeQueryById|mcp__Dune__createMaterializedView|mcp__Dune__refreshMaterializedView|mcp__Dune__updateMaterializedView|mcp__Dune__setSchedule)
    printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"Dune spend guard: this call runs (or schedules) a Dune query and spends this cycle'"'"'s datapoints/credits. On 2026-11-19 hand-run queries spent the cycle to 430% with no lane involved, pausing every Dune lane until the reset. Check mcp__Dune__getUsage first, filter on partition columns, and approve only a query you mean to pay for."}}'
    ;;
esac

exit 0
