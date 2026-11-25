import {Schema} from 'effect';

export const CODE_GRAPH_DIAGRAM_QUESTION_MAXIMUM_LENGTH = 1024;
export const CODE_GRAPH_DIAGRAM_TYPES = ['auto', 'architecture', 'class', 'sequence', 'flowchart'] as const;
export const CodeGraphDiagramTypeSchema = Schema.Literals(CODE_GRAPH_DIAGRAM_TYPES);
export type CodeGraphDiagramType = typeof CodeGraphDiagramTypeSchema.Type;

const DiagramType = Schema.Literals(['architecture', 'class', 'sequence', 'flowchart']);
const Freshness = Schema.Literals(['current', 'deferred', 'stale', 'unknown']);
const Scope = Schema.Struct({
  repositoryId: Schema.String,
  repositoryName: Schema.String,
  snapshotId: Schema.String,
  commit: Schema.optionalKey(Schema.String),
  viewKey: Schema.optionalKey(Schema.String),
  project: Schema.optionalKey(Schema.String),
});
const Span = Schema.Struct({
  line: Schema.Int,
  column: Schema.Int,
  endLine: Schema.Int,
  endColumn: Schema.Int,
});
const Subject = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  kind: Schema.String,
  path: Schema.String,
  span: Span,
  name: Schema.optionalKey(Schema.String),
  qualifiedName: Schema.optionalKey(Schema.String),
  signature: Schema.optionalKey(Schema.String),
});
const Node = Schema.Struct({
  ...Subject.fields,
  diagramId: Schema.String,
  evidenceKind: Schema.optionalKey(Schema.Literals(['boundary', 'unresolved'])),
});
const Edge = Schema.Struct({
  id: Schema.String,
  source: Schema.String,
  target: Schema.String,
  relation: Schema.String,
  provenance: Schema.Literals(['declared', 'resolved', 'syntactic']),
  path: Schema.String,
  span: Span,
});
const Group = Schema.Struct({
  diagramId: Schema.String,
  label: Schema.String,
  members: Schema.Array(Schema.String),
});
const CoverageSite = {
  label: Schema.String,
  edgeId: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
  span: Schema.optionalKey(Span),
};
const Coverage = Schema.Struct({
  completeness: Schema.Literals(['complete', 'incomplete', 'undetermined']),
  subject: Schema.optionalKey(Subject),
  boundaries: Schema.Array(
    Schema.Struct({
      ...CoverageSite,
      kind: Schema.Literals(['external', 'outside-scope']),
    }),
  ),
  gaps: Schema.Array(
    Schema.Struct({
      ...CoverageSite,
      kind: Schema.Literals(['unresolved-target', 'missing-evidence', 'partial-project', 'interrupted']),
    }),
  ),
});
const Base = {
  scope: Scope,
  freshness: Freshness,
  limits: Schema.Array(Schema.String),
  coverage: Schema.optionalKey(Coverage),
};
const Diagram = Schema.Struct({
  diagramType: DiagramType,
  source: Schema.String,
  inferred: Schema.Boolean,
  evidence: Schema.Struct({
    nodes: Schema.Array(Node),
    edges: Schema.Array(Edge),
    groups: Schema.Array(Group),
  }),
});

export const CodeGraphDiagramResultSchema = Schema.Union([
  Schema.Struct({
    ...Base,
    status: Schema.Literal('diagram'),
    ...Diagram.fields,
  }),
  Schema.Struct({
    ...Base,
    coverage: Coverage,
    status: Schema.Literal('incomplete'),
    message: Schema.String,
    nextAction: Schema.String,
    diagram: Schema.optionalKey(Diagram),
    suggestedType: Schema.optionalKey(DiagramType),
  }),
  Schema.Struct({
    ...Base,
    status: Schema.Literal('clarification'),
    message: Schema.String,
    candidates: Schema.Array(Schema.Struct({...Subject.fields, retryQuery: Schema.optionalKey(Schema.String)})),
  }),
  Schema.Struct({
    ...Base,
    status: Schema.Literal('unavailable'),
    message: Schema.String,
    nextAction: Schema.String,
    suggestedType: Schema.optionalKey(DiagramType),
  }),
]);

export type CodeGraphDiagramResult = typeof CodeGraphDiagramResultSchema.Type;
export type CodeGraphDiagramScope = typeof Scope.Type;
export type CodeGraphDiagramFreshness = typeof Freshness.Type;
export type CodeGraphDiagramCoverage = typeof Coverage.Type;
