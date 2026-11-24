import {Array as Arr, Option, String as Str} from 'effect';
import {compareCodeUnits} from '../ordering.js';
import {parseCodeGraphEndpointSelector} from './selector.js';
import type {CodeGraphEdge, CodeGraphQueryNode, CodeGraphSpan} from '../types.js';
import type {
  CodeGraphDiagramFreshness,
  CodeGraphDiagramResult,
  CodeGraphDiagramScope,
  CodeGraphDiagramType,
} from './diagram_contract.js';

export const CODE_GRAPH_DIAGRAM_EVIDENCE_LIMITS = {nodes: 40, edges: 80} as const;
const DRAW_LIMITS = {nodes: 8, edges: 10} as const;
const QUESTION_LIMIT = 1024;
const SEED_LIMIT = 240;
const LABEL_LIMIT = 72;
const SUBJECT_TERMS = /[\p{L}\p{N}_$@][\p{L}\p{N}_$@./#:-]*/gu;
const QUESTION_WORDS = new Set(
  Str.split(' ')(
    'a about and are architecture as call calls callpath chain class classes code component components connect connected dependency dependencies diagram do does draw explain flow flowchart for from give graph how i implement implements in inherit inherits interaction interface interfaces is it map me mermaid module modules of on order package packages path please project relate relates relationship relationships repository sequence show static structure the this to together type types use uses what when where which with work works',
  ),
);
const CLASS_KINDS = new Set(['class', 'interface', 'struct', 'trait', 'type', 'type_alias']);
const ARCHITECTURE_KINDS = new Set(['component', 'database', 'resource', 'service']);
const ARCHITECTURE_RELATIONS = new Set(['calls', 'configures', 'constructs', 'depends_on', 'reads_or_writes']);
const FLOW_RELATIONS = new Set([
  ...ARCHITECTURE_RELATIONS,
  'contains',
  'declares',
  'exports',
  'extends',
  'implements',
  'imports',
  'overrides',
  'references',
  'reexports',
  'tests',
]);
const DEPENDENCY_RELATIONS = new Set(['depends_on', 'imports', 'reexports']);
const DEPENDENCY_KINDS = new Set(['module', 'package', 'project', 'target', 'file']);

type Diagram = Extract<CodeGraphDiagramResult, {status: 'diagram'}>;
type DiagramType = Diagram['diagramType'];
type DiagramProvenance = Diagram['evidence']['edges'][number]['provenance'];
interface Fact extends CodeGraphEdge {
  readonly sourceId: string;
  readonly targetId: string;
  readonly provenance: DiagramProvenance;
}

export interface CodeGraphDiagramInput {
  readonly question: string;
  readonly diagramType?: CodeGraphDiagramType;
  /**
   * Supply raw evidence from the authorized repository and snapshot in scope, in retrieval order.
   * The projection examines only the first 40 nodes and 80 edges.
   */
  readonly nodes: readonly CodeGraphQueryNode[];
  readonly edges: readonly CodeGraphEdge[];
  readonly scope: CodeGraphDiagramScope;
  readonly freshness: CodeGraphDiagramFreshness;
  readonly limits?: readonly string[];
  readonly budget?: {readonly nodes?: number; readonly edges?: number};
}

function subjectTerms(question: string): readonly string[] {
  const bounded = Str.replaceAll('\\', '/')(Str.slice(0, QUESTION_LIMIT)(question));
  const complete = question.length > QUESTION_LIMIT ? Str.replace(/[\p{L}\p{N}_$@./#:-]+$/u, '')(bounded) : bounded;
  const tokens = Option.getOrElse(Str.match(SUBJECT_TERMS)(complete), () => []);
  return Arr.map(tokens, token => Str.replace(/[.:]+$/u, '')(token));
}

export function prepareCodeGraphDiagramQuery(question: string): string {
  const terms = subjectTerms(question);
  const important = Arr.filter(terms, term => !QUESTION_WORDS.has(Str.toLowerCase(term)));
  const bounded: string[] = [];
  let length = 0;
  for (const term of new Set(important.length ? important : terms)) {
    if (length + term.length > SEED_LIMIT || bounded.length >= 16) break;
    bounded.push(term);
    length += term.length + 1;
  }
  return Arr.join(bounded, ' ');
}

function isExplicitSelector(term: string): boolean {
  return /^cgs_[a-f0-9]{32,64}$/iu.test(term) || /^[^#]+#[^#]+$/u.test(term);
}

function matchesSelector(node: CodeGraphQueryNode, raw: string): boolean {
  const selector = parseCodeGraphEndpointSelector(raw);
  if (!selector.path) return Str.toLowerCase(raw) === node.id;
  return (
    selector.path === Str.replaceAll('\\', '/')(node.path) &&
    (selector.symbol === node.name || selector.symbol === node.qualifiedName)
  );
}

interface NamedTerm {
  readonly spelling: string;
  readonly caseSensitive: boolean;
}

function namedTerm(tokens: readonly string[], terms: readonly string[]): NamedTerm | undefined {
  for (const [index, token] of tokens.entries()) {
    if (!/^(?:for|from|of)$/iu.test(token)) continue;
    const next = tokens[index + 1];
    const subject = next && /^(?:a|an|the)$/iu.test(next) ? tokens[index + 2] : next;
    if (subject && terms.includes(Str.toLowerCase(subject))) return {spelling: subject, caseSensitive: false};
  }
  const identifier = Option.getOrUndefined(
    Arr.findFirst(
      tokens,
      (token, index) => terms.includes(Str.toLowerCase(token)) && (index === 0 ? /.+\p{Lu}/u : /\p{Lu}/u).test(token),
    ),
  );
  if (identifier) return {spelling: identifier, caseSensitive: true};
  const first = tokens[0];
  if (terms.length === 1 && first && (tokens.length === 1 || /^(?:show|draw|explain|give)$/iu.test(first))) {
    const spelling = terms[0];
    if (spelling) return {spelling, caseSensitive: false};
  }
  return undefined;
}

function namedMatch(node: CodeGraphQueryNode, term: NamedTerm | undefined): number {
  if (!term) return 0;
  if (term.spelling === node.name || term.spelling === node.qualifiedName) return 2;
  if (term.caseSensitive) return 0;
  const normalized = Str.toLowerCase(term.spelling);
  return normalized === Str.toLowerCase(node.name) || normalized === Str.toLowerCase(node.qualifiedName) ? 1 : 0;
}

function words(value: string): readonly string[] {
  const split = Str.replace(/([a-z0-9])([A-Z])/gu, '$1 $2')(value);
  return Option.getOrElse(Str.match(/[\p{L}\p{N}]+/gu)(Str.toLowerCase(split)), () => []);
}

function relevance(node: CodeGraphQueryNode, terms: readonly string[]): number {
  const name = Str.toLowerCase(node.name);
  const qualified = Str.toLowerCase(node.qualifiedName);
  const path = Str.toLowerCase(node.path);
  const names = [...words(node.name), ...words(node.qualifiedName)];
  const pathWords = words(node.path);
  let score = 0;
  for (const term of terms) {
    if (
      term === name ||
      term === qualified ||
      term === path ||
      term === (node.packageName && Str.toLowerCase(node.packageName))
    )
      score += 12;
    else if (names.includes(term)) score += 7;
    else if (
      Arr.some(names, word => term.length >= 5 && word.length >= 5 && Str.slice(0, 5)(word) === Str.slice(0, 5)(term))
    )
      score += 4;
    else if (pathWords.includes(term)) score += 2;
  }
  return score;
}

function validSpan(span: CodeGraphSpan): boolean {
  return (
    Arr.every(
      [span.line, span.column, span.endLine, span.endColumn],
      value => Number.isSafeInteger(value) && value > 0,
    ) &&
    (span.endLine > span.line || (span.endLine === span.line && span.endColumn >= span.column))
  );
}

function admitNode(node: CodeGraphQueryNode): boolean {
  return !!node.id && node.id.length <= 128 && !!node.path && node.path.length <= 512 && validSpan(node.span);
}

function admitFact(edge: CodeGraphEdge, nodes: ReadonlyMap<string, CodeGraphQueryNode>): edge is Fact {
  return (
    !!edge.sourceId &&
    !!edge.targetId &&
    nodes.has(edge.sourceId) &&
    nodes.has(edge.targetId) &&
    !!edge.id &&
    edge.id.length <= 128 &&
    !!edge.evidencePath &&
    edge.evidencePath.length <= 512 &&
    validSpan(edge.evidenceSpan) &&
    FLOW_RELATIONS.has(edge.relation) &&
    (edge.provenance === 'declared' || edge.provenance === 'resolved' || edge.provenance === 'syntactic')
  );
}

function isClassFact(edge: Fact, nodes: ReadonlyMap<string, CodeGraphQueryNode>): boolean {
  return (
    (edge.relation === 'extends' || edge.relation === 'implements') &&
    CLASS_KINDS.has(nodes.get(edge.sourceId)?.kind ?? '') &&
    CLASS_KINDS.has(nodes.get(edge.targetId)?.kind ?? '')
  );
}

function isArchitectureFact(edge: Fact, nodes: ReadonlyMap<string, CodeGraphQueryNode>): boolean {
  return (
    ARCHITECTURE_RELATIONS.has(edge.relation) &&
    ARCHITECTURE_KINDS.has(nodes.get(edge.sourceId)?.kind ?? '') &&
    ARCHITECTURE_KINDS.has(nodes.get(edge.targetId)?.kind ?? '')
  );
}

function connected(
  subject: string,
  edges: readonly Fact[],
): {readonly ids: Set<string>; readonly facts: readonly Fact[]} {
  const ids = new Set([subject]);
  for (const id of ids) {
    for (const edge of edges) {
      if (edge.sourceId === id) ids.add(edge.targetId);
      if (edge.targetId === id) ids.add(edge.sourceId);
    }
  }
  return {ids, facts: Arr.filter(edges, edge => ids.has(edge.sourceId))};
}

function sequencePath(subject: string, edges: readonly Fact[]): readonly Fact[] | undefined {
  const path: Fact[] = [];
  const visited = new Set([subject]);
  let current = subject;
  for (;;) {
    const outgoing = Arr.filter(edges, edge => edge.relation === 'calls' && edge.sourceId === current);
    const next = outgoing[0];
    if (!next) return path.length ? path : undefined;
    if (outgoing.length > 1 || visited.has(next.targetId)) return undefined;
    path.push(next);
    current = next.targetId;
    visited.add(current);
  }
}

function intent(terms: readonly string[]): DiagramType | undefined {
  const value = Arr.join(
    Arr.filter(terms, term => !/[./#:@]/u.test(term)),
    ' ',
  );
  if (/\b(?:class(?:es)?|inherit(?:ance|s)?|implement(?:ation|s)?|interfaces?)\b/iu.test(value)) return 'class';
  if (/\b(?:sequence|call path|call chain|call order|in what order|step by step)\b/iu.test(value)) return 'sequence';
  if (/\b(?:architecture|topology|infrastructure)\b/iu.test(value)) return 'architecture';
  if (/\b(?:flowchart|dependency|dependencies|imports?|modules?|packages?)\b/iu.test(value)) return 'flowchart';
  return undefined;
}

function isDependencyFact(edge: Fact, nodes: ReadonlyMap<string, CodeGraphQueryNode>): boolean {
  return (
    DEPENDENCY_RELATIONS.has(edge.relation) &&
    (DEPENDENCY_KINDS.has(nodes.get(edge.sourceId)?.kind ?? '') ||
      DEPENDENCY_KINDS.has(nodes.get(edge.targetId)?.kind ?? ''))
  );
}

function limitCount(value: number | undefined, ceiling: number): number {
  return value === undefined || !Number.isFinite(value) ? ceiling : Math.min(Math.max(0, Math.floor(value)), ceiling);
}

function fitConnected(
  subject: string,
  facts: readonly Fact[],
  budget: CodeGraphDiagramInput['budget'],
): {readonly ids: Set<string>; readonly facts: readonly Fact[]} {
  const nodeLimit = limitCount(budget?.nodes, DRAW_LIMITS.nodes);
  const edgeLimit = limitCount(budget?.edges, DRAW_LIMITS.edges);
  const ids = new Set(nodeLimit > 0 ? [subject] : []);
  const selected = new Set<Fact>();
  for (const id of ids) {
    for (const edge of facts) {
      if (selected.size >= edgeLimit) break;
      if (edge.sourceId !== id && edge.targetId !== id) continue;
      const next = edge.sourceId === id ? edge.targetId : edge.sourceId;
      if (!ids.has(next) && ids.size >= nodeLimit) continue;
      ids.add(next);
      selected.add(edge);
    }
  }
  return {ids, facts: [...selected]};
}

function present(value: string, limit: number): string {
  return Arr.join(Arr.fromIterable(Str.slice(0, limit * 2)(value)).slice(0, limit), '');
}

function subjectEvidence(node: CodeGraphQueryNode): Omit<Diagram['evidence']['nodes'][number], 'diagramId'> {
  return {
    id: node.id,
    label: present(node.qualifiedName || node.name, 128),
    kind: present(node.kind, 48),
    path: node.path,
    span: node.span,
  };
}

function safeLabel(value: string, fallback: string): string {
  const allowed = Str.replace(/[^\p{L}\p{N} _.-]+/gu, ' ')(present(value, LABEL_LIMIT));
  const label = Str.trim(Str.replace(/ {2,}/gu, ' ')(allowed));
  return !label || /^end$/iu.test(label) ? fallback : label;
}

function groupNodes(
  nodes: Diagram['evidence']['nodes'],
  byId: ReadonlyMap<string, CodeGraphQueryNode>,
  facts: readonly Fact[],
): Diagram['evidence']['groups'] {
  if (!Arr.some(facts, edge => DEPENDENCY_RELATIONS.has(edge.relation))) return [];
  const groups = new Map<string, string[]>();
  for (const node of nodes) {
    const lastSlash = Option.getOrElse(Str.lastIndexOf('/')(node.path), () => -1);
    const label = byId.get(node.id)?.packageName || (lastSlash > 0 ? Str.slice(0, lastSlash)(node.path) : '.');
    const members = groups.get(label) ?? [];
    members.push(node.diagramId);
    groups.set(label, members);
  }
  return Arr.map([...groups], ([label, members], index) => ({
    diagramId: `g${index + 1}`,
    label: present(label, 128),
    members,
  }));
}

function sourceFor(type: DiagramType, evidence: Diagram['evidence']): string {
  const {nodes, edges, groups} = evidence;
  const labels = new Map(Arr.map(nodes, node => [node.diagramId, safeLabel(node.label, node.diagramId)]));
  const flowNode = (id: string) => `  ${id}["${labels.get(id)}"]`;
  switch (type) {
    case 'architecture':
      return Arr.join(
        [
          'architecture-beta',
          ...Arr.map(nodes, node => `  service ${node.diagramId}[${labels.get(node.diagramId)}]`),
          ...Arr.map(edges, edge => `  ${edge.source}:R --> L:${edge.target}`),
        ],
        '\n',
      );
    case 'class':
      return Arr.join(
        [
          'classDiagram',
          ...Arr.map(nodes, node => `  class ${node.diagramId}["${labels.get(node.diagramId)}"]`),
          ...Arr.map(
            edges,
            edge => `  ${edge.source} ${edge.relation === 'implements' ? '..|>' : '--|>'} ${edge.target}`,
          ),
        ],
        '\n',
      );
    case 'sequence':
      return Arr.join(
        [
          'sequenceDiagram',
          ...Arr.map(nodes, node => `  participant ${node.diagramId} as ${labels.get(node.diagramId)}`),
          ...Arr.map(edges, edge => `  ${edge.source}->>${edge.target}: calls`),
        ],
        '\n',
      );
    case 'flowchart':
      return Arr.join(
        [
          'flowchart TD',
          ...(groups.length
            ? Arr.flatMap(groups, group => [
                `  subgraph ${group.diagramId}["${safeLabel(group.label, 'Root')}"]`,
                ...Arr.map(group.members, flowNode),
                '  end',
              ])
            : Arr.map(nodes, node => flowNode(node.diagramId))),
          ...Arr.map(edges, edge => `  ${edge.source} -->|${edge.relation}| ${edge.target}`),
        ],
        '\n',
      );
  }
}

function snapshotLimits(
  input: CodeGraphDiagramInput,
  byId: ReadonlyMap<string, CodeGraphQueryNode>,
  facts: readonly Fact[],
): string[] {
  const limits = Arr.map((input.limits ?? []).slice(0, 6), limit => present(limit, 160));
  if (input.freshness !== 'current') limits.push(`Snapshot freshness is ${input.freshness}.`);
  if (
    input.nodes.length > CODE_GRAPH_DIAGRAM_EVIDENCE_LIMITS.nodes ||
    input.edges.length > CODE_GRAPH_DIAGRAM_EVIDENCE_LIMITS.edges
  ) {
    limits.push('The projection used a bounded evidence window.');
  }
  if (
    byId.size < Math.min(input.nodes.length, CODE_GRAPH_DIAGRAM_EVIDENCE_LIMITS.nodes) ||
    facts.length < Math.min(input.edges.length, CODE_GRAPH_DIAGRAM_EVIDENCE_LIMITS.edges)
  ) {
    limits.push('The projection omitted evidence without a supported relationship or a complete source reference.');
  }
  return limits;
}

export function projectCodeGraphDiagram(input: CodeGraphDiagramInput): CodeGraphDiagramResult {
  const byId = new Map(
    Arr.map(Arr.filter(input.nodes.slice(0, CODE_GRAPH_DIAGRAM_EVIDENCE_LIMITS.nodes), admitNode), node => [
      node.id,
      node,
    ]),
  );
  const facts = Arr.filter(input.edges.slice(0, CODE_GRAPH_DIAGRAM_EVIDENCE_LIMITS.edges), edge =>
    admitFact(edge, byId),
  ).sort((left, right) => compareCodeUnits(left.id, right.id));
  const limits = snapshotLimits(input, byId, facts);
  const base = {scope: input.scope, freshness: input.freshness, limits};
  const unavailable = (message: string, nextAction: string, suggestedType?: DiagramType): CodeGraphDiagramResult => ({
    ...base,
    status: 'unavailable',
    message,
    nextAction,
    ...(suggestedType === undefined ? {} : {suggestedType}),
  });
  const tokens = subjectTerms(input.question);
  const terms = [...new Set(Arr.filter(Arr.map(tokens, Str.toLowerCase), term => !QUESTION_WORDS.has(term)))];
  const selectors = Arr.filter(tokens, isExplicitSelector);
  const named = namedTerm(tokens, terms);
  const explicitType = input.diagramType === 'auto' ? undefined : input.diagramType;
  const requested = explicitType ?? intent(tokens);
  const classFacts =
    requested === undefined || requested === 'class' ? Arr.filter(facts, edge => isClassFact(edge, byId)) : [];
  const architectureFacts =
    requested === undefined || requested === 'architecture'
      ? Arr.filter(facts, edge => isArchitectureFact(edge, byId))
      : [];
  const dependencyFacts =
    requested === 'architecture' && !explicitType ? Arr.filter(facts, edge => isDependencyFact(edge, byId)) : [];
  const calls = requested === 'sequence' ? Arr.filter(facts, edge => edge.relation === 'calls') : [];
  const supportFacts =
    requested === 'class'
      ? classFacts
      : requested === 'architecture'
        ? [...architectureFacts, ...dependencyFacts]
        : requested === 'sequence'
          ? calls
          : facts;
  const generic = !terms.length && requested !== undefined;
  const ranked = Arr.flatMap([...byId.values()], node => {
    const match = relevance(node, terms);
    if (selectors.length ? !Arr.some(selectors, term => matchesSelector(node, term)) : !match && !generic) return [];
    const sequence = requested === 'sequence' ? sequencePath(node.id, calls) : undefined;
    const direct = Arr.some(
      supportFacts,
      edge => edge.sourceId === node.id || (requested !== 'sequence' && edge.targetId === node.id),
    );
    return [{node, match, named: namedMatch(node, named), support: sequence ? 2 : direct ? 1 : 0, sequence}];
  }).sort(
    (left, right) =>
      right.named - left.named ||
      right.support - left.support ||
      right.match - left.match ||
      right.node.score - left.node.score ||
      compareCodeUnits(left.node.id, right.node.id),
  );
  const first = ranked[0];
  if (!first || (generic && !first.support)) {
    return unavailable(
      'The selected graph has no source evidence for a named subject in the question.',
      'Ask for a symbol, package, or path in the selected graph.',
    );
  }

  const subject = first.node.id;
  const candidates = [first];
  const covered = connected(subject, supportFacts).ids;
  const firstName = Str.toLowerCase(first.node.name);
  for (const candidate of ranked.slice(1)) {
    if (
      candidate.named !== first.named ||
      candidate.match !== first.match ||
      candidate.support !== first.support ||
      candidates.length >= 5
    )
      continue;
    const sameName = !generic && firstName === Str.toLowerCase(candidate.node.name);
    if (!sameName && covered.has(candidate.node.id)) continue;
    candidates.push(candidate);
    for (const id of connected(candidate.node.id, supportFacts).ids) covered.add(id);
  }
  if (candidates.length > 1) {
    return {
      ...base,
      status: 'clarification',
      message: 'Which source location is the subject of this diagram?',
      candidates: Arr.map(candidates, candidate => subjectEvidence(candidate.node)),
    };
  }

  const component = connected(subject, facts).facts;
  const classes = connected(subject, classFacts).facts;
  const architecture = connected(subject, architectureFacts).facts;
  const dependencies = connected(subject, dependencyFacts).facts;
  const architectureFallback =
    !explicitType && requested === 'architecture' && !architecture.length && dependencies.length > 0;
  const type = architectureFallback
    ? 'flowchart'
    : (requested ?? (classes.length ? 'class' : architecture.length ? 'architecture' : 'flowchart'));
  const typed =
    type === 'class'
      ? classes.length
        ? classes
        : undefined
      : type === 'architecture'
        ? architecture.length
          ? architecture
          : undefined
        : type === 'sequence'
          ? first.sequence
          : architectureFallback
            ? dependencies
            : component;
  if (!typed) {
    const message =
      type === 'sequence'
        ? 'The evidence does not identify a single nested call path from this subject.'
        : `The subject has no supported ${type} relationship in the selected graph.`;
    return unavailable(message, 'Request a flowchart or name a narrower subject.', 'flowchart');
  }
  const fitted = fitConnected(subject, typed, input.budget);
  if (!fitted.ids.size || (typed.length && !fitted.facts.length)) {
    return unavailable(
      'A complete diagram and its source evidence exceed the response limit.',
      'Request a larger response limit or a narrower subject.',
    );
  }
  if (
    typed.length > fitted.facts.length ||
    ((type !== 'flowchart' || architectureFallback) && component.length > typed.length)
  ) {
    limits.push('The diagram shows only part of the available connected evidence.');
  }
  if (type === 'sequence') limits.push('The sequence shows an inferred path from static calls.');
  const drawn = Arr.filter(
    Arr.map([...fitted.ids], id => byId.get(id)),
    node => node !== undefined,
  );
  const nodes = Arr.map(drawn, (node, index) => ({...subjectEvidence(node), diagramId: `n${index + 1}`}));
  const diagramIds = new Map(Arr.map(nodes, node => [node.id, node.diagramId]));
  const edges = Arr.flatMap(fitted.facts, edge => {
    const source = diagramIds.get(edge.sourceId);
    const target = diagramIds.get(edge.targetId);
    if (!source || !target) return [];
    return [
      {
        id: edge.id,
        source,
        target,
        relation: edge.relation,
        provenance: edge.provenance,
        path: edge.evidencePath,
        span: edge.evidenceSpan,
      },
    ];
  });
  const groups = type === 'flowchart' ? groupNodes(nodes, byId, fitted.facts) : [];
  const evidence = {nodes, edges, groups};
  return {
    ...base,
    status: 'diagram',
    diagramType: type,
    source: sourceFor(type, evidence),
    evidence,
    inferred: type === 'sequence',
  };
}
