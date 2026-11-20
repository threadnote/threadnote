import * as EffectRecord from 'effect/Record';
import type ts from 'typescript-compiler';
import {Array as EffectArray, Predicate} from 'effect';
import {collectBindingNames, spanFor} from './extractor_syntax.js';
import type {
  CodeGraphEdge,
  CodeGraphNavigationFacts,
  CodeGraphNavigationProof,
  CodeGraphSpan,
  CodeGraphSymbol,
} from './types.js';
export const CODE_GRAPH_NAVIGATION_FACT_VERSION = 1 as const;
export const CODE_GRAPH_NAVIGATION_PROOF_LIMIT = 32;
export const CODE_GRAPH_NAVIGATION_FACT_BYTES = 64 * 1024;
const encoder = new TextEncoder();
export function createNavigationFactCollector(
  compiler: typeof ts,
  source: ts.SourceFile,
  localBindings: ReadonlyMap<ts.Node, ReadonlySet<string>>,
) {
  let canonical: Map<string, ts.ImportDeclaration> | undefined;
  for (const statement of source.statements) {
    if (
      !compiler.isImportDeclaration(statement) ||
      !compiler.isStringLiteralLike(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== 'node:fs/promises'
    )
      continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly || !clause.namedBindings || !compiler.isNamedImports(clause.namedBindings))
      continue;
    for (const element of clause.namedBindings.elements)
      if (
        !element.isTypeOnly &&
        (element.propertyName?.text ?? element.name.text) === 'writeFile' &&
        element.name.text.length <= 256
      ) {
        canonical ??= new Map();
        canonical.set(element.name.text, statement);
      }
  }
  const imports = canonical;
  if (!imports) return undefined;
  const bindings = new Map<string, number>();
  const invalid = new Set<string>();
  const proofs: CodeGraphNavigationProof[] = [];
  const ownerGrammar = new WeakMap<ts.FunctionDeclaration, boolean>();
  let omitted = false;
  let bytes = 64;
  const bind = (name: ts.BindingName | undefined): void => {
    if (!name) return;
    if (compiler.isIdentifier(name)) {
      if (imports.has(name.text)) bindings.set(name.text, (bindings.get(name.text) ?? 0) + 1);
    } else for (const element of name.elements) if (!compiler.isOmittedExpression(element)) bind(element.name);
  };
  for (const statement of source.statements) {
    if (compiler.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      bind(clause?.name);
      if (clause?.namedBindings && compiler.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) bind(element.name);
      } else if (clause?.namedBindings && compiler.isNamespaceImport(clause.namedBindings))
        bind(clause.namedBindings.name);
    } else if (compiler.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) bind(declaration.name);
    } else if (
      compiler.isFunctionDeclaration(statement) ||
      compiler.isClassDeclaration(statement) ||
      compiler.isEnumDeclaration(statement) ||
      compiler.isInterfaceDeclaration(statement) ||
      compiler.isTypeAliasDeclaration(statement) ||
      compiler.isModuleDeclaration(statement) ||
      compiler.isImportEqualsDeclaration(statement)
    ) {
      if (statement.name && compiler.isIdentifier(statement.name)) bind(statement.name);
    }
  }
  for (const [name, count] of bindings) if (count !== 1) invalid.add(name);
  const simpleValue = (node: ts.Expression): boolean =>
    compiler.isIdentifier(node) ||
    compiler.isStringLiteralLike(node) ||
    compiler.isNumericLiteral(node) ||
    node.kind === compiler.SyntaxKind.TrueKeyword ||
    node.kind === compiler.SyntaxKind.FalseKeyword ||
    node.kind === compiler.SyntaxKind.NullKeyword;
  const variable = (statement: ts.Statement): boolean =>
    compiler.isVariableStatement(statement) &&
    EffectArray.every(
      statement.declarationList.declarations,
      declaration =>
        compiler.isIdentifier(declaration.name) &&
        (!declaration.initializer ||
          simpleValue(declaration.initializer) ||
          (compiler.isCallExpression(declaration.initializer) &&
            compiler.isIdentifier(declaration.initializer.expression) &&
            !declaration.initializer.questionDotToken &&
            EffectArray.every(declaration.initializer.arguments, simpleValue))),
    );
  const branch = (statement: ts.Statement): boolean => {
    if (compiler.isBlock(statement)) return EffectArray.every(statement.statements, branch);
    if (variable(statement)) return true;
    if (!compiler.isExpressionStatement(statement) || !compiler.isAwaitExpression(statement.expression)) return false;
    const call = statement.expression.expression;
    return (
      compiler.isCallExpression(call) &&
      compiler.isIdentifier(call.expression) &&
      imports.has(call.expression.text) &&
      !call.questionDotToken &&
      call.arguments.length >= 2 &&
      compiler.isIdentifier(call.arguments[0]) &&
      EffectArray.every(call.arguments, simpleValue)
    );
  };
  const supportedOwner = (fn: ts.FunctionDeclaration): boolean => {
    const cached = ownerGrammar.get(fn);
    if (cached !== undefined) return cached;
    let seenGuard = false;
    let allowed = fn.body !== undefined;
    const statements = fn.body?.statements ?? [];
    for (let index = 0; index < statements.length; index++) {
      const statement = statements[index];
      if (!seenGuard && variable(statement)) continue;
      if (!seenGuard && compiler.isIfStatement(statement) && compiler.isIdentifier(statement.expression)) {
        seenGuard = true;
        if (branch(statement.thenStatement) && (!statement.elseStatement || branch(statement.elseStatement))) continue;
      } else if (
        seenGuard &&
        compiler.isReturnStatement(statement) &&
        index === statements.length - 1 &&
        (!statement.expression || simpleValue(statement.expression))
      )
        continue;
      allowed = false;
      break;
    }
    allowed &&= seenGuard;
    ownerGrammar.set(fn, allowed);
    return allowed;
  };
  const invalidateAssignmentTarget = (node: ts.Node): void => {
    if (compiler.isIdentifier(node)) {
      if (imports.has(node.text)) invalid.add(node.text);
    } else compiler.forEachChild(node, invalidateAssignmentTarget);
  };
  const span = (node: ts.Node) => spanFor(source, node.getStart(source, false), node.getEnd());
  return {
    observe(node: ts.Node) {
      if (
        (compiler.isForOfStatement(node) || compiler.isForInStatement(node)) &&
        !compiler.isVariableDeclarationList(node.initializer)
      )
        invalidateAssignmentTarget(node.initializer);
      if (
        compiler.isBinaryExpression(node) &&
        node.operatorToken.kind >= compiler.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= compiler.SyntaxKind.LastAssignment
      )
        invalidateAssignmentTarget(node.left);
      if (
        (compiler.isPrefixUnaryExpression(node) || compiler.isPostfixUnaryExpression(node)) &&
        (node.operator === compiler.SyntaxKind.PlusPlusToken ||
          node.operator === compiler.SyntaxKind.MinusMinusToken) &&
        compiler.isIdentifier(node.operand)
      )
        if (imports.has(node.operand.text)) invalid.add(node.operand.text);
      if (
        compiler.isVariableDeclaration(node) &&
        compiler.isVariableDeclarationList(node.parent) &&
        !(node.parent.flags & compiler.NodeFlags.BlockScoped)
      ) {
        if (compiler.isIdentifier(node.name) && !imports.has(node.name.text)) return;
        let scope: ts.Node | undefined = node.parent;
        while (scope && !compiler.isFunctionLike(scope) && !compiler.isSourceFile(scope)) scope = scope.parent;
        if (scope && compiler.isSourceFile(scope) && node.parent.parent.parent !== source) {
          const names = new Set<string>();
          collectBindingNames(compiler, node.name, names);
          for (const name of names) if (imports.has(name)) invalid.add(name);
        }
      }
    },
    call(node: ts.CallExpression, owner: CodeGraphSymbol, edgeId: string) {
      if (!compiler.isIdentifier(node.expression) || node.questionDotToken || !imports.has(node.expression.text))
        return;
      if (proofs.length >= CODE_GRAPH_NAVIGATION_PROOF_LIMIT) {
        omitted = true;
        return;
      }
      for (let scope: ts.Node | undefined = node.parent; scope && !compiler.isSourceFile(scope); scope = scope.parent)
        if (localBindings.get(scope)?.has(node.expression.text)) return;
      const parent = node.parent;
      if (
        !compiler.isAwaitExpression(parent) ||
        !compiler.isExpressionStatement(parent.parent) ||
        node.arguments.length < 2 ||
        !compiler.isIdentifier(node.arguments[0])
      )
        return;
      let current: ts.Node = parent.parent;
      let guard: CodeGraphNavigationProof['guard'] | undefined;
      while (current.parent && !compiler.isFunctionLike(current.parent)) {
        const next = current.parent;
        if (compiler.isIfStatement(next) && compiler.isIdentifier(next.expression) && !guard) {
          const branch = next.thenStatement === current ? 'then' : next.elseStatement === current ? 'else' : undefined;
          if (!branch) return;
          guard = {span: span(next.expression), branch};
        } else if (!compiler.isBlock(next)) return;
        current = next;
      }
      const fn = current.parent;
      if (
        !guard ||
        !fn ||
        !compiler.isFunctionDeclaration(fn) ||
        fn.parent !== source ||
        !fn.name ||
        fn.name.text !== owner.name ||
        !fn.body ||
        fn.asteriskToken !== undefined ||
        !fn.modifiers ||
        !EffectArray.some(fn.modifiers, modifier => modifier.kind === compiler.SyntaxKind.AsyncKeyword)
      )
        return;
      if (!supportedOwner(fn)) return;
      const declaration = imports.get(node.expression.text)!;
      const proof: CodeGraphNavigationProof = {
        ownerId: owner.id,
        ownerSpan: owner.span,
        callEdgeId: edgeId,
        module: 'node:fs/promises',
        imported: 'writeFile',
        local: node.expression.text,
        importSpan: span(declaration),
        callSpan: span(node),
        calleeSpan: span(node.expression),
        targetSpan: span(node.arguments[0]),
        guard,
      };
      const size = encoder.encode(JSON.stringify(proof)).byteLength + 1;
      if (bytes + size > CODE_GRAPH_NAVIGATION_FACT_BYTES) {
        omitted = true;
        return;
      }
      bytes += size;
      proofs.push(proof);
    },
    finish(): CodeGraphNavigationFacts | undefined {
      return {
        version: CODE_GRAPH_NAVIGATION_FACT_VERSION,
        omitted,
        proofs: EffectArray.filter(proofs, proof => !invalid.has(proof.local)),
      };
    },
  };
}
export function closeNavigationFacts(
  facts: CodeGraphNavigationFacts | undefined,
  symbols: readonly CodeGraphSymbol[],
  edges: readonly CodeGraphEdge[],
): CodeGraphNavigationFacts | undefined {
  if (!facts) return undefined;
  const owners = new Set(EffectArray.map(symbols, symbol => symbol.id));
  const calls = new Map(EffectArray.map(edges, edge => [edge.id, edge] as const));
  const proofs = EffectArray.filter(
    facts.proofs,
    proof =>
      owners.has(proof.ownerId) &&
      calls.get(proof.callEdgeId)?.sourceId === proof.ownerId &&
      calls.get(proof.callEdgeId)?.relation === 'calls' &&
      calls.get(proof.callEdgeId)?.targetName === proof.local,
  );
  return proofs.length === facts.proofs.length ? facts : {...facts, proofs, omitted: true};
}
export function parseNavigationFacts(
  value: unknown,
  symbols: readonly CodeGraphSymbol[],
  edges: readonly CodeGraphEdge[],
): CodeGraphNavigationFacts {
  const object = record(value, ['version', 'omitted', 'proofs']);
  if (
    object.version !== CODE_GRAPH_NAVIGATION_FACT_VERSION ||
    typeof object.omitted !== 'boolean' ||
    !EffectArray.isArray(object.proofs) ||
    object.proofs.length > CODE_GRAPH_NAVIGATION_PROOF_LIMIT
  )
    throw new Error('Invalid navigation fact envelope.');
  const proofs = EffectArray.map(object.proofs, item => {
    const input = record(item, [
      'ownerId',
      'ownerSpan',
      'callEdgeId',
      'module',
      'imported',
      'local',
      'importSpan',
      'callSpan',
      'calleeSpan',
      'targetSpan',
      'guard',
    ]);
    const guard = record(input.guard, ['span', 'branch']);
    if (
      input.module !== 'node:fs/promises' ||
      input.imported !== 'writeFile' ||
      (guard.branch !== 'then' && guard.branch !== 'else')
    )
      throw new Error('Unsupported navigation proof.');
    const proof: CodeGraphNavigationProof = {
      ownerId: text(input.ownerId),
      ownerSpan: parseSpan(input.ownerSpan),
      callEdgeId: text(input.callEdgeId),
      module: input.module,
      imported: input.imported,
      local: text(input.local),
      importSpan: parseSpan(input.importSpan),
      callSpan: parseSpan(input.callSpan),
      calleeSpan: parseSpan(input.calleeSpan),
      targetSpan: parseSpan(input.targetSpan),
      guard: {span: parseSpan(guard.span), branch: guard.branch},
    };
    const owner = EffectArray.findFirst(symbols, symbol => symbol.id === proof.ownerId);
    if (
      owner._tag === 'None' ||
      owner.value.kind !== 'function' ||
      !sameSpan(owner.value.span, proof.ownerSpan) ||
      !contains(proof.ownerSpan, proof.callSpan) ||
      !contains(proof.callSpan, proof.calleeSpan) ||
      !contains(proof.callSpan, proof.targetSpan) ||
      !contains(proof.ownerSpan, proof.guard.span)
    )
      throw new Error('Navigation proof spans or owner are invalid.');
    return proof;
  });
  const facts = {version: CODE_GRAPH_NAVIGATION_FACT_VERSION, omitted: object.omitted, proofs};
  if (
    encoder.encode(JSON.stringify(facts)).byteLength > CODE_GRAPH_NAVIGATION_FACT_BYTES ||
    closeNavigationFacts(facts, symbols, edges)?.proofs.length !== proofs.length
  )
    throw new Error('Navigation proof exceeds bounds or lacks its call anchor.');
  return facts;
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !Predicate.isObject(value) ||
    EffectRecord.keys(value).length !== keys.length ||
    !EffectArray.every(keys, key => EffectRecord.has(value, key))
  )
    throw new Error('Invalid navigation fact keys.');
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256)
    throw new Error('Invalid navigation identity.');
  return value;
}
function parseSpan(value: unknown): CodeGraphSpan {
  const input = record(value, ['line', 'column', 'endLine', 'endColumn']);
  const {line, column, endLine, endColumn} = input;
  if (
    typeof line !== 'number' ||
    typeof column !== 'number' ||
    typeof endLine !== 'number' ||
    typeof endColumn !== 'number' ||
    !EffectArray.every([line, column, endLine, endColumn], n => Number.isSafeInteger(n) && n > 0) ||
    endLine < line ||
    (line === endLine && endColumn <= column)
  )
    throw new Error('Invalid navigation span.');
  return {line, column, endLine, endColumn};
}
function contains(outer: CodeGraphSpan, inner: CodeGraphSpan): boolean {
  return (
    (inner.line > outer.line || (inner.line === outer.line && inner.column >= outer.column)) &&
    (inner.endLine < outer.endLine || (inner.endLine === outer.endLine && inner.endColumn <= outer.endColumn))
  );
}
function sameSpan(left: CodeGraphSpan, right: CodeGraphSpan): boolean {
  return (
    left.line === right.line &&
    left.column === right.column &&
    left.endLine === right.endLine &&
    left.endColumn === right.endColumn
  );
}
