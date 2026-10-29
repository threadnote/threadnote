import {Array as EffectArray} from 'effect';
import {Effect, Schema} from 'effect';
import {
  CodeGraphStore,
  type CodeGraphEdgeCursor,
  type CodeGraphStoreShape,
  type CodeGraphSymbolCursor,
} from './store.js';
import type {CodeGraphEdge, CodeGraphProvenance, CodeGraphSnapshot, CodeGraphSymbol} from './types.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const CODE_GRAPH_EXPORT_VERSION = 1 as const;
export const CODE_GRAPH_EXPORT_SCHEMA = 'threadnote.code-graph-export' as const;
export const CODE_GRAPH_EXPORT_FORMATS = ['json', 'graphml', 'html', 'svg'] as const;

export type CodeGraphExportFormat = (typeof CODE_GRAPH_EXPORT_FORMATS)[number];
export type CodeGraphExportLimit = number | 'all';

export interface CodeGraphExportLimits {
  readonly edgeLimit: CodeGraphExportLimit;
  readonly nodeLimit: CodeGraphExportLimit;
}

interface CodeGraphExportReadLimits extends CodeGraphExportLimits {
  readonly edgeReadLimit: number;
  readonly nodeReadLimit: number;
  readonly pageSize: number;
}

interface CodeGraphExportRequestedLimits extends CodeGraphExportLimits {
  readonly pageSize: number;
}

export interface CodeGraphExportRequest {
  readonly databasePath: string;
  readonly edgeLimit?: CodeGraphExportLimit;
  readonly format: CodeGraphExportFormat;
  readonly nodeLimit?: CodeGraphExportLimit;
  readonly pageSize?: number;
  readonly repository: {
    readonly displayName: string;
    readonly repositoryId: string;
  };
  readonly snapshotId: string;
  readonly write: (chunk: string) => Effect.Effect<void, unknown>;
}

export interface CodeGraphExportSummary {
  readonly canonical: false;
  readonly derived: true;
  readonly edges: {
    readonly available: number;
    readonly omitted: number;
    readonly scanned: number;
    readonly truncated: boolean;
    readonly written: number;
  };
  readonly format: CodeGraphExportFormat;
  readonly limits: CodeGraphExportLimits;
  readonly nodes: {
    readonly available: number;
    readonly supplemental: number;
    readonly truncated: boolean;
    readonly written: number;
  };
  readonly provenanceCounts: Readonly<Record<CodeGraphProvenance, number>>;
  readonly snapshotId: string;
  readonly version: typeof CODE_GRAPH_EXPORT_VERSION;
  readonly warnings: readonly string[];
}

