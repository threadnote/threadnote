import {Array as EffectArray} from 'effect';
import {Icon} from '../components/Icons';
import {SiteShell} from '../components/SiteShell';
import {
  performanceControlLanguages,
  retainedPerformanceArtifactFieldPaths,
  retainedPerformanceObjectiveResults,
  type RetainedPerformanceArtifact,
} from '@threadnote/evidence/performance';
import {performanceEvidence} from '../content/performanceEvidence';
import {docsArticleHref, setDocumentMeta, siteHref} from '../lib/site';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const integerFormatter = new Intl.NumberFormat('en-US');

function formatInteger(value: number): string {
  return integerFormatter.format(value);
}

function formatBytes(value: number): string {
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(1)} GiB`;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds.toFixed(1)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} s`;
  return `${(milliseconds / 60_000).toFixed(1)} min`;
}

function formatMeasuredDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds.toFixed(1)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(3)} s`;
  const minutes = Math.floor(milliseconds / 60_000);
  return `${minutes}m ${((milliseconds % 60_000) / 1_000).toFixed(3)}s`;
}

const pipeline = [
  {
    number: '01',
    label: 'Discover',
    title: 'Prune before reading',
    body: 'Dependency trees, hidden folders, generated roots, build output, and Bazel output trees are excluded during traversal—not materialized and discarded later.',
  },
  {
    number: '02',
    label: 'Extract',
    title: 'Bound each file, not the repository',
    body: 'A bounded parser worker pool applies per-file complexity budgets. Pathological source keeps declarations and imports; low-signal structured data keeps useful metadata.',
  },
  {
    number: '03',
    label: 'Persist',
    title: 'Prepare in parallel, write with backpressure',
    body: 'Workers feed one backpressured SQLite writer. Deterministic batches and compact lexical postings control transient memory and write amplification.',
  },
  {
    number: '04',
    label: 'Activate',
    title: 'Keep the last good snapshot live',
    body: 'Queries continue reading the ready graph until the building snapshot validates and promotes atomically. Interrupted builds never replace known-good evidence.',
  },
] as const;

function surfaceCards(artifact: RetainedPerformanceArtifact | undefined) {
  return [
    {
      label: 'CLI',
      title: 'Operational detail for the person waiting',
      body: 'File and language activity, phase timings, row counts, persistence stages, storage high-water, and liveness make long cold builds observable.',
      detail: 'Interactive progress · privacy-safe diagnostics',
    },
    {
      label: 'Manager',
      title: artifact ? 'Bounded views, retained measurements' : 'Bounded, snapshot-aware views',
      body: artifact
        ? `The retained run covers indexed catalog, bounded graph query, overview, detail, and client-side layout preparation with a ${formatInteger(artifact.manager.nodeBudget)}-node / ${formatInteger(artifact.manager.edgeBudget)}-edge evidence budget and snapshot binding. Real Manager query controls exercise the GraphWorkspace request gate: superseding aborts an in-flight request, and a completed late response is rejected before it can update the UI.`
        : 'Manager reads bounded snapshots and rejects stale responses. Its current architecture is covered here without turning a development observation into a browser-rendering SLA.',
      detail: artifact
        ? `Query p95 ${formatDuration(artifact.manager.queryP95Milliseconds)} · max payload ${formatBytes(artifact.manager.queryMaxPayloadBytes)}`
        : 'Bounded payloads · cancellable requests',
    },
    {
      label: 'Graph MCP',
      title: 'Concise evidence for the agent',
      body: 'Graph responses stay deliberately bounded so a large repository cannot flood an agent context. Stable IDs support precise node, neighbor, path, and impact follow-ups.',
      detail: 'Small result · explicit drill-down',
    },
    {
      label: 'Memory MCP',
      title: 'Canonical memory reads stay retrievable',
      body: 'Recall returns ranked pointers. Bounded memory pages preserve canonical content and provide explicit continuation until the selected record is complete.',
      detail: 'Ranked recall · bounded continuation',
    },
  ] as const;
}

const retainedProofGroups = [
  {
    label: 'Exact provenance',
    body: 'The complete harness artifact binds its bytes, exact source and public-repository commits, the measured local-source ApplicationLayer, and a separately validated—but not executed—managed payload, plus hardware, Bun, SQLite, and disk details.',
  },
  {
    label: 'End-to-end phases',
    body: 'Cold discovery, extraction, materialization, resolution, activation, and total time; then a one-file incremental overlay with explicit registration, post-scan, and proportional-work counters plus an independent rebuild of that same overlay.',
  },
  {
    label: 'Resource high-water',
    body: 'Database footprint, resident-memory and transient-storage high-water marks, end-to-end durable filesystem growth, query latency distribution, and bounded Manager response and layout-preparation measurements.',
  },
  {
    label: 'Correctness controls',
    body: 'Java, Kotlin, TypeScript, and Bazel controls plus the clean digest and exact incremental-versus-independent-rebuild structural digest parity.',
  },
] as const;

type EvidenceCard = Readonly<{label: string; value: string; detail: string}>;

const production431Baseline = {
  coldMilliseconds: 9_857_300,
  oneFileMilliseconds: 184_400,
  registrationMilliseconds: 50_400,
  postScanMilliseconds: 37_100,
} as const;

function reductionPercent(baseline: number, observed: number): string {
  return `${((1 - observed / baseline) * 100).toFixed(1)}% lower`;
}

function scaleCards(artifact: RetainedPerformanceArtifact | undefined): readonly EvidenceCard[] {
  if (!artifact) {
    return [
      {
        label: 'Indexed files',
        value: 'Pending',
        detail: 'Exact-release artifact required',
      },
      {
        label: 'Symbols',
        value: 'Pending',
        detail: 'No historical fallback is promoted',
      },
      {
        label: 'Relationships',
        value: 'Pending',
        detail: 'No mixed-source evidence',
      },
      {
        label: 'Graph database',
        value: 'Pending',
        detail: 'Current evidence unavailable',
      },
    ];
  }
  return [
    {
      label: 'Eligible files',
      value: formatInteger(artifact.inventory.eligibleFiles),
      detail: `${formatInteger(artifact.inventory.indexedFiles)} indexed`,
    },
    {label: 'Symbols', value: formatInteger(artifact.graph.symbols), detail: 'Searchable declarations and structure'},
    {
      label: 'Relationships',
      value: formatInteger(artifact.graph.relationships),
      detail: `${formatInteger(artifact.graph.referenceCandidates)} reference candidates`,
    },
    {
      label: 'Graph database',
      value: formatBytes(artifact.storage.databaseBytes),
      detail: 'Persistent SQLite footprint',
    },
  ];
}

function phaseCards(artifact: RetainedPerformanceArtifact | undefined): readonly EvidenceCard[] {
  if (!artifact) {
    return [
      {
        label: 'Cold index',
        value: 'Pending',
        detail: 'Exact-release evidence required',
      },
      {
        label: 'One-file incremental',
        value: 'Pending',
        detail: 'Exact-release evidence required',
      },
      {
        label: 'Independent rebuild',
        value: 'Pending',
        detail: 'Same-overlay parity evidence required',
      },
      {
        label: 'Exact-current graph query p95',
        value: 'Pending',
        detail: 'Retained samples required',
      },
    ];
  }
  return [
    {
      label: 'Cold index',
      value: formatMeasuredDuration(artifact.phases.cold.totalMilliseconds),
      detail: 'Clean exact-HEAD run',
    },
    {
      label: 'One-file incremental',
      value: formatMeasuredDuration(artifact.phases.incremental.totalMilliseconds),
      detail:
        `Registration ${formatMeasuredDuration(artifact.phases.incremental.registrationMilliseconds)} · ` +
        `post-scan ${formatMeasuredDuration(artifact.phases.incremental.postCommittedScanMilliseconds)}`,
    },
    {
      label: 'Independent rebuild',
      value: formatMeasuredDuration(artifact.phases.independentRebuild.totalMilliseconds),
      detail: 'Identical dirty overlay',
    },
    {
      label: 'Exact-current graph query p95',
      value: formatDuration(artifact.queries.p95Milliseconds),
      detail: `Includes exact Git/worktree observation · ${formatInteger(artifact.queries.sampleCount)} retained samples`,
    },
  ];
}

function ProvenanceCard({artifact}: {artifact: RetainedPerformanceArtifact | undefined}) {
  if (!artifact) {
    return (
      <aside className="performance-run-card performance-run-card--observed" aria-live="polite">
        <header>
          <div>
            <span className="status-dot" />
            <strong>Current evidence pending</strong>
          </div>
          <small>fail closed</small>
        </header>
        <p>
          This build did not receive a complete, source-matched exact-release artifact. Historical observations are not
          substituted for current product evidence.
        </p>
      </aside>
    );
  }
  return (
    <aside className="performance-run-card performance-run-card--verified">
      <header>
        <div>
          <span className="status-dot" />
          <strong>Retained evidence verified</strong>
        </div>
        <small>{artifact.artifact.generatedAt}</small>
      </header>
      <a href={artifact.artifact.url} target="_blank" rel="noreferrer">
        <span>Benchmark artifact</span>
        <strong>{artifact.source.repository.name}</strong>
        <code>{Effect.pipe(artifact.artifact.sha256, EffectString.slice(0, 16))}…</code>
      </a>
      <dl>
        <div>
          <dt>Threadnote</dt>
          <dd>{Effect.pipe(artifact.source.threadnote.commit, EffectString.slice(0, 12))}</dd>
        </div>
        <div>
          <dt>Repository</dt>
          <dd>{Effect.pipe(artifact.source.repository.commit, EffectString.slice(0, 12))}</dd>
        </div>
        <div>
          <dt>Runner</dt>
          <dd>{artifact.runner.hardware}</dd>
        </div>
      </dl>
      <p>
        {artifact.runner.runtime.name} {artifact.runner.runtime.version} · {artifact.runner.database.name}{' '}
        {artifact.runner.database.version} · {artifact.runner.runtime.target} ·{' '}
        {formatBytes(artifact.runner.memoryBytes)} memory
      </p>
    </aside>
  );
}

export default function PerformancePage() {
  setDocumentMeta(
    'Performance',
    'Threadnote 4 large-repository architecture and retained benchmark evidence for polyglot, Bazel, and fast concurrent-worktree codebases.',
  );

  const artifact = performanceEvidence.state === 'verified' ? performanceEvidence.artifact : undefined;
  const metrics = scaleCards(artifact);
  const phases = phaseCards(artifact);
  const objectives = artifact ? retainedPerformanceObjectiveResults(artifact) : [];
  const passedObjectiveCount = EffectArray.filter(
    objectives,
    (objective, __effectArrayIndex) => __effectArrayIndex in objectives && objective.passed,
  ).length;
  const surfaces = surfaceCards(artifact);
  const proofGroups = retainedProofGroups;

  return (
    <SiteShell page="performance" fullBleed>
      <section className="performance-hero">
        <div className="performance-hero__copy">
          <span className="eyebrow">Threadnote 4 performance</span>
          <h1>Large codebases are a normal case.</h1>
          <p>
            Threadnote is built for the repository you actually work in: polyglot, Bazel-aware, nested, and active
            across concurrent worktrees. Repository size is never an admission test.
          </p>
          <div className="performance-hero__actions">
            <a className="button" href="#evidence">
              Inspect measured evidence
              <Icon name="arrow" aria-hidden="true" />
            </a>
            <a className="button button--ghost" href={docsArticleHref('graph-monorepos')}>
              Large-repository docs
            </a>
            <a className="button button--ghost" href={siteHref('performance/graphify/')}>
              Compare with Graphify
            </a>
          </div>
        </div>
        <ProvenanceCard artifact={artifact} />
      </section>

      <section className="performance-scale" id="evidence" aria-label="Retained benchmark scale">
        {EffectArray.map(metrics, metric => (
          <article key={metric.label}>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
            <small>{metric.detail}</small>
          </article>
        ))}
      </section>

      <section className="performance-section performance-proof">
        <header className="section-heading section-heading--split">
          <div>
            <span className="eyebrow">Measured with named scope</span>
            <h2>Public evidence, honest boundaries.</h2>
          </div>
          <p>
            The large-repository measurements come from one pinned IntelliJ Community snapshot. Focused and failed
            release observations are retained separately and labeled by scope instead of being presented as one
            universal end-to-end run; only the final v4.3.8 artifact is publicly bound on this page.
          </p>
        </header>

        <div className="performance-proof-grid">
          {EffectArray.map(proofGroups, group => (
            <article key={group.label}>
              <span className={artifact ? 'performance-check performance-check--passed' : 'performance-check'} />
              <small>{artifact ? 'verified release run' : 'checked-in observation'}</small>
              <h3>{group.label}</h3>
              <p>{group.body}</p>
            </article>
          ))}
        </div>

        <div className="performance-control-panel">
          <header>
            <div>
              <span className="eyebrow">Polyglot controls</span>
              <h3>Definitions and build structure must survive scale.</h3>
            </div>
            <p>Each control records its exact query, path, stable node ID, latency, and pass state.</p>
          </header>
          <div>
            {EffectArray.map(performanceControlLanguages, language => {
              const control = artifact?.controls[language];
              return (
                <article key={language}>
                  <span>{language === 'bazel' ? 'Bazel / Starlark' : language}</span>
                  <strong>{control ? formatDuration(control.milliseconds) : 'Pending'}</strong>
                  <small>{control?.path ?? 'Exact-release control evidence required'}</small>
                </article>
              );
            })}
          </div>
        </div>

        <div className="performance-phase-panel">
          <header>
            <span className="eyebrow">Measured execution paths</span>
            <p>
              Every timing has one named scope. The exact-current graph query includes worktree/Git observation and
              graph retrieval; CLI, MCP, and browser startup remain outside that retained sample.
            </p>
          </header>
          <div>
            {EffectArray.map(phases, phase => (
              <article key={phase.label}>
                <span>{phase.label}</span>
                <strong>{phase.value}</strong>
                <small>{phase.detail}</small>
              </article>
            ))}
          </div>
        </div>

        {artifact ? (
          <>
            <div className="performance-phase-panel">
              <header>
                <span className="eyebrow">Release engineering targets</span>
                <p>
                  {passedObjectiveCount} of {objectives.length} targets passed on this exact pinned run. Open targets
                  stay visible; they do not invalidate complete, correct evidence.
                </p>
              </header>
              <div>
                {EffectArray.map(objectives, objective => (
                  <article key={objective.measurement}>
                    <span>{objective.label}</span>
                    <strong>{objective.passed ? 'Passed' : 'Open'}</strong>
                    <small>
                      {formatMeasuredDuration(objective.observedMilliseconds)} observed · target under{' '}
                      {formatMeasuredDuration(objective.targetMilliseconds)}
                    </small>
                  </article>
                ))}
              </div>
            </div>
            <div className="performance-phase-panel">
              <header>
                <span className="eyebrow">From production v4.3.1 to v4.3.8</span>
                <p>
                  Same pinned IntelliJ commit and runner. The historical v4.3.1 values are the rounded retained
                  production observation recorded in{' '}
                  <a href="https://github.com/threadnote/threadnote/issues/203" target="_blank" rel="noreferrer">
                    issue #203
                  </a>
                  ; v4.3.8 values come from the exact bound artifact above.
                </p>
              </header>
              <div>
                <article>
                  <span>Cold index</span>
                  <strong>
                    {reductionPercent(production431Baseline.coldMilliseconds, artifact.phases.cold.totalMilliseconds)}
                  </strong>
                  <small>164m 17.3s → {formatMeasuredDuration(artifact.phases.cold.totalMilliseconds)}</small>
                </article>
                <article>
                  <span>One-file incremental</span>
                  <strong>
                    {reductionPercent(
                      production431Baseline.oneFileMilliseconds,
                      artifact.phases.incremental.totalMilliseconds,
                    )}
                  </strong>
                  <small>184.4s → {formatMeasuredDuration(artifact.phases.incremental.totalMilliseconds)}</small>
                </article>
                <article>
                  <span>Registration</span>
                  <strong>
                    {reductionPercent(
                      production431Baseline.registrationMilliseconds,
                      artifact.phases.incremental.registrationMilliseconds,
                    )}
                  </strong>
                  <small>50.4s → {formatMeasuredDuration(artifact.phases.incremental.registrationMilliseconds)}</small>
                </article>
                <article>
                  <span>Post-committed scan</span>
                  <strong>
                    {reductionPercent(
                      production431Baseline.postScanMilliseconds,
                      artifact.phases.incremental.postCommittedScanMilliseconds,
                    )}
                  </strong>
                  <small>
                    37.1s → {formatMeasuredDuration(artifact.phases.incremental.postCommittedScanMilliseconds)}
                  </small>
                </article>
              </div>
            </div>
          </>
        ) : null}

        <div className="performance-phase-panel">
          <header>
            <span className="eyebrow">Evidence discipline</span>
            <p>
              Four release versions produced five exact-release observations that missed the hard registration target.
              All are disclosed here; no unchanged run was added merely to wait for a favorable sample.
            </p>
          </header>
          <div>
            <article>
              <span>v4.3.4 observation 1</span>
              <strong>Registration open by 212 ms</strong>
              <small title="Artifact SHA-256 c25e1dc8cdbc96e5aa0e4803f37bc949e9b4220e109ecf0245171471d5f8bc9d">
                58m 47.730s cold · 11.618s one-file · 5.212s registration · 57ms post-scan · SHA-256 c25e1dc8…
              </small>
            </article>
            <article>
              <span>v4.3.4 observation 2</span>
              <strong>Registration open by 191 ms</strong>
              <small title="Artifact SHA-256 0f3ba956f491d4de39d81101ddfaae029eb097146cea29ce3f848f69bbf79fad">
                57m 38.761s cold · 9.876s one-file · 5.191s registration · 54.6ms post-scan · SHA-256 0f3ba956…
              </small>
            </article>
            <article>
              <span>v4.3.5 observation 1</span>
              <strong>Registration open by 234 ms</strong>
              <small title="Artifact SHA-256 cc337e8778eb8e2d0590b995f43985f21f6da3ec50ec2bdb53d201cbce1110f7">
                58m 33.894s cold · 11.791s one-file · 5.234s registration · 56.8ms post-scan · SHA-256 cc337e87…
              </small>
            </article>
            <article>
              <span>v4.3.6 observation 1</span>
              <strong>Registration open by 178 ms</strong>
              <small title="Artifact SHA-256 731f8694ac4e4617601ba814dacba7d95729ad32a7537c7dea1bfd2d7efcd569">
                58m 46.774s cold · 11.818s one-file · 5.178s registration · 57.2ms post-scan · SHA-256 731f8694…
              </small>
            </article>
            <article>
              <span>v4.3.7 observation 1</span>
              <strong>Registration open by 255 ms</strong>
              <small title="Artifact SHA-256 899faf6380b2fb6a69078b5cd79837451453be02541df4956854da1df6414a97">
                59m 43.019s cold · 12.169s one-file · 5.255s registration · 58.3ms post-scan · SHA-256 899faf63…
              </small>
            </article>
            {artifact ? (
              <article>
                <span>{artifact.source.threadnote.version} exact release</span>
                <strong>All four targets passed</strong>
                <small title={`Artifact SHA-256 ${artifact.artifact.sha256}`}>
                  {formatMeasuredDuration(artifact.phases.cold.totalMilliseconds)} cold ·{' '}
                  {formatMeasuredDuration(artifact.phases.incremental.totalMilliseconds)} one-file ·{' '}
                  {formatMeasuredDuration(artifact.phases.incremental.registrationMilliseconds)} registration ·{' '}
                  {formatMeasuredDuration(artifact.phases.incremental.postCommittedScanMilliseconds)} post-scan ·
                  SHA-256 {Effect.pipe(artifact.artifact.sha256, EffectString.slice(0, 8))}…
                </small>
              </article>
            ) : null}
            <article>
              <span>What the evidence established</span>
              <strong>Correctness held while diagnosis narrowed</strong>
              <small>
                Every failed observation retained parity, proportional work, transaction bounds, polyglot controls, and
                zero required failure counters. v4.3.7 isolated the remaining registration cost to reusable receipt
                payload work.{' '}
                {artifact
                  ? `${artifact.source.threadnote.version} cleared it without weakening those controls.`
                  : 'Final closure stays pending until the exact release adapter verifies its source and digest.'}
              </small>
            </article>
          </div>
        </div>
      </section>

      <section className="performance-pipeline">
        <header className="section-heading section-heading--split">
          <div>
            <span className="eyebrow">Bounded by architecture</span>
            <h2>Control the work. Never reject the repository.</h2>
          </div>
          <p>
            Large-repository reliability comes from bounded units and backpressure, not an arbitrary repository byte or
            row limit. Complexity budgets degrade individual pathological artifacts while useful structure remains
            searchable.
          </p>
        </header>
        <ol>
          {EffectArray.map(pipeline, stage => (
            <li key={stage.number}>
              <div>
                <span>{stage.number}</span>
                <small>{stage.label}</small>
              </div>
              <h3>{stage.title}</h3>
              <p>{stage.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="performance-section performance-surfaces">
        <header className="section-heading">
          <span className="eyebrow">Right detail for the reader</span>
          <h2>Detailed where humans operate. Compact where agents reason.</h2>
          <p>
            Operational visibility should not become MCP context pollution. Threadnote intentionally gives each surface
            a different information budget.
          </p>
        </header>
        <div>
          {EffectArray.map(surfaces, surface => (
            <article key={surface.label}>
              <span>{surface.label}</span>
              <h3>{surface.title}</h3>
              <p>{surface.body}</p>
              <code>{surface.detail}</code>
            </article>
          ))}
        </div>
      </section>

      <section className="performance-methodology">
        <div>
          <span className="eyebrow">Read the numbers honestly</span>
          <h2>Evidence, not a universal SLA.</h2>
        </div>
        <div>
          <p>
            One pinned public repository on one reviewed runner shows the observed cold, one-file incremental,
            independent-rebuild, query, and Manager paths working at that shape. It does not promise identical times for
            every repository, disk, operating system, or machine.
          </p>
          {artifact ? (
            <>
              <p>
                The release-run adapter verified all {retainedPerformanceArtifactFieldPaths.length} retained fields and
                fails closed on malformed, mixed, or source-mismatched evidence. The public artifact is bound to its
                exact bytes, Threadnote source, {artifact.source.threadnote.version} release commit, and pinned IntelliJ
                commit.
              </p>
              <p>
                The retained IntelliJ run covers {formatInteger(artifact.inventory.indexedFiles)} indexed files,{' '}
                {formatInteger(artifact.graph.symbols)} symbols, {formatInteger(artifact.graph.relationships)}{' '}
                relationships, and Java, Kotlin, TypeScript, and Bazel controls. Its one-file overlay matches the
                independent rebuild's structural digest exactly.
              </p>
              <p>
                This exact release run met {passedObjectiveCount} of {objectives.length} stated engineering targets.
                Targets that remain open are shown beside their observed measurements instead of being hidden or
                promoted into a universal latency promise.
              </p>
              <p>
                Auxiliary audit note: after the headline cold and one-file phases had completed, a separate read-only{' '}
                <code>git status --porcelain</code> inspected fixture metadata for 4.6 seconds during the independent
                same-overlay rebuild. It changed no files and was outside the measured process tree. Treat the
                independent-rebuild wall/resource fields as having that bounded external I/O; the four headline target
                timings preceded it.
              </p>
              <p>
                For that {formatInteger(artifact.phases.incremental.changedFiles)}-file overlay, the harness recorded:{' '}
                {formatInteger(artifact.phases.incremental.inventoryFilesInspected)} inventory files inspected;{' '}
                {formatInteger(artifact.phases.incremental.baseFactsLoaded)} base facts loaded;{' '}
                {formatInteger(artifact.phases.incremental.attributionContextFiles)} attribution-context files; and{' '}
                {formatInteger(artifact.phases.incremental.probedDependencyPaths)} dependency-path probes against{' '}
                {formatInteger(artifact.phases.incremental.totalFiles)} total files. It planned{' '}
                {formatInteger(artifact.phases.incremental.plannedRows)} rows from{' '}
                {formatBytes(artifact.phases.incremental.sourceBytes)} of source and{' '}
                {formatBytes(artifact.phases.incremental.factBytes)} of facts, with{' '}
                {formatInteger(artifact.phases.incremental.deletedFiles)} deleted files. These counters distinguish
                bounded changed/fanout work from a repository-wide scan.
              </p>
            </>
          ) : (
            <p>
              A comprehensive release-run adapter requires {retainedPerformanceArtifactFieldPaths.length} retained
              fields and fails closed on malformed, missing, mixed, or source-mismatched evidence. Current cards remain
              pending rather than falling back to results from an older release.
            </p>
          )}
          <p>
            Permanent development ratchets use reduced deterministic fixtures so ordinary pull requests do not rebuild
            IntelliJ. They preserve correctness, proportional-work, storage, resource, and failure controls; exact
            IntelliJ observations remain manual release evidence and are never promoted into a universal percentile.
          </p>
        </div>
      </section>

      <section className="content-section content-section--cta">
        <div className="cta-panel cta-panel--compact">
          <span className="eyebrow">Built for agents</span>
          <h2>Your agents will love it—even when the repository is enormous.</h2>
          <p>Give them precise current-source evidence without filling their context with the machinery behind it.</p>
          <div className="cta-panel__actions">
            <a className="button" href={docsArticleHref('installation')}>
              Install Threadnote
            </a>
            <a className="button button--ghost" href={docsArticleHref('manager')}>
              Explore Manager
            </a>
          </div>
        </div>
      </section>
    </SiteShell>
  );
}
