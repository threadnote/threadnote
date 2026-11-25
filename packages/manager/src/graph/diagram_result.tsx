import {
  CODE_GRAPH_DIAGRAM_QUESTION_MAXIMUM_LENGTH,
  CodeGraphDiagramTypeSchema,
  type CodeGraphDiagramCoverage,
  type CodeGraphDiagramResult,
  type CodeGraphDiagramType,
} from '@threadnote/graph/query/diagram_contract';
import {Array as Arr, Schema, String as Str} from 'effect';
import React, {useLayoutEffect, useRef, useState} from 'react';
import {MermaidBlock} from '../mermaid_block.js';
import {graphDiagramScopeMatches, type GraphDiagramLoader} from './model.js';

const diagramTypes = ['auto', 'flowchart', 'sequence', 'class', 'architecture'] as const;
const diagramLabels = {
  auto: 'Auto',
  flowchart: 'Flowchart',
  sequence: 'Sequence',
  class: 'Class',
  architecture: 'Architecture',
} satisfies Record<CodeGraphDiagramType, string>;

type RequestState =
  | {readonly kind: 'idle'}
  | {readonly kind: 'pending'}
  | {readonly kind: 'failed'; readonly message: string}
  | {readonly kind: 'ready'; readonly result: CodeGraphDiagramResult};