export class CodeGraphExportError extends Schema.TaggedError<CodeGraphExportError, {readonly brand: unique symbol}>()(
  'CodeGraphExportError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

export const CODE_GRAPH_EXPORT_LIMIT_POLICY = {
  graphml: {defaultEdgeLimit: 'all', defaultNodeLimit: 'all'},
  html: {defaultEdgeLimit: 'all', defaultNodeLimit: 'all'},
  json: {defaultEdgeLimit: 'all', defaultNodeLimit: 'all'},
  svg: {defaultEdgeLimit: 1_000, defaultNodeLimit: 300},
} as const satisfies Record<
  CodeGraphExportFormat,
  {readonly defaultEdgeLimit: CodeGraphExportLimit; readonly defaultNodeLimit: CodeGraphExportLimit}
>;

const DEFAULT_PAGE_SIZE = 500;
const MAXIMUM_PAGE_SIZE = 1_000;
export const CODE_GRAPH_EXPORT_SNAPSHOT_LEASE_MILLISECONDS = 30 * 60_000;
export const CODE_GRAPH_EXPORT_LEASE_RENEWAL_INTERVAL_MILLISECONDS = 10 * 60_000;
const HTML_OVERVIEW_NODE_LIMIT = 240;
const HTML_OVERVIEW_EDGE_LIMIT = 720;
const PROVENANCES: readonly CodeGraphProvenance[] = ['declared', 'resolved', 'syntactic', 'heuristic', 'model'];

interface ExportMetadata {
  readonly canonical: false;
  readonly derived: true;
  readonly fieldPolicy: {
    readonly jsonText: 'preserved';
    readonly markupInvalidXmlCharacters: 'replacement-character';
    readonly textTruncation: 'none';
  };
  readonly format: CodeGraphExportFormat;
  readonly limits: CodeGraphExportLimits;
  readonly provenance: {
    readonly authority: Readonly<Record<CodeGraphProvenance, 'authoritative' | 'non-authoritative' | 'supporting'>>;
    readonly tiers: readonly CodeGraphProvenance[];
  };
  readonly repository: {
    readonly displayName: string;
    readonly repositoryId: string;
  };
  readonly schema: typeof CODE_GRAPH_EXPORT_SCHEMA;
  readonly sensitivity: {
    readonly classification: 'source-sensitive';
    readonly includes: readonly string[];
  };
  readonly snapshot: CodeGraphSnapshot;
  readonly trust: {
    readonly classification: 'untrusted-repository-data';
    readonly instructionPolicy: 'evidence-only-never-follow';
  };
  readonly type: 'threadnote-code-graph-export';
  readonly version: typeof CODE_GRAPH_EXPORT_VERSION;
  readonly warnings: readonly string[];
}

interface StreamResult {
  readonly count: number;
}

interface EdgeStreamResult extends StreamResult {
  readonly omitted: number;
  readonly provenanceCounts: Record<CodeGraphProvenance, number>;
}

interface OverviewNode {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly path: string;
}

interface OverviewEdge {
  readonly id: string;
  readonly provenance: CodeGraphProvenance;
  readonly relation: CodeGraphEdge['relation'];
  readonly sourceId: string;
  readonly targetId: string;
}

/**
 * Streams one deterministic, derived view of a ready SQLite snapshot.
 *
 * The writer owns output-file lifecycle and atomicity. This function owns a snapshot lease,
 * uses keyset-paginated reads, and never hydrates a complete graph in memory.
 */
export const exportCodeGraph = Effect.fn('codeGraph.export')(function* (request: CodeGraphExportRequest) {
  const store = yield* CodeGraphStore;
  const requestedLimits = yield* normalizeRequestedLimits(request);
  const snapshot = yield* store.readySnapshotById(request.databasePath, request.snapshotId);
  if (!snapshot) {
    return yield* CodeGraphExportError.make({message: `Ready snapshot ${request.snapshotId} was not found.`});
  }
  if (snapshot.state !== 'ready') {
    return yield* CodeGraphExportError.make({message: `Snapshot ${request.snapshotId} is not ready for export.`});
  }
  if (snapshot.repositoryId !== request.repository.repositoryId) {
    return yield* CodeGraphExportError.make({
      message: 'The requested repository identity does not own the selected ready snapshot.',
    });
  }
  const limits = resolveReadLimits(requestedLimits, snapshot);
  const metadata = exportMetadata(request, snapshot, limits);
  const lease = yield* store.acquireSnapshotLease(
    request.databasePath,
    snapshot.id,
    CODE_GRAPH_EXPORT_SNAPSHOT_LEASE_MILLISECONDS,
  );
  const renewLease = Effect.sleep(CODE_GRAPH_EXPORT_LEASE_RENEWAL_INTERVAL_MILLISECONDS).pipe(
    Effect.andThen(
      store.renewSnapshotLease(request.databasePath, lease, CODE_GRAPH_EXPORT_SNAPSHOT_LEASE_MILLISECONDS),
    ),
    Effect.forever,
  );
  return yield* Effect.raceFirst(
    store.withSession(request.databasePath, renderExport(store, request, snapshot, metadata, limits), {readOnly: true}),
    renewLease,
  ).pipe(Effect.ensuring(store.releaseSnapshotLease(request.databasePath, lease).pipe(Effect.ignore)));
});

function renderExport(
  store: CodeGraphStoreShape,
  request: CodeGraphExportRequest,
  snapshot: CodeGraphSnapshot,
  metadata: ExportMetadata,
  limits: CodeGraphExportReadLimits,
) {
  switch (request.format) {
    case 'json':
      return renderJsonExport(store, request, snapshot, metadata, limits);
    case 'graphml':
      return renderGraphMlExport(store, request, snapshot, metadata, limits);
    case 'html':
      return renderHtmlExport(store, request, snapshot, metadata, limits);
    case 'svg':
      return renderSvgExport(store, request, snapshot, metadata, limits);
  }
}

function renderJsonExport(
  store: CodeGraphStoreShape,
  request: CodeGraphExportRequest,
  snapshot: CodeGraphSnapshot,
  metadata: ExportMetadata,
  limits: CodeGraphExportReadLimits,
) {
  return Effect.gen(function* () {
    const write = request.write;
    yield* write(`${Effect2.pipe(JSON.stringify(metadata), EffectString.slice(0, -1))},"nodes":[`);
    let firstNode = true;
    const nodes = yield* streamNodes(store, request.databasePath, snapshot, limits, node =>
      Effect.gen(function* () {
        yield* write(`${firstNode ? '' : ','}${JSON.stringify(node)}`);
        firstNode = false;
      }),
    );
    yield* write('],"edges":[');
    let firstEdge = true;
    const edges = yield* streamEdges(store, request.databasePath, snapshot, limits, edge =>
      Effect.gen(function* () {
        yield* write(`${firstEdge ? '' : ','}${JSON.stringify(edge)}`);
        firstEdge = false;
        return true;
      }),
    );
    const summary = exportSummary(request.format, snapshot, metadata, nodes.count, edges);
    yield* write(`],"summary":${JSON.stringify(summary)}}\n`);
    return summary;
  });
}

function renderGraphMlExport(
  store: CodeGraphStoreShape,
  request: CodeGraphExportRequest,
  snapshot: CodeGraphSnapshot,
  metadata: ExportMetadata,
  limits: CodeGraphExportReadLimits,
) {
  return Effect.gen(function* () {
    const write = request.write;
    const completeNodeSelection = limits.nodeReadLimit === snapshot.symbolCount;
    const selectedNodeIds = completeNodeSelection ? undefined : new Set<string>();
    let supplementalNodes = 0;
    yield* write(graphMlStart(metadata));
    const nodes = yield* streamNodes(store, request.databasePath, snapshot, limits, node =>
      Effect.gen(function* () {
        selectedNodeIds?.add(node.id);
        yield* write(graphMlNode(node));
      }),
    );
    const edges = yield* streamEdges(store, request.databasePath, snapshot, limits, (edge, ordinal) => {
      const source = graphMlEndpoint(edge, 'source', ordinal, completeNodeSelection, selectedNodeIds);
      const target = graphMlEndpoint(edge, 'target', ordinal, completeNodeSelection, selectedNodeIds);
      supplementalNodes += Number(source.supplemental) + Number(target.supplemental);
      return write(`${source.node}${target.node}${graphMlEdge(edge, source.id, target.id)}`).pipe(Effect.as(true));
    });
    const summary = exportSummary(request.format, snapshot, metadata, nodes.count, edges, supplementalNodes);
    yield* write(`<data key="g_summary">${escapeGraphMarkup(JSON.stringify(summary))}</data></graph></graphml>\n`);
    return summary;
  });
}

function renderHtmlExport(
  store: CodeGraphStoreShape,
  request: CodeGraphExportRequest,
  snapshot: CodeGraphSnapshot,
  metadata: ExportMetadata,
  limits: CodeGraphExportReadLimits,
) {
  return Effect.gen(function* () {
    const write = request.write;
    const overviewNodes: OverviewNode[] = [];
    const overviewNodeIds = new Set<string>();
    const overviewEdges: OverviewEdge[] = [];
    yield* write(htmlStart(metadata));
    const nodes = yield* streamNodes(store, request.databasePath, snapshot, limits, node =>
      Effect.gen(function* () {
        if (overviewNodes.length < HTML_OVERVIEW_NODE_LIMIT) {
          const overview = overviewNode(node);
          overviewNodes.push(overview);
          overviewNodeIds.add(overview.id);
        }
        yield* write(htmlNode(node));
      }),
    );
    yield* write(
      '</tbody></table></div><h2>Relationships</h2><div class="table-wrap"><table><thead><tr>' +
        '<th>Source</th><th>Relationship</th><th>Target</th><th>Evidence</th></tr></thead><tbody>',
    );
    const edges = yield* streamEdges(store, request.databasePath, snapshot, limits, edge =>
      Effect.gen(function* () {
        if (
          overviewEdges.length < HTML_OVERVIEW_EDGE_LIMIT &&
          edge.sourceId &&
          edge.targetId &&
          overviewNodeIds.has(edge.sourceId) &&
          overviewNodeIds.has(edge.targetId)
        ) {
          overviewEdges.push(overviewEdge(edge));
        }
        yield* write(htmlEdge(edge));
        return true;
      }),
    );
    const summary = exportSummary(request.format, snapshot, metadata, nodes.count, edges);
    yield* write(
      `</tbody></table></div><h2>Bounded overview</h2>${renderOverviewSvg(
        overviewNodes,
        overviewEdges,
        metadata,
        summary,
        false,
      )}${htmlSummary(summary)}</main></body></html>\n`,
    );
    return summary;
  });
}

function renderSvgExport(
  store: CodeGraphStoreShape,
  request: CodeGraphExportRequest,
  snapshot: CodeGraphSnapshot,
  metadata: ExportMetadata,
  limits: CodeGraphExportReadLimits,
) {
  return Effect.gen(function* () {
    const completeNodeSelection = limits.nodeReadLimit === snapshot.symbolCount;
    const selectedNodeIds = completeNodeSelection ? undefined : new Set<string>();
    yield* request.write(svgExportStart(metadata, limits));
    const nodes = yield* streamNodes(store, request.databasePath, snapshot, limits, node =>
      Effect.gen(function* () {
        selectedNodeIds?.add(node.id);
        yield* request.write(svgExportNode(node));
      }),
    );
    const edges = yield* streamEdges(store, request.databasePath, snapshot, limits, edge => {
      if (
        !edge.sourceId ||
        !edge.targetId ||
        (!completeNodeSelection && (!selectedNodeIds?.has(edge.sourceId) || !selectedNodeIds?.has(edge.targetId)))
      ) {
        return Effect.succeed(false);
      }
      return request.write(svgExportEdge(edge)).pipe(Effect.as(true));
    });
    const summary = exportSummary(request.format, snapshot, metadata, nodes.count, edges);
    yield* request.write(`</g><metadata>${escapeGraphMarkup(JSON.stringify({metadata, summary}))}</metadata></svg>\n`);
    return summary;
  });
}

function streamNodes(
  store: CodeGraphStoreShape,
  databasePath: string,
  snapshot: CodeGraphSnapshot,
  limits: CodeGraphExportReadLimits,
  visit: (node: CodeGraphSymbol) => Effect.Effect<void, unknown>,
) {
  return Effect.gen(function* () {
    const expected = limits.nodeReadLimit;
    let count = 0;
    let cursor: CodeGraphSymbolCursor | undefined;
    while (count < expected) {
      const page = yield* store.loadSymbolPage(
        databasePath,
        snapshot.id,
        cursor,
        Math.min(limits.pageSize, expected - count),
      );
      if (page.length === 0) break;
      for (const symbol of page) {
        yield* visit(symbol);
        count += 1;
      }
      const last = page.at(-1)!;
      cursor = {id: last.id, path: last.path, qualifiedName: last.qualifiedName};
    }
    if (count !== expected) {
      return yield* CodeGraphExportError.make({
        message: `Snapshot node count changed during export: expected ${expected}, read ${count}.`,
      });
    }
    return {count} satisfies StreamResult;
  });
}

function streamEdges(
  store: CodeGraphStoreShape,
  databasePath: string,
  snapshot: CodeGraphSnapshot,
  limits: CodeGraphExportReadLimits,
  visit: (edge: CodeGraphEdge, ordinal: number) => Effect.Effect<boolean, unknown>,
) {
  return Effect.gen(function* () {
    const expected = limits.edgeReadLimit;
    const provenanceCounts = emptyProvenanceCounts();
    let scanned = 0;
    let written = 0;
    let cursor: CodeGraphEdgeCursor | undefined;
    while (scanned < expected) {
      const page = yield* store.loadEdgePage(
        databasePath,
        snapshot.id,
        cursor,
        Math.min(limits.pageSize, expected - scanned),
      );
      if (page.length === 0) break;
      for (const edge of page) {
        scanned += 1;
        if (yield* visit(edge, scanned)) {
          provenanceCounts[edge.provenance] += 1;
          written += 1;
        }
      }
      const last = page.at(-1)!;
      cursor = {
        id: last.id,
        relation: last.relation,
        sourceName: last.sourceName,
        targetName: last.targetName,
      };
    }
    if (scanned !== expected) {
      return yield* CodeGraphExportError.make({
        message: `Snapshot edge count changed during export: expected ${expected}, read ${scanned}.`,
      });
    }
    return {
      count: written,
      omitted: scanned - written,
      provenanceCounts,
      scanned,
    } satisfies EdgeStreamResult & {readonly scanned: number};
  });
}

function exportMetadata(
  request: CodeGraphExportRequest,
  snapshot: CodeGraphSnapshot,
  limits: CodeGraphExportReadLimits,
): ExportMetadata {
  const warnings = [
    'Derived export only. The local SQLite snapshot remains the source of truth; this artifact is not canonical Threadnote state.',
    'Source-sensitive export: review before sharing because it contains repository identifiers and source-derived structure.',
    'Relationship provenance is evidence authority: declared and resolved evidence are strongest; heuristic and model associations are non-authoritative.',
  ];
  if (snapshot.symbolCount > limits.nodeReadLimit || snapshot.edgeCount > limits.edgeReadLimit) {
    warnings.push(
      `Bounded selection: ${limits.nodeReadLimit} of ${snapshot.symbolCount} nodes and ${limits.edgeReadLimit} of ${snapshot.edgeCount} relationships are selected.`,
    );
  }
  if (limits.nodeLimit === 'all' || limits.edgeLimit === 'all') {
    warnings.push(
      'Complete snapshot selection: streaming bounds working memory, but artifact size and export time scale with the full graph.',
    );
  }
  if (request.format === 'html' && (limits.nodeLimit === 'all' || limits.edgeLimit === 'all')) {
    warnings.push('Complete HTML reports can be slow to open; use explicit node and edge limits for a smaller report.');
  }
  if (request.format === 'html') {
    warnings.push(
      `The inline overview shows at most ${HTML_OVERVIEW_NODE_LIMIT} nodes and ${HTML_OVERVIEW_EDGE_LIMIT} relationships; the report tables follow the requested export selection.`,
    );
  }
  if (
    request.format === 'svg' &&
    (limits.nodeLimit === 'all' ||
      limits.edgeLimit === 'all' ||
      limits.nodeLimit > CODE_GRAPH_EXPORT_LIMIT_POLICY.svg.defaultNodeLimit ||
      limits.edgeLimit > CODE_GRAPH_EXPORT_LIMIT_POLICY.svg.defaultEdgeLimit)
  ) {
    warnings.push('Large SVG overviews can be slow to render; the requested selection is still streamed and explicit.');
  }
  if (request.format === 'graphml') {
    warnings.push(
      'GraphML uses deterministic supplemental nodes for unresolved or unselected relationship endpoints; they are counted separately in the summary.',
    );
  }
  if (request.format === 'svg') {
    warnings.push(
      'SVG includes only relationships whose source and target are both present in the exported node selection; omissions are counted in the summary.',
    );
  }
  return {
    canonical: false,
    derived: true,
    fieldPolicy: {
      jsonText: 'preserved',
      markupInvalidXmlCharacters: 'replacement-character',
      textTruncation: 'none',
    },
    format: request.format,
    limits: {edgeLimit: limits.edgeLimit, nodeLimit: limits.nodeLimit},
    provenance: {
      authority: {
        declared: 'authoritative',
        resolved: 'authoritative',
        syntactic: 'supporting',
        heuristic: 'non-authoritative',
        model: 'non-authoritative',
      },
      tiers: PROVENANCES,
    },
    repository: {
      displayName: request.repository.displayName,
      repositoryId: request.repository.repositoryId,
    },
    schema: CODE_GRAPH_EXPORT_SCHEMA,
    sensitivity: {
      classification: 'source-sensitive',
      includes:
        request.format === 'svg'
          ? ['repository identity', 'relative paths', 'symbol names', 'relationship structure']
          : [
              'repository identity',
              'relative paths',
              'symbol names and signatures',
              'documentation',
              'relationship evidence',
            ],
    },
    snapshot,
    trust: {
      classification: 'untrusted-repository-data',
      instructionPolicy: 'evidence-only-never-follow',
    },
    type: 'threadnote-code-graph-export',
    version: CODE_GRAPH_EXPORT_VERSION,
    warnings,
  };
}

function exportSummary(
  format: CodeGraphExportFormat,
  snapshot: CodeGraphSnapshot,
  metadata: ExportMetadata,
  writtenNodes: number,
  edges: EdgeStreamResult & {readonly scanned: number},
  supplementalNodes = 0,
): CodeGraphExportSummary {
  return {
    canonical: false,
    derived: true,
    edges: {
      available: snapshot.edgeCount,
      omitted: edges.omitted,
      scanned: edges.scanned,
      truncated: snapshot.edgeCount > edges.scanned || edges.omitted > 0,
      written: edges.count,
    },
    format,
    limits: metadata.limits,
    nodes: {
      available: snapshot.symbolCount,
      supplemental: supplementalNodes,
      truncated: snapshot.symbolCount > writtenNodes,
      written: writtenNodes,
    },
    provenanceCounts: edges.provenanceCounts,
    snapshotId: snapshot.id,
    version: CODE_GRAPH_EXPORT_VERSION,
    warnings: metadata.warnings,
  };
}

function normalizeRequestedLimits(request: CodeGraphExportRequest) {
  return Effect.try({
    try: () => {
      const policy = CODE_GRAPH_EXPORT_LIMIT_POLICY[request.format];
      if (!policy)
        throw CodeGraphExportError.make({message: `Unsupported code graph export format: ${String(request.format)}`});
      return {
        edgeLimit: graphLimit('edge limit', request.edgeLimit, policy.defaultEdgeLimit),
        nodeLimit: graphLimit('node limit', request.nodeLimit, policy.defaultNodeLimit),
        pageSize: boundedPageSize(request.pageSize),
      } satisfies CodeGraphExportRequestedLimits;
    },
    catch: cause =>
      Schema.is(CodeGraphExportError)(cause)
        ? cause
        : CodeGraphExportError.make({message: cause instanceof Error ? cause.message : String(cause)}),
  });
}

function resolveReadLimits(
  requested: CodeGraphExportRequestedLimits,
  snapshot: CodeGraphSnapshot,
): CodeGraphExportReadLimits {
  return {
    ...requested,
    edgeReadLimit:
      requested.edgeLimit === 'all' ? snapshot.edgeCount : Math.min(requested.edgeLimit, snapshot.edgeCount),
    nodeReadLimit:
      requested.nodeLimit === 'all' ? snapshot.symbolCount : Math.min(requested.nodeLimit, snapshot.symbolCount),
  };
}

function graphLimit(
  label: string,
  value: CodeGraphExportLimit | undefined,
  fallback: CodeGraphExportLimit,
): CodeGraphExportLimit {
  const selected = value ?? fallback;
  if (selected === 'all') return selected;
  if (!Number.isSafeInteger(selected) || selected < 0) {
    throw CodeGraphExportError.make({message: `${label} must be "all" or a non-negative safe integer.`});
  }
  return selected;
}

function boundedPageSize(value: number | undefined): number {
  const selected = value ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > MAXIMUM_PAGE_SIZE) {
    throw CodeGraphExportError.make({message: `page size must be an integer between 1 and ${MAXIMUM_PAGE_SIZE}.`});
  }
  return selected;
}

