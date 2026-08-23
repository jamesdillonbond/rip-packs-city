# The pack simulator's flip animation keeps calling `setState` after unmount — an intermittent unhandled rejection that fails `npm test` while every test passes

**Filed 2026-08-22 22:55 PT (2026-08-23 05:55Z), Claude Code interactive.** Found as collateral while
running the full suite for unrelated work, not by looking for it.

## What was measured

`npm test` exited **1** with:

```
Test Files  1359 passed (1359)
     Tests  14821 passed (14821)
    Errors  1 error

⎯⎯⎯⎯ Unhandled Rejection ⎯⎯⎯⎯⎯
ReferenceError: window is not defined
 ❯ resolveUpdatePriority  react-dom-client.development.js:1308
 ❯ dispatchSetState       react-dom-client.development.js:9126
 ❯ app/(collections)/[collection]/packs/simulator/[distId]/PackSimulatorClient.tsx:252:11
```

⚠ **EVERY TEST PASSED. The run failed anyway** — an unhandled rejection is not a test result, so no
test name appears and nothing points at a file to fix. Vitest's own note is the only clue that the
error "originated in `__tests__/component-SimulatorAndApiKeys.test.tsx`", and even that says the throw
did not necessarily happen inside it.

## The mechanism, and it is a real product defect rather than a test artifact

`PackSimulatorClient.tsx:249-253`:

```ts
if (n <= 10) {
  for (let i = 0; i < rips.length * slots; i++) {
    await new Promise((r) => setTimeout(r, 70))
    setFlipIndex((p) => p + 1)
  }
}
```

**Up to `rips.length * slots` iterations at 70 ms each, with no cancellation and no mounted check.**
Nothing aborts it when the component unmounts, so the loop keeps calling `setFlipIndex` into a
component that is gone. Under vitest that lands after jsdom has torn `window` down, which is why the
error is a `ReferenceError` rather than React's usual warning.

⚠ **In the browser this does not throw, which is exactly why it has survived.** A user who starts a
10× rip and navigates away leaves a timer chain running for up to `slots × 10 × 70 ms`, setting state
on an unmounted tree. React drops the update, so the only visible cost is wasted work — invisible,
until a test environment made it fatal.

## Why it is INTERMITTENT, and the control

- Re-ran `__tests__/component-SimulatorAndApiKeys.test.tsx` **alone, three times: clean each time.**
- Re-ran the **full suite** on the identical tree: **exit 0, 14,821 passed, zero errors.**

So it needs the timing of a loaded parallel run to land after teardown rather than before. ⚠ **Two
observations, one failing and one clean, on the same tree** — that is what makes this a race and not a
regression, and it is also why it will keep reappearing at random in CI until the loop is cancelled.

⚠ **Do NOT record this as "a flake".** CLAUDE.md is explicit that flake is not a root cause, and here
the root cause is named above and is fixable: the loop needs an abort signal (a ref cleared in a
`useEffect` cleanup, or an `AbortController` checked each iteration).

## What is NOT established

- **Whether it can fail a CI job.** CI runs `npm run test:coverage`, not bare `npm test`, and I have
  not seen it fire there — the recent runs on `main` were green. ⚠ That is an absence of observation,
  not evidence of immunity: the same race exists under the same parallelism.
- **Whether other animation loops share the shape.** Only this one was measured. A scan for
  `await new Promise((r) => setTimeout` inside a loop would be the cheap way to find siblings, and it
  is exactly the copy-paste shape this repo keeps paying for — but it has NOT been run.

## Recommended fix

1. Give the loop a cancellation token cleared on unmount, and check it after each `await` **before**
   calling `setFlipIndex` — the check has to be after the await, since that is where the gap is.
2. Pin it with a test that unmounts mid-animation and asserts no further state update, rather than one
   that merely runs the animation to completion — the second would pass today.
3. ⚠ Whatever the fix, **it cannot be verified by a single green run.** The failure mode is a race, so
   the evidence has to be the mechanism (a cleanup that provably runs), not an absence of the error.

---
