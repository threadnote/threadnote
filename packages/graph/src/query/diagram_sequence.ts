import {Array as Arr, Schema, String as Str} from 'effect';
import type * as ts from 'typescript/ast';
import {collectLocalBindings, relationshipExpressionName, spanFor} from '../extractor_syntax.js';
import {
  NativeTypeScriptUnavailable,
  TYPESCRIPT_FULL_TRAVERSAL_CHARACTER_LIMIT,
  withNativeTypeScriptExtractionSource,
  type NativeTypeScriptAst,
  type NativeTypeScriptExtractionSession,
} from '../typescript_runtime.js';
import type {CodeGraphQueryNode, CodeGraphSpan} from '../types.js';
import type {CodeGraphDiagramFact} from './diagram.js';
import {CodeGraphDiagramGapSchema, type CodeGraphDiagramCoverage} from './diagram_contract.js';

interface SequenceInput {
  readonly subject: CodeGraphQueryNode;
  readonly facts: readonly CodeGraphDiagramFact[];
  readonly nodes: ReadonlyMap<string, CodeGraphQueryNode>;
  readonly sources: ReadonlyMap<string, Uint8Array>;
  readonly gaps: CodeGraphDiagramCoverage['gaps'];
}

type Compiler = NativeTypeScriptAst;
type Execution = 'invoked' | 'awaited' | 'yielded';
type SequenceGap = CodeGraphDiagramCoverage['gaps'][number];
/** TypeScript 7 has no OptionalChain alias; these are the node kinds that carry the optional-chain flag. */
type OptionalChain =
  ts.PropertyAccessExpression | ts.ElementAccessExpression | ts.CallExpression | ts.NonNullExpression;

const Span = Schema.Struct({line: Schema.Int, column: Schema.Int, endLine: Schema.Int, endColumn: Schema.Int});
const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));

/**
 * The verified subject source and only the evidence the projection reads. It is plain JSON, so a parser worker that
 * borrows the shared native session can project it outside the caller process.
 */
export const CodeGraphSourceSequenceRequestSchema = Schema.Struct({
  subject: Schema.Struct({path: Schema.String, span: Span, qualifiedName: Schema.String}),
  text: Schema.String,
  calls: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      relation: Schema.Literals(['calls', 'constructs']),
      sourceId: Schema.String,
      sourceName: Schema.String,
      targetId: Schema.String,
      targetName: Schema.String,
      evidencePath: Schema.String,
      evidenceSpan: Span,
    }),
  ),
  nodes: Schema.Array(Schema.Struct({id: Schema.String, path: Schema.String, qualifiedName: Schema.String})),
  gaps: Schema.Array(CodeGraphDiagramGapSchema),
});
export type CodeGraphSourceSequenceRequest = typeof CodeGraphSourceSequenceRequestSchema.Type;

export const CodeGraphSourceSequenceSchema = Schema.Struct({
  source: Schema.String,
  orderedCalls: Count,
  unorderedCalls: Count,
  discoveredGaps: Schema.Array(CodeGraphDiagramGapSchema),
  lifelines: Schema.Array(Schema.Struct({diagramId: Schema.String, path: Schema.String, label: Schema.String})),
  hasControls: Schema.Boolean,
});
type SourceSequence = typeof CodeGraphSourceSequenceSchema.Type;
export type CodeGraphSourceSequence = SourceSequence;

/**
 * `projected` carries the projection, or none when source does not support one (the caller keeps the graph path).
 * `unavailable` means no native TypeScript session parsed the source in time; the diagram reports that gap.
 */
export const CodeGraphSourceSequenceOutcomeSchema = Schema.Union([
  Schema.Struct({status: Schema.Literal('projected'), sequence: Schema.optionalKey(CodeGraphSourceSequenceSchema)}),
  Schema.Struct({status: Schema.Literal('unavailable')}),
]);
export type CodeGraphSourceSequenceOutcome = typeof CodeGraphSourceSequenceOutcomeSchema.Type;

function spanKey(span: CodeGraphSpan): string {
  return `${span.line}:${span.column}:${span.endLine}:${span.endColumn}`;
}

function label(value: string, fallback: string): string {
  const safe = Str.trim(Str.replace(/[^\p{L}\p{M}\p{N} ./_-]+/gu, ' ')(value));
  return safe && !/^end$/iu.test(safe) ? safe : fallback;
}

