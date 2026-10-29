import {Array as EffectArray} from 'effect';
import {Schema} from 'effect';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const ACTIVATION_REQUEST_VERSION = 1 as const;
export const ACTIVATION_REQUEST_MAX_BYTES = 256 * 1_024;

export interface ActivationDecisionInputV1 {
  readonly decision: string;
  readonly invalidated: readonly string[];
  readonly rationale: string;
  readonly constraints: readonly string[];
  readonly operation?: 'create' | 'replace';
  readonly replaceUri?: string;
  readonly unresolvedRisks: readonly string[];
  readonly verification: readonly string[];
}

export interface ActivationProductionRequestV1 {
  readonly adrPaths: readonly string[];
  readonly decision: ActivationDecisionInputV1;
  readonly primarySurfaceId: string;
  readonly project: string;
  readonly publicationMode: 'direct' | 'proposal';
  readonly repositoryRoot: string;
  readonly scope?: 'local' | 'project' | 'user';
  readonly secondarySurfaceId: string;
  readonly task: string;
  readonly team: {
    readonly name: string;
    readonly push: boolean;
    readonly remotePath?: string;
    readonly setDefault: boolean;
  };
  readonly topic: string;
  readonly type: 'threadnote-activation-request';
  readonly version: typeof ACTIVATION_REQUEST_VERSION;
}

const Text = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4_096),
  Schema.makeFilter(value => (hasControlCharacter(value) ? 'Expected text without control characters.' : undefined)),
);
const Item = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(2_000),
  Schema.makeFilter(value => (hasControlCharacter(value) ? 'Expected text without control characters.' : undefined)),
);
const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
);
const PortableIdentifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
);
const TeamName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/u),
  Schema.makeFilter(value => (/^\.+$/u.test(value) ? 'Expected a non-dot team name.' : undefined)),
);
const RelativePath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096));
const BoundedItems = Schema.Array(Item).check(Schema.isMaxLength(32));

const ActivationDecisionInputV1Schema = Schema.Struct({
  constraints: BoundedItems,
  decision: Text,
  invalidated: BoundedItems,
  operation: Schema.optionalKey(Schema.Literals(['create', 'replace'])),
  rationale: Text,
  replaceUri: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048))),
  unresolvedRisks: BoundedItems,
  verification: BoundedItems,
});

const ActivationProductionRequestV1Schema = Schema.Struct({
  adrPaths: Schema.Array(RelativePath).check(Schema.isMaxLength(64)),
  decision: ActivationDecisionInputV1Schema,
  primarySurfaceId: Identifier,
  project: PortableIdentifier,
  publicationMode: Schema.Literals(['direct', 'proposal']),
  repositoryRoot: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384)),
  scope: Schema.optionalKey(Schema.Literals(['local', 'project', 'user'])),
  secondarySurfaceId: Identifier,
  task: Text,
  team: Schema.Struct({
    name: TeamName,
    push: Schema.Boolean,
    remotePath: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384))),
    setDefault: Schema.Boolean,
  }),
  topic: PortableIdentifier,
  type: Schema.Literal('threadnote-activation-request'),
  version: Schema.Literal(ACTIVATION_REQUEST_VERSION),
});

const STRICT_PARSE_OPTIONS = {errors: 'all', onExcessProperty: 'error'} as const;

export function parseActivationProductionRequestV1(value: unknown): ActivationProductionRequestV1 {
  const request = Schema.decodeUnknownSync(ActivationProductionRequestV1Schema, STRICT_PARSE_OPTIONS)(value);
  if (request.primarySurfaceId === request.secondarySurfaceId) throw new Error('Activation surfaces must be distinct.');
  if (request.decision.operation === 'replace' && request.decision.replaceUri === undefined) {
    throw new Error('Replacement activation decisions require replaceUri.');
  }
  if (request.decision.operation !== 'replace' && request.decision.replaceUri !== undefined) {
    throw new Error('replaceUri is only valid for replacement activation decisions.');
  }
  return request;
}

function hasControlCharacter(value: string): boolean {
  return EffectArray.some([...value], character => {
    const codePoint =
      Effect.pipe(
        character,
        EffectString.codePointAt(0),
        Effect.Option.getOrElse(() => undefined),
      ) ?? 0;
    return codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a;
  });
}
