import {Array as EffectArray, Option} from 'effect';
import * as EffectString from 'effect/String';
import type {Node} from 'web-tree-sitter';
import {
  CODE_GRAPH_NAVIGATION_FACT_BYTES,
  CODE_GRAPH_NAVIGATION_FACT_VERSION,
  CODE_GRAPH_NAVIGATION_PROOF_LIMIT,
} from '../../navigation_facts.js';
import type {
  CodeGraphEdge,
  CodeGraphNavigationFacts,
  CodeGraphPythonOpenWriteProof,
  CodeGraphSpan,
  CodeGraphSymbol,
} from '../../types.js';

/**
 * Names that can rebind or bypass the builtin `open` without a visible binding of the identifier itself.
 * A file that uses any of them yields no proof.
 */
const REBINDING_NAMES = new Set([
  '__builtins__',
  '__import__',
  'builtins',
  'eval',
  'exec',
  'globals',
  'locals',
  'setattr',
  'vars',
]);
const WRITE_MODE = /^(?=[rwxabt+]{1,3}$)(?=.*[wxa+])(?!.*(.).*\1)[rwxabt+]+$/u;
const encoder = new TextEncoder();

export interface PythonNavigationFactInput {
  readonly root: Node;
  readonly symbols: readonly CodeGraphSymbol[];
  readonly edges: readonly CodeGraphEdge[];
  readonly span: (node: Node) => CodeGraphSpan;
}

/**
 * Finite Python proof of one possible conditional durable write: a top-level function whose single
 * `if <name>:` branch opens `open(<name>, "<write mode>")` in a `with` statement. Anything outside that
 * grammar, any rebinding of `open` and any dynamic rebinding helper yields no proof. The proof states a
 * possible source effect, never an observed write.
 */
export function collectPythonNavigationFacts(input: PythonNavigationFactInput): CodeGraphNavigationFacts | undefined {
  const calls: Node[] = [];
  let unsafe = false;
  const stack: Node[] = [input.root];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === 'wildcard_import') unsafe = true;
    if (node.type === 'identifier') {
      if (REBINDING_NAMES.has(node.text)) unsafe = true;
      if (node.text === 'open') {
        const parent = node.parent;
        if (parent?.type === 'call' && sameNode(parent.childForFieldName('function'), node)) calls.push(parent);
        else if (!(parent?.type === 'attribute' && sameNode(parent.childForFieldName('attribute'), node)))
          unsafe = true; // Any binding, parameter, alias or bare reference of `open` defeats the builtin proof.
      }
    }
    for (const child of node.namedChildren) if (child) stack.push(child);
  }
  if (calls.length === 0) return undefined;
  const facts = (proofs: readonly CodeGraphPythonOpenWriteProof[], omitted: boolean): CodeGraphNavigationFacts => ({
    version: CODE_GRAPH_NAVIGATION_FACT_VERSION,
    omitted,
    proofs,
  });
  if (unsafe) return facts([], false);
  const proofs: CodeGraphPythonOpenWriteProof[] = [];
  let omitted = false;
  let bytes = 64;
  const callsByOwner = new Map<string, number>();
  for (const call of calls) {
    const owner = ownerFunction(call);
    if (owner) callsByOwner.set(owner.id.toString(), (callsByOwner.get(owner.id.toString()) ?? 0) + 1);
  }
  for (const call of calls.sort((left, right) => left.startIndex - right.startIndex)) {
    const fn = ownerFunction(call);
    // One `open` call per owner: tree-sitter call edges carry no span in their id.
    if (!fn || callsByOwner.get(fn.id.toString()) !== 1) continue;
    const proof = proveCall(input, call, fn);
    if (!proof) continue;
    if (proofs.length >= CODE_GRAPH_NAVIGATION_PROOF_LIMIT) {
      omitted = true;
      break;
    }
    const size = encoder.encode(JSON.stringify(proof)).byteLength + 1;
    if (bytes + size > CODE_GRAPH_NAVIGATION_FACT_BYTES) {
      omitted = true;
      break;
    }
    bytes += size;
    proofs.push(proof);
  }
  return facts(proofs, omitted);
}

