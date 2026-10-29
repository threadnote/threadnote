import {Array as EffectArray} from 'effect';
import {Icon} from '../components/Icons';
import {SiteShell} from '../components/SiteShell';
import {
  graphifyReviewedSource,
  graphifySharedCapabilities,
  graphifyVerifiedDifferences,
} from '../content/graphifyComparison';
import {performanceEvidence} from '../content/performanceEvidence';
import {docsArticleHref, setDocumentMeta, siteHref} from '../lib/site';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const integerFormatter = new Intl.NumberFormat('en-US');
const threadnoteComparator = {
  artifactSha256: 'b56994fe99c3d68be80f79315b88d4420a7241a76de72c317d2fc3d84de23b39',
  commit: 'f1e4102a78e4df2127fca0c4d59da39ffb5f70a6',
  version: 'v4.3.8',
} as const;

function formatInteger(value: number): string {
  return integerFormatter.format(value);
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds.toFixed(1)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(3)} s`;
  const minutes = Math.floor(milliseconds / 60_000);
  return `${minutes}m ${((milliseconds % 60_000) / 1_000).toFixed(3)}s`;
}

export default function GraphifyPerformancePage() {
  setDocumentMeta(
    'Threadnote and Graphify',
    'A source-reviewed Threadnote and Graphify comparison with shared graph capabilities, verified workflow differences, and separately labeled performance evidence.',
  );

  const verifiedArtifact = performanceEvidence.state === 'verified' ? performanceEvidence.artifact : undefined;
  const artifact =
    verifiedArtifact?.source.threadnote.version === threadnoteComparator.version &&
    verifiedArtifact.source.threadnote.commit === threadnoteComparator.commit &&
    verifiedArtifact.artifact.sha256 === threadnoteComparator.artifactSha256
      ? verifiedArtifact
      : undefined;

  return (
    <SiteShell page="performance-graphify" fullBleed>
      <section className="subpage-hero comparison-hero">
        <div>
          <span className="eyebrow">Performance / Graphify</span>
          <h1>Compare the evidence boundary, not the feature count.</h1>
          <p>
            Threadnote and Graphify overlap substantially in graph analysis. This page starts with that parity, then
            separates only source-verified architecture, workflow, semantic, and scale differences.
          </p>
        </div>
        <div className="subpage-hero__metric">
          <strong>{graphifyReviewedSource.version}</strong>
          <span>Graphify source reviewed</span>
          <small>
            Exact commit {Effect.pipe(graphifyReviewedSource.commit, EffectString.slice(0, 12))} · 25 August 2026
          </small>
        </div>
      </section>

      <section className="comparison-section comparison-parity" id="shared-capabilities">
        <header className="section-heading section-heading--split">
          <div>
            <span className="eyebrow">Shared capabilities</span>
            <h2>These are parity, not reasons to choose one.</h2>
          </div>
          <p>
            Similar labels do not imply identical files or algorithms. They do mean that neither product should be
            presented as uniquely offering the following graph-analysis workflows.
          </p>
        </header>
        <div className="performance-proof-grid">
          {EffectArray.map(graphifySharedCapabilities, capability => (
            <article key={capability.title}>
              <span className="performance-check performance-check--passed" />
              <small>available in both</small>
              <h3>{capability.title}</h3>
              <p>{capability.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="comparison-section" id="verified-differences">
        <header className="section-heading section-heading--split">
          <div>
            <span className="eyebrow">Verified differences</span>
            <h2>The systems optimize for different continuity boundaries.</h2>
          </div>
          <p>
            Threadnote is an engineering-context runtime around a current, worktree-aware graph. Graphify is a project
            graph suite with a wider optional semantic and downstream-target surface. Both can be useful together.
          </p>
        </header>

        <div className="comparison-intro">
          <article className="comparison-product comparison-product--threadnote">
            <span>Threadnote 4</span>
            <h3>Current source plus memory across sessions</h3>
            <p>
              Choose Threadnote when exact repository state, bounded agent evidence, durable decisions, and team
              handoffs must stay connected as work moves between worktrees and assistants.
            </p>
          </article>
          <div className="comparison-plus" aria-hidden="true">
            <span>or</span>
            <small>often, both</small>
          </div>
          <article className="comparison-product comparison-product--graphify">
            <span>Graphify {graphifyReviewedSource.version}</span>
            <h3>Project graph plus optional semantic pipelines</h3>
            <p>
              Choose Graphify for its project-graph workflow, optional model-backed document and image semantics,
              transcription path, PR tooling, and additional generated graph destinations.
            </p>
          </article>
        </div>

        <div className="comparison-table-wrap">
          <table className="comparison-table">
            <thead>
              <tr>
                <th>Dimension</th>
                <th>Threadnote 4</th>
                <th>Graphify {graphifyReviewedSource.version}</th>
              </tr>
            </thead>
            <tbody>
              {EffectArray.map(graphifyVerifiedDifferences, row => (
                <tr key={row.dimension}>
                  <th>{row.dimension}</th>
                  <td>{row.threadnote}</td>
                  <td>{row.graphify}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="comparison-note">
          Graphify descriptions were reviewed against the published{' '}
          <a href={graphifyReviewedSource.sourceUrl} target="_blank" rel="noreferrer">
            {graphifyReviewedSource.version} source at{' '}
            {Effect.pipe(graphifyReviewedSource.commit, EffectString.slice(0, 12))}
            <span aria-hidden="true"> ↗</span>
          </a>{' '}
          and its{' '}
          <a href={graphifyReviewedSource.packageUrl} target="_blank" rel="noreferrer">
            package metadata <span aria-hidden="true">↗</span>
          </a>
          . Product capabilities can evolve independently.
        </p>
      </section>

      <section className="comparison-section comparison-scale" id="scale-evidence">
        <header className="section-heading section-heading--split">
          <div>
            <span className="eyebrow">Scale evidence</span>
            <h2>Right-censored artifact non-arrival.</h2>
          </div>
          <p>
            The Graphify observation is a right-censored lower bound, not an invented eventual completion time. The
            operator sent <code>SIGINT</code> after the recorded five-hour utility threshold had been exceeded; the
            frozen command had not produced a supported terminal graph.
          </p>
        </header>

        <div className="comparison-intro">
          <article className="comparison-product comparison-product--threadnote">
            <span>
              {artifact ? `${artifact.source.threadnote.version} exact release` : 'Threadnote release evidence'}
            </span>
            <h3>
              {artifact
                ? `${formatDuration(artifact.phases.cold.totalMilliseconds)} cold build`
                : 'Evidence unavailable'}
            </h3>
            <p>
              {artifact ? (
                <>
                  {formatInteger(artifact.inventory.indexedFiles)} files · {formatInteger(artifact.graph.symbols)}{' '}
                  symbols · {formatInteger(artifact.graph.relationships)} relationships. One-file incremental:{' '}
                  {formatDuration(artifact.phases.incremental.totalMilliseconds)} with exact independent-rebuild parity.
                </>
              ) : (
                'The fail-closed release adapter did not expose a verified artifact for this build.'
              )}
            </p>
            {artifact ? (
              <a className="text-link" href={artifact.artifact.url} target="_blank" rel="noreferrer">
                Inspect retained Threadnote evidence <Icon name="arrow" aria-hidden="true" />
              </a>
            ) : null}
          </article>
          <div className="comparison-plus" aria-hidden="true">
            <span>vs</span>
            <small>same fixture</small>
          </div>
          <article className="comparison-product comparison-product--graphify">
            <span>Graphify {graphifyReviewedSource.version}</span>
            <h3>No graph after 5h 32m 40s</h3>
            <p>
              The guarded code-only run was operator-terminated at 5:32:39.939. Per-file AST progress completed, but
              neither <code>graph.json</code> nor its atomic write-temp existed, so no supported query surface could be
              exercised.
            </p>
            <a
              className="text-link"
              href={siteHref(
                'graphify-intellij-evidence.bd4686d2fce1fe369c73ac77ebe65604bcb3af6fb4564691d10dfb296aca61b1.json',
              )}
              target="_blank"
              rel="noreferrer"
            >
              Inspect retained Graphify evidence <Icon name="arrow" aria-hidden="true" />
            </a>
          </article>
        </div>
        <p className="comparison-note">
          Both observations used the same Apple M1 Max, 64 GiB memory, internal APFS SSD, and fixture commit. Graphify
          records four workers in its public summary. Threadnote&apos;s separately retained operator launcher also set
          four workers (SHA-256 <code>3d8edfd8…</code>), but its bound benchmark artifact does not serialize that field.
          Threadnote used Bun 1.3.14; the Graphify package <code>graphifyy</code> 0.9.49 used Python 3.12.5. Its exact
          product command was <code>graphify extract . --code-only --no-cluster --timing --max-workers 4</code> inside a
          no-network sandbox.
        </p>
        <p className="comparison-note">
          The common structural stopwatch compares Threadnote lexical-only indexing with Graphify code-only extraction;
          both stay on deterministic local extraction and spend no provider tokens. Separately, Threadnote can add its
          installed local embedding model for semantic vector seeds without calling a hosted embedding service. That
          still consumes local CPU or GPU, memory, and energy. Graphify&apos;s model-backed document and media paths are
          useful product capabilities, but they are outside this structural timing arm.
        </p>
        {artifact ? (
          <p className="comparison-note">
            The products did not admit identical work: Threadnote indexed{' '}
            {formatInteger(artifact.inventory.indexedFiles)} of {formatInteger(artifact.inventory.eligibleFiles)}{' '}
            eligible files, while Graphify reported 191,249 code files and separately skipped 25,799 non-code, 52,519
            unclassified, and 65 sensitive-path files. Their native discovery contracts are part of the products, so the
            5.825× elapsed multiple before Graphify artifact arrival is neither a completion-time nor a throughput
            ratio.
          </p>
        ) : (
          <p className="comparison-note">
            Graphify&apos;s native inventory remains available in its retained evidence. Cross-product file counts and
            elapsed context stay hidden unless the exact v4.3.8 comparator artifact passes its source and digest checks.
          </p>
        )}
        <p className="comparison-note">
          Across the full 5:32:39.939 observation, Graphify&apos;s process tree accumulated 20,309.960 CPU-seconds—about
          1.018 CPU cores on average. Parent RSS was 12.1 GB immediately before termination, process-tree peak RSS was
          14.8 GB, swap growth remained zero, and no sampler failed. Its 3.7 GB per-file AST cache survived. Source
          review of v0.9.49 found no durable checkpoint for resuming the in-memory cross-file resolution and downstream
          graph construction reached by this run. The <code>SIGINT</code> stack located current work in{' '}
          <code>disambiguate_ambiguous_candidates</code>, where <code>set(test_cands)</code> was rebuilt inside a
          candidate loop. That is a source-visible superlinear risk and the exact interruption point—not proof that one
          line consumed the entire silent interval.
        </p>
      </section>

      <section className="comparison-section" id="queryability-contract">
        <header className="section-heading section-heading--split">
          <div>
            <span className="eyebrow">Queryability contract</span>
            <h2>A graph file is not the finish line.</h2>
          </div>
          <p>
            The terminal comparison must show that an agent can load and query the result—not merely that extraction
            eventually wrote bytes. Construction, admission, cold hydration, and warm traversal are reported separately.
          </p>
        </header>
        <div className="performance-proof-grid">
          <article>
            <span className="performance-check" />
            <small>default admission · not reached</small>
            <h3>No graph file reached the loader</h3>
            <p>
              Construction produced neither <code>graph.json</code> nor a write-temp, so Graphify&apos;s supported
              default 512 MiB file guard had no artifact to admit or reject.
            </p>
          </article>
          <article>
            <span className="performance-check" />
            <small>cold load · not reached</small>
            <h3>No artifact could be hydrated</h3>
            <p>
              The predeclared raised-cap probe could not read, parse, or hydrate nodes and links into NetworkX because
              the construction stage never published its monolithic JSON input.
            </p>
          </article>
          <article>
            <span className="performance-check" />
            <small>warm use · not reached</small>
            <h3>No warm query process existed</h3>
            <p>
              Exact-symbol, natural structural, and affected-node controls remained unrun. Reporting them as query
              failures would be inaccurate; the graph never reached the prerequisite queryability boundary.
            </p>
          </article>
        </div>
        <p className="comparison-note">
          Under this frozen workflow, no supported terminal graph or query surface arrived before the operator stop. It
          does not claim Graphify could never finish on another machine or with an unknown longer wait; it records that
          an agent had no usable graph after more than five ordinary work hours.
        </p>
      </section>

      <section className="content-section content-section--cta">
        <div className="cta-panel cta-panel--compact">
          <span className="eyebrow">Keep reading the evidence</span>
          <h2>Inspect Threadnote’s retained run and architecture.</h2>
          <p>The main Performance page keeps exact release measurements, methodology, and open targets together.</p>
          <div className="cta-panel__actions">
            <a className="button" href={siteHref('performance/')}>
              Performance evidence
            </a>
            <a className="button button--ghost" href={docsArticleHref('architecture')}>
              Architecture docs
            </a>
          </div>
        </div>
      </section>
    </SiteShell>
  );
}
