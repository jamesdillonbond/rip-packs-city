#!/usr/bin/env python3
"""CI gate for the /api/smoke-test response (reads the JSON body on stdin).

WHY THIS FILE EXISTS
--------------------
`.github/workflows/smoke-tests.yml` used to gate on `d.get('failed', 0)` — a key
`app/api/smoke-test/route.ts` has NEVER returned. `.get(..., 0)` silently yielded
0, so the failure branch was dead code and the job reported success on every run
regardless of what the probes actually found (it was masking a live
`rpc:check_public_security_invariants` hard failure). The route also returns
HTTP 200 from its own top-level crash handler, so the workflow's
`HTTP_CODE != 200` check could not catch that either.

So this gate is deliberately fail-loud:
  * unparseable body                    -> fail
  * any expected key ABSENT             -> fail (a detached gate must not pass)
  * hardPassed != hardTotal             -> fail
  * any non-soft failing result         -> fail
Soft failures (external dependencies) are printed but do NOT fail the build,
matching the route's own hard/soft split.

The key names below are pinned by `__tests__/smoke-gate-contract.test.ts`, which
fails CI if the route's response shape and this list ever drift apart again.
"""

from __future__ import annotations

import json
import sys

# Keys the gate reads. Every one of these MUST exist in the route's success
# response — see __tests__/smoke-gate-contract.test.ts.
REQUIRED_KEYS = ("passed", "total", "allPassed", "hardPassed", "hardTotal", "results")


def _label(result: dict) -> str:
    return str(result.get("name") or result.get("endpoint") or "?")


def _detail(result: dict) -> str:
    return str(result.get("detail") or "failed")


def main() -> int:
    raw = sys.stdin.read()

    try:
        body = json.loads(raw)
    except Exception as exc:  # noqa: BLE001 - any parse problem is a hard fail
        print("::error::smoke-test response was not valid JSON (%s)" % exc)
        print(raw[:2000])
        return 1

    if not isinstance(body, dict):
        print("::error::smoke-test response was not a JSON object")
        return 1

    missing = [k for k in REQUIRED_KEYS if k not in body]
    if missing:
        print(
            "::error::smoke-test response is missing expected key(s): %s — the CI "
            "gate has detached from the route contract (see scripts/smoke-gate.py)"
            % ", ".join(missing)
        )
        print(json.dumps(sorted(body.keys())))
        return 1

    results = body.get("results")
    if not isinstance(results, list):
        print("::error::smoke-test `results` was not a list")
        return 1

    hard_passed = body.get("hardPassed")
    hard_total = body.get("hardTotal")
    soft_failures = body.get("softFailures")

    print(
        "Results: %s passed / %s total · hard %s/%s · soft failures %s"
        % (
            body.get("passed"),
            body.get("total"),
            hard_passed,
            hard_total,
            soft_failures if soft_failures is not None else "n/a",
        )
    )

    failing = [r for r in results if isinstance(r, dict) and not r.get("passed")]
    hard_failing = [r for r in failing if not r.get("soft")]
    soft_failing = [r for r in failing if r.get("soft")]

    for r in hard_failing:
        print("  HARD FAIL: %s — %s" % (_label(r), _detail(r)))
    for r in soft_failing:
        print("  soft fail (informational): %s — %s" % (_label(r), _detail(r)))

    if not isinstance(hard_passed, int) or not isinstance(hard_total, int):
        print("::error::hardPassed/hardTotal are not integers — cannot gate safely")
        return 1

    if hard_passed != hard_total:
        print("::error::%d hard smoke test(s) failed" % (hard_total - hard_passed))
        return 1

    # Belt-and-braces: the counters and the per-result flags must agree.
    if hard_failing:
        print(
            "::error::%d result(s) report passed=false but hardPassed==hardTotal — "
            "inconsistent smoke-test response" % len(hard_failing)
        )
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
