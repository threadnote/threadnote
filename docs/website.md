# Threadnote website

The public Threadnote 4 website is a separate React, TypeScript, and Three.js application under `apps/website/`. It is not a
Manager asset and is never copied into a standalone CLI release.

## Local development

```bash
bun install --frozen-lockfile
bun run site:dev
```

The site uses independent HTML entry points so every public route has a real document and works without hash routing:

- `/` — product landing page
- `/performance/` — large-repository architecture and retained benchmark evidence
- `/docs/` — searchable 4.0 documentation; every article also has a crawler-visible `/docs/<article>/` URL
- `/whats-new/` — stable releases from the latest major version
- `/pro-tips/` — animated workflow simulations
- `/faq/` — product questions and comparisons

Run the website checks and a production build with:

```bash
bun run site:check
THREADNOTE_SITE_BASE=/ bun run site:build
```

The production output is `site-dist/`. It is ignored by Git and rejected if it appears inside `dist/`.
The build derives one static HTML shell per documentation article from the canonical docs content. These files expose
article-specific canonical, Open Graph, and X card metadata before React loads, so copied article URLs produce the
correct link preview. Legacy `/docs/#<article>` links still open and are upgraded in the browser, but fragments are
not sent in HTTP requests and therefore cannot provide article-specific crawler previews themselves.

The researched Graphify comparison remains in the FAQ source but is hidden in normal development and production
builds. Set `VITE_SHOW_GRAPHIFY_COMPARISON=true` only when the comparison is ready to be shown again.

The Performance page fails closed around one complete, runtime-validated code-graph harness artifact. It does not
accept a manually reduced result summary. Until one final exact-HEAD artifact contains the pinned source and
public-repository commits, clean managed-install provenance, source dependency and executable/payload/release hashes,
runtime target, hardware/runtime/database provenance, complete cold and incremental phases,
Java/Kotlin/TypeScript/Bazel controls, query and Manager measurements from that same run, RSS/WAL/TEMP/storage
high-water, and incremental-versus-independent-rebuild digest parity, every result value remains explicitly pending.
Do not combine observations copied from separate runs.

Verified values require both `apps/website/public/performance-evidence.json` and
`apps/website/performance/evidence.binding.json`. The Vite build hashes the exact public JSON bytes, checks the sidecar
SHA-256 and harness timestamp, verifies the benchmarked Threadnote commit is an ancestor of the website build, rejects
tracked, staged, or untracked changes in bound sources, cross-checks the exact lockfile and package-manifest hashes,
and compares a deterministic source-tree digest before exposing a verified virtual module to React. The artifact link
is generated from `THREADNOTE_SITE_BASE`, including subpath deployments. Missing both files is the valid pending state;
a partial pair or any mismatch fails the build. CI and Pages use full Git history so source-commit verification cannot
silently degrade in shallow checkouts. Every push to `main` runs the Pages workflow because any bound runtime-source
change must get a chance to fail closed rather than leave previously verified claims deployed.

After producing and reviewing the complete payload, install and bind it with:

```bash
cp /absolute/path/to/complete-reviewed-harness-artifact.json apps/website/public/performance-evidence.json
bun run site:bind-performance-evidence
```

The binding command validates the exact payload, verifies its Threadnote source commit against the current runtime
tree, computes both SHA-256 digests, and writes `apps/website/performance/evidence.binding.json`. Commit the public payload
and generated sidecar together; never hand-edit the binding.

The focused v4.0.1 worktree-readiness comparison is intentionally a separate same-machine engineering artifact, not a
substitute for that comprehensive release-evidence contract. Its harness checks out exact candidate and predecessor
commits, builds the same warm public fixture for both, alternates linked-worktree samples, asserts the expected
materialization modes and staged-file counts, and requires graph-count plus controlled-query parity for every pair.
Reproduce it with:

```bash
bun run bench:worktree-readiness -- \
  --candidate-ref v4.0.1 --samples 5 --warmups 1 \
  --output apps/threadnote/test/evaluation/candidates/threadnote-4.0.1/benchmarks/darwin-arm64-m1-max/code-graph-worktree-readiness-2026-08-04.json
```

