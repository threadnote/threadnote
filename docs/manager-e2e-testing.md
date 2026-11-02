# Manager browser E2E tests

The Playwright suite launches the actual built Threadnote CLI and Manager bundle
in a disposable account. Source-mode smoke also checks the real browser bundle's
asset resolution. Tests never attach to an existing Manager or global installation.

```sh
bun install --frozen-lockfile
node node_modules/@playwright/test/cli.js install --with-deps chromium firefox webkit
bun run test:e2e:manager -- --project=chromium smoke.spec.ts
bun run test:e2e:manager:ui
bun run test:e2e:manager:report
```

The default matrix runs Chromium scenarios plus tests tagged `@compat` in Firefox
and WebKit. Set `THREADNOTE_MANAGER_E2E_FULL_BROWSERS=1` to run the entire suite in
all three engines. The CI workflow dispatch exposes the same option. The affected
Bazel inventory selects the browser lane; its result is required by the normal
aggregate CI check.

The build runs once before the tests. During iteration, after building the current
source, use the runner directly for a focused file or title:

```sh
node node_modules/@playwright/test/cli.js test -c playwright.manager.config.ts --project=chromium --grep 'S01'
```

Fixtures strip inherited credentials and isolate home, account, manifest, Git
configuration, host configuration and temporary/cache directories. A test-only
Bun preload provides explicitly registered external fetch responses and rejects
unmatched egress. Core Manager HTTP, live WebSocket, rendering and persistence
remain real. The same preload records detached children so cleanup can target
fixture-owned processes. Every test starts with a fresh browser context and home.

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

Coverage is added in the approved phases: harness, memory workflows, graphs and
context, reviews and workspace tools, recovery and security, then compatibility
qualification. Scenario IDs S01–S20 will be mapped to the checked coverage
inventory as their implementation lands. This documentation does not imply that
unimplemented phases have passed.

External boundary probes run before broader journey coverage:

| Boundary                           | Real composition and deterministic substitute                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Obsidian                           | Supported `source add`, temporary Markdown vault, actual coordinator and filesystem sync                                                                                             |
| GitHub, Linear, Pocket, Superhuman | Supported source configuration and synthetic credentials; bundled preload answers the owning client fetches, including requests from the actual detached coordinator                 |
| Agent generation                   | Disposable `claude` executable on the fixture PATH; actual model discovery, subprocess invocation and consolidation job produce a synthetic draft                                    |
| Local model setup                  | Supported CLI policy initialization and authenticated Manager policy action; absent model catalog is asserted honestly. Browser tests do not install multi-gigabyte model artifacts. |
| Runtime updates                    | Actual release-check/notes logic reads synthetic immutable GitHub metadata. Installation actions remain subject to production eligibility and confirmation gates.                    |

The preload is bundled in global setup because a compiled Bun executable cannot
resolve workspace test aliases. Its activation is checked before starting Manager.
Coordinator loopback traffic is admitted only for the fixture's endpoint, bearer
token and recorded worker PID. An unregistered request fails and is journaled.
Browser workers also use disposable homes; `CFFIXED_USER_HOME` avoids the known
[Firefox macOS app-data issue](https://github.com/microsoft/playwright/issues/42768).
Cleanup removes only the fixture's own temporary directories and process identities.
