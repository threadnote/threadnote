import {Array as EffectArray} from 'effect';
import {Predicate, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {compareCodeUnits} from '../ordering.js';
import type {CodeGraphSpan} from '../types.js';
import {
  CODE_GRAPH_MONIKER_STRICT_PARSE_OPTIONS,
  CodeGraphMonikerSchemaV1,
  type CodeGraphExternalDependencyKind,
  type CodeGraphMonikerV1,
  type CodeGraphPackageMonikerV1,
  type CodeGraphProtobufMonikerKind,
  type CodeGraphProtobufMonikerV1,
} from './types.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const MONIKER_ID = /^cgm_[0-9a-f]{64}$/u;
const COMPONENT_ID = /^cgp_[0-9a-f]{32}$/u;
const SYMBOL_ID = /^cgs_(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})$/u;
const NPM_PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u;
const PROTOBUF_NAME = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/u;
const MAX_EVIDENCE_PATH_LENGTH = 4_096;
const MAX_MONIKER_IDENTITY_LENGTH = 8_192;
const MAX_PACKAGE_VERSION_LENGTH = 8_192;

export interface CodeGraphPackageMonikerInput {
  readonly componentId: string;
  readonly dependencyKind?: CodeGraphExternalDependencyKind;
  readonly evidence: {readonly path: string; readonly span: CodeGraphSpan};
  readonly packageName: string;
  readonly packageVersion?: string;
  readonly role: 'import' | 'export';
}

export interface CodeGraphProtobufMonikerInput {
  readonly evidence: {readonly path: string; readonly span: CodeGraphSpan};
  readonly importPath?: string;
  readonly kind: CodeGraphProtobufMonikerKind;
  readonly packageName?: string;
  readonly qualifiedName?: string;
  readonly role: 'import' | 'export';
  readonly symbolId: string;
}

export function normalizeNpmPackageName(value: string): string {
  const normalized = Effect.pipe(value, EffectString.normalize('NFKC'), EffectString.trim, EffectString.toLowerCase);
  if (normalized.length > 214 || !NPM_PACKAGE.test(normalized)) {
    throw new Error('Code graph npm package name is invalid.');
  }
  return normalized;
}