export function GraphDiagramQuestion({
  repositoryId,
  viewId,
  snapshotId,
  load,
}: {
  readonly repositoryId: string;
  readonly viewId: string;
  readonly snapshotId: string;
  readonly load: GraphDiagramLoader;
}): React.ReactElement {
  const [question, setQuestion] = useState('');
  const [diagramType, setDiagramType] = useState<CodeGraphDiagramType>('auto');
  const [state, setState] = useState<RequestState>({kind: 'idle'});
  const request = useRef<AbortController | undefined>(undefined);
  const candidate = Str.trim(question);
  const canSubmit = candidate.length > 0 && candidate.length <= CODE_GRAPH_DIAGRAM_QUESTION_MAXIMUM_LENGTH;

  useLayoutEffect(() => () => request.current?.abort(), []);

  function reset(): void {
    request.current?.abort();
    request.current = undefined;
    setState({kind: 'idle'});
  }

  async function submit(type: CodeGraphDiagramType, query = candidate): Promise<void> {
    if (!query || query.length > CODE_GRAPH_DIAGRAM_QUESTION_MAXIMUM_LENGTH) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setDiagramType(type);
    setState({kind: 'pending'});
    const isCurrent = () => request.current === controller && !controller.signal.aborted;
    try {
      const result = await load(viewId, snapshotId, query, type, controller.signal);
      if (!isCurrent()) return;
      setState(
        graphDiagramScopeMatches(result, repositoryId, viewId, snapshotId)
          ? {kind: 'ready', result}
          : {
              kind: 'failed',
              message: 'The result belongs to a different graph view or snapshot. Refresh the graph catalog and retry.',
            },
      );
    } catch (cause) {
      if (isCurrent()) {
        setState({
          kind: 'failed',
          message: cause instanceof Error ? cause.message : 'The diagram request failed. Retry the question.',
        });
      }
    }
  }

  return (
    <details className="graph-diagram">
      <summary>Ask for a code diagram</summary>
      <form
        className="graph-diagram-form"
        onSubmit={event => {
          event.preventDefault();
          void submit(diagramType);
        }}
      >
        <label>
          Question
          <input
            type="text"
            maxLength={CODE_GRAPH_DIAGRAM_QUESTION_MAXIMUM_LENGTH}
            value={question}
            onChange={event => {
              reset();
              setQuestion(event.currentTarget.value);
            }}
          />
        </label>
        <label>
          Diagram type
          <select
            value={diagramType}
            onChange={event => {
              const value = event.currentTarget.value;
              if (!Schema.is(CodeGraphDiagramTypeSchema)(value)) return;
              reset();
              setDiagramType(value);
            }}
          >
            {Arr.map(diagramTypes, type => (
              <option key={type} value={type}>
                {diagramLabels[type]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={!canSubmit || state.kind === 'pending'}>
          Generate diagram
        </button>
      </form>
      {state.kind === 'pending' ? (
        <p className="graph-diagram-request" role="status">
          Reading graph evidence…
        </p>
      ) : null}
      {state.kind === 'failed' ? (
        <p className="graph-diagram-request" role="alert">
          {state.message}
        </p>
      ) : null}
      {state.kind === 'ready' ? (
        <GraphDiagramResult
          result={state.result}
          onSuggest={type => void submit(type)}
          onChooseCandidate={query => {
            setQuestion(query);
            void submit(diagramType, query);
          }}
        />
      ) : null}
    </details>
  );
}

function DiagramCoverage({coverage}: {readonly coverage: CodeGraphDiagramCoverage}): React.ReactElement {
  const {subject, boundaries, gaps} = coverage;
  return (
    <section aria-label="Diagram coverage">
      <p className="graph-diagram-status">Coverage {coverage.completeness}</p>
      {subject ? (
        <p className="graph-diagram-subject">
          <span>Subject</span> <strong>{subject.label}</strong>
          <code>
            {subject.path}:{subject.span.line}
          </code>
        </p>
      ) : null}
      <CoverageSites label="Boundaries" sites={boundaries} />
      <CoverageSites label="Evidence gaps" sites={gaps} />
    </section>
  );
}

type CoverageSite = CodeGraphDiagramCoverage['boundaries'][number] | CodeGraphDiagramCoverage['gaps'][number];
const coverageLabels = {
  external: 'External',
  'outside-scope': 'Outside scope',
  'unresolved-target': 'Unresolved target',
  'missing-evidence': 'Missing evidence',
  'partial-project': 'Partial project',
  interrupted: 'Interrupted read',
} satisfies Record<CoverageSite['kind'], string>;

function CoverageSites({
  label,
  sites,
}: {
  readonly label: string;
  readonly sites: readonly CoverageSite[];
}): React.ReactElement | null {
  if (!sites.length) return null;
  return (
    <details className="graph-diagram-disclosure">
      <summary>
        {label} ({sites.length})
      </summary>
      <ul>
        {Arr.map(sites, (site, index) => (
          <li key={site.edgeId ?? index}>
            <span className="graph-diagram-site-kind">{coverageLabels[site.kind]}</span> · {site.label}
            {site.path ? (
              <code>
                {site.path}
                {site.span ? `:${site.span.line}` : ''}
              </code>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

function DiagramSourceEvidence({
  evidence,
}: {
  readonly evidence: Extract<CodeGraphDiagramResult, {status: 'diagram'}>['evidence'];
}): React.ReactElement {
  return (
    <details className="graph-diagram-disclosure">
      <summary>Source evidence</summary>
      <ul>
        {Arr.map(evidence.nodes, node => (
          <li key={node.id}>
            <span className="graph-diagram-site-kind">{node.diagramId}</span> {node.label}
            {node.evidenceKind === 'unresolved' ? ' (unresolved target)' : ''}
            <code>
              {node.path}:{node.span.line}
            </code>
          </li>
        ))}
        {Arr.map(evidence.edges, edge => (
          <li key={edge.id}>
            <span className="graph-diagram-site-kind">
              {edge.source} → {edge.target}
            </span>{' '}
            · {edge.relation} ({edge.provenance})
            <code>
              {edge.path}:{edge.span.line}
            </code>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function GraphDiagramResult({
  result,
  onSuggest,
  onChooseCandidate,
}: {
  readonly result: CodeGraphDiagramResult;
  readonly onSuggest?: (type: CodeGraphDiagramType) => void;
  readonly onChooseCandidate?: (query: string) => void;
}): React.ReactElement {
  const suggestion =
    'suggestedType' in result && Schema.is(CodeGraphDiagramTypeSchema)(result.suggestedType)
      ? result.suggestedType
      : undefined;
  const diagram = result.status === 'diagram' ? result : result.status === 'incomplete' ? result.diagram : undefined;
  const [copy, setCopy] = useState<'ready' | 'copied' | 'failed'>('ready');

  async function copySource(source: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(source);
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  }

  return (
    <section aria-label="Code diagram result" className="graph-diagram-result">
      <header className="graph-diagram-heading">
        <div>
          <h3>
            {diagram
              ? `${diagramLabels[diagram.diagramType]} diagram`
              : result.status === 'clarification'
                ? 'Choose a source location'
                : 'Diagram unavailable'}
          </h3>
          <div className="graph-diagram-context">
            <span>
              {result.scope.repositoryName}
              {result.scope.project ? ` · ${result.scope.project}` : ''}
            </span>
            <span className="graph-diagram-freshness" data-freshness={result.freshness}>
              Freshness {result.freshness}
            </span>
            <details className="graph-diagram-snapshot">
              <summary>Snapshot</summary>
              <code>{result.scope.snapshotId}</code>
            </details>
          </div>
        </div>
        {diagram ? (
          <button type="button" onClick={() => void copySource(diagram.source)}>
            Copy Mermaid code
          </button>
        ) : null}
      </header>
      <div className="graph-diagram-layout" data-preview={diagram !== undefined}>
        {diagram ? (
          <div className="graph-diagram-canvas">
            {diagram.inferred ? (
              <p className="graph-diagram-note">This diagram shows an inferred static path.</p>
            ) : null}
            {copy === 'copied' ? <p role="status">Mermaid code copied.</p> : null}
            {copy === 'failed' ? (
              <>
                <p role="alert">Clipboard access failed. Select and copy the Mermaid code below.</p>
                <textarea aria-label="Selectable Mermaid code" readOnly rows={6} value={diagram.source} />
              </>
            ) : null}
            <MermaidBlock source={diagram.source} expandable />
          </div>
        ) : null}
        <aside aria-label="Diagram evidence" className="graph-diagram-evidence">
          {result.coverage || result.status !== 'diagram' ? (
            <div
              className="graph-diagram-evidence-card"
              data-tone={
                result.status === 'unavailable' ? 'unavailable' : (result.coverage?.completeness ?? 'undetermined')
              }
            >
              {result.coverage ? <DiagramCoverage coverage={result.coverage} /> : null}
              {result.status !== 'diagram' ? <p>{result.message}</p> : null}
              {result.status === 'incomplete' || result.status === 'unavailable' ? (
                <p className="graph-diagram-note">{result.nextAction}</p>
              ) : null}
              {suggestion && onSuggest ? (
                <button type="button" onClick={() => onSuggest(suggestion)}>
                  Show {diagramLabels[suggestion]}
                </button>
              ) : null}
              {result.status === 'clarification' ? (
                <>
                  {Arr.some(result.candidates, candidate => !candidate.retryQuery) ? (
                    <p className="graph-diagram-note">
                      For a location without a retry button, replace its reference with its candidate ID. If the
                      question is too long, shorten it.
                    </p>
                  ) : null}
                  <ul className="graph-diagram-choices">
                    {Arr.map(result.candidates, ({id, label, path, span, retryQuery}) => {
                      const location = (
                        <>
                          {label} ·{' '}
                          <code>
                            {path}:{span.line}
                          </code>
                        </>
                      );
                      return (
                        <li key={id}>
                          {retryQuery && onChooseCandidate ? (
                            <button type="button" onClick={() => onChooseCandidate(retryQuery)}>
                              Use {location}
                            </button>
                          ) : (
                            <>
                              {location}
                              {!retryQuery ? (
                                <>
                                  {' '}
                                  · Candidate ID <code>{id}</code>
                                </>
                              ) : null}
                            </>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </>
              ) : null}
            </div>
          ) : null}
          {diagram ? <DiagramSourceEvidence evidence={diagram.evidence} /> : null}
          {result.limits.length ? (
            <details className="graph-diagram-disclosure">
              <summary>Diagram limits</summary>
              <ul>
                {Arr.map(result.limits, limit => (
                  <li key={limit}>{limit}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </aside>
      </div>
    </section>
  );
}