function emptyProvenanceCounts(): Record<CodeGraphProvenance, number> {
  return {declared: 0, resolved: 0, syntactic: 0, heuristic: 0, model: 0};
}

function graphMlStart(metadata: ExportMetadata): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns">\n' +
    '<key id="g_metadata" for="graph" attr.name="threadnote.metadata" attr.type="string"/>\n' +
    '<key id="g_summary" for="graph" attr.name="threadnote.summary" attr.type="string"/>\n' +
    '<key id="n_name" for="node" attr.name="name" attr.type="string"/>\n' +
    '<key id="n_qualified_name" for="node" attr.name="qualifiedName" attr.type="string"/>\n' +
    '<key id="n_kind" for="node" attr.name="kind" attr.type="string"/>\n' +
    '<key id="n_language" for="node" attr.name="language" attr.type="string"/>\n' +
    '<key id="n_path" for="node" attr.name="path" attr.type="string"/>\n' +
    '<key id="n_package" for="node" attr.name="packageName" attr.type="string"/>\n' +
    '<key id="n_exported" for="node" attr.name="exported" attr.type="boolean"/>\n' +
    '<key id="n_signature" for="node" attr.name="signature" attr.type="string"/>\n' +
    '<key id="n_documentation" for="node" attr.name="documentation" attr.type="string"/>\n' +
    '<key id="n_content_hash" for="node" attr.name="contentHash" attr.type="string"/>\n' +
    '<key id="n_lookup_keys" for="node" attr.name="lookupKeys" attr.type="string"/>\n' +
    '<key id="n_resolution_domain" for="node" attr.name="resolutionDomain" attr.type="string"/>\n' +
    '<key id="n_arity" for="node" attr.name="arity" attr.type="int"/>\n' +
    '<key id="n_span" for="node" attr.name="span" attr.type="string"/>\n' +
    '<key id="e_relation" for="edge" attr.name="relation" attr.type="string"/>\n' +
    '<key id="e_provenance" for="edge" attr.name="provenance" attr.type="string"/>\n' +
    '<key id="e_confidence" for="edge" attr.name="confidence" attr.type="double"/>\n' +
    '<key id="e_source_name" for="edge" attr.name="sourceName" attr.type="string"/>\n' +
    '<key id="e_target_name" for="edge" attr.name="targetName" attr.type="string"/>\n' +
    '<key id="e_evidence_path" for="edge" attr.name="evidencePath" attr.type="string"/>\n' +
    '<key id="e_evidence_span" for="edge" attr.name="evidenceSpan" attr.type="string"/>\n' +
    `<graph id="${escapeGraphMarkup(metadata.snapshot.id)}" edgedefault="directed">\n` +
    `<data key="g_metadata">${escapeGraphMarkup(JSON.stringify(metadata))}</data>\n`
  );
}

