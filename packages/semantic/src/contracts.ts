import * as EffectArray from 'effect/Array';
import * as EffectString from 'effect/String';
import {Schema} from 'effect';
/** Versioned, provider-neutral data. Decode at the transport boundary. */
export const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
  Schema.isPattern(/^[^\p{Cc}]+$/u),
);
export const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const Counter = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
/** Lexical normalization only. Realpath, symlinks and filesystem case belong to the I/O boundary. */
export function canonicalFileUri(value: string): string {
  const uri = new URL(value);
  if (
    uri.protocol !== 'file:' ||
    !EffectString.startsWith('/')(uri.pathname) ||
    uri.search ||
    uri.hash ||
    uri.username ||
    uri.password ||
    /%2f|%5c/iu.test(uri.pathname)
  )
    throw new Error('Invalid file URI.');
  const decoded = decodeURIComponent(uri.pathname);
  if (/\p{Cc}|\\/u.test(decoded)) throw new Error('Invalid file URI path.');
  const parts = EffectArray.filter(EffectString.split('/')(decoded), Boolean);
  uri.pathname =
    '/' +
    EffectArray.join(
      EffectArray.map(parts, (part, index) =>
        index === 0 && /^[a-z]:$/iu.test(part) ? EffectString.toUpperCase(part[0]) + ':' : encodeURIComponent(part),
      ),
      '/',
    ) +
    (parts.length === 1 && /^[a-z]:$/iu.test(parts[0]) ? '/' : '');
  return uri.href;
}
export const FileUri = Schema.String.check(
  Schema.isMaxLength(8192),
  Schema.makeFilter(value => {
    try {
      return canonicalFileUri(value) === value;
    } catch {
      return false;
    }
  }),
);
export const SourceView = Schema.Struct({
  kind: Schema.Literals(['disk', 'overlay', 'editor']),
  id: Identifier,
  owner: Identifier,
  epoch: Counter,
});
export const Observation = Schema.Struct({
  version: Schema.Literal(1),
  repository: Identifier,
  worktree: FileUri,
  project: FileUri,
  configuration: Digest,
  toolchain: Digest,
  provider: Schema.Struct({
    id: Identifier,
    version: Identifier,
    generation: Counter,
  }),
  view: SourceView,
  uri: FileUri,
  content: Digest,
  documentVersion: Schema.NullOr(Counter),
  projectEpoch: Counter,
});
export type Observation = typeof Observation.Type;
export type SourceView = typeof SourceView.Type;
export const Capability = Schema.Struct({
  operation: Schema.Literals([
    'symbols',
    'definition',
    'references',
    'hover',
    'diagnostics',
    'rename',
    'code-action',
    'completion',
    'signature',
    'implementation',
    'type-definition',
    'call-hierarchy',
    'type-hierarchy',
    'formatting',
  ]),
  status: Schema.Literals(['qualified', 'experimental', 'unsupported', 'prerequisite-blocked', 'deferred']),
  reason: Identifier,
  qualification: Schema.NullOr(Digest),
});
export const Evidence = Schema.Struct({
  basis: Schema.Literals(['semantic', 'structural']),
  observation: Observation,
  scope: Identifier,
  completeness: Schema.Literals(['complete', 'partial', 'unknown']),
  limitations: Schema.Array(Identifier).check(Schema.isMaxLength(64)),
});
export type Evidence = typeof Evidence.Type;
export const QueryOutcome = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    status: Schema.Literal('ok'),
    evidence: Evidence,
    items: Schema.Array(Schema.Json),
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    status: Schema.Literals(['unsupported', 'unavailable', 'timeout', 'cancelled', 'stale', 'conflict']),
    reason: Identifier,
    evidence: Schema.NullOr(Evidence),
  }),
]);
export type QueryOutcome = typeof QueryOutcome.Type;
/** Deliberately explicit: display names and property insertion order are not identity. */
export function observationKey(o: Observation): string {
  return JSON.stringify([
    o.version,
    o.repository,
    o.worktree,
    o.project,
    o.configuration,
    o.toolchain,
    o.provider.id,
    o.provider.version,
    o.provider.generation,
    o.view.kind,
    o.view.id,
    o.view.owner,
    o.view.epoch,
    o.uri,
    o.content,
    o.documentVersion,
    o.projectEpoch,
  ]);
}
export const Position = Schema.Struct({line: Counter, character: Counter});
export type Position = typeof Position.Type;
export interface SymbolCandidate {
  readonly id: string;
  readonly name: string;
  readonly observation: Observation;
  /** The actual occurrence validated by the provider, not just the declaration range. */
  readonly occurrence: {
    readonly start: Position;
    readonly end: Position;
  };
  readonly verifiedAnchor?: string;
}
export type SymbolLocator =
  | {
      readonly kind: 'occurrence';
      readonly observation: Observation;
      readonly position: Position;
    }
  | {
      readonly kind: 'anchor';
      readonly observation: Observation;
      readonly anchor: string;
    }
  | {
      readonly kind: 'name';
      readonly name: string;
    };
export type SymbolResolution =
  | {
      readonly status: 'exact';
      readonly candidate: SymbolCandidate;
    }
  | {
      readonly status: 'candidates';
      readonly candidates: readonly SymbolCandidate[];
    }
  | {
      readonly status: 'stale' | 'unresolved';
    };
function compare(a: Position, b: Position): number {
  return a.line - b.line || a.character - b.character;
}
/** Classification of provider/verified-anchor evidence; this does not perform lexical resolution. */
export function resolveSymbol(
  locator: SymbolLocator,
  current: Observation,
  candidates: readonly SymbolCandidate[],
): SymbolResolution {
  const key = observationKey(current);
  if (locator.kind !== 'name' && observationKey(locator.observation) !== key) return {status: 'stale'};
  const matches = EffectArray.filter(candidates, candidate => {
    if (observationKey(candidate.observation) !== key) return false;
    if (locator.kind === 'name') return candidate.name === locator.name;
    if (locator.kind === 'anchor') return candidate.verifiedAnchor === locator.anchor;
    return (
      compare(candidate.occurrence.start, locator.position) <= 0 &&
      compare(locator.position, candidate.occurrence.end) < 0
    );
  });
  if (matches.length === 0) return {status: 'unresolved'};
  if (locator.kind !== 'name' && matches.length === 1) return {status: 'exact', candidate: matches[0]};
  return {status: 'candidates', candidates: matches};
}
