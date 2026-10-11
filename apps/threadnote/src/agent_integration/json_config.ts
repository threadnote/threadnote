import type {JsonObject} from '@threadnote/platform/json';
import {
  applyEdits,
  createScanner,
  modify,
  parseTree,
  stripComments,
  SyntaxKind,
  type Node,
  type ParseError,
} from 'jsonc-parser';
import {escapeRegExp, isJsonObject} from '../utils.js';

/** A string is a literal key (including dots); arrays address nested objects. */
export type AgentJsonContainer = string | readonly string[];

export const agentContainerPath = (container: AgentJsonContainer): readonly string[] =>
  typeof container === 'string' ? [container] : container;

export const sameAgentContainer = (a: AgentJsonContainer, b: AgentJsonContainer): boolean =>
  JSON.stringify(agentContainerPath(a)) === JSON.stringify(agentContainerPath(b));

export function agentServerContainer(config: JsonObject, container: AgentJsonContainer): unknown {
  let current: unknown = config;
  for (const key of agentContainerPath(container)) current = isJsonObject(current) ? current[key] : undefined;
  return current;
}

export function createdAgentContainerParents(config: JsonObject, container: AgentJsonContainer): number {
  const keys = agentContainerPath(container);
  for (let depth = 1; depth < keys.length; depth++)
    if (agentServerContainer(config, keys.slice(0, depth)) === undefined) return keys.length - depth;
  return 0;
}

export function parseAgentJson(content: string | undefined, codec: 'json' | 'jsonc' = 'json'): JsonObject {
  const errors: ParseError[] = [];
  const value: unknown =
    codec === 'jsonc'
      ? jsoncNodeValue(parseTree(content ?? '{}', errors, {allowTrailingComma: true}))
      : JSON.parse(content ?? '{}');
  if (errors.length > 0) throw new Error('Agent configuration contains invalid JSONC.');
  if (!isJsonObject(value)) throw new Error('Agent configuration must be a JSON object.');
  return value;
}

function jsoncNodeValue(node: Node | undefined): unknown {
  if (node === undefined) return undefined;
  if (node.type === 'array') return (node.children ?? []).map(jsoncNodeValue);
  if (node.type === 'object') {
    const result: Record<string, unknown> = {};
    for (const property of node.children ?? []) {
      const [key, value] = property.children ?? [];
      if (typeof key?.value !== 'string' || value === undefined) continue;
      Object.defineProperty(result, key.value, {
        configurable: true,
        enumerable: true,
        value: jsoncNodeValue(value),
        writable: true,
      });
    }
    return result;
  }
  return node.type === 'null' ? null : node.value;
}

export function writeAgentServer(
  content: string | undefined,
  codec: 'json' | 'jsonc',
  container: AgentJsonContainer,
  name: string,
  next: JsonObject,
): string {
  if (codec === 'json' || content === undefined) return `${JSON.stringify(next, undefined, 2)}\n`;
  const raw = content ?? '{}\n';
  const keys = agentContainerPath(container);
  const servers = agentServerContainer(next, container);
  let target = [...keys, name];
  if (!isJsonObject(servers)) {
    target = [...keys];
    for (let depth = 1; depth < keys.length; depth++) {
      if (agentServerContainer(next, keys.slice(0, depth)) === undefined) {
        target = keys.slice(0, depth);
        break;
      }
    }
  }
  const value = isJsonObject(servers) ? servers[name] : undefined;
  const current = agentServerContainer(parseAgentJson(raw, codec), target);
  const updated = patchJsoncValue(raw, target, current, value);
  return preserveJsoncComments(raw, updated);
}

export function agentJsonHasComments(content: string): boolean {
  return stripComments(content) !== content;
}

function preserveJsoncComments(original: string, updated: string): string {
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const remaining = jsoncComments(updated);
  const missing = jsoncComments(original).filter(comment => {
    const index = remaining.indexOf(comment);
    if (index === -1) return true;
    remaining.splice(index, 1);
    return false;
  });
  return missing.length === 0 ? updated : `${missing.join(eol)}${eol}${updated}`;
}

function jsoncComments(content: string): string[] {
  const scanner = createScanner(content, false);
  const comments: string[] = [];
  for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
    if (token === SyntaxKind.LineCommentTrivia || token === SyntaxKind.BlockCommentTrivia) {
      const offset = scanner.getTokenOffset();
      comments.push(content.slice(offset, offset + scanner.getTokenLength()));
    }
  }
  return comments;
}

function patchJsoncValue(raw: string, target: string[], current: unknown, next: unknown): string {
  if (JSON.stringify(current) === JSON.stringify(next)) return raw;
  if (isJsonObject(current) && isJsonObject(next)) {
    let updated = raw;
    for (const key of new Set([...Object.keys(current), ...Object.keys(next)]))
      updated = patchJsoncValue(updated, [...target, key], current[key], next[key]);
    return updated;
  }
  return applyEdits(
    raw,
    modify(raw, target, next, {
      formattingOptions: {insertSpaces: true, tabSize: 2, eol: raw.includes('\r\n') ? '\r\n' : '\n'},
    }),
  );
}

export function mergeAgentServer(
  config: JsonObject,
  containerKey: AgentJsonContainer,
  name: string,
  entry: JsonObject,
): JsonObject {
  const keys = agentContainerPath(containerKey);
  const merge = (current: JsonObject, depth: number): JsonObject => {
    const key = keys[depth];
    const child = current[key];
    if (child !== undefined && !isJsonObject(child))
      throw new Error(`Expected an object at ${keys.slice(0, depth + 1).join('.')}.`);
    return {
      ...current,
      [key]: depth === keys.length - 1 ? {...(child ?? {}), [name]: entry} : merge(child ?? {}, depth + 1),
    };
  };
  return merge(config, 0);
}

export function removeAgentServer(
  config: JsonObject,
  containerKey: AgentJsonContainer,
  name: string,
  createdContainer: boolean,
  createdParents = 0,
): JsonObject {
  const keys = agentContainerPath(containerKey);
  const remove = (current: JsonObject, depth: number): JsonObject => {
    const key = keys[depth];
    const child = current[key];
    if (!isJsonObject(child)) return current;
    const nextChild = depth === keys.length - 1 ? {...child} : remove(child, depth + 1);
    if (depth === keys.length - 1) delete nextChild[name];
    const next = {...current, [key]: nextChild};
    if (createdContainer && depth >= keys.length - 1 - createdParents && Object.keys(nextChild).length === 0)
      delete next[key];
    return next;
  };
  return remove(config, 0);
}

export function jsonServerDisabled(
  config: JsonObject,
  containerKey: AgentJsonContainer,
  name: string,
  policyGlobs = false,
): boolean {
  const container = agentServerContainer(config, containerKey);
  const entry = isJsonObject(container) ? container[name] : undefined;
  const server = isJsonObject(entry) ? entry : {};
  const policy = isJsonObject(config.mcp) ? config.mcp : {};
  const matches = (value: unknown) =>
    typeof value === 'string' &&
    (policyGlobs
      ? new RegExp(
          `^${value
            .split('*')
            .map(part => part.split('?').map(escapeRegExp).join('.'))
            .join('.*')}$`,
        ).test(name)
      : value === name);
  return (
    server.disabled === true ||
    server.enabled === false ||
    [config.disabledServers, policy.excluded, policy.excludedServers].some(
      value => Array.isArray(value) && value.some(matches),
    ) ||
    [policy.allowed, policy.allowedServers].some(value => Array.isArray(value) && !value.some(matches))
  );
}