function graphMlNode(node: CodeGraphSymbol): string {
  return (
    `<node id="${escapeGraphMarkup(node.id)}">` +
    graphMlData('n_name', node.name) +
    graphMlData('n_qualified_name', node.qualifiedName) +
    graphMlData('n_kind', node.kind) +
    graphMlData('n_language', node.language) +
    graphMlData('n_path', node.path) +
    graphMlData('n_package', node.packageName) +
    graphMlData('n_exported', String(node.exported)) +
    graphMlData('n_signature', node.signature) +
    graphMlData('n_documentation', node.documentation) +
    graphMlData('n_content_hash', node.contentHash) +
    graphMlData('n_lookup_keys', node.lookupKeys ? JSON.stringify(node.lookupKeys) : undefined) +
    graphMlData('n_resolution_domain', node.resolutionDomain) +
    graphMlData('n_arity', node.arity === undefined ? undefined : String(node.arity)) +
    graphMlData('n_span', JSON.stringify(node.span)) +
    '</node>\n'
  );
}

function graphMlEndpoint(
  edge: CodeGraphEdge,
  role: 'source' | 'target',
  ordinal: number,
  completeNodeSelection: boolean,
  selectedNodeIds: ReadonlySet<string> | undefined,
): {readonly id: string; readonly node: string; readonly supplemental: boolean} {
  const storedId = role === 'source' ? edge.sourceId : edge.targetId;
  const name = role === 'source' ? edge.sourceName : edge.targetName;
  if (storedId && (completeNodeSelection || selectedNodeIds?.has(storedId))) {
    return {id: storedId, node: '', supplemental: false};
  }
  const reason = storedId ? 'outside-selection' : 'unresolved';
  const id = `tn-${reason}-${role}-${ordinal}`;
  return {
    id,
    node:
      `<node id="${id}">` +
      graphMlData('n_name', name) +
      graphMlData('n_qualified_name', name) +
      graphMlData('n_kind', 'supplemental-endpoint') +
      graphMlData('n_language', 'unknown') +
      graphMlData('n_path', edge.evidencePath) +
      graphMlData('n_exported', 'false') +
      graphMlData('n_resolution_domain', reason) +
      '</node>\n',
    supplemental: true,
  };
}

