import {Array as EffectArray} from 'effect';
import {Icon} from '../components/Icons';
import {SiteShell} from '../components/SiteShell';
import {docsArticleHref, setDocumentMeta, siteHref} from '../lib/site';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const questions = [
  {
    question: 'Is Threadnote a hosted memory service?',
    answer:
      'No. Threadnote 5 has a complete standalone local and Git-team workflow. Canonical Markdown, models, SQLite indexes, graph snapshots, and share metadata live under ~/.threadnote. A network boundary is crossed only for explicit operations such as downloading a verified release or model, syncing a configured team share, submitting an approved issue, or after explicitly enabling anonymous operational telemetry. Hosted organization deployment is a separate track, not a prerequisite.',
  },
  {
    question: 'What is a Knowledge Delta?',
    answer:
      'It is a small, reviewable closeout proposal—not a transcript. It can cover decisions and rationale, constraints, verification performed, knowledge invalidated by the task, and unresolved risks. A person approves, edits, defers, or rejects each candidate at an exact revision. Applying a candidate changes personal memory; publishing it to a team is a separate explicit Git action.',
  },
  {
    question: 'Does Threadnote send prompts or memory to an AI provider?',
    answer:
      'No provider is required for core functionality. The default embedding model runs locally through node-llama-cpp. Threadnote supplies context to the coding agent you connected, so that agent’s own provider and privacy policy still apply.',
  },
  {
    question: 'Does it replace AGENTS.md, repository docs, or source code?',
    answer:
      'No. Repository files remain authoritative. Threadnote makes scoped operational knowledge recallable and gives agents a current structural view of source. Stable project rules and reviewed design documents still belong in the repository.',
  },
  {
    question: 'Why are memory recall and code graph search separate tools?',
    answer:
      'They answer different questions. Recall finds what was learned, decided, or handed off and returns pointers to canonical records. inspect_code_graph answers scoped current-source questions; analyze_code_graph summarizes whole-repository topology. Keeping those surfaces separate stops historical paths from masquerading as current source evidence and avoids mixing a focused query with an architecture-wide analysis.',
  },
  {
    question: 'What do memory-to-code citations and stale-link warnings mean?',
    answer:
      'Code citations are optional capture-time evidence for exact files or symbols. Context Brief checks selected citations against an already-ready current graph: exact or uniquely relocated evidence keeps the memory fresh, while relocation adds a stale-link warning so you can recapture the new locator. That warning is about the link, not the memory. Changed or deleted evidence makes the memory stale, and unavailable or ambiguous evidence stays unknown. Even an exact citation proves that the cited bytes survived—not that the memory prose is automatically correct.',
  },
  {
    question: 'Can an agent start with code and find related memory?',
    answer:
      'Yes. Pass up to eight canonical graph-indexed repository-relative paths or exact local cgs_<32 lowercase hex> symbols as Context Brief codeRefs, or repeat --code-ref in the CLI. Context Brief v3 retrieves active memories with explicit matching citations alongside normal task recall, validates their evidence against an already-ready graph, and reports bounded relation and coverage receipts. Noncanonical paths, malformed handles, and cgr_ handles are argument errors. It does not guess semantic links, start cold indexing, or support Workset code-reference backlinks in this first milestone.',
  },
  {
    question: 'Will my existing memories disappear after upgrading to 5.0?',
    answer:
      'No. Existing v4, v1, and other uncited memories stay readable and recallable. Schema v5 migration does not invent owners, review dates, expiry, or precise citations. Older uncited records keep conservative commit-level freshness when Threadnote can resolve it and otherwise show unknown. Portable checkpoint operations touch only disposable graph storage, so they do not migrate or filter existing memory either.',
  },
  {
    question: 'Do I need a Workset to use code citations or Context Brief?',
    answer:
      'No. For an ordinary one-repository task, pass the absolute callerCwd—or run the CLI from that checkout—and use its ready current graph. A named, explicitly prepared Workset is only for bounded multi-repository evidence. Citation writes never start indexing implicitly: unavailable evidence returns a recovery receipt. Queries against a prepared Workset use only its published ready generation and never fan out cold graph builds.',
  },
  {
    question: 'Which agents can use it?',
    answer:
      'Any agent that can connect a local stdio MCP server or invoke the CLI can use Threadnote. The installer’s exact managed, manual, and experimental boundaries are listed on the supported agents page; the underlying contract is tool-neutral.',
  },
  {
    question: 'Does every memory get shared with my team?',
    answer:
      'No. Memory is private by default. Publishing is a separate previewed and scanned action for selected durable memories or reusable artifacts; soft-leak redaction is explicit. Handoffs, preferences, secrets, customer data, and raw logs should not be published.',
  },
  {
    question: 'What happens when local AI is unavailable?',
    answer:
      'Recall fails open to deterministic lexical, field, scope, lifecycle, authority, and other non-model signals. Derived vector indexes are disposable and can be rebuilt; canonical Markdown remains intact.',
  },
  {
    question: 'Do large monorepos have a hard graph-size cap?',
    answer:
      'There is no repository-size admission cap. Threadnote stores graph generations in SQLite instead of one monolithic JSON document; a bounded parser pool, one backpressured writer, generated-root pruning, and metadata-only snapshot data bound transient work. Individual query responses still honor explicit node, edge, and result limits so an agent receives a useful evidence set rather than an unbounded dump.',
  },
  {
    question: 'How do graph scopes help in a monorepo?',
    answer:
      'A graph scope is a positive, project-level selection of one or more app or library roots plus their declared forward dependencies. It keeps unrelated packages out of that project graph, so changes elsewhere do not constantly make it stale. Preview the scope before indexing; every result reports its coverage, and a path outside the selection is reported as outside the project graph rather than missing. A Workset is different: it combines prepared projects or repositories for one cross-project task.',
  },
  {
    question: 'Will every new worktree rebuild its graph from scratch?',
    answer:
      'No. Linked worktrees share one checkout graph store. Threadnote can immediately alias a graph-equivalent commit, build a compatible clean commit as a bounded delta from a ready full anchor, or construct an already-dirty worktree directly from that anchor. Extractor, workspace, manifest, or unbounded resolution changes still fall back to a full build for correctness.',
  },
  {
    question: 'How does Manager keep long graph work responsive?',
    answer:
      'Manager launches graph indexing and Workset preparation in isolated processes instead of running those builds inside the UI service. Workset repositories prepare with bounded concurrency and report progress independently. Queries still read only a ready, atomically published generation rather than partial build state.',
  },
  {
    question: 'Can I move a graph to another machine without a Workset or cloud?',
    answer:
      'Yes. Portable graph checkpoints are free, manual, offline files. Export the exact ready, clean graph for the current commit, transfer the artifact plus an independently obtained expected SHA-256 digest, run inspect and then the full verify with that digest, and import from a local checkout of the same repository where the source commit already exists. No account, hosted service, or Workset is required, and schema-v1 or uncited legacy memories are unaffected.',
  },
  {
    question: 'Can agents query a graph while it is still indexing?',
    answer:
      'Agents never query partial rows from an unpromoted snapshot. A cold repository reports indexing and a retry delay until one consistent lexical snapshot is ready. After promotion, exact and lexical queries can use that snapshot while optional vectors and whole-graph summaries finish in the background; during later refreshes, bounded lookups may explicitly use the previous ready snapshot as stale.',
  },
  {
    question: 'Can I use Obsidian without giving it the whole memory store?',
    answer:
      'Yes. Vault notes enter recall only through allowlisted sources, and memories leave Threadnote only through an explicitly configured projection with selected URIs. Generated files are one-way, scrubbed, and drift-protected.',
  },
];

