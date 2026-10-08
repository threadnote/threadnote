import {linearUuid} from './config.js';
import {fail, record} from './transport.js';
export interface LinearIssue {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly description: string | null;
  readonly url: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly team: {readonly id: string; readonly name: string};
  readonly project: {readonly id: string; readonly name: string} | null;
  readonly state: {readonly id: string; readonly name: string; readonly type: string};
}
export interface LinearComment {
  readonly id: string;
  readonly body: string;
  readonly url: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly editedAt: string | null;
  readonly parentId: string | null;
  readonly resolvedAt: string | null;
  readonly resolvingCommentId: string | null;
  readonly documentContentId: string | null;
  readonly user: {readonly id: string; readonly name: string} | null;
}
export interface LinearProject {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly content: string | null;
  readonly updatedAt: string;
  readonly url: string;
}
export interface LinearDocument {
  readonly id: string;
  readonly title: string;
  readonly content: string | null;
  readonly updatedAt: string;
  readonly url: string;
  readonly project: {readonly id: string};
}
export interface LinearUpdate {
  readonly id: string;
  readonly body: string;
  readonly updatedAt: string;
  readonly createdAt: string;
  readonly health: string;
  readonly url: string;
  readonly user: {readonly id: string; readonly name: string};
  readonly project: {readonly id: string};
}
export const ISSUE_FIELDS =
  'id identifier title description url createdAt updatedAt archivedAt team { id name } project { id name } state { id name type }';
export const COMMENT_FIELDS =
  'id body url createdAt updatedAt editedAt parentId resolvedAt resolvingCommentId documentContentId user { id name }';
export const PROJECT_FIELDS = 'id name description content updatedAt url';
export const DOCUMENT_FIELDS = 'id title content updatedAt url project { id }';
export const UPDATE_FIELDS = 'id body updatedAt createdAt health url user { id name } project { id }';
export const PAGE_INFO = 'pageInfo { hasNextPage endCursor }';
export function object(value: unknown): Record<string, unknown> {
  if (!record(value)) fail('contract-invalid');
  return value;
}
export function uuid(value: unknown): string {
  try {
    return linearUuid(value);
  } catch {
    return fail('contract-invalid');
  }
}
export function text(value: unknown, maximum = 200000): string {
  if (typeof value !== 'string' || value.length > maximum) fail('contract-invalid');
  return value;
}
function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}
function time(value: unknown): string {
  const result = text(value, 64);
  if (!Number.isFinite(Date.parse(result))) fail('contract-invalid');
  return result;
}
function nullableTime(value: unknown): string | null {
  return value === null ? null : time(value);
}
function named(value: unknown) {
  const v = object(value);
  return {id: uuid(v.id), name: text(v.name, 1024)};
}
export function link(value: unknown): string {
  const result = text(value, 2048);
  try {
    const u = new URL(result);
    if (u.origin !== 'https://linear.app' || u.username || u.password || u.search) fail('contract-invalid');
  } catch {
    return fail('contract-invalid');
  }
  return result;
}
export function issue(value: unknown): LinearIssue {
  const v = object(value);
  const state = object(v.state);
  return {
    id: uuid(v.id),
    identifier: text(v.identifier, 128),
    title: text(v.title, 1024),
    description: nullableText(v.description),
    url: link(v.url),
    createdAt: time(v.createdAt),
    updatedAt: time(v.updatedAt),
    archivedAt: nullableTime(v.archivedAt),
    team: named(v.team),
    project: v.project === null ? null : named(v.project),
    state: {id: uuid(state.id), name: text(state.name, 1024), type: text(state.type, 128)},
  };
}
export function comment(value: unknown): LinearComment {
  const v = object(value);
  return {
    id: uuid(v.id),
    body: text(v.body),
    url: link(v.url),
    createdAt: time(v.createdAt),
    updatedAt: time(v.updatedAt),
    editedAt: nullableTime(v.editedAt),
    parentId: v.parentId === null ? null : uuid(v.parentId),
    resolvedAt: nullableTime(v.resolvedAt),
    resolvingCommentId: v.resolvingCommentId === null ? null : uuid(v.resolvingCommentId),
    documentContentId: v.documentContentId === null ? null : uuid(v.documentContentId),
    user: v.user === null ? null : named(v.user),
  };
}
export function project(value: unknown): LinearProject {
  const v = object(value);
  return {
    id: uuid(v.id),
    name: text(v.name, 1024),
    description: text(v.description),
    content: nullableText(v.content),
    updatedAt: time(v.updatedAt),
    url: link(v.url),
  };
}
export function document(value: unknown): LinearDocument {
  const v = object(value);
  return {
    id: uuid(v.id),
    title: text(v.title, 1024),
    content: nullableText(v.content),
    updatedAt: time(v.updatedAt),
    url: link(v.url),
    project: {id: uuid(object(v.project).id)},
  };
}
export function update(value: unknown): LinearUpdate {
  const v = object(value);
  return {
    id: uuid(v.id),
    body: text(v.body),
    updatedAt: time(v.updatedAt),
    createdAt: time(v.createdAt),
    health: text(v.health, 128),
    url: link(v.url),
    user: named(v.user),
    project: {id: uuid(object(v.project).id)},
  };
}
export function connection<T>(
  value: unknown,
  parse: (value: unknown) => T,
): {nodes: T[]; cursor: string | null; more: boolean} {
  const v = object(value);
  const page = object(v.pageInfo);
  if (
    !Array.isArray(v.nodes) ||
    v.nodes.length > 50 ||
    typeof page.hasNextPage !== 'boolean' ||
    (page.endCursor !== null && typeof page.endCursor !== 'string')
  )
    fail('contract-invalid');
  const cursor = page.endCursor === null ? null : text(page.endCursor, 2048);
  if (page.hasNextPage && (!cursor || v.nodes.length === 0)) fail('contract-incomplete');
  return {nodes: v.nodes.map(parse), cursor, more: page.hasNextPage};
}