The Performance page derives its rounded worktree values from that checked-in JSON. The Vite build also emits the
unchanged raw artifact at `/evidence/code-graph-worktree-readiness-v4.0.1.json` so readers can inspect every sample and
its provenance. Keep the source module, emitted path, tests, and artifact together when refreshing the comparison.

The 4.1 beta hardening program adds retained candidate and exact-tag evidence without replacing the narrower checked-in
v4.0.1 comparison. Production-large runs remain pinned-runner `n=1` observations; heavy-tail runs cover parser/cache
and interruption behavior; required PR checks cover correctness and platform packaging. Website copy may describe
those gates and bounded architecture, but it must not publish a combined latency percentile or claim universal
“maximum performance.” See [`4.1.0-beta.1-release-evidence.md`](./4.1.0-beta.1-release-evidence.md) for the release-facing
scope and deliberate deferrals.

## Content and interaction contracts

- Treat current source, CLI help, MCP schemas, checked-in user guides, tests, and shared durable design memories as
  authoritative. The historical GitHub wiki describes Threadnote 3 and must not supply 4.0 commands or architecture
  facts.
- Memory simulations show `recall_context` returning `threadnote://` pointers followed by `read_context`.
- Scoped current-source questions use `inspect_code_graph`; whole-repository statistics, communities, hubs, and
  surprising links use the separate `analyze_code_graph` tool.
- The landing-page graph showcase keeps both MCP flows visible and uses fictional repository names, symbols, paths,
  topology signals, and Manager data.
- Publishing simulations show the preview and explicit approval boundary.
- The home-page Manager recording must come from the real Manager with isolated example data. Keep its still image and pause control in sync, and exclude loading screens, private data, local paths, and session tokens from every frame.
- Keep useful content in the DOM when animation is disabled. Honor reduced motion and keep canvas scenes decorative.

## GitHub Pages

`.github/workflows/pages.yml` builds the site with the repository-pinned Bun version, uploads only `site-dist/`, and
deploys it through GitHub Pages Actions. The production origin is `https://threadnote.io`, so the workflow builds with
`THREADNOTE_SITE_BASE=/` and all public routes live directly under the domain root.

The repository Pages source must be **GitHub Actions**, not the legacy `main:/docs` source. The transition page formerly
at `docs/index.html` has been retired; do not recreate it or configure Pages to publish the checked-in documentation
tree. A repository `CNAME` file is intentionally absent: GitHub ignores it for custom Actions-based Pages deployments,
and the custom domain is configured in repository settings.

### Custom-domain cutover

Perform the control-plane changes in this order to avoid domain takeover and certificate failures:

1. In personal **GitHub Settings → Pages**, add and verify `threadnote.io`. Publish the TXT record GitHub supplies at
   `_github-pages-challenge-Kashkovsky.threadnote.io` and retain it after verification.
2. After the Website workflow exists on `main`, set **Repository Settings → Pages → Source** to **GitHub Actions**.
3. In the same repository Pages settings, set the custom domain to `threadnote.io` before changing its public DNS.
4. Replace any registrar parking records with all four GitHub Pages apex `A` records:
   `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, and `185.199.111.153`.
5. Set `www` as a `CNAME` directly to `Kashkovsky.github.io` (without `/threadnote`), so GitHub can redirect it to the
   canonical apex. Do not point `www` at the apex and do not publish wildcard records.
6. Optionally add GitHub's four IPv6 `AAAA` records: `2606:50c0:8000::153`, `2606:50c0:8001::153`,
   `2606:50c0:8002::153`, and `2606:50c0:8003::153`.
7. After DNS propagation and certificate provisioning, enable **Enforce HTTPS**, dispatch the Website workflow, and
   verify `/`, `/performance/`, `/docs/`, `/whats-new/`, `/pro-tips/`, `/faq/`, `/robots.txt`, and
   `/sitemap.xml`.

After cutover, set the repository About homepage to `https://threadnote.io/` and submit
`https://threadnote.io/sitemap.xml` to the search-engine webmaster consoles in use. The default project Pages URL and
the configured `www` variant should redirect to the canonical apex.

The CLI release build copies only `assets/`, `config/`, `cursor-plugin/`, and `packages/manager/static/` into the npm
artifact. `bun run check:self-contained` rejects source-only trees such as `docs/`, `training/`, `apps/`, `packages/`,
and `site-dist/` inside a compiled release.