export default function FaqPage() {
  setDocumentMeta(
    'FAQ',
    'Threadnote 5 frequently asked questions about local data, Knowledge Deltas, source freshness, compatibility, and sharing.',
  );

  return (
    <SiteShell page="faq" fullBleed>
      <section className="subpage-hero subpage-hero--faq">
        <div>
          <span className="eyebrow">Frequently asked questions</span>
          <h1>Understand the boundary before you trust the context.</h1>
          <p>Straight answers about local data, source freshness, existing memory, agent integration, and scope.</p>
        </div>
        <a className="button button--ghost" href={siteHref('docs/')}>
          Read the full docs
          <Icon name="arrow" aria-hidden="true" />
        </a>
      </section>

      <section className="faq-section content-section">
        <header className="section-heading">
          <span className="eyebrow">The practical questions</span>
          <h2>What teams ask before installing.</h2>
        </header>
        <div className="faq-list">
          {EffectArray.map(questions, (item, index) => (
            <details key={item.question} open={index === 0}>
              <summary>
                <span>{Effect.pipe(String(index + 1), EffectString.padStart(2, '0'))}</span>
                <strong>{item.question}</strong>
                <i aria-hidden="true" />
              </summary>
              <p>
                {item.answer}
                {item.question === 'Which agents can use it?' && (
                  <>
                    {' '}
                    <a href={siteHref('agents/')}>View supported agents.</a>
                  </>
                )}
              </p>
            </details>
          ))}
        </div>
      </section>

      <section className="content-section content-section--cta">
        <div className="cta-panel cta-panel--compact">
          <span className="eyebrow">Still deciding?</span>
          <h2>Try the workflow, inspect the storage, keep the source.</h2>
          <p>
            Threadnote is open source. Start with the walkthrough, explore the mocked Manager, or inspect the
            architecture before connecting an agent.
          </p>
          <div className="cta-panel__actions">
            <a className="button" href={docsArticleHref('installation')}>
              Install guide
            </a>
            <a className="button button--ghost" href={siteHref('manager-demo/')}>
              Manager demo
            </a>
          </div>
        </div>
      </section>
    </SiteShell>
  );
}