function effectImports(compiler: Compiler, file: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of file.statements) {
    if (!compiler.isImportDeclaration(statement) || !compiler.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause;
    if (!bindings || bindings.phaseModifier === compiler.SyntaxKind.TypeKeyword || !bindings.namedBindings) continue;
    if (statement.moduleSpecifier.text === 'effect' && compiler.isNamedImports(bindings.namedBindings)) {
      for (const specifier of bindings.namedBindings.elements) {
        if (!specifier.isTypeOnly && (specifier.propertyName ?? specifier.name).text === 'Effect')
          names.add(specifier.name.text);
      }
    }
    if (statement.moduleSpecifier.text === 'effect/Effect' && compiler.isNamespaceImport(bindings.namedBindings))
      names.add(bindings.namedBindings.name.text);
  }
  return names;
}

/** TypeScript 7 spellings of the TypeScript 5 syntax predicates this projection used. */
function syntax(compiler: Compiler) {
  const isOptionalChain = (node: ts.Node): node is OptionalChain =>
    (compiler.isPropertyAccessExpression(node) ||
      compiler.isElementAccessExpression(node) ||
      compiler.isCallExpression(node) ||
      compiler.isNonNullExpression(node)) &&
    (node.flags & compiler.NodeFlags.OptionalChain) !== 0;
  return {
    isOptionalChain,
    isCallChain: (node: ts.Node): node is ts.CallExpression => compiler.isCallExpression(node) && isOptionalChain(node),
    isElementAccessChain: (node: ts.Node): node is ts.ElementAccessExpression =>
      compiler.isElementAccessExpression(node) && isOptionalChain(node),
    isClassLike: (node: ts.Node) => compiler.isClassDeclaration(node) || compiler.isClassExpression(node),
    isIterationStatement: (node: ts.Node) =>
      compiler.isForStatement(node) ||
      compiler.isForOfStatement(node) ||
      compiler.isForInStatement(node) ||
      compiler.isWhileStatement(node) ||
      compiler.isDoStatement(node),
  };
}

/** Prepare the JSON request from verified bytes, or nothing when the subject source cannot be projected. */
export function codeGraphSourceSequenceRequest(input: SequenceInput): CodeGraphSourceSequenceRequest | undefined {
  const bytes = input.sources.get(input.subject.path);
  if (!bytes || !/\.[cm]?[jt]sx?$/iu.test(input.subject.path)) return undefined;
  let text: string;
  try {
    text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    return undefined;
  }
  if (text.length > TYPESCRIPT_FULL_TRAVERSAL_CHARACTER_LIMIT) return undefined;
  const calls = Arr.flatMap(input.facts, fact =>
    fact.relation === 'calls' || fact.relation === 'constructs'
      ? [
          {
            id: fact.id,
            relation: fact.relation,
            sourceId: fact.sourceId,
            sourceName: fact.sourceName,
            targetId: fact.targetId,
            targetName: fact.targetName,
            evidencePath: fact.evidencePath,
            evidenceSpan: fact.evidenceSpan,
          },
        ]
      : [],
  );
  const nodeIds = new Set(Arr.flatMap(calls, call => [call.sourceId, call.targetId]));
  const nodes = Arr.flatMap([...input.nodes.values()], node =>
    nodeIds.has(node.id) ? [{id: node.id, path: node.path, qualifiedName: node.qualifiedName}] : [],
  );
  return {
    subject: {path: input.subject.path, span: input.subject.span, qualifiedName: input.subject.qualifiedName},
    text,
    calls,
    nodes,
    gaps: Arr.filter(input.gaps, gap => gap.path === input.subject.path && gap.span !== undefined),
  };
}

/**
 * Project source order inside verified execution scopes with a borrowed native session. The caller retains the full
 * graph evidence. A session failure rejects with `NativeTypeScriptUnavailable`; source the projection cannot support
 * resolves to `undefined`.
 */
export async function projectCodeGraphSourceSequence(
  request: CodeGraphSourceSequenceRequest,
  session: NativeTypeScriptExtractionSession,
): Promise<SourceSequence | undefined> {
  try {
    return await withNativeTypeScriptExtractionSource(
      {path: request.subject.path, content: request.text},
      session,
      (file, diagnostics) => (diagnostics.length ? undefined : projectSource(request, session.ast, file)),
    );
  } catch (error) {
    if (Schema.is(NativeTypeScriptUnavailable)(error)) throw error;
    return undefined;
  }
}

