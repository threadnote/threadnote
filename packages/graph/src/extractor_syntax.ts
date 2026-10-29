import type ts from 'typescript-compiler';
import {Array as EffectArray, Option} from 'effect';
import * as Effect from 'effect';
import * as EffectString from 'effect/String';
import type {CodeGraphSpan} from './types.js';

export function typeScriptDeclarationArity(compiler: typeof ts, node: ts.Node): number | undefined {
  if (
    compiler.isFunctionDeclaration(node) ||
    compiler.isMethodDeclaration(node) ||
    compiler.isMethodSignature(node) ||
    compiler.isGetAccessorDeclaration(node) ||
    compiler.isSetAccessorDeclaration(node) ||
    compiler.isConstructorDeclaration(node)
  ) {
    return node.parameters.length;
  }
  if (
    compiler.isVariableDeclaration(node) &&
    node.initializer !== undefined &&
    (compiler.isArrowFunction(node.initializer) || compiler.isFunctionExpression(node.initializer))
  ) {
    return node.initializer.parameters.length;
  }
  return undefined;
}

export function isTypeScriptCallableImplementation(compiler: typeof ts, node: ts.Node): boolean {
  if (
    compiler.isFunctionDeclaration(node) ||
    compiler.isMethodDeclaration(node) ||
    compiler.isGetAccessorDeclaration(node) ||
    compiler.isSetAccessorDeclaration(node) ||
    compiler.isConstructorDeclaration(node)
  ) {
    return node.body !== undefined;
  }
  return (
    compiler.isVariableDeclaration(node) &&
    node.initializer !== undefined &&
    (compiler.isArrowFunction(node.initializer) || compiler.isFunctionExpression(node.initializer))
  );
}

export function declarationKind(compiler: typeof ts, node: ts.Node): string {
  if (compiler.isClassDeclaration(node)) return 'class';
  if (compiler.isInterfaceDeclaration(node)) return 'interface';
  if (compiler.isTypeAliasDeclaration(node)) return 'type';
  if (compiler.isEnumDeclaration(node)) return 'enum';
  return 'function';
}

export function hasExportModifier(compiler: typeof ts, node: ts.Node): boolean {
  return (
    compiler.canHaveModifiers(node) &&
    (Option.getOrUndefined(
      Option.map(Option.fromNullishOr(compiler.getModifiers(node)), __effectOptionalArray =>
        Boolean(
          EffectArray.some(__effectOptionalArray, modifier => modifier.kind === compiler.SyntaxKind.ExportKeyword),
        ),
      ),
    ) ??
      false)
  );
}

export function propertyName(compiler: typeof ts, name: ts.PropertyName): string | undefined {
  return compiler.isIdentifier(name) || compiler.isStringLiteralLike(name) || compiler.isNumericLiteral(name)
    ? name.text
    : undefined;
}

export function relationshipExpressionName(
  compiler: typeof ts,
  expression: ts.Expression,
  localBindings: ReadonlyMap<ts.Node, ReadonlySet<string>>,
): string | undefined {
  const name = expressionName(compiler, expression);
  if (!name || !compiler.isIdentifier(expression)) return name;
  for (let scope: ts.Node | undefined = expression.parent; scope; scope = scope.parent) {
    if (localBindings.get(scope)?.has(expression.text)) return locallyBoundTarget(expression.text);
    if (compiler.isSourceFile(scope)) break;
  }
  return name;
}