function graphMlEdge(edge: CodeGraphEdge, sourceId: string, targetId: string): string {
  return (
    `<edge id="${escapeGraphMarkup(edge.id)}" source="${escapeGraphMarkup(sourceId)}" ` +
    `target="${escapeGraphMarkup(targetId)}">` +
    graphMlData('e_relation', edge.relation) +
    graphMlData('e_provenance', edge.provenance) +
    graphMlData('e_confidence', String(edge.confidence)) +
    graphMlData('e_source_name', edge.sourceName) +
    graphMlData('e_target_name', edge.targetName) +
    graphMlData('e_evidence_path', edge.evidencePath) +
    graphMlData('e_evidence_span', JSON.stringify(edge.evidenceSpan)) +
    '</edge>\n'
  );
}

function graphMlData(key: string, value: string | undefined): string {
  return value === undefined ? '' : `<data key="${key}">${escapeGraphMarkup(value)}</data>`;
}

function htmlStart(metadata: ExportMetadata): string {
  const warnings = EffectArray.join(
    EffectArray.map(metadata.warnings, warning => `<li>${escapeHtmlText(warning)}</li>`),
    '',
  );
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">' +
    `<meta name="threadnote-export-version" content="${CODE_GRAPH_EXPORT_VERSION}">` +
    `<title>Threadnote graph — ${escapeHtmlText(metadata.repository.displayName)}</title>` +
    '<style>:root{color-scheme:dark;--bg:#0a0f14;--panel:#111922;--ink:#e6edf3;--muted:#91a0ad;--line:#273747;' +
    '--accent:#67e8c7;--warn:#ffd479}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);' +
    'font:14px/1.5 system-ui,sans-serif}main{max-width:1440px;margin:auto;padding:32px}h1,h2{letter-spacing:-.02em}' +
    'h1{font-size:30px;margin-bottom:4px}h2{margin-top:32px}.eyebrow{color:var(--accent);font-weight:700;text-transform:uppercase;' +
    'letter-spacing:.08em}.muted{color:var(--muted)}.warning{border:1px solid #695b32;background:#201d14;padding:16px 20px;' +
    'border-radius:10px;color:var(--warn)}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:10px}' +
    'table{border-collapse:collapse;width:100%;background:var(--panel)}th,td{padding:9px 12px;border-bottom:1px solid var(--line);' +
    'text-align:left;vertical-align:top}th{position:sticky;top:0;background:#17212c;color:var(--accent)}code,pre{font-family:' +
    'ui-monospace,SFMono-Regular,Consolas,monospace}code{unicode-bidi:plaintext}pre{white-space:pre-wrap;word-break:break-word;' +
    'max-width:72ch}.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:1px 7px;color:var(--muted)}' +
    '.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:24px 0}.card{background:var(--panel);' +
    'border:1px solid var(--line);border-radius:10px;padding:14px}.card strong{display:block;font-size:22px;color:var(--accent)}' +
    'svg{width:100%;height:auto;background:var(--panel);border:1px solid var(--line);border-radius:10px}</style></head><body><main>' +
    '<p class="eyebrow">Derived · noncanonical · source-sensitive</p>' +
    `<h1>${escapeHtmlText(metadata.repository.displayName)}</h1>` +
    `<p class="muted">Snapshot <code>${escapeHtmlText(metadata.snapshot.id)}</code> · commit ` +
    `<code>${escapeHtmlText(metadata.snapshot.commit)}</code></p>` +
    `<section class="warning"><strong>Review before sharing</strong><ul>${warnings}</ul></section>` +
    '<h2>Provenance authority</h2><p><span class="pill">declared</span> <span class="pill">resolved</span> authoritative · ' +
    '<span class="pill">syntactic</span> supporting · <span class="pill">heuristic</span> ' +
    '<span class="pill">model</span> non-authoritative</p>' +
    '<h2>Symbols</h2><div class="table-wrap"><table><thead><tr><th>Kind</th><th>Symbol</th><th>Location</th>' +
    '<th>Language</th><th>Details</th></tr></thead><tbody>'
  );
}