/** In-process form for callers that already hold verified bytes and a borrowed session. */
export function renderSourceBackedSequence(
  input: SequenceInput,
  session: NativeTypeScriptExtractionSession,
): Promise<SourceSequence | undefined> {
  const request = codeGraphSourceSequenceRequest(input);
  return request === undefined ? Promise.resolve(undefined) : projectCodeGraphSourceSequence(request, session);
}

function projectSource(
  input: CodeGraphSourceSequenceRequest,
  compiler: Compiler,
  file: ts.SourceFile,
): SourceSequence | undefined {
  const {isOptionalChain, isCallChain, isElementAccessChain, isClassLike, isIterationStatement} = syntax(compiler);
  const bindings = collectLocalBindings(compiler, file);
  const imports = effectImports(compiler, file);
  const span = (node: ts.Node) => spanFor(file, node.getStart(file), node.end);
  const isEffectCall = (node: ts.Expression, method: string): boolean => {
    if (!compiler.isCallExpression(node) || !compiler.isPropertyAccessExpression(node.expression)) return false;
    const {expression: receiver, name} = node.expression;
    return (
      name.text === method &&
      compiler.isIdentifier(receiver) &&
      imports.has(receiver.text) &&
      relationshipExpressionName(compiler, receiver, bindings) === receiver.text
    );
  };
  const functionBody = (expression: ts.Node | undefined): ts.ConciseBody | undefined =>
    expression && (compiler.isArrowFunction(expression) || compiler.isFunctionExpression(expression))
      ? expression.body
      : undefined;
  const subjectSpan = spanKey(input.subject.span);
  const findSubject = (node: ts.Node): ts.ConciseBody | undefined => {
    let body: ts.ConciseBody | undefined;
    if (spanKey(span(node)) === subjectSpan) {
      if (compiler.isFunctionDeclaration(node) || compiler.isMethodDeclaration(node)) body = node.body;
      if (compiler.isVariableDeclaration(node) && node.initializer) {
        const initializer = node.initializer;
        body = functionBody(initializer);
        if (compiler.isCallExpression(initializer) && isEffectCall(initializer.expression, 'fn')) {
          body = functionBody(initializer.arguments[0]);
        }
      }
    }
    return body ?? node.forEachChild(findSubject);
  };
  const rootBody = findSubject(file);
  if (!rootBody) return undefined;
  const nodeById = new Map(Arr.map(input.nodes, node => [node.id, node] as const));
  const calls = input.calls;
  const sites = new Map<string, CodeGraphSourceSequenceRequest['calls'][number][]>();
  for (const call of calls) {
    if (call.evidencePath !== input.subject.path) continue;
    const key = spanKey(call.evidenceSpan);
    const group = sites.get(key) ?? [];
    group.push(call);
    sites.set(key, group);
  }
  const existingGaps = new Map<string, SequenceGap>();
  for (const gap of input.gaps) {
    if (gap.path === input.subject.path && gap.span) existingGaps.set(spanKey(gap.span), gap);
  }
  const discoveredGaps = new Map<string, SequenceGap>();
  const unresolvedActor = Symbol('Unresolved target');
  const actors = new Map<string | symbol, string>();
  const actor = (path: string | symbol) => {
    const existing = actors.get(path);
    if (existing) return existing;
    const id = `p${actors.size + 1}`;
    actors.set(path, id);
    return id;
  };
  const rootActor = actor(input.subject.path);
  const ordered = new Set<string>();
  const deferredBodies = new Map<ts.ConciseBody, string>();
  const at = (node: ts.Node) => `line ${span(node).line}`;
  const note = (message: string) => `  Note over ${rootActor}: ${message}`;
  const frameLines = (header: string, body: readonly string[]) =>
    body.length ? [`  ${header}`, ...body, '  end'] : [];
  const alternatives = (condition: string, yes: readonly string[], no: readonly string[]) => {
    if (!yes.length && !no.length) return [];
    return no.length
      ? [
          `  alt ${condition}`,
          ...(yes.length ? yes : [note('No shown calls in this branch')]),
          '  else Otherwise',
          ...no,
          '  end',
        ]
      : frameLines(`opt ${condition}`, yes);
  };
  const propertyPath = (node: ts.Expression): string => {
    if (compiler.isIdentifier(node)) return node.text;
    if (!compiler.isPropertyAccessExpression(node)) return '';
    const parent = propertyPath(node.expression);
    return parent ? `${parent}.${node.name.text}` : '';
  };
  const deferredLabel = (node: ts.CallExpression): string => {
    const parent = node.parent;
    if (compiler.isCallExpression(parent)) {
      const consumer = label(propertyPath(parent.expression), '');
      if (consumer) return `${consumer} effect body at ${at(node)}`;
    }
    return `Effect body at ${at(node)}`;
  };
  const predicate = (condition: ts.Expression): string => {
    const node = compiler.isBinaryExpression(condition) ? condition.left : condition;
    const name = label(propertyPath(node), '');
    return name ? `${name} condition at ${at(condition)}` : `Condition at ${at(condition)}`;
  };
  const orderCall = (
    node: ts.CallExpression | ts.NewExpression,
    execution: Execution,
    knownEffectWrapper = false,
  ): readonly string[] => {
    const key = spanKey(span(node));
    const facts = sites.get(key) ?? [];
    if (facts.length === 1) {
      const fact = facts[0];
      if (ordered.has(fact.id)) return [];
      if (fact.relation !== (compiler.isNewExpression(node) ? 'constructs' : 'calls')) return [];
      const source = nodeById.get(fact.sourceId);
      const target = nodeById.get(fact.targetId);
      if (!source || !target) return [];
      ordered.add(fact.id);
      return [
        `  %% Indexed call ${label(fact.id, 'evidence')}`,
        `  ${actor(source.path)}->>${actor(target.path)}: ${label(target.qualifiedName, 'Indexed target')} ${execution} at ${at(node)}`,
      ];
    }
    if (facts.length || execution === 'invoked' || knownEffectWrapper) return [];
    const expression = node.expression;
    if (!compiler.isIdentifier(expression) && !compiler.isPropertyAccessExpression(expression)) return [];
    const name = compiler.isIdentifier(expression) ? expression.text : expression.name.text;
    const gap = existingGaps.get(key);
    if (!gap) {
      discoveredGaps.set(key, {
        kind: 'unresolved-target',
        path: input.subject.path,
        span: span(node),
        label: label(propertyPath(expression) || name, 'Call'),
      });
    }
    if (!gap?.edgeId || gap.kind !== 'unresolved-target')
      return [note(`${label(name, 'Call')} ${execution} at ${at(node)}. Target identity is unknown`)];
    return [
      `  %% Unresolved call ${label(gap.edgeId, 'source gap')}`,
      `  ${rootActor}->>${actor(unresolvedActor)}: ${label(name, 'Dynamic call')} ${execution} at ${at(node)}`,
    ];
  };

  const loopExits = new WeakMap<ts.Node, boolean>();
  const scopeExits = new WeakMap<ts.Node, boolean>();
  const exits = (node: ts.Node, insideLoop = false): boolean => {
    if (compiler.isFunctionLikeDeclaration(node) || isClassLike(node)) return false;
    if (compiler.isReturnStatement(node) || compiler.isThrowStatement(node)) return true;
    if (compiler.isBreakStatement(node) || compiler.isContinueStatement(node))
      return !insideLoop || node.label !== undefined;
    const summaries = insideLoop ? loopExits : scopeExits;
    const previous = summaries.get(node);
    if (previous !== undefined) return previous;
    const nested = insideLoop || isIterationStatement(node);
    const result = node.forEachChild(child => (exits(child, nested) ? true : undefined)) ?? false;
    summaries.set(node, result);
    return result;
  };

  const visitBody = (body: ts.ConciseBody): readonly string[] => {
    if (!compiler.isBlock(body)) return visitExpression(body);
    const lines: string[] = [];
    let needsContinuation = false;
    let continuationCount = 0;
    for (const statement of body.statements) {
      const projected = visitStatement(statement);
      if (projected.length && needsContinuation) {
        lines.push(`  opt Control reaches ${at(statement)}`);
        needsContinuation = false;
        continuationCount++;
      }
      lines.push(...projected);
      if (
        compiler.isReturnStatement(statement) ||
        compiler.isThrowStatement(statement) ||
        compiler.isBreakStatement(statement) ||
        compiler.isContinueStatement(statement)
      )
        break;
      needsContinuation ||= exits(statement);
    }
    while (continuationCount-- > 0) lines.push('  end');
    return lines;
  };

  const visitOptionalChain = (
    node: OptionalChain,
    execution: Execution,
    continueChain: () => readonly string[],
  ): readonly string[] => {
    const visitStep = () => {
      const step = isCallChain(node)
        ? [...Arr.flatMap(node.arguments, argument => visitExpression(argument)), ...orderCall(node, execution)]
        : isElementAccessChain(node)
          ? visitExpression(node.argumentExpression)
          : [];
      const rest = [...step, ...continueChain()];
      return 'questionDotToken' in node && node.questionDotToken
        ? frameLines(`opt Optional chain continues at ${at(node)}`, rest)
        : rest;
    };
    return isOptionalChain(node.expression)
      ? visitOptionalChain(node.expression, 'invoked', visitStep)
      : [...visitExpression(node.expression), ...visitStep()];
  };

  const visitExpression = (node: ts.Expression, execution: Execution = 'invoked'): readonly string[] => {
    if (isOptionalChain(node)) return visitOptionalChain(node, execution, () => []);
    if (compiler.isParenthesizedExpression(node) || compiler.isAsExpression(node) || compiler.isNonNullExpression(node))
      return visitExpression(node.expression, execution);
    if (compiler.isAwaitExpression(node)) return visitExpression(node.expression, 'awaited');
    if (compiler.isYieldExpression(node))
      return node.expression ? visitExpression(node.expression, node.asteriskToken ? 'yielded' : 'invoked') : [];
    if (compiler.isConditionalExpression(node)) {
      return [
        ...visitExpression(node.condition),
        ...alternatives(
          predicate(node.condition),
          visitExpression(node.whenTrue, execution),
          visitExpression(node.whenFalse, execution),
        ),
      ];
    }
    if (compiler.isBinaryExpression(node)) {
      const {AmpersandAmpersandToken, BarBarToken, QuestionQuestionToken} = compiler.SyntaxKind;
      const shortCircuit = [AmpersandAmpersandToken, BarBarToken, QuestionQuestionToken].includes(
        node.operatorToken.kind,
      );
      const left = visitExpression(node.left);
      const right = visitExpression(node.right, execution);
      return [...left, ...(shortCircuit ? frameLines(`opt Right operand at ${at(node)}`, right) : right)];
    }
    if (compiler.isCallExpression(node) || compiler.isNewExpression(node)) {
      if (compiler.isCallExpression(node) && isEffectCall(node, 'gen')) {
        const body = functionBody(node.arguments[0]);
        if (body) {
          if (execution === 'yielded') return visitBody(body);
          const title = deferredLabel(node);
          deferredBodies.set(body, title);
          return [note(`${title} is a separate scope. Its execution time is unknown`)];
        }
      }
      const receiver = node.expression;
      const pipe = compiler.isPropertyAccessExpression(receiver) && receiver.name.text === 'pipe';
      const args = node.arguments ?? [];
      const yieldedBody =
        execution === 'yielded' &&
        pipe &&
        compiler.isCallExpression(receiver.expression) &&
        isEffectCall(receiver.expression, 'gen') &&
        Arr.every(
          args,
          argument =>
            isEffectCall(argument, 'onExit') ||
            isEffectCall(argument, 'provideService') ||
            isEffectCall(argument, 'catch'),
        )
          ? functionBody(receiver.expression.arguments[0])
          : undefined;
      if (yieldedBody)
        return [
          ...Arr.flatMap(args, argument => visitExpression(argument)),
          ...orderCall(node, execution, true),
          ...visitBody(yieldedBody),
        ];
      return [
        ...visitExpression(receiver),
        ...Arr.flatMap(args, argument => visitExpression(argument)),
        ...orderCall(node, execution),
      ];
    }
    if (compiler.isPropertyAccessExpression(node)) return visitExpression(node.expression);
    if (compiler.isElementAccessExpression(node))
      return [...visitExpression(node.expression), ...visitExpression(node.argumentExpression)];
    if (compiler.isArrayLiteralExpression(node)) return Arr.flatMap(node.elements, element => visitExpression(element));
    if (compiler.isObjectLiteralExpression(node)) {
      return Arr.flatMap(node.properties, property =>
        compiler.isPropertyAssignment(property)
          ? visitExpression(property.initializer)
          : compiler.isSpreadAssignment(property)
            ? visitExpression(property.expression)
            : [],
      );
    }
    if (compiler.isSpreadElement(node)) return visitExpression(node.expression);
    return [];
  };

  const visitStatement = (node: ts.Statement): readonly string[] => {
    if (compiler.isBlock(node)) return visitBody(node);
    if (compiler.isVariableStatement(node))
      return Arr.flatMap(node.declarationList.declarations, declaration =>
        declaration.initializer ? visitExpression(declaration.initializer) : [],
      );
    if (compiler.isExpressionStatement(node)) return visitExpression(node.expression);
    if (compiler.isIfStatement(node))
      return [
        ...visitExpression(node.expression),
        ...alternatives(
          predicate(node.expression),
          visitStatement(node.thenStatement),
          node.elseStatement ? visitStatement(node.elseStatement) : [],
        ),
      ];
    if (compiler.isReturnStatement(node) || compiler.isThrowStatement(node)) {
      const value = node.expression ? visitExpression(node.expression) : [];
      return [
        ...value,
        note(`${compiler.isReturnStatement(node) ? 'Return' : 'Throw'} at ${at(node)}. This scope exits`),
      ];
    }
    if (compiler.isBreakStatement(node) || compiler.isContinueStatement(node))
      return [note(`${compiler.isBreakStatement(node) ? 'Exit loop' : 'Next loop pass'} at ${at(node)}`)];
    if (
      compiler.isForStatement(node) ||
      compiler.isForOfStatement(node) ||
      compiler.isForInStatement(node) ||
      compiler.isWhileStatement(node) ||
      compiler.isDoStatement(node)
    ) {
      return frameLines(`loop Local iteration at ${at(node)}`, visitStatement(node.statement));
    }
    return [];
  };

  const timeline = [...visitBody(rootBody)];
  for (const [body, title] of deferredBodies) {
    const local = visitBody(body);
    if (!local.length) continue;
    timeline.push(note(`${title} when invoked. Its order relative to other scopes is unknown`));
    timeline.push(...frameLines('rect rgb(240, 244, 248)', local));
  }
  if (!ordered.size) {
    return discoveredGaps.size
      ? {
          source: '',
          orderedCalls: 0,
          unorderedCalls: calls.length,
          discoveredGaps: [...discoveredGaps.values()],
          lifelines: [],
          hasControls: false,
        }
      : undefined;
  }
  const unordered = new Map<string, {readonly id: string; readonly text: string}[]>();
  for (const fact of calls) {
    if (ordered.has(fact.id)) continue;
    const group = unordered.get(fact.evidencePath) ?? [];
    const source = nodeById.get(fact.sourceId)?.qualifiedName ?? fact.sourceName;
    const target = nodeById.get(fact.targetId)?.qualifiedName ?? fact.targetName;
    group.push({
      id: fact.id,
      text: `${label(source, 'Indexed source')} ${fact.relation} ${label(target, 'Indexed target')} at line ${fact.evidenceSpan.line}`,
    });
    unordered.set(fact.evidencePath, group);
  }
  const lifelines = Arr.flatMap([...actors], ([path, diagramId]) =>
    typeof path === 'string' ? [{diagramId, path, label: label(path, diagramId)}] : [],
  );
  return {
    source: Arr.join(
      [
        'sequenceDiagram',
        ...Arr.map(
          [...actors],
          ([path, id]) => `  participant ${id} as ${typeof path === 'string' ? label(path, id) : 'Unresolved target'}`,
        ),
        note(`Source order within each execution scope of ${label(input.subject.qualifiedName, 'selected subject')}`),
        ...timeline,
        ...Arr.flatMap([...unordered], ([path, rows]) => [
          '  %% Evidence IDs for the following note, in row order',
          ...Arr.map(rows, row => `  %% ${label(row.id, 'evidence')}`),
          note(
            `Unordered indexed relationships in ${label(path, 'source file')}<br/>${Arr.join(
              Arr.map(rows, row => row.text),
              '<br/>',
            )}`,
          ),
        ]),
      ],
      '\n',
    ),
    orderedCalls: ordered.size,
    unorderedCalls: calls.length - ordered.size,
    discoveredGaps: [...discoveredGaps.values()],
    lifelines,
    hasControls: Arr.some(timeline, line => /^ {2}(?:alt|opt|loop|par|break)\b/u.test(line)),
  };
}
