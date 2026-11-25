import {Array as Arr, Option, String as Str} from 'effect';
import {codeGraphSymbolPathClass, codeGraphSymbolPathScoreMultiplier} from '../store/query/core.js';
import {isStableCodeGraphNodeId, parseCodeGraphEndpointSelector} from './selector.js';
import type {CodeGraphEdge, CodeGraphQueryNode, CodeGraphRelation, CodeGraphSpan} from '../types.js';
import {renderSourceBackedSequence} from './diagram_sequence.js';
import {CODE_GRAPH_DIAGRAM_QUESTION_MAXIMUM_LENGTH} from './diagram_contract.js';
import type {
  CodeGraphDiagramCoverage,
  CodeGraphDiagramFreshness,
  CodeGraphDiagramResult,
  CodeGraphDiagramScope,
  CodeGraphDiagramType,
} from './diagram_contract.js';

export const DIAGRAM_PROJECT_RETRY =
  'Retry the same question in a graph view or configured project that includes the implementation.';

const SUBJECT_TERMS = /(?:\.\/?)*[\p{L}\p{N}_$@](?:[\p{L}\p{M}\p{N}_$@./#:-]|\u{200C}|\u{200D})*/gu;
const QUOTED_SUBJECT_TERMS =
  /"[^"\r\n]*"|(?<![\p{L}\p{M}\p{N}_$@])'[^'\r\n]*'|\x60[^\x60\r\n]*\x60|(?:\.\/?)*[\p{L}\p{N}_$@](?:[\p{L}\p{M}\p{N}_$@./#:-]|\u{200C}|\u{200D})*/gu;
const QUESTION_WORDS = new Set(
  Str.split(' ')(
    'a about and are architecture as call calls callpath chain class classes code component components connect connected dependency dependencies diagram do does draw explain flow flowchart for from during give graph how i implement implements in inherit inherits interaction interface interfaces is it map me mermaid module modules of occur on order package packages path please project relate relates relationship relationships repository sequence show static structure the this to together type types use uses what when where which with work works',
  ),
);
const DIAGRAM_TYPES = new Set(['class', 'interface', 'struct', 'trait', 'type', 'type_alias', 'enum', 'protocol']);
const DIAGRAM_MEMBERS = new Set(['method', 'member', 'field', 'property', 'constructor', 'associated_type']);
const DIAGRAM_COMPONENTS = new Set([
  'component',
  'database',
  'resource',
  'service',
  'module',
  'package',
  'project',
  'target',
  'file',
  'config',
  'repository',
  'output',
]);
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

function subjectTerms(question: string): readonly string[] {
  const normalized = Str.replaceAll('\\', '/')(question);
  const tokens = Option.getOrElse(Str.match(QUOTED_SUBJECT_TERMS)(normalized), () => []);
  return Arr.flatMap(tokens, token => {
    if (!/^["'\x60]/u.test(token)) return [Str.replace(/[.:]+$/u, '')(token)];
    const phrase = Str.slice(1, -1)(token);
    if (isExplicitSelector(phrase)) return [phrase];
    const words = Option.getOrElse(Str.match(SUBJECT_TERMS)(phrase), () => []);
    return Arr.map(words, word => Str.replace(/[.:]+$/u, '')(word));
  });
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

const TEST_TOPIC = /^(?:test|spec|fixture|mock)$/u;

function isDiagramCallable(node: CodeGraphQueryNode): boolean {
  return (
    /^(?:(?:function|method)(?:[_a-z]+)?|constructor|macro|init|initializer|lambda|closure|callback)$/u.test(
      node.kind,
    ) ||
    (node.kind === 'variable' && /\bfunction\b|=>/u.test(node.signature ?? ''))
  );
}

export function diagramTopicSearchTerms(topic: readonly string[]): readonly string[] {
  const action = Option.getOrUndefined(Arr.findLast(topic, term => !TEST_TOPIC.test(term))) ?? topic.at(-1);
  if (action === 'search') return ['search', 'query'];
  if (action === 'query') return ['query', 'search'];
  // A specific compound topic can name the generation of an index.
  if (action === 'index' && Arr.filter(topic, term => !TEST_TOPIC.test(term)).length > 2)
    return ['index', 'generation'];
  return action === undefined ? [] : [action];
}

function topicRelevance(node: CodeGraphQueryNode, terms: readonly string[]): number {
  if (node.kind === 'module' || node.kind === 'file' || isDiagramTypeKind(node.kind)) return 0;
  const tests = Arr.some(terms, term => TEST_TOPIC.test(term));
  if (tests ? codeGraphSymbolPathClass(node.path) !== 'test' : !isDiagramCallable(node)) return 0;
  const actions = diagramTopicSearchTerms(terms);
  const name = words(node.name);
  const identity = [...name, ...words(node.qualifiedName)];
  const action = Option.getOrUndefined(Arr.findFirst(actions, term => identity.includes(term)));
  if (action === undefined) return 0;
  const packageWords = words(node.packageName ?? '');
  const context =
    actions[0] === 'index' && action === 'generation' ? identity : [...identity, ...packageWords, ...words(node.path)];
  const qualifiers = Arr.filter(terms, term => !actions.includes(term) && !TEST_TOPIC.test(term));
  if (!qualifiers.length || !Arr.every(qualifiers, term => context.includes(term))) return 0;
  const matched = Arr.map(terms, term => (term === actions[0] ? action : term));
  const local = Arr.filter(matched, term => packageWords.includes(term)).length;
  const density = Arr.filter(name, term => matched.includes(term)).length / Math.max(1, name.length);
  const entry = node.exported && !tests;
  const pathParts = Str.split('/')(node.path);
  const moduleName = Str.replace(/\.[^.]+$/u, '')(pathParts.at(-1) ?? '');
  const primaryModule =
    actions.includes(moduleName) && (pathParts.length === 1 || /^(?:src|lib)$/u.test(pathParts.at(-2) ?? ''));
  const entryScore = entry ? (primaryModule ? 10 : 2) : 0;
  return (
    (relevance(node, matched) + 2 * local + 3 * density + entryScore) *
    codeGraphSymbolPathScoreMultiplier(node.path, terms)
  );
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

function safeLabel(value: string, fallback: string): string {
  const safe = Str.replace(/[^\p{L}\p{M}\p{N} _.-]+/gu, ' ')(value);
  const label = Str.trim(Str.replace(/ +/gu, ' ')(safe));
  return !label || /^end$/iu.test(label) ? fallback : label;
}

function safeClassMemberLabel(value: string, fallback: string): string {
  return Str.replace(/^-/u, '−')(safeLabel(value, fallback));
}

function groupNodes(
  nodes: Diagram['evidence']['nodes'],
  byId: ReadonlyMap<string, CodeGraphQueryNode>,
  facts: readonly Fact[],
): Diagram['evidence']['groups'] {
  if (!Arr.some(facts, edge => diagramArchitectureRelations.has(edge.relation) || edge.relation === 'constructs')) {
    return [];
  }
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
    label,
    members,
  }));
}

function groupSequenceLifelines(
  nodes: Diagram['evidence']['nodes'],
  lifelines: NonNullable<ReturnType<typeof renderSourceBackedSequence>>['lifelines'],
): Diagram['evidence']['groups'] {
  const membersByFile = new Map<string, string[]>();
  for (const node of nodes) {
    const members = membersByFile.get(node.path) ?? [];
    members.push(node.diagramId);
    membersByFile.set(node.path, members);
  }
  return Arr.map(lifelines, ({diagramId, label, path}) => ({
    diagramId,
    label,
    members: membersByFile.get(path) ?? [],
  }));
}

function sourceFor(type: DiagramType, evidence: Diagram['evidence']): string {
  const {nodes, edges, groups} = evidence;
  const labels = new Map(Arr.map(nodes, node => [node.diagramId, safeLabel(node.label, node.diagramId)]));
  const flowNode = (id: string) => `  ${id}["${labels.get(id)}"]`;
  switch (type) {
    case 'architecture': {
      const membership = new Map(
        Arr.flatMap(groups, group => Arr.map(group.members, member => [member, group.diagramId] as const)),
      );
      const pairs = new Set<string>();
      const links = Arr.flatMap(edges, (edge, index) => {
        const pair = `${edge.source}-${edge.target}`;
        if (!pairs.has(pair)) {
          pairs.add(pair);
          return [`  ${edge.source}:R --> L:${edge.target}`];
        }
        // Mermaid uses the endpoint pair as the rendered edge ID.
        const route = `link${index + 1}`;
        return [`  junction ${route}`, `  ${edge.source}:R -- L:${route}`, `  ${route}:R --> L:${edge.target}`];
      });
      return Arr.join(
        [
          'architecture-beta',
          ...Arr.map(groups, group => `  group ${group.diagramId}[${safeLabel(group.label, group.diagramId)}]`),
          ...Arr.map(nodes, node => {
            const group = membership.get(node.diagramId);
            return `  service ${node.diagramId}[${labels.get(node.diagramId)}]${group ? ` in ${group}` : ''}`;
          }),
          ...links,
        ],
        '\n',
      );
    }
    case 'class': {
      const members = Arr.filter(nodes, node => isDiagramMemberKind(node.kind));
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
          ...Arr.flatMap(edges, edge =>
            edge.relation === 'calls' || edge.relation === 'constructs'
              ? [`  ${edge.source}->>${edge.target}: ${edge.relation}`]
              : [],
          ),
        ],
        '\n',
      );
    case 'flowchart': {
      const unresolved = new Set(
        Arr.flatMap(nodes, node => (node.evidenceKind === 'unresolved' ? [node.diagramId] : [])),
      );
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
          ...Arr.map(edges, edge =>
            unresolved.has(edge.target)
              ? `  ${edge.source} -.-> ${edge.target}`
              : `  ${edge.source} -->|${edge.relation}| ${edge.target}`,
          ),
        ],
        '\n',
      );
    }
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

const ARTICLE = /^(?:a|an|the)$/u;

function subjectAfter(tokens: readonly string[], index: number): number | undefined {
  const subject = ARTICLE.test(tokens[index] ?? '') ? index + 1 : index;
  return tokens[subject] === undefined ? undefined : subject;
}

function interrogativeSubjectIndex(tokens: readonly string[]): number | undefined {
  const [first, second, third] = tokens;
  if (/^(?:how|what)$/iu.test(first ?? '') && /^(?:do|does|did)$/iu.test(second ?? '')) return subjectAfter(tokens, 2);
  if (/^(?:who|what)$/iu.test(first ?? '') && /^calls?$/iu.test(second ?? '') && !/^occurs?$/iu.test(third ?? ''))
    return subjectAfter(tokens, 2);
  return undefined;
}

function explicitSubjectIndex(tokens: readonly string[]): number | undefined {
  const [first, second] = tokens;
  if (!first) return undefined;
  if (second === undefined) return 0;
  const interrogative = interrogativeSubjectIndex(tokens);
  if (interrogative !== undefined) return interrogative;
  if (tokens.length === 2 && /^(?:show|draw|explain|give)$/iu.test(first)) return 1;
  const preposition = tokens.at(ARTICLE.test(tokens.at(-2) ?? '') ? -3 : -2);
  return /^(?:for|from|of)$/iu.test(preposition ?? '') ? tokens.length - 1 : undefined;
}

function behaviorDirections(tokens: readonly string[], cueTokens: readonly string[]) {
  const separators = Arr.flatMap(tokens, (token, index) => (/^(?:and|or|then)$/iu.test(token) ? [index] : []));
  let start = 0;
  let incoming = false;
  let outgoing = false;
  for (const end of [...separators, tokens.length]) {
    const clause = tokens.slice(start, end);
    const subject = interrogativeSubjectIndex(clause);
    const prose = Arr.join(
      Arr.filter(cueTokens.slice(start, end), (token, index) => token !== '' && index !== subject),
      ' ',
    );
    if (
      /\b(?:incoming|upstream|callers?|called by|who calls|what calls(?!\s+occur\b)|(?:how|what) .{0,50}\breach(?:es)?|entry points? (?:to|for))\b/iu.test(
        prose,
      )
    ) {
      incoming = true;
    } else if (
      /^what (?:does|do|did) calls?\b|\b(?:works?|executes?|execution|triggers?|outgoing|downstream|step by step)\b/iu.test(
        prose,
      )
    ) {
      outgoing = true;
    }
    start = end + 1;
  }
  return {incoming, outgoing};
}

function pathOperand(tokens: readonly string[]): string | undefined {
  if (tokens.length === 1) return tokens[0];
  if (tokens.length === 2 && ARTICLE.test(tokens[0])) return tokens[1];
  return undefined;
}

function compoundTopic(tokens: readonly string[]): readonly string[] {
  if (!/^how$/iu.test(tokens[0] ?? '')) return [];
  const start = /^(?:do|does|did)$/iu.test(tokens[1] ?? '') ? 2 : 1;
  const end = Option.getOrUndefined(
    Arr.findFirstIndex(tokens, (token, index) => index >= start && /^works?$/iu.test(token)),
  );
  if (end === undefined) return [];
  const phrase = Arr.filter(
    tokens.slice(start, end),
    token => !/^(?:a|an|the|and|or|really|actually|please)$/iu.test(token),
  );
  if (phrase.length < 2 || Arr.some(phrase, token => /[./#:@_$]|[\p{Ll}\p{N}]\p{Lu}/u.test(token))) return [];
  return Arr.map(phrase, token => Str.replace(/^(test|spec|fixture|mock)s$/u, '$1')(Str.toLowerCase(token)));
}

const PATH_CUE = /(?:^| )(?:call (?:path|chain|order)|sequence(?: diagram)?(?: of (?:the )?calls)?)$/iu;

function requestedPath(tokens: readonly string[], cueTokens: readonly string[]) {
  const start = Option.getOrUndefined(
    Arr.findFirstIndex(cueTokens, (token, index) =>
      index === 0
        ? /^from$/iu.test(token)
        : /^(?:from|to)$/iu.test(token) && PATH_CUE.test(Arr.join(cueTokens.slice(0, index), ' ')),
    ),
  );
  if (start === undefined || Arr.some(tokens.slice(0, start), isExplicitSelector)) return undefined;
  if (/^to$/iu.test(cueTokens[start])) return {kind: 'malformed'} as const;
  const separator = Option.getOrUndefined(
    Arr.findFirstIndex(tokens, (token, index) => index > start && /^to$/iu.test(token)),
  );
  if (separator === undefined) return undefined;
  const fromTokens = tokens.slice(start + 1, separator);
  const trailing = tokens.slice(separator + 1);
  const toTokens = trailing.length > 1 && /^please$/iu.test(trailing.at(-1) ?? '') ? trailing.slice(0, -1) : trailing;
  const from = pathOperand(fromTokens);
  const to = pathOperand(toTokens);
  if ((!from && Arr.some(fromTokens, isExplicitSelector)) || (!to && Arr.some(toTokens, isExplicitSelector)))
    return undefined;
  return from && to ? ({kind: 'path', from, to} as const) : ({kind: 'malformed'} as const);
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
  // Keep token positions so a path cue cannot cross a selector.
  const cueTokens = Arr.map(tokens, (token, index) =>
    index !== explicitSubject && index !== object && !isExplicitSelector(token) && !/[./#:@]/u.test(token) ? token : '',
  );
  const cues = Arr.filter(cueTokens, Boolean);
  const prose = Arr.join(cues, ' ');
  const preferred = intent(cues);
  const explicitType = type === 'auto' ? undefined : type;
  const pathRequest = requestedPath(tokens, cueTokens);
  const path = pathRequest?.kind === 'path' ? pathRequest : undefined;
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
  const intentDomain =
    path !== undefined
      ? 'behavior'
      : structure
        ? 'types'
        : preferred === 'architecture' || /\b(?:dependencies|dependency|imports?|resources?)\b/iu.test(prose)
          ? 'architecture'
          : !behavior && explicitType === 'class'
            ? 'types'
            : 'behavior';
  const domain = path === undefined && explicitType === 'architecture' ? 'architecture' : intentDomain;
  const terms = Arr.filter(
    tokens,
    (term, index) =>
      index === explicitSubject ||
      (domain === 'types' && predicateIndex !== undefined && index === object) ||
      (!EVIDENCE_REQUEST_WORDS.has(Str.toLowerCase(term)) && (domain !== 'types' || index !== predicateIndex)),
  );
  const named =
    explicitSubject === undefined
      ? namedTerm(tokens, Arr.map(terms, Str.toLowerCase))
      : {spelling: tokens[explicitSubject], caseSensitive: true};
  const topic =
    intentDomain === 'behavior' && path === undefined && selectors.length === 0 ? compoundTopic(tokens) : [];
  const directions = behaviorDirections(tokens, cueTokens);
  const incoming = (domain === 'types' && predicateIndex !== undefined && inverse) || directions.incoming;
  const unanchoredNames =
    domain === 'behavior' &&
    path === undefined &&
    explicitSubject === undefined &&
    preferred === undefined &&
    !behavior &&
    !topic.length &&
    !selectors.length &&
    !Arr.some(tokens, token => /[./#:@]/u.test(token));
  return {
    selectors,
    terms,
    named,
    preferred,
    explicitType,
    domain,
    explicitBehavior: behavior || directions.outgoing,
    incoming: path === undefined && incoming,
    outgoingBehavior: directions.outgoing,
    inheritance,
    path,
    malformedPath: pathRequest?.kind === 'malformed',
    topic,
    unanchoredNames,
  } as const;
}

export type CodeGraphDiagramQuestion = ReturnType<typeof describeCodeGraphDiagramQuestion>;

export function diagramFileOverview(question: CodeGraphDiagramQuestion, node: CodeGraphQueryNode): boolean {
  return (
    question.domain === 'behavior' &&
    !question.explicitBehavior &&
    !question.incoming &&
    !question.path &&
    (node.kind === 'module' || node.kind === 'file') &&
    (question.selectors.length > 0 || Arr.some(question.terms, term => Str.replace(/^\.\//u, '')(term) === node.path))
  );
}

export function wantsSourceBackedSequence(question: CodeGraphDiagramQuestion): boolean {
  return (
    question.path === undefined &&
    question.domain === 'behavior' &&
    (question.explicitType ?? question.preferred) === 'sequence'
  );
}

export function rankCodeGraphDiagramTopicFallback(
  node: CodeGraphQueryNode,
  question: CodeGraphDiagramQuestion,
): readonly [number, number, number] | undefined {
  const pathClass = Arr.some(question.topic, term => TEST_TOPIC.test(term)) ? 'test' : 'implementation';
  return isDiagramCallable(node) &&
    namedMatch(node, question.named) === 2 &&
    codeGraphSymbolPathClass(node.path) === pathClass
    ? [3, 0, 0]
    : undefined;
}

export function diagramEndpoint(question: CodeGraphDiagramQuestion, selector: string): CodeGraphDiagramQuestion {
  return {
    ...question,
    selectors: isExplicitSelector(selector) ? [selector] : [],
    terms: [selector],
    named: {spelling: selector, caseSensitive: true},
    topic: [],
    unanchoredNames: false,
  };
}
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
  if (question.topic.length) {
    const topical = topicRelevance(node, question.topic);
    return topical > 0 ? [1, topical, role] : undefined;
  }
  if (named) return [3, match, role];
  if (exact || (exactPackage && node.kind === 'package')) return [2, match, role];
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

function quoteDiagramOperand(value: string): string | undefined {
  if (/\r|\n/u.test(value)) return undefined;
  const tokens = subjectTerms(value);
  if (tokens.length === 1 && tokens[0] === value) return value;
  for (const quote of ['"', "'", '`']) {
    if (!Str.includes(quote)(value)) return `${quote}${value}${quote}`;
  }
  return undefined;
}

export function diagramClarificationCandidate(
  question: CodeGraphDiagramQuestion,
  node: CodeGraphQueryNode,
  pathChoice?: {readonly role: 'from'} | {readonly role: 'to'; readonly source: CodeGraphQueryNode},
): Extract<CodeGraphDiagramResult, {status: 'clarification'}>['candidates'][number] {
  const candidate = completeDiagramSubject(node);
  const value = isStableCodeGraphNodeId(node.id) ? node.id : `${node.path}#${node.qualifiedName || node.name}`;
  const selector = isExplicitSelector(value) ? quoteDiagramOperand(value) : undefined;
  if (!selector) return candidate;

  let retryQuery: string;
  if (question.path && pathChoice) {
    const from =
      pathChoice.role === 'from'
        ? selector
        : isStableCodeGraphNodeId(pathChoice.source.id)
          ? pathChoice.source.id
          : quoteDiagramOperand(question.path.from);
    const to = pathChoice.role === 'to' ? selector : quoteDiagramOperand(question.path.to);
    if (!from || !to) return candidate;
    retryQuery = `from ${from} to ${to}`;
  } else {
    const overview = diagramFileOverview(question, node);
    const focus =
      question.domain === 'types'
        ? question.inheritance
          ? 'class diagram of inheritance'
          : 'class diagram'
        : question.domain === 'architecture'
          ? 'architecture'
          : question.preferred === 'sequence'
            ? `sequence diagram${overview ? '' : ' of calls'}`
            : overview
              ? 'diagram'
              : 'calls';
    const directions = [question.incoming ? 'incoming calls' : '', question.outgoingBehavior ? 'outgoing calls' : ''];
    const direction = Arr.join(Arr.filter(directions, Boolean), ' and ');
    retryQuery = `Show the ${focus} for ${selector}${direction ? ` with ${direction}` : ''}`;
  }
  return retryQuery.length <= CODE_GRAPH_DIAGRAM_QUESTION_MAXIMUM_LENGTH ? {...candidate, retryQuery} : candidate;
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
  const calls = Arr.filter(facts, edge => edge.relation === 'calls' || edge.relation === 'constructs');
  const first = calls[0];
  if (!first) return undefined;
  const outgoing = new Map(Arr.map(calls, edge => [edge.sourceId, edge] as const));
  const targets = new Set(Arr.map(calls, edge => edge.targetId));
  if (outgoing.size !== calls.length || targets.size !== calls.length) return undefined;
  const ownership = new Map<string, Fact[]>();
  for (const edge of facts) {
    if (edge.relation === 'calls' || edge.relation === 'constructs') continue;
    if (!isDiagramOwnershipRelation(edge.relation) || outgoing.get(edge.sourceId)?.targetId !== edge.targetId) {
      return undefined;
    }
    const attached = ownership.get(edge.sourceId) ?? [];
    attached.push(edge);
    ownership.set(edge.sourceId, attached);
  }
  if (calls.length === 1 && first.sourceId === first.targetId) return facts;
  const starts = Arr.filter([...outgoing.keys()], id => !targets.has(id));
  if (starts.length !== 1) return undefined;
  const path: Fact[] = [];
  let edge = outgoing.get(starts[0]);
  while (edge) {
    outgoing.delete(edge.sourceId);
    path.push(edge);
    edge = outgoing.get(edge.targetId);
  }
  return path.length === calls.length
    ? Arr.flatMap(path, edge => [edge, ...(ownership.get(edge.sourceId) ?? [])])
    : undefined;
}

function reachable(facts: readonly Fact[], start: string, reverse: boolean, terminal?: string): ReadonlySet<string> {
  const adjacency = new Map<string, string[]>();
  for (const edge of facts) {
    const source = reverse ? edge.targetId : edge.sourceId;
    const target = reverse ? edge.sourceId : edge.targetId;
    const adjacent = adjacency.get(source) ?? [];
    adjacent.push(target);
    adjacency.set(source, adjacent);
  }
  const visited = new Set([start]);
  for (const id of visited) {
    if (id === terminal) continue;
    for (const peer of adjacency.get(id) ?? []) visited.add(peer);
  }
  return visited;
}

export function selectDiagramPath(facts: readonly Fact[], from: string, to: string): readonly Fact[] {
  const terminal = from === to ? undefined : to;
  const forward = reachable(facts, from, false, terminal);
  if (!forward.has(to)) return [];
  const reverse = reachable(facts, to, true);
  return Arr.filter(
    facts,
    edge => edge.sourceId !== terminal && forward.has(edge.sourceId) && reverse.has(edge.targetId),
  );
}

function sequenceExample(
  facts: readonly Fact[],
  nodes: ReadonlyMap<string, CodeGraphQueryNode>,
  from: string,
): string | undefined {
  const direct = Arr.filter(
    facts,
    edge => edge.sourceId === from && edge.relation === 'calls' && edge.provenance === 'resolved',
  ).sort(
    (left, right) =>
      left.evidenceSpan.line - right.evidenceSpan.line || left.evidenceSpan.column - right.evidenceSpan.column,
  );
  const first = direct[0];
  if (!first || !completeSequence(selectDiagramPath(facts, from, first.targetId))) return undefined;
  const selector = (id: string) => {
    const node = nodes.get(id);
    if (
      !node ||
      !/^[\p{L}\p{M}\p{N} _./@-]+$/u.test(node.path) ||
      !/^[\p{L}\p{M}\p{N}_.$:-]+$/u.test(node.qualifiedName)
    )
      return undefined;
    const value = `${node.path}#${node.qualifiedName}`;
    return Str.includes(' ')(value) ? `"${value}"` : value;
  };
  const source = selector(from);
  const target = selector(first.targetId);
  return source && target ? `Show the call path from ${source} to ${target}` : undefined;
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
  const endpoint = (id: string) => boundaryIds.has(id) || isDiagramComponentKind(nodes.get(id)?.kind ?? '');
  return (
    facts.length > 0 &&
    Arr.every(
      facts,
      edge =>
        (diagramArchitectureRelations.has(edge.relation) || isDiagramOwnershipRelation(edge.relation)) &&
        endpoint(edge.sourceId) &&
        endpoint(edge.targetId),
    )
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
  readonly unresolvedCalls?: readonly Fact[];
  readonly sequenceSources?: ReadonlyMap<string, Uint8Array>;
  readonly architectureAnchor?: Fact;
  readonly pathTarget?: CodeGraphQueryNode;
}): CodeGraphDiagramResult {
  const {
    question,
    scope,
    freshness,
    nodes,
    boundaryIds,
    facts,
    architectureAnchor,
    pathTarget,
    sequenceSources,
    unresolvedCalls = [],
  } = input;
  const limits = freshness === 'current' ? [] : [`Snapshot freshness is ${freshness}.`];
  if (architectureAnchor) {
    limits.push(
      `The architecture shows direct dependencies of the containing module. The indexed ${architectureAnchor.relation} declaration is at ${architectureAnchor.evidencePath}:${architectureAnchor.evidenceSpan.line}.`,
    );
  }
  if (pathTarget)
    limits.push(
      `The diagram covers indexed paths to ${pathTarget.qualifiedName} at ${pathTarget.path}:${pathTarget.span.line}.`,
    );
  const subject = input.coverage.subject ? nodes.get(input.coverage.subject.id) : undefined;
  const sourceProjection =
    subject && sequenceSources?.size && wantsSourceBackedSequence(question)
      ? renderSourceBackedSequence({subject, facts, nodes, sources: sequenceSources, gaps: input.coverage.gaps})
      : undefined;
  const sequence = completeSequence(facts);
  const discoveredGaps = sourceProjection?.discoveredGaps ?? [];
  // Keep the simple linear path unless verified source adds control flow or exposes missing evidence.
  const sourceSequence =
    sourceProjection?.source &&
    sourceProjection.orderedCalls > 0 &&
    (sourceProjection.hasControls ||
      discoveredGaps.length > 0 ||
      sequence === undefined ||
      input.coverage.completeness !== 'complete')
      ? sourceProjection
      : undefined;
  const sourceGaps: CodeGraphDiagramCoverage['gaps'] = [
    ...discoveredGaps,
    ...(sourceSequence?.unorderedCalls
      ? [
          {
            kind: 'missing-evidence' as const,
            label: `Source does not establish the order of ${sourceSequence.unorderedCalls} indexed calls.`,
          },
        ]
      : []),
  ];
  const coverage: CodeGraphDiagramCoverage = sourceGaps.length
    ? {...input.coverage, completeness: 'incomplete', gaps: [...input.coverage.gaps, ...sourceGaps]}
    : input.coverage;
  const base = {scope, freshness, coverage, limits};
  const classFit = question.domain === 'types' && canRepresentClassDiagram(facts, nodes);
  const architectureFit =
    question.domain === 'architecture' && canRepresentArchitectureDiagram(facts, nodes, boundaryIds);
  const interrupted = Arr.some(coverage.gaps, gap => gap.kind === 'interrupted');
  const sequenceFit = sourceSequence !== undefined || (sequence !== undefined && !interrupted);
  const flowchartFacts = unresolvedCalls.length ? [...facts, ...unresolvedCalls] : facts;
  const suitable =
    question.domain === 'types' && classFit
      ? 'class'
      : question.domain === 'architecture' && architectureFit
        ? 'architecture'
        : (question.preferred === 'sequence' || pathTarget !== undefined) && sequenceFit
          ? 'sequence'
          : 'flowchart';
  const diagramType = question.explicitType ?? suitable;
  const fits =
    diagramType === 'class'
      ? classFit
      : diagramType === 'architecture'
        ? architectureFit
        : diagramType === 'sequence'
          ? sequenceFit
          : true;
  const unsupportedTypeMessage =
    diagramType === 'sequence'
      ? sequence === undefined
        ? 'Static evidence does not establish a single ordered call path.'
        : 'The graph read stopped before it could verify the indexed call path.'
      : `The ${diagramType} diagram cannot represent every relationship for this subject.`;
  const build = (type: DiagramType) => {
    const drawn = type === 'flowchart' ? flowchartFacts : type === 'sequence' && !sourceSequence ? sequence! : facts;
    const ids = new Set<string>();
    if ((type !== 'sequence' || sourceSequence) && coverage.subject)
      ids.add(architectureAnchor?.sourceId ?? coverage.subject.id);
    for (const edge of drawn) {
      ids.add(edge.sourceId);
      ids.add(edge.targetId);
    }
    const evidenceNodes = Arr.map([...ids], (id, index): Diagram['evidence']['nodes'][number] => {
      const node = nodes.get(id)!;
      const evidenceKind = node.kind === 'unresolved' ? 'unresolved' : boundaryIds.has(id) ? 'boundary' : undefined;
      return {
        ...completeDiagramSubject(node),
        diagramId: `n${index + 1}`,
        ...(evidenceKind === undefined ? {} : {evidenceKind}),
      };
    });
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
    const groups =
      type === 'sequence' && sourceSequence
        ? groupSequenceLifelines(evidenceNodes, sourceSequence.lifelines)
        : type === 'flowchart' || type === 'architecture'
          ? groupNodes(evidenceNodes, nodes, drawn)
          : [];
    const evidence = {nodes: evidenceNodes, edges, groups};
    const source = type === 'sequence' && sourceSequence ? sourceSequence.source : sourceFor(type, evidence);
    return {diagramType: type, source, inferred: type === 'sequence', evidence};
  };
  if (diagramType === 'sequence' && fits)
    limits.push(
      sourceSequence
        ? 'The sequence follows verified static source. Calls without proven order remain in the evidence.'
        : 'The sequence shows an inferred path from indexed calls.',
    );
  const example =
    diagramType === 'sequence' && !fits && !sequence && !pathTarget && coverage.subject
      ? sequenceExample(facts, nodes, coverage.subject.id)
      : undefined;
  const selectPath = pathTarget
    ? facts.length
      ? 'Select Flowchart to show relationships between the same endpoints.'
      : 'Choose an endpoint with an indexed path from the source.'
    : example
      ? `Select Sequence and ask "${example}". Select Flowchart for the current relationships.`
      : 'Name both endpoints of an indexed call path or select Flowchart for the available evidence.';
  const rejectsExplicitType = question.explicitType !== undefined && !fits;
  const canSuggestFlowchart = rejectsExplicitType && coverage.subject !== undefined && flowchartFacts.length > 0;
  const noClassEvidence =
    question.explicitType === 'class' &&
    coverage.subject !== undefined &&
    !interrupted &&
    (facts.length === 0 ||
      (question.domain === 'behavior' &&
        !isDiagramTypeKind(coverage.subject.kind) &&
        !isDiagramMemberKind(coverage.subject.kind)));
  const noClassMessage = 'The selected snapshot has no indexed structural relationships for this subject.';
  const missingInProject = facts.length === 0 && Arr.some(coverage.gaps, gap => gap.kind === 'partial-project');
  const noRelationships =
    coverage.subject !== undefined &&
    facts.length === 0 &&
    Arr.every(coverage.gaps, gap => gap.kind === 'missing-evidence');
  const classAction = canSuggestFlowchart
    ? 'Name a class or interface with indexed type relationships, or select Flowchart for the current relationships.'
    : 'Name a class or interface with indexed type relationships.';
  if (coverage.completeness === 'incomplete') {
    const gapMessage = interrupted
      ? 'The graph read stopped before it could establish complete coverage.'
      : missingInProject
        ? unresolvedCalls.length
          ? 'The selected graph project has partial coverage and no resolved relationships for this question.'
          : 'The selected graph project has partial coverage and no indexed relationships for this question.'
        : noClassEvidence
          ? noClassMessage
          : noRelationships
            ? 'The selected snapshot has no indexed relationships for this subject.'
            : 'The selected snapshot has gaps in the evidence for this subject.';
    const message =
      rejectsExplicitType && !noClassEvidence
        ? `${gapMessage} ${unsupportedTypeMessage}${canSuggestFlowchart ? ' A flowchart can show the available relationships.' : ''}`
        : gapMessage;
    return {
      ...base,
      status: 'incomplete',
      message,
      nextAction: interrupted
        ? 'Retry the diagram for the same subject and graph view.'
        : missingInProject
          ? DIAGRAM_PROJECT_RETRY
          : noClassEvidence
            ? classAction
            : question.explicitType === 'sequence' && !fits
              ? selectPath
              : canSuggestFlowchart
                ? 'Select Flowchart to show the available relationships.'
                : 'Check the listed source locations or name a subject within the available graph evidence.',
      ...(coverage.subject &&
      (diagramType === 'flowchart' ? flowchartFacts.length : facts.length) &&
      !rejectsExplicitType
        ? {diagram: build(diagramType)}
        : {}),
      ...(canSuggestFlowchart ? {suggestedType: 'flowchart' as const} : {}),
    };
  }
  if (!fits) {
    return {
      ...base,
      status: 'unavailable',
      message: noClassEvidence ? noClassMessage : unsupportedTypeMessage,
      nextAction:
        diagramType === 'sequence'
          ? selectPath
          : noClassEvidence
            ? classAction
            : 'Request a flowchart for the full relationship evidence.',
      suggestedType: 'flowchart',
    };
  }
  return {...base, status: 'diagram', ...build(diagramType)};
}
