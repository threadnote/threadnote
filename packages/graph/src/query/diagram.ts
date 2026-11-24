import {Array as Arr, Option, String as Str} from 'effect';
import {compareCodeUnits} from '../ordering.js';
import {parseCodeGraphEndpointSelector} from './selector.js';
import type {CodeGraphEdge, CodeGraphQueryNode, CodeGraphRelation, CodeGraphSpan} from '../types.js';
import type {
  CodeGraphDiagramCoverage,
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
const SUBJECT_TERMS = /(?:\.\/?)*[\p{L}\p{N}_$@](?:[\p{L}\p{M}\p{N}_$@./#:-]|\u{200C}|\u{200D})*/gu;
const QUOTED_SUBJECT_TERMS =
  /"[^"\r\n]*"|(?<![\p{L}\p{M}\p{N}_$@])'[^'\r\n]*'|\x60[^\x60\r\n]*\x60|(?:\.\/?)*[\p{L}\p{N}_$@](?:[\p{L}\p{M}\p{N}_$@./#:-]|\u{200C}|\u{200D})*/gu;
const QUESTION_WORDS = new Set(
  Str.split(' ')(
    'a about and are architecture as call calls callpath chain class classes code component components connect connected dependency dependencies diagram do does draw explain flow flowchart for from during give graph how i implement implements in inherit inherits interaction interface interfaces is it map me mermaid module modules of occur on order package packages path please project relate relates relationship relationships repository sequence show static structure the this to together type types use uses what when where which with work works',
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
const DIAGRAM_TYPES = new Set([...CLASS_KINDS, 'enum', 'protocol']);
const DIAGRAM_MEMBERS = new Set(['method', 'member', 'field', 'property', 'constructor', 'associated_type']);
const DIAGRAM_COMPONENTS = new Set([...ARCHITECTURE_KINDS, ...DEPENDENCY_KINDS, 'config', 'repository', 'output']);
export const DIAGRAM_ARCHITECTURE_RELATIONS = [
  'depends_on',
  'imports',
  'reexports',
  'configures',
  'reads_or_writes',
] as const;

export const isDiagramTypeKind = (kind: string): boolean => DIAGRAM_TYPES.has(kind);
export const isDiagramMemberKind = (kind: string): boolean => DIAGRAM_MEMBERS.has(kind);
export const isDiagramComponentKind = (kind: string): boolean => DIAGRAM_COMPONENTS.has(kind);
export const isDiagramOwnershipRelation = (relation: CodeGraphRelation): boolean =>
  relation === 'contains' || relation === 'declares';
const diagramArchitectureRelations = new Set<CodeGraphRelation>(DIAGRAM_ARCHITECTURE_RELATIONS);

type Diagram = Extract<CodeGraphDiagramResult, {status: 'diagram'}>;
type DiagramType = Diagram['diagramType'];
type DiagramProvenance = Diagram['evidence']['edges'][number]['provenance'];
export interface CodeGraphDiagramFact extends CodeGraphEdge {
  readonly sourceId: string;
  readonly targetId: string;
  readonly provenance: DiagramProvenance;
}
type Fact = CodeGraphDiagramFact;

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
  const complete =
    question.length > QUESTION_LIMIT
      ? Str.replace(/(?:[\p{L}\p{M}\p{N}_$@./#:-]|\u{200C}|\u{200D})+$/u, '')(bounded)
      : bounded;
  const tokens = Option.getOrElse(Str.match(QUOTED_SUBJECT_TERMS)(complete), () => []);
  return Arr.flatMap(tokens, token => {
    if (!/^["'\x60]/u.test(token)) return [Str.replace(/[.:]+$/u, '')(token)];
    const phrase = Str.slice(1, -1)(token);
    if (isExplicitSelector(phrase)) return [phrase];
    const words = Option.getOrElse(Str.match(SUBJECT_TERMS)(phrase), () => []);
    return Arr.map(words, word => Str.replace(/[.:]+$/u, '')(word));
  });
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
  if (/\b(?:sequence|call path|call chain|call order|what calls occur|in what order|step by step)\b/iu.test(value))
    return 'sequence';
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

function safeCompleteLabel(value: string, fallback: string): string {
  const safe = Str.replace(/[^\p{L}\p{M}\p{N} _.-]+/gu, ' ')(value);
  const label = Str.trim(Str.replace(/ +/gu, ' ')(safe));
  return !label || /^end$/iu.test(label) ? fallback : label;
}

function safeClassMemberLabel(value: string, fallback: string): string {
  return Str.replace(/^-/u, '−')(safeCompleteLabel(value, fallback));
}

function groupNodes(
  nodes: Diagram['evidence']['nodes'],
  byId: ReadonlyMap<string, CodeGraphQueryNode>,
  facts: readonly Fact[],
  complete = false,
): Diagram['evidence']['groups'] {
  if (
    !Arr.some(
      facts,
      edge =>
        DEPENDENCY_RELATIONS.has(edge.relation) ||
        (complete && ARCHITECTURE_RELATIONS.has(edge.relation) && edge.relation !== 'calls'),
    )
  )
    return [];
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
    label: complete ? label : present(label, 128),
    members,
  }));
}

function sourceFor(type: DiagramType, evidence: Diagram['evidence'], complete = false): string {
  const {nodes, edges, groups} = evidence;
  const labelFor = complete ? safeCompleteLabel : safeLabel;
  const labels = new Map(Arr.map(nodes, node => [node.diagramId, labelFor(node.label, node.diagramId)]));
  const flowNode = (id: string) => `  ${id}["${labels.get(id)}"]`;
  switch (type) {
    case 'architecture': {
      const membership = new Map(
        Arr.flatMap(groups, group => Arr.map(group.members, member => [member, group.diagramId] as const)),
      );
      return Arr.join(
        [
          'architecture-beta',
          ...Arr.map(groups, group => `  group ${group.diagramId}[${labelFor(group.label, group.diagramId)}]`),
          ...Arr.map(nodes, node => {
            const group = membership.get(node.diagramId);
            return `  service ${node.diagramId}[${labels.get(node.diagramId)}]${group ? ` in ${group}` : ''}`;
          }),
          ...Arr.map(edges, edge => `  ${edge.source}:R --> L:${edge.target}`),
        ],
        '\n',
      );
    }
    case 'class': {
      const members = complete ? Arr.filter(nodes, node => isDiagramMemberKind(node.kind)) : [];
      const byId = new Map(Arr.map(members, node => [node.diagramId, node] as const));
      return Arr.join(
        [
          'classDiagram',
          ...Arr.map(
            Arr.filter(nodes, node => !byId.has(node.diagramId)),
            node => `  class ${node.diagramId}["${labels.get(node.diagramId)}"]`,
          ),
          ...Arr.map(edges, edge => {
            const member = byId.get(edge.target);
            if (member) {
              const name = safeClassMemberLabel(member.name ?? member.label, member.diagramId);
              const callable = member.kind === 'method' || member.kind === 'constructor';
              return `  %% Member ${member.diagramId}\n  ${edge.source} : ${name}${callable ? '()' : ''}`;
            }
            if (edge.relation === 'implements' || edge.relation === 'extends')
              return `  ${edge.source} ${edge.relation === 'implements' ? '..|>' : '--|>'} ${edge.target}`;
            return `  ${edge.source} --> ${edge.target} : ${edge.relation}`;
          }),
        ],
        '\n',
      );
    }
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
                `  subgraph ${group.diagramId}["${labelFor(group.label, 'Root')}"]`,
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

const EVIDENCE_REQUEST_WORDS = new Set([
  ...QUESTION_WORDS,
  'an',
  'be',
  'been',
  'being',
  'by',
  'called',
  'caller',
  'callers',
  'derived',
  'details',
  'entry',
  'execution',
  'external',
  'feature',
  'happen',
  'happens',
  'implementation',
  'incoming',
  'infrastructure',
  'locally',
  'implementations',
  'members',
  'methods',
  'or',
  'outgoing',
  'reach',
  'reaches',
  'request',
  'resources',
  'step',
  'steps',
  'subclasses',
  'structs',
  'topology',
  'trigger',
  'triggers',
  'upstream',
  'who',
]);
const STRUCTURAL_PREDICATE =
  /^(?:implement(?:s|ed|ing)?|extend(?:s|ed|ing)?|inherit(?:s|ed|ing)?|overrid(?:e|es|den|ing)|deriv(?:e|es|ed|ing))$/iu;

const ARTICLE = /^(?:a|an|the)$/iu;

function subjectAfter(tokens: readonly string[], index: number): number | undefined {
  const subject = ARTICLE.test(tokens[index] ?? '') ? index + 1 : index;
  return tokens[subject] === undefined ? undefined : subject;
}

function explicitSubjectIndex(tokens: readonly string[]): number | undefined {
  const [first, second] = tokens;
  if (!first) return undefined;
  if (second === undefined) return 0;
  if (/^(?:how|what)$/iu.test(first) && /^(?:do|does|did)$/iu.test(second)) return subjectAfter(tokens, 2);
  if (tokens.length === 2 && /^(?:show|draw|explain|give)$/iu.test(first)) return 1;
  const preposition = tokens.at(ARTICLE.test(tokens.at(-2) ?? '') ? -3 : -2);
  return /^(?:for|from|of)$/iu.test(preposition ?? '') ? tokens.length - 1 : undefined;
}

function asksForStructuralSources(tokens: readonly string[], predicateIndex: number | undefined): boolean {
  if (predicateIndex === undefined) return false;
  if (
    /^(?:implemented|extended|overridden|inherited)$/iu.test(tokens[predicateIndex] ?? '') &&
    /^by$/iu.test(tokens[predicateIndex + 1] ?? '')
  )
    return true;
  if (!/^(?:who|what|which)$/iu.test(tokens[0] ?? '')) return false;
  // A named subject before the predicate is its source. An interrogative and generic type phrase ask for source types.
  return Arr.every(tokens.slice(1, predicateIndex), token => EVIDENCE_REQUEST_WORDS.has(Str.toLowerCase(token)));
}

export function describeCodeGraphDiagramQuestion(question: string, type: CodeGraphDiagramType | undefined) {
  const tokens = subjectTerms(question);
  const selectors = Arr.filter(tokens, isExplicitSelector);
  const explicitSubject = explicitSubjectIndex(tokens);
  const possiblePredicate = Option.getOrUndefined(
    Arr.findFirstIndex(tokens, (token, index) => index !== explicitSubject && STRUCTURAL_PREDICATE.test(token)),
  );
  const inverse = asksForStructuralSources(tokens, possiblePredicate);
  const object = inverse && possiblePredicate !== undefined ? subjectAfter(tokens, possiblePredicate + 1) : undefined;
  const cues = Arr.filter(
    tokens,
    (token, index) =>
      index !== explicitSubject && index !== object && !isExplicitSelector(token) && !/[./#:@]/u.test(token),
  );
  const prose = Arr.join(cues, ' ');
  const preferred = intent(cues);
  const explicitType = type === 'auto' ? undefined : type;
  const inheritance = /\b(?:inherit(?:s|ance)?|subclasses|derived|base class)\b/iu.test(prose);
  const behavior = /\b(?:calls?|called|callers?|works?|executes?|execution|reaches?|triggers?|step by step)\b/iu.test(
    prose,
  );
  const structuralArgument =
    possiblePredicate !== undefined &&
    Arr.some(
      tokens,
      (token, index) =>
        index !== possiblePredicate &&
        (index === explicitSubject ||
          index === object ||
          (!EVIDENCE_REQUEST_WORDS.has(Str.toLowerCase(token)) && !STRUCTURAL_PREDICATE.test(token))),
    );
  const predicateIndex = !behavior && structuralArgument ? possiblePredicate : undefined;
  const structure =
    /\b(?:class|type) diagram\b/iu.test(prose) ||
    (!behavior &&
      (predicateIndex !== undefined ||
        inheritance ||
        /\b(?:class(?:es)?|interfaces?|types?|members?)\b/iu.test(prose)));
  const domain = structure
    ? 'types'
    : preferred === 'architecture' || /\b(?:dependencies|dependency|imports?|resources?)\b/iu.test(prose)
      ? 'architecture'
      : !behavior && explicitType === 'class'
        ? 'types'
        : !behavior && explicitType === 'architecture'
          ? 'architecture'
          : 'behavior';
  const terms = Arr.filter(
    tokens,
    (term, index) =>
      index === explicitSubject ||
      (domain === 'types' && predicateIndex !== undefined && index === object) ||
      (!EVIDENCE_REQUEST_WORDS.has(Str.toLowerCase(term)) && (domain !== 'types' || index !== predicateIndex)),
  );
  const named = namedTerm(tokens, Arr.map(terms, Str.toLowerCase));
  const incoming =
    (domain === 'types' && predicateIndex !== undefined && inverse) ||
    /\b(?:incoming|upstream|callers?|called by|who calls|what calls(?!\s+occur\b)|(?:how|what) .{0,50}\breach(?:es)?|entry points? (?:to|for))\b/iu.test(
      prose,
    );
  return {selectors, terms, named, preferred, explicitType, domain, incoming, inheritance} as const;
}

export type CodeGraphDiagramQuestion = ReturnType<typeof describeCodeGraphDiagramQuestion>;

export function rankCodeGraphDiagramSubject(
  node: CodeGraphQueryNode,
  question: CodeGraphDiagramQuestion,
): readonly [number, number, number] | undefined {
  if (question.selectors.length) {
    if (!Arr.some(question.selectors, selector => matchesSelector(node, selector))) return undefined;
    return [6, 0, 0];
  }
  const path = Str.replaceAll('\\', '/')(node.path);
  const exactPath = Arr.some(question.terms, term => Str.replace(/^\.\//u, '')(term) === path);
  const qualified = Arr.some(question.terms, term => term === node.qualifiedName && term !== node.name);
  const exact = Arr.some(question.terms, term => term === node.name || term === node.qualifiedName);
  const exactPackage = Arr.some(question.terms, term => term === node.packageName);
  const named = namedMatch(node, question.named);
  const match = relevance(node, [...new Set(Arr.map(question.terms, Str.toLowerCase))]);
  const role =
    question.domain === 'types'
      ? Number(isDiagramTypeKind(node.kind))
      : question.domain === 'architecture'
        ? Number(isDiagramComponentKind(node.kind))
        : Number(/(?:route|handler|entry|main)$/iu.test(node.name));
  if (exactPath && (node.kind === 'module' || node.kind === 'file')) return [5, match, role];
  if (qualified) return [4, match, role];
  if (named || exact || (exactPackage && node.kind === 'package')) return [3, match, role];
  if (match === 0 || (!exactPath && Arr.some(question.terms, Str.includes('/')))) return undefined;
  return [1, match, role];
}

export function completeDiagramSubject(
  node: CodeGraphQueryNode,
): Omit<Diagram['evidence']['nodes'][number], 'diagramId'> {
  return {
    id: node.id,
    label: node.qualifiedName || node.name,
    kind: node.kind,
    path: node.path,
    span: node.span,
    name: node.name,
    qualifiedName: node.qualifiedName,
    ...(node.signature === undefined ? {} : {signature: node.signature}),
  };
}

export function hasDiagramSourceSpan(path: string, span: CodeGraphSpan): boolean {
  return path.length > 0 && validSpan(span);
}

export function completeDiagramFact(edge: CodeGraphEdge, sourceId: string, targetId: string): Fact | undefined {
  return edge.id &&
    hasDiagramSourceSpan(edge.evidencePath, edge.evidenceSpan) &&
    (edge.provenance === 'declared' || edge.provenance === 'resolved' || edge.provenance === 'syntactic')
    ? {...edge, sourceId, targetId, provenance: edge.provenance}
    : undefined;
}

function completeSequence(facts: readonly Fact[]): readonly Fact[] | undefined {
  if (!facts.length || Arr.some(facts, edge => edge.relation !== 'calls')) return undefined;
  const outgoing = new Map(Arr.map(facts, edge => [edge.sourceId, edge] as const));
  const targets = new Set(Arr.map(facts, edge => edge.targetId));
  if (outgoing.size !== facts.length || targets.size !== facts.length) return undefined;
  const starts = Arr.filter([...outgoing.keys()], id => !targets.has(id));
  if (starts.length !== 1) return undefined;
  const path: Fact[] = [];
  let edge = outgoing.get(starts[0]);
  while (edge) {
    outgoing.delete(edge.sourceId);
    path.push(edge);
    edge = outgoing.get(edge.targetId);
  }
  return path.length === facts.length ? path : undefined;
}

function canRepresentClassDiagram(facts: readonly Fact[], nodes: ReadonlyMap<string, CodeGraphQueryNode>): boolean {
  const representedMembers = new Set<string>();
  return (
    facts.length > 0 &&
    Arr.every(facts, edge => {
      const source = nodes.get(edge.sourceId);
      const target = nodes.get(edge.targetId);
      if (!source || !target || !isDiagramTypeKind(source.kind)) return false;
      if (isDiagramTypeKind(target.kind)) return true;
      if (
        !isDiagramOwnershipRelation(edge.relation) ||
        !isDiagramMemberKind(target.kind) ||
        representedMembers.has(edge.targetId)
      )
        return false;
      representedMembers.add(edge.targetId);
      return true;
    })
  );
}

function canRepresentArchitectureDiagram(
  facts: readonly Fact[],
  nodes: ReadonlyMap<string, CodeGraphQueryNode>,
  boundaryIds: ReadonlySet<string>,
): boolean {
  const representedPairs = new Set<string>();
  const endpoint = (id: string) => boundaryIds.has(id) || isDiagramComponentKind(nodes.get(id)?.kind ?? '');
  return (
    facts.length > 0 &&
    Arr.every(facts, edge => {
      const pair = JSON.stringify([edge.sourceId, edge.targetId]);
      if (
        (!diagramArchitectureRelations.has(edge.relation) && !isDiagramOwnershipRelation(edge.relation)) ||
        !endpoint(edge.sourceId) ||
        !endpoint(edge.targetId) ||
        representedPairs.has(pair)
      )
        return false;
      representedPairs.add(pair);
      return true;
    })
  );
}

export function renderCompleteCodeGraphDiagram(input: {
  readonly question: CodeGraphDiagramQuestion;
  readonly scope: CodeGraphDiagramScope;
  readonly freshness: CodeGraphDiagramFreshness;
  readonly coverage: CodeGraphDiagramCoverage;
  readonly nodes: ReadonlyMap<string, CodeGraphQueryNode>;
  readonly boundaryIds: ReadonlySet<string>;
  readonly facts: readonly Fact[];
}): CodeGraphDiagramResult {
  const {question, scope, freshness, coverage, nodes, boundaryIds, facts} = input;
  const limits = freshness === 'current' ? [] : [`Snapshot freshness is ${freshness}.`];
  const base = {scope, freshness, coverage, limits};
  const classFit = question.domain === 'types' && canRepresentClassDiagram(facts, nodes);
  const architectureFit =
    question.domain === 'architecture' && canRepresentArchitectureDiagram(facts, nodes, boundaryIds);
  const sequence = completeSequence(facts);
  const suitable =
    question.domain === 'types' && classFit
      ? 'class'
      : question.domain === 'architecture' && architectureFit
        ? 'architecture'
        : question.preferred === 'sequence' && sequence
          ? 'sequence'
          : 'flowchart';
  const diagramType = question.explicitType ?? suitable;
  const fits =
    diagramType === 'class'
      ? classFit
      : diagramType === 'architecture'
        ? architectureFit
        : diagramType === 'sequence'
          ? sequence !== undefined && coverage.completeness === 'complete'
          : true;
  const build = (type: DiagramType) => {
    const drawn = type === 'sequence' ? sequence! : facts;
    const ids = new Set<string>();
    if (type !== 'sequence' && coverage.subject) ids.add(coverage.subject.id);
    for (const edge of drawn) {
      ids.add(edge.sourceId);
      ids.add(edge.targetId);
    }
    const evidenceNodes = Arr.map([...ids], (id, index) => ({
      ...completeDiagramSubject(nodes.get(id)!),
      diagramId: `n${index + 1}`,
      ...(boundaryIds.has(id) ? {evidenceKind: 'boundary' as const} : {}),
    }));
    const diagramIds = new Map(Arr.map(evidenceNodes, node => [node.id, node.diagramId] as const));
    const edges = Arr.map(drawn, edge => ({
      id: edge.id,
      source: diagramIds.get(edge.sourceId)!,
      target: diagramIds.get(edge.targetId)!,
      relation: edge.relation,
      provenance: edge.provenance,
      path: edge.evidencePath,
      span: edge.evidenceSpan,
    }));
    const groups = type === 'flowchart' || type === 'architecture' ? groupNodes(evidenceNodes, nodes, drawn, true) : [];
    const evidence = {nodes: evidenceNodes, edges, groups};
    return {diagramType: type, source: sourceFor(type, evidence, true), inferred: type === 'sequence', evidence};
  };
  if (coverage.completeness === 'incomplete') {
    const interrupted = Arr.some(coverage.gaps, gap => gap.kind === 'interrupted');
    return {
      ...base,
      status: 'incomplete',
      message: interrupted
        ? 'The graph read stopped before it could establish complete coverage.'
        : 'The selected snapshot has gaps in the evidence for this subject.',
      nextAction: interrupted
        ? 'Retry the diagram for the same subject and graph view.'
        : 'Check the listed source locations or name a subject within the available graph evidence.',
      ...(coverage.subject && facts.length ? {diagram: build(fits ? diagramType : 'flowchart')} : {}),
    };
  }
  if (!fits) {
    return {
      ...base,
      status: 'unavailable',
      message:
        diagramType === 'sequence'
          ? 'Static evidence does not establish a single ordered call path.'
          : `A ${diagramType} diagram cannot represent every relationship for this subject.`,
      nextAction: 'Request a flowchart for the full relationship evidence.',
      suggestedType: 'flowchart',
    };
  }
  if (diagramType === 'sequence') limits.push('The sequence shows an inferred path from static calls.');
  return {...base, status: 'diagram', ...build(diagramType)};
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