export function normalizeProtobufImportPath(value: string): string {
  const normalized = Effect.pipe(
    value,
    EffectString.normalize('NFKC'),
    EffectString.trim,
    EffectString.replaceAll('\\', '/'),
    EffectString.replace(/^\.\//u, ''),
  );
  const segments = Effect.pipe(normalized, EffectString.split('/'));
  if (
    !normalized ||
    normalized.length > MAX_EVIDENCE_PATH_LENGTH ||
    Effect.pipe(normalized, EffectString.startsWith('/')) ||
    !Effect.pipe(normalized, EffectString.endsWith('.proto')) ||
    EffectArray.some(
      [...normalized],
      character =>
        Effect.pipe(
          character,
          EffectString.codePointAt(0),
          Effect.Option.getOrElse(() => undefined),
        )! < 32 ||
        Effect.pipe(
          character,
          EffectString.codePointAt(0),
          Effect.Option.getOrElse(() => undefined),
        ) === 127,
    ) ||
    EffectArray.some(segments, segment => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('Code graph protobuf import path is invalid.');
  }
  return normalized;
}

export function normalizeProtobufName(value: string): string {
  const normalized = Effect.pipe(
    value,
    EffectString.normalize('NFKC'),
    EffectString.trim,
    EffectString.replace(/^\./u, ''),
  );
  if (normalized.length > MAX_MONIKER_IDENTITY_LENGTH || !PROTOBUF_NAME.test(normalized)) {
    throw new Error('Code graph protobuf identity is invalid.');
  }
  return normalized;
}

export function codeGraphPackageMoniker(input: CodeGraphPackageMonikerInput): CodeGraphPackageMonikerV1 {
  const packageName = normalizeNpmPackageName(input.packageName);
  const packageVersion = optionalNonEmpty(input.packageVersion, 'package version');
  if (!COMPONENT_ID.test(input.componentId)) {
    throw new Error('Code graph package moniker component identity is invalid.');
  }
  if (input.role === 'import' && input.dependencyKind === undefined) {
    throw new Error('Code graph package import moniker requires its declaration kind.');
  }
  if (input.role === 'export' && input.dependencyKind !== undefined) {
    throw new Error('Code graph package export moniker cannot carry an import declaration kind.');
  }
  const identity = `package:npm:${packageName}`;
  const moniker = {
    componentId: input.componentId,
    ...(input.dependencyKind === undefined ? {} : {dependencyKind: input.dependencyKind}),
    evidence: normalizedEvidence(input.evidence),
    id: '',
    identity,
    kind: 'package',
    packageName,
    ...(packageVersion === undefined ? {} : {packageVersion}),
    resolutionDomain: 'package:npm',
    role: input.role,
    scheme: 'package',
    version: 1,
  } satisfies Omit<CodeGraphPackageMonikerV1, 'id'> & {id: string};
  return {...moniker, id: monikerId(moniker)};
}

export function codeGraphProtobufMoniker(input: CodeGraphProtobufMonikerInput): CodeGraphProtobufMonikerV1 {
  const packageName = input.packageName === undefined ? undefined : normalizeProtobufName(input.packageName);
  const importPath = input.importPath === undefined ? undefined : normalizeProtobufImportPath(input.importPath);
  const qualifiedName = input.qualifiedName === undefined ? undefined : normalizeProtobufName(input.qualifiedName);
  if (!SYMBOL_ID.test(input.symbolId)) {
    throw new Error('Code graph protobuf moniker symbol identity is invalid.');
  }
  if (input.kind === 'file' && importPath === undefined)
    throw new Error('Protobuf file moniker requires an import path.');
  if (input.kind === 'package' && packageName === undefined)
    throw new Error('Protobuf package moniker requires a package.');
  if (['message', 'service', 'rpc'].includes(input.kind) && qualifiedName === undefined) {
    throw new Error(`Protobuf ${input.kind} moniker requires a qualified identity.`);
  }
  if (
    (input.kind === 'file' && (packageName !== undefined || qualifiedName !== undefined)) ||
    (input.kind === 'package' && (importPath !== undefined || qualifiedName !== undefined)) ||
    (['message', 'service', 'rpc'].includes(input.kind) && importPath !== undefined)
  ) {
    throw new Error('Code graph protobuf moniker carries fields from another declaration kind.');
  }
  if (
    packageName !== undefined &&
    qualifiedName !== undefined &&
    qualifiedName !== packageName &&
    !Effect.pipe(qualifiedName, EffectString.startsWith(`${packageName}.`))
  ) {
    throw new Error('Code graph protobuf declaration is outside its package identity.');
  }
  const identity =
    input.kind === 'file'
      ? `protobuf:file:${importPath!}`
      : input.kind === 'package'
        ? `protobuf:package:${packageName!}`
        : `protobuf:${input.kind}:${qualifiedName!}`;
  const moniker = {
    evidence: normalizedEvidence(input.evidence),
    id: '',
    identity,
    ...(importPath === undefined ? {} : {importPath}),
    kind: input.kind,
    ...(packageName === undefined ? {} : {packageName}),
    ...(qualifiedName === undefined ? {} : {qualifiedName}),
    resolutionDomain: 'protobuf',
    role: input.role,
    scheme: 'protobuf',
    symbolId: input.symbolId,
    version: 1,
  } satisfies Omit<CodeGraphProtobufMonikerV1, 'id'> & {id: string};
  return {...moniker, id: monikerId(moniker)};
}

export function parseCodeGraphMonikerV1(value: unknown): CodeGraphMonikerV1 {
  const parsed = Schema.decodeUnknownSync(CodeGraphMonikerSchemaV1, CODE_GRAPH_MONIKER_STRICT_PARSE_OPTIONS)(value);
  const canonical = parsed.scheme === 'package' ? codeGraphPackageMoniker(parsed) : codeGraphProtobufMoniker(parsed);
  if (!MONIKER_ID.test(parsed.id) || !structurallyEqual(parsed, canonical)) {
    throw new Error('Code graph moniker fields are not canonical.');
  }
  return canonical;
}

export function canonicalCodeGraphMonikers(values: readonly CodeGraphMonikerV1[]): readonly CodeGraphMonikerV1[] {
  const byId = new Map<string, CodeGraphMonikerV1>();
  for (const value of values) {
    const parsed = parseCodeGraphMonikerV1(value);
    if (!byId.has(parsed.id)) byId.set(parsed.id, parsed);
  }
  return [...byId.values()].sort(compareCodeGraphMonikers);
}

export function compareCodeGraphMonikers(left: CodeGraphMonikerV1, right: CodeGraphMonikerV1): number {
  return (
    compareCodeUnits(left.identity, right.identity) ||
    compareCodeUnits(left.role, right.role) ||
    compareCodeUnits(left.id, right.id)
  );
}

function normalizedEvidence(evidence: {readonly path: string; readonly span: CodeGraphSpan}) {
  const path = Effect.pipe(
    evidence.path,
    EffectString.normalize('NFC'),
    EffectString.replaceAll('\\', '/'),
    EffectString.replace(/^\.\//u, ''),
  );
  if (
    !path ||
    path.length > MAX_EVIDENCE_PATH_LENGTH ||
    Effect.pipe(path, EffectString.startsWith('/')) ||
    EffectArray.some(
      Effect.pipe(path, EffectString.split('/')),
      segment => !segment || segment === '.' || segment === '..',
    )
  )
    throw new Error('Code graph moniker path is invalid.');
  const span = evidence.span;
  if (
    !EffectArray.every([span.line, span.column, span.endLine, span.endColumn], Number.isSafeInteger) ||
    span.line < 1 ||
    span.column < 1 ||
    span.endLine < span.line ||
    (span.endLine === span.line && span.endColumn < span.column)
  ) {
    throw new Error('Code graph moniker span is invalid.');
  }
  return {path, span};
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) return false;
  if (EffectArray.isArray(left) || EffectArray.isArray(right)) {
    return (
      EffectArray.isArray(left) &&
      EffectArray.isArray(right) &&
      left.length === right.length &&
      EffectArray.every(left, (value, index) => structurallyEqual(value, right[index]))
    );
  }
  if (!Predicate.isObject(left) || !Predicate.isObject(right)) return false;
  const leftKeys = EffectRecord.keys(left).sort(compareCodeUnits);
  const rightKeys = EffectRecord.keys(right).sort(compareCodeUnits);
  return (
    leftKeys.length === rightKeys.length &&
    EffectArray.every(leftKeys, (key, index) => key === rightKeys[index] && structurallyEqual(left[key], right[key]))
  );
}

function optionalNonEmpty(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = Effect.pipe(value, EffectString.normalize('NFKC'), EffectString.trim);
  if (!normalized || normalized.length > MAX_PACKAGE_VERSION_LENGTH) {
    throw new Error(`Code graph ${label} is invalid.`);
  }
  return normalized;
}

function monikerId(moniker: Omit<CodeGraphMonikerV1, 'id'> & {readonly id?: string}): string {
  const evidence = moniker.evidence;
  return `cgm_${sha256HexSync(
    EffectArray.join(
      [
        'threadnote-code-graph-moniker-v1',
        moniker.scheme,
        moniker.resolutionDomain,
        moniker.identity,
        moniker.role,
        moniker.kind,
        'packageName' in moniker ? String(moniker.packageName ?? '') : '',
        'packageVersion' in moniker ? String(moniker.packageVersion ?? '') : '',
        'dependencyKind' in moniker ? String(moniker.dependencyKind ?? '') : '',
        'importPath' in moniker ? String(moniker.importPath ?? '') : '',
        'qualifiedName' in moniker ? String(moniker.qualifiedName ?? '') : '',
        'componentId' in moniker ? String(moniker.componentId ?? '') : '',
        'symbolId' in moniker ? String(moniker.symbolId ?? '') : '',
        evidence.path,
        String(evidence.span.line),
        String(evidence.span.column),
        String(evidence.span.endLine),
        String(evidence.span.endColumn),
      ],
      '\0',
    ),
  )}`;
}