function htmlNode(node: CodeGraphSymbol): string {
  const details = EffectArray.join(
    EffectArray.filter([node.signature, node.documentation], (value): value is string => value !== undefined),
    '\n\n',
  );
  return (
    `<tr data-node-id="${escapeHtmlText(node.id)}"><td>${escapeHtmlText(node.kind)}</td>` +
    `<td><code>${escapeHtmlText(node.qualifiedName)}</code></td>` +
    `<td><code>${escapeHtmlText(node.path)}:${node.span.line}</code></td>` +
    `<td>${escapeHtmlText(node.language)}</td><td>` +
    (details
      ? `<details><summary>Source-derived details</summary><pre>${escapeHtmlText(details)}</pre></details>`
      : '—') +
    '</td></tr>'
  );
}

function htmlEdge(edge: CodeGraphEdge): string {
  return (
    `<tr data-edge-id="${escapeHtmlText(edge.id)}"><td><code>${escapeHtmlText(edge.sourceName)}</code></td>` +
    `<td>${escapeHtmlText(edge.relation)} <span class="pill">${escapeHtmlText(edge.provenance)}</span></td>` +
    `<td><code>${escapeHtmlText(edge.targetName)}</code></td>` +
    `<td><code>${escapeHtmlText(edge.evidencePath)}:${edge.evidenceSpan.line}</code></td></tr>`
  );
}

