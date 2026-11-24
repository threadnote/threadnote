import {
  CodeGraphDiagramTypeSchema,
  type CodeGraphDiagramCoverage,
  type CodeGraphDiagramResult,
  type CodeGraphDiagramType,
} from '@threadnote/graph/query/diagram_contract';
import {Array as Arr, Schema} from 'effect';
import React, {useLayoutEffect, useRef, useState} from 'react';
import {MermaidBlock} from '../mermaid_block.js';
import {
  GRAPH_QUERY_MAXIMUM_LENGTH,
  graphDiagramScopeMatches,
  managerGraphQueryCandidate,
  type GraphDiagramLoader,
} from './model.js';

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
  const candidate = managerGraphQueryCandidate(question);

  useLayoutEffect(() => () => request.current?.abort(), []);

  function reset(): void {
    request.current?.abort();
    request.current = undefined;
    setState({kind: 'idle'});
  }

  async function submit(type: CodeGraphDiagramType): Promise<void> {
    if (candidate === undefined) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setDiagramType(type);
    setState({kind: 'pending'});
    const isCurrent = () => request.current === controller && !controller.signal.aborted;
    try {
      const result = await load(viewId, snapshotId, candidate, type, controller.signal);
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
            maxLength={GRAPH_QUERY_MAXIMUM_LENGTH}
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
        <button type="submit" disabled={candidate === undefined || state.kind === 'pending'}>
          Generate diagram
        </button>
      </form>
      {state.kind === 'pending' ? <p role="status">Reading graph evidence…</p> : null}
      {state.kind === 'failed' ? <p role="alert">{state.message}</p> : null}
      {state.kind === 'ready' ? (
        <GraphDiagramResult result={state.result} onSuggest={type => void submit(type)} />
      ) : null}
    </details>
  );
}

function DiagramCoverage({coverage}: {readonly coverage: CodeGraphDiagramCoverage}): React.ReactElement {
  const {subject, boundaries, gaps} = coverage;
  return (
    <section aria-label="Diagram coverage">
      <p>Coverage {coverage.completeness}</p>
      {subject ? (
        <p>
          Subject {subject.label} ·{' '}
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
    <details>
      <summary>
        {label} ({sites.length})
      </summary>
      <ul>
        {Arr.map(sites, (site, index) => (
          <li key={site.edgeId ?? index}>
            {coverageLabels[site.kind]} · {site.label}
            {site.path ? (
              <>
                {' '}
                ·{' '}
                <code>
                  {site.path}
                  {site.span ? `:${site.span.line}` : ''}
                </code>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function GraphDiagramResult({
  result,
  onSuggest,
}: {
  readonly result: CodeGraphDiagramResult;
  readonly onSuggest?: (type: CodeGraphDiagramType) => void;
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
      <h3>{diagram ? `${diagramLabels[diagram.diagramType]} diagram` : 'Diagram unavailable'}</h3>
      <p>
        {result.scope.repositoryName} · Snapshot <code>{result.scope.snapshotId}</code> · Freshness {result.freshness}
      </p>
      {result.coverage ? <DiagramCoverage coverage={result.coverage} /> : null}
      {result.status !== 'diagram' ? <p>{result.message}</p> : null}
      {result.status === 'incomplete' || result.status === 'unavailable' ? <p>{result.nextAction}</p> : null}
      {suggestion && onSuggest ? (
        <button type="button" onClick={() => onSuggest(suggestion)}>
          Show {diagramLabels[suggestion]}
        </button>
      ) : null}
      {diagram ? (
        <>
          {diagram.inferred ? <p>This diagram shows an inferred static path.</p> : null}
          <button type="button" onClick={() => void copySource(diagram.source)}>
            Copy Mermaid code
          </button>
          {copy === 'copied' ? <p role="status">Mermaid code copied.</p> : null}
          {copy === 'failed' ? (
            <>
              <p role="alert">Clipboard access failed. Select and copy the Mermaid code below.</p>
              <textarea aria-label="Selectable Mermaid code" readOnly rows={6} value={diagram.source} />
            </>
          ) : null}
          <MermaidBlock source={diagram.source} expandable />
          <details>
            <summary>Source evidence</summary>
            <ul>
              {Arr.map(diagram.evidence.nodes, node => (
                <li key={node.id}>
                  {node.diagramId} {node.label} ·{' '}
                  <code>
                    {node.path}:{node.span.line}
                  </code>
                </li>
              ))}
              {Arr.map(diagram.evidence.edges, edge => (
                <li key={edge.id}>
                  {edge.source} → {edge.target} · {edge.relation} ({edge.provenance}) ·{' '}
                  <code>
                    {edge.path}:{edge.span.line}
                  </code>
                </li>
              ))}
            </ul>
          </details>
        </>
      ) : null}
      {result.status === 'clarification' ? (
        <ul>
          {Arr.map(result.candidates, candidate => (
            <li key={candidate.id}>
              {candidate.label} ·{' '}
              <code>
                {candidate.path}:{candidate.span.line}
              </code>
            </li>
          ))}
        </ul>
      ) : null}
      {result.limits.length ? (
        <ul aria-label="Diagram limits">
          {Arr.map(result.limits, limit => (
            <li key={limit}>{limit}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