function proveCall(input: PythonNavigationFactInput, call: Node, fn: Node): CodeGraphPythonOpenWriteProof | undefined {
  const callee = call.childForFieldName('function');
  const argumentsNode = call.childForFieldName('arguments');
  const args = argumentsNode?.namedChildren ?? [];
  const target = args[0];
  const mode = args[1];
  if (!callee || args.length !== 2 || target?.type !== 'identifier' || !mode || !writeMode(mode)) return undefined;
  // with_statement > with_clause > with_item > as_pattern > call
  const pattern = call.parent;
  const item = pattern?.parent;
  const clause = item?.parent;
  const statement = clause?.parent;
  if (
    pattern?.type !== 'as_pattern' ||
    !sameNode(pattern.namedChildren[0], call) ||
    item?.type !== 'with_item' ||
    clause?.type !== 'with_clause' ||
    clause.namedChildren.length !== 1 ||
    statement?.type !== 'with_statement'
  )
    return undefined;
  const handle = pattern.childForFieldName('alias')?.namedChildren[0];
  if (handle?.type !== 'identifier' || !writesOnly(statement.childForFieldName('body'), handle.text)) return undefined;
  const guarded = guardOf(statement, fn, input.span);
  if (!guarded) return undefined;
  const name = fn.childForFieldName('name')?.text;
  const ownerSpan = input.span(fn);
  const owner = Option.getOrUndefined(
    EffectArray.findFirst(
      input.symbols,
      symbol => symbol.kind === 'function' && symbol.name === name && sameSpan(symbol.span, ownerSpan),
    ),
  );
  const calleeSpan = input.span(callee);
  const edge = owner
    ? Option.getOrUndefined(
        EffectArray.findFirst(
          input.edges,
          candidate =>
            candidate.relation === 'calls' &&
            candidate.provenance === 'syntactic' &&
            candidate.sourceId === owner.id &&
            candidate.targetName === 'open' &&
            sameSpan(candidate.evidenceSpan, calleeSpan),
        ),
      )
    : undefined;
  if (!owner || !edge) return undefined;
  return {
    ownerId: owner.id,
    ownerSpan,
    callEdgeId: edge.id,
    module: 'builtins',
    imported: 'open',
    local: 'open',
    modeSpan: input.span(mode),
    callSpan: input.span(call),
    calleeSpan,
    targetSpan: input.span(target),
    guard: guarded,
  };
}

/** The innermost function definition, only when it is a plain top-level `def` without decorators. */
function ownerFunction(node: Node): Node | undefined {
  let current = node.parent;
  while (current && current.type !== 'function_definition') {
    if (current.type === 'lambda' || current.type === 'class_definition') return undefined;
    current = current.parent;
  }
  return current?.parent?.type === 'module' ? current : undefined;
}

/** The single `if <identifier>:` around the write statement, with only blocks in between. */
function guardOf(
  statement: Node,
  fn: Node,
  span: (node: Node) => CodeGraphSpan,
): CodeGraphPythonOpenWriteProof['guard'] | undefined {
  const body = fn.childForFieldName('body');
  const branchBlock = statement.parent;
  if (branchBlock?.type !== 'block') return undefined;
  const branchOwner = branchBlock.parent;
  let ifStatement: Node | null = null;
  let branch: 'then' | 'else' | undefined;
  if (branchOwner?.type === 'if_statement' && sameNode(branchOwner.childForFieldName('consequence'), branchBlock)) {
    ifStatement = branchOwner;
    branch = 'then';
  } else if (branchOwner?.type === 'else_clause' && branchOwner.parent?.type === 'if_statement') {
    ifStatement = branchOwner.parent;
    branch = 'else';
  }
  if (!ifStatement || !branch || !sameNode(ifStatement.parent, body) || !supportedOwner(fn, ifStatement))
    return undefined;
  const condition = ifStatement.childForFieldName('condition');
  if (condition?.type !== 'identifier') return undefined;
  return {span: span(condition), branch};
}

/** Owner body: simple assignments, one guard whose branches only assign or write, then an optional return. */
function supportedOwner(fn: Node, guard: Node): boolean {
  const statements = fn.childForFieldName('body')?.namedChildren ?? [];
  let seenGuard = false;
  for (let index = 0; index < statements.length; index++) {
    const statement = statements[index];
    if (!statement) return false;
    if (!seenGuard && simpleAssignment(statement)) continue;
    if (!seenGuard && sameNode(statement, guard)) {
      seenGuard = true;
      const consequence = guard.childForFieldName('consequence');
      const alternatives = EffectArray.filter(guard.namedChildren, child => child?.type === 'elif_clause');
      const otherwise = Option.getOrUndefined(
        EffectArray.findFirst(guard.namedChildren, child => child?.type === 'else_clause'),
      );
      if (
        alternatives.length > 0 ||
        !branchStatements(consequence) ||
        (otherwise && !branchStatements(otherwise.childForFieldName('body')))
      )
        return false;
      continue;
    }
    if (seenGuard && statement.type === 'return_statement' && index === statements.length - 1) {
      const value = statement.namedChildren[0];
      if (!value || simpleValue(value)) continue;
    }
    return false;
  }
  return seenGuard;
}

