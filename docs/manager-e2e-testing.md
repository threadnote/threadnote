# Manager browser E2E tests

The Playwright suite launches the actual built Threadnote CLI and Manager bundle
in a disposable account. Source-mode smoke also checks the real browser bundle's
asset resolution. Tests never attach to an existing Manager or global installation.

```sh
bun install --frozen-lockfile
bun --bun node_modules/@playwright/test/cli.js install --with-deps chromium
bun run test:e2e:manager -- --project=chromium smoke.spec.ts
bun run test:e2e:manager:ui
bun run test:e2e:manager:report
```

Node 24 is required for the nested runner lifecycle probe; the package entrypoints run through Bun.

Chromium is the only browser project, locally and in CI. The complete suite runs
on affected pull requests and manual CI dispatch. The affected Bazel inventory
selects the browser lane; its result is required by the normal aggregate CI check.
The browser build follows the frozen Playwright lockfile; Node 24 and the pinned
Bun version are provisioned by CI.

The build runs once before the tests. During iteration, after building the current
source, use the runner directly for a focused file or title:

```sh
bun --bun node_modules/@playwright/test/cli.js test -c playwright.manager.config.ts --project=chromium --grep 'S01'
```

Fixtures strip inherited credentials and isolate home, account, manifest, Git
configuration, host configuration and temporary/cache directories. A test-only
Bun preload provides explicitly registered external fetch responses and rejects
unmatched egress. Core Manager HTTP, live WebSocket, rendering and persistence
remain real. A separately labeled capability-fallback test returns 501 only from
`/api/live-session`; its canonical reads and writes still reach the compiled
server. Live-recovery tests forward real WebSocket frames unchanged and cut their
owned transport. Held-read tests delay actual server responses.

The preload records detached children so cleanup can target fixture-owned
processes. Workers that deliberately sanitize away preload variables receive the
guard again only when launching the same isolated executable. The model-worker
probe asserts its download reaches the registered synthetic boundary. Every test
starts with a fresh browser context and home.

Prefer accessible roles and labels plus retrying assertions. Do not wait for
`networkidle`: Manager maintains a live connection. Do not use fixed sleeps or
stub Manager APIs in successful user journeys. Keep generated-state properties
in normal Vitest tests, using Effect Vitest integration when Effect is the program
under test; browser, process and protocol boundaries use Playwright's Promise API.

Reports, failure traces, screenshots, videos and bounded sanitized application
logs live in `.context/manager-e2e/`. They contain synthetic fixtures and ephemeral
test authentication. Traces can include request headers; never introduce real
credentials or user content. CI retains these artifacts for seven days.

The initially empty account legitimately returns the exact documented 409 error
from `/api/shares/conflicts` when no team is configured. The fixture recognizes
that specific response body and its corresponding browser resource error. Other
HTTP errors, browser exceptions, console errors and outbound requests fail tests.

The checked [coverage inventory](../apps/threadnote/test/e2e/manager/coverage-inventory.json)
maps R1–R10 and S01–S20 to discovered Chromium cases, all 12 navigation sections
and all five production integration registrations. Its normal Vitest contract
fails missing, renamed or unmapped cases and browser-scope drift. The browser
reporter rejects skipped and expected-failure cases; CI also rejects focused tests and retry passes
that would otherwise be reported as flaky success. Real child-runner probes
verify passing, skipped, flaky and expected-failure outcomes without requiring browser downloads.

| Scenarios | Coverage                                                                                                          |
| --------- | ----------------------------------------------------------------------------------------------------------------- |
| S01–S02   | Compiled/source assets, authority, isolation, cleanup, shell and Home                                             |
| S03–S06   | Search, links, editor/source fallback, relations, lifecycle, packs, bulk failure and consolidation                |
| S07–S10   | Projects, worksets, real graph queries/source inspection, guarded maintenance, Context Brief and paging           |
| S11–S12   | Proposed/automatic/topic reviews, stale evidence, model retry and Context Health decisions                        |
| S13–S15   | Local Git sharing/conflicts, managed workflow installation and every configured provider                          |
| S16–S18   | Live recovery/drafts/read ordering, restart authority, runtime operations and inert content                       |
| S19–S20   | Native modal focus/Escape/return, narrow layout, 200% root page zoom, long Unicode, WebGL2 and runtime provenance |

The 200% case uses the engine's root CSS zoom and checks layout and keyboard
reachability; it does not substitute a device scale factor. State-machine
permutations remain in unit/property tests. For reliability qualification, run the
four real-live mutation/draft/held-read cases ten times with local retries disabled:

```sh
bun --bun node_modules/@playwright/test/cli.js test -c playwright.manager.config.ts live.spec.ts --grep 'Home observes|transport recovery|old held' --repeat-each=10
```

For the inventory and runner guard contracts:

```sh
bun --bun vitest run apps/threadnote/test/e2e/manager/fixtures/coverage.test.ts
bun run bazel:affected
```

External boundary probes run before broader journey coverage:

| Boundary                           | Real composition and deterministic substitute                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Obsidian                           | Supported `source add`, temporary Markdown vault, actual coordinator and filesystem sync                                                                                       |
| GitHub, Linear, Pocket, Superhuman | Supported source configuration and synthetic credentials; bundled preload answers the owning client fetches, including requests from the actual detached coordinator           |
| Agent generation                   | Disposable `claude` executable on the fixture PATH; actual model discovery, subprocess invocation and consolidation job produce a synthetic draft                              |
| Local model setup                  | Supported CLI policy and actual worker; gated download progress, synthetic 403, explicit retry and stop. Hardware refusal is asserted honestly. No model artifact is accepted. |
| Runtime updates                    | Actual release-check/notes logic reads synthetic immutable GitHub metadata. Installation actions remain subject to production eligibility and confirmation gates.              |

The preload is bundled in global setup because a compiled Bun executable cannot
resolve workspace test aliases. Its activation is checked before starting Manager.
Coordinator loopback traffic is admitted only for the fixture's endpoint, bearer
token and recorded worker PID. An unregistered request fails and is journaled.
Browser workers also use disposable homes. Cleanup removes only the fixture's own
temporary directories and process identities. The Context Brief, provider and
runtime tests establish composition against local substitutes, without claiming
real hosted OAuth availability or a successful multi-gigabyte model installation.