function htmlSummary(summary: CodeGraphExportSummary): string {
  return (
    '<h2>Export summary</h2><div class="summary">' +
    `<div class="card"><strong>${summary.nodes.written}</strong>nodes written of ${summary.nodes.available}</div>` +
    `<div class="card"><strong>${summary.edges.written}</strong>relationships written of ${summary.edges.available}</div>` +
    `<div class="card"><strong>${summary.edges.omitted}</strong>relationships omitted by format</div>` +
    `<div class="card"><strong>${summary.limits.nodeLimit}/${summary.limits.edgeLimit}</strong>node/edge limits</div>` +
    '</div><p class="muted">Generated deterministically from a leased SQLite snapshot. This report is derived and noncanonical.</p>'
  );
}

function overviewNode(node: CodeGraphSymbol): OverviewNode {
  return {id: node.id, kind: node.kind, label: node.name, path: node.path};
}

function overviewEdge(edge: CodeGraphEdge): OverviewEdge {
  return {
    id: edge.id,
    provenance: edge.provenance,
    relation: edge.relation,
    sourceId: edge.sourceId!,
    targetId: edge.targetId!,
  };
}

const SVG_EXPORT_WIDTH = 1_600;
const SVG_EXPORT_HEIGHT = 1_000;
const SVG_EXPORT_HEADER_HEIGHT = 96;