function branchStatements(block: Node | null): boolean {
  if (block?.type !== 'block') return false;
  return EffectArray.every(
    block.namedChildren,
    statement => !!statement && (simpleAssignment(statement) || withWrite(statement)),
  );
}

function withWrite(statement: Node): boolean {
  if (statement.type !== 'with_statement') return false;
  const clause = statement.namedChildren[0];
  const pattern = clause?.namedChildren[0]?.childForFieldName('value');
  const call = pattern?.namedChildren[0];
  const handle = pattern?.childForFieldName('alias')?.namedChildren[0];
  return (
    clause?.type === 'with_clause' &&
    clause.namedChildren.length === 1 &&
    pattern?.type === 'as_pattern' &&
    call?.type === 'call' &&
    call.childForFieldName('function')?.text === 'open' &&
    handle?.type === 'identifier' &&
    writesOnly(statement.childForFieldName('body'), handle.text)
  );
}

/** Body of the `with`: only `<handle>.write(<simple>)` expression statements. */
function writesOnly(block: Node | null, handle: string): boolean {
  if (block?.type !== 'block' || block.namedChildren.length === 0) return false;
  return EffectArray.every(block.namedChildren, statement => {
    const call = statement?.type === 'expression_statement' ? statement.namedChildren[0] : undefined;
    const callee = call?.type === 'call' ? call.childForFieldName('function') : undefined;
    const args = call?.childForFieldName('arguments')?.namedChildren ?? [];
    return (
      callee?.type === 'attribute' &&
      callee.childForFieldName('object')?.text === handle &&
      callee.childForFieldName('object')?.type === 'identifier' &&
      callee.childForFieldName('attribute')?.text === 'write' &&
      args.length === 1 &&
      !!args[0] &&
      simpleValue(args[0])
    );
  });
}

function simpleAssignment(statement: Node): boolean {
  const assignment = statement.type === 'expression_statement' ? statement.namedChildren[0] : undefined;
  if (assignment?.type !== 'assignment' || statement.namedChildren.length !== 1) return false;
  const left = assignment.childForFieldName('left');
  const right = assignment.childForFieldName('right');
  return left?.type === 'identifier' && !!right && simpleValue(right) && assignment.childForFieldName('type') === null;
}

function simpleValue(node: Node): boolean {
  return (
    node.type === 'identifier' ||
    node.type === 'integer' ||
    node.type === 'float' ||
    node.type === 'true' ||
    node.type === 'false' ||
    node.type === 'none' ||
    (node.type === 'string' && plainString(node) !== undefined)
  );
}

/** Content of a plain string literal without prefix or interpolation. */
function plainString(node: Node): string | undefined {
  const parts = node.namedChildren;
  if (
    !EffectArray.every(
      parts,
      part => part?.type === 'string_start' || part?.type === 'string_content' || part?.type === 'string_end',
    )
  )
    return undefined;
  const start = Option.getOrUndefined(EffectArray.findFirst(parts, part => part?.type === 'string_start'));
  if (!start || !(start.text === '"' || start.text === "'")) return undefined;
  return EffectArray.join(
    EffectArray.map(
      EffectArray.filter(parts, part => part?.type === 'string_content'),
      part => part?.text ?? '',
    ),
    '',
  );
}

function writeMode(node: Node): boolean {
  const value = plainString(node);
  return value !== undefined && WRITE_MODE.test(value) && !EffectString.includes('\\')(value);
}

function sameNode(left: Node | null | undefined, right: Node | null | undefined): boolean {
  return !!left && !!right && left.id === right.id;
}

function sameSpan(left: CodeGraphSpan, right: CodeGraphSpan): boolean {
  return (
    left.line === right.line &&
    left.column === right.column &&
    left.endLine === right.endLine &&
    left.endColumn === right.endColumn
  );
}