export function collectLocalBindings(
  compiler: typeof ts,
  sourceFile: ts.SourceFile,
): ReadonlyMap<ts.Node, ReadonlySet<string>> {
  const bindings = new Map<ts.Node, Set<string>>();
  const add = (scope: ts.Node | undefined, name: ts.BindingName | undefined) => {
    if (!scope || !name) return;
    const values = bindings.get(scope) ?? new Set<string>();
    collectBindingNames(compiler, name, values);
    bindings.set(scope, values);
  };
  const visit = (node: ts.Node): void => {
    if (compiler.isParameter(node)) {
      add(nearestFunctionScope(compiler, node.parent), node.name);
    } else if (compiler.isVariableDeclaration(node) && !compiler.isCatchClause(node.parent)) {
      const list = compiler.isVariableDeclarationList(node.parent) ? node.parent : undefined;
      const blockScoped = (list?.flags ?? 0) & compiler.NodeFlags.BlockScoped;
      add(
        blockScoped ? nearestBlockScope(compiler, node.parent) : nearestFunctionScope(compiler, node.parent),
        node.name,
      );
    } else if (
      (compiler.isFunctionDeclaration(node) || compiler.isClassDeclaration(node) || compiler.isEnumDeclaration(node)) &&
      node.name &&
      !compiler.isSourceFile(node.parent)
    ) {
      add(nearestBlockScope(compiler, node.parent) ?? nearestFunctionScope(compiler, node.parent), node.name);
    } else if ((compiler.isFunctionExpression(node) || compiler.isClassExpression(node)) && node.name) {
      add(node, node.name);
    } else if (compiler.isCatchClause(node)) {
      add(node, node.variableDeclaration?.name);
    }
    compiler.forEachChild(node, visit);
  };
  compiler.forEachChild(sourceFile, visit);
  return bindings;
}

export function collectBindingNames(compiler: typeof ts, name: ts.BindingName, output: Set<string>): void {
  if (compiler.isIdentifier(name)) {
    output.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!compiler.isOmittedExpression(element)) collectBindingNames(compiler, element.name, output);
  }
}

export function nearestFunctionScope(compiler: typeof ts, node: ts.Node | undefined): ts.Node | undefined {
  for (let current = node; current && !compiler.isSourceFile(current); current = current.parent) {
    if (compiler.isFunctionLike(current)) return current;
  }
  return undefined;
}

export function nearestBlockScope(compiler: typeof ts, node: ts.Node | undefined): ts.Node | undefined {
  for (let current = node; current && !compiler.isSourceFile(current); current = current.parent) {
    if (compiler.isBlock(current) || compiler.isCatchClause(current) || compiler.isFunctionLike(current))
      return current;
  }
  return undefined;
}

export function locallyBoundTarget(name: string): string {
  return `local:${encodeURIComponent(name)}`;
}

export function expressionName(compiler: typeof ts, expression: ts.Expression): string | undefined {
  if (compiler.isIdentifier(expression)) return expression.text;
  if (compiler.isPropertyAccessExpression(expression)) {
    if (expression.expression.kind === compiler.SyntaxKind.ThisKeyword) return `this.${expression.name.text}`;
    if (compiler.isIdentifier(expression.expression)) return `${expression.expression.text}.${expression.name.text}`;
    return `property.${expression.name.text}`;
  }
  if (compiler.isElementAccessExpression(expression) && expression.argumentExpression) {
    return expressionName(compiler, expression.argumentExpression);
  }
  return undefined;
}

export function spanFor(sourceFile: ts.SourceFile, start: number, end: number): CodeGraphSpan {
  const from = sourceFile.getLineAndCharacterOfPosition(start);
  const to = sourceFile.getLineAndCharacterOfPosition(Math.max(start, end));
  return {column: from.character + 1, endColumn: to.character + 1, endLine: to.line + 1, line: from.line + 1};
}

export function textSpan(content: string, start: number, end: number): CodeGraphSpan {
  const before = Effect.pipe(content, EffectString.slice(0, start), EffectString.split('\n'));
  const through = Effect.pipe(content, EffectString.slice(0, end), EffectString.split('\n'));
  return {
    column: before.at(-1)!.length + 1,
    endColumn: through.at(-1)!.length + 1,
    endLine: through.length,
    line: before.length,
  };
}

export function leadingDocumentation(
  compiler: typeof ts,
  sourceFile: ts.SourceFile,
  node: ts.Node,
): string | undefined {
  const ranges = compiler.getLeadingCommentRanges(sourceFile.text, node.getFullStart()) ?? [];
  const comments = EffectArray.map(
    EffectArray.filter(
      EffectArray.map(ranges, range => Effect.pipe(sourceFile.text, EffectString.slice(range.pos, range.end))),
      value => Effect.pipe(value, EffectString.startsWith('/**')),
    ),
    value =>
      Effect.pipe(
        value,
        EffectString.replace(/^\/\*\*|\*\/$/g, ''),
        EffectString.replace(/^\s*\*\s?/gm, ''),
        EffectString.trim,
      ),
  );
  const value = comments.at(-1);
  return value ? Effect.pipe(value, EffectString.slice(0, 1_024)) : undefined;
}