function svgExportStart(metadata: ExportMetadata, limits: CodeGraphExportReadLimits): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="tn-title tn-desc" ` +
    `viewBox="0 0 ${SVG_EXPORT_WIDTH} ${SVG_EXPORT_HEIGHT}">` +
    `<title id="tn-title">Threadnote graph overview — ${escapeGraphMarkup(metadata.repository.displayName)}</title>` +
    '<desc id="tn-desc">Derived, noncanonical, source-sensitive streamed graph overview.</desc>' +
    '<rect width="100%" height="100%" fill="#111922"/>' +
    '<text x="24" y="30" fill="#67e8c7" font-size="12" font-weight="700">' +
    'DERIVED · NONCANONICAL · SOURCE-SENSITIVE</text>' +
    `<text x="24" y="58" fill="#eef6fb" font-size="22" font-weight="700">${escapeGraphMarkup(
      metadata.repository.displayName,
    )}</text>` +
    `<text x="24" y="78" fill="#9bacb9" font-size="11">${limits.nodeReadLimit} selected nodes · ` +
    `${limits.edgeReadLimit} selected relationships</text><g id="graph">`
  );
}

function svgExportNode(node: CodeGraphSymbol): string {
  const position = svgPosition(node.id);
  return (
    `<g transform="translate(${position.x} ${position.y})"><circle r="5" fill="${nodeColor(node.kind)}" ` +
    'stroke="#d7fff4" stroke-width=".6"><title>' +
    `${escapeGraphMarkup(node.name)} — ${escapeGraphMarkup(node.path)}</title></circle></g>`
  );
}

function svgExportEdge(edge: CodeGraphEdge): string {
  const source = svgPosition(edge.sourceId!);
  const target = svgPosition(edge.targetId!);
  const dash = edge.provenance === 'heuristic' || edge.provenance === 'model' ? ' stroke-dasharray="5 5"' : '';
  return (
    `<line x1="${source.x}" y1="${source.y}" x2="${target.x}" y2="${target.y}" ` +
    `stroke="#526779" stroke-width=".8" opacity=".3"${dash}><title>${escapeGraphMarkup(edge.relation)} ` +
    `[${escapeGraphMarkup(edge.provenance)}]</title></line>`
  );
}

function svgPosition(id: string): {readonly x: number; readonly y: number} {
  const horizontalRange = SVG_EXPORT_WIDTH - 48;
  const verticalRange = SVG_EXPORT_HEIGHT - SVG_EXPORT_HEADER_HEIGHT - 24;
  return {
    x: 24 + (stableHash(id, 0x811c9dc5) % horizontalRange),
    y: SVG_EXPORT_HEADER_HEIGHT + (stableHash(id, 0x9e3779b9) % verticalRange),
  };
}

function renderOverviewSvg(
  nodes: readonly OverviewNode[],
  edges: readonly OverviewEdge[],
  metadata: ExportMetadata,
  summary: CodeGraphExportSummary,
  standalone: boolean,
): string {
  const columns = Math.max(1, Math.min(10, Math.ceil(Math.sqrt(Math.max(1, nodes.length)))));
  const rows = Math.max(1, Math.ceil(nodes.length / columns));
  const cellWidth = 154;
  const cellHeight = 86;
  const headerHeight = standalone ? 92 : 24;
  const width = Math.max(480, columns * cellWidth + 48);
  const height = Math.max(180, headerHeight + rows * cellHeight + 36);
  const positions = new Map(
    EffectArray.map(nodes, (node, index) => [
      node.id,
      {
        x: 24 + (index % columns) * cellWidth + cellWidth / 2,
        y: headerHeight + Math.floor(index / columns) * cellHeight + cellHeight / 2,
      },
    ]),
  );
  const metadataJson = escapeGraphMarkup(JSON.stringify({metadata, summary}));
  const lineMarkup = EffectArray.join(
    EffectArray.map(edges, edge => {
      const source = positions.get(edge.sourceId);
      const target = positions.get(edge.targetId);
      if (!source || !target) return '';
      const dash = edge.provenance === 'heuristic' || edge.provenance === 'model' ? ' stroke-dasharray="5 5"' : '';
      return (
        `<line x1="${source.x}" y1="${source.y}" x2="${target.x}" y2="${target.y}" ` +
        `stroke="#526779" stroke-width="1.2" opacity=".55" marker-end="url(#arrow)"${dash}>` +
        `<title>${escapeGraphMarkup(edge.relation)} [${escapeGraphMarkup(edge.provenance)}]</title></line>`
      );
    }),
    '',
  );
  const nodeMarkup = EffectArray.join(
    EffectArray.map(nodes, node => {
      const position = positions.get(node.id)!;
      return (
        `<g transform="translate(${position.x} ${position.y})"><circle r="17" fill="${nodeColor(node.kind)}" ` +
        'stroke="#d7fff4" stroke-width="1.2">' +
        `<title>${escapeGraphMarkup(node.label)} — ${escapeGraphMarkup(node.path)}</title></circle>` +
        `<text y="31" text-anchor="middle" fill="#dce7ef" font-size="10">${escapeGraphMarkup(
          ellipsize(node.label, 24),
        )}</text></g>`
      );
    }),
    '',
  );
  const header = standalone
    ? `<text x="24" y="30" fill="#67e8c7" font-size="12" font-weight="700">DERIVED · NONCANONICAL · SOURCE-SENSITIVE</text>` +
      `<text x="24" y="58" fill="#eef6fb" font-size="22" font-weight="700">${escapeGraphMarkup(
        metadata.repository.displayName,
      )}</text>` +
      `<text x="24" y="78" fill="#9bacb9" font-size="11">${summary.nodes.written} nodes · ${summary.edges.written} relationships</text>`
    : '';
  return (
    (standalone ? '<?xml version="1.0" encoding="UTF-8"?>\n' : '') +
    `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="tn-title tn-desc" ` +
    `viewBox="0 0 ${width} ${height}"><title id="tn-title">Threadnote graph overview — ${escapeGraphMarkup(
      metadata.repository.displayName,
    )}</title><desc id="tn-desc">Derived, noncanonical, source-sensitive bounded graph overview.</desc>` +
    `<metadata>${metadataJson}</metadata><defs><marker id="arrow" viewBox="0 0 10 10" refX="22" refY="5" ` +
    'markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#526779"/>' +
    '</marker></defs><rect width="100%" height="100%" fill="#111922"/>' +
    `${header}<g>${lineMarkup}${nodeMarkup}</g></svg>`
  );
}

function nodeColor(kind: string): string {
  const palette = ['#67e8c7', '#7dd3fc', '#a78bfa', '#f9a8d4', '#fcd34d', '#86efac'];
  const hash = stableHash(kind, 0);
  return palette[hash % palette.length];
}

function stableHash(value: string, seed: number): number {
  let hash = seed >>> 0;
  for (const character of value) {
    hash ^= Effect2.pipe(
      character,
      EffectString.codePointAt(0),
      Effect2.Option.getOrElse(() => undefined),
    )!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function ellipsize(value: string, maximumCharacters: number): string {
  const characters = Array.from(value);
  return characters.length <= maximumCharacters
    ? value
    : `${EffectArray.join(characters.slice(0, maximumCharacters - 1), '')}…`;
}

/** Replaces characters forbidden by XML 1.0 and applies a code-unit bound without splitting surrogate pairs. */
export function normalizeCodeGraphText(value: string, maximumCharacters: number): string {
  if (maximumCharacters <= 0) return '';
  let normalized = '';
  for (const character of value) {
    const point = Effect2.pipe(
      character,
      EffectString.codePointAt(0),
      Effect2.Option.getOrElse(() => undefined),
    )!;
    normalized += isXmlCharacter(point) ? character : '\uFFFD';
  }
  if (normalized.length <= maximumCharacters) return normalized;
  let result = Effect2.pipe(normalized, EffectString.slice(0, Math.max(0, maximumCharacters - 1)));
  const last = Effect2.pipe(
    result,
    EffectString.charCodeAt(result.length - 1),
    Effect2.Option.getOrElse(() => NaN),
  );
  if (last >= 0xd800 && last <= 0xdbff) result = Effect2.pipe(result, EffectString.slice(0, -1));
  return `${result}…`;
}

function isXmlCharacter(point: number): boolean {
  return (
    point === 0x9 ||
    point === 0xa ||
    point === 0xd ||
    (point >= 0x20 && point <= 0xd7ff) ||
    (point >= 0xe000 && point <= 0xfffd) ||
    (point >= 0x10000 && point <= 0x10ffff)
  );
}

export function escapeGraphMarkup(value: string): string {
  return Effect2.pipe(
    normalizeCodeGraphText(value, Number.MAX_SAFE_INTEGER),
    EffectString.replaceAll('&', '&amp;'),
    EffectString.replaceAll('<', '&lt;'),
    EffectString.replaceAll('>', '&gt;'),
    EffectString.replaceAll('"', '&quot;'),
    EffectString.replaceAll("'", '&apos;'),
  );
}

export function escapeHtmlText(value: string): string {
  return Effect2.pipe(escapeGraphMarkup(value), EffectString.replaceAll('&apos;', '&#39;'));
}
