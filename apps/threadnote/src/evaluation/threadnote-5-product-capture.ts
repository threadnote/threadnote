import {Array as EffectArray, Option as EffectOption} from 'effect';
import {canonicalJson, type CanonicalJsonValue} from '@threadnote/graph/checkpoint/canonical_json';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  parseThreadnote5TrustedSourceV1,
  THREADNOTE_5_RELEASE_SCENARIOS,
  type Threadnote5ReleaseScenario,
  type Threadnote5SourceV1,
} from './threadnote-5-release-readiness-contract.js';
import {exactObject, integerIn} from './threadnote-5-release-readiness-validation.js';
import {
  parseThreadnote5ProductEventV1,
  type ProductCaptureSource,
  type Threadnote5ProductEventV1,
} from './threadnote-5-product-capture-events.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const PRODUCT_CAPTURE_LIMITS = {
  arrayItems: 256,
  bytes: 1_048_576,
  configurationBytes: 8_192,
  depth: 24,
  entries: 8_192,
  keyBytes: 128,
  objectFields: 64,
  rootBytes: 4_096,
  stringBytes: 65_536,
} as const;

export interface Threadnote5ProductCaptureIdentityV1 {
  readonly attempt: number;
  readonly candidate: Threadnote5SourceV1;
  readonly scenario: Threadnote5ReleaseScenario;
  readonly trial: number;
  readonly version: 1;
}

export type Threadnote5ProductCaptureV1 = Threadnote5ProductCaptureIdentityV1 &
  Threadnote5ProductEventV1 & {
    readonly digest: string;
    readonly type: 'threadnote-product-capture';
  };

const identityKeys = ['attempt', 'candidate', 'scenario', 'trial', 'version'] as const;
const scenarioSources: Readonly<Record<Threadnote5ReleaseScenario, readonly ProductCaptureSource[]>> = {
  solo: ['activation', 'context-brief', 'value-report'],
  'two-agent': ['activation', 'value-report'],
  'git-shared': ['activation', 'value-report'],
  offline: ['activation', 'value-report'],
  'dirty-worktree': ['context-check'],
  'interrupted-resumed': ['activation', 'closeout'],
  'upgrade-downgrade': [],
  'provider-neutral-proposal': ['git-proposal'],
  'verified-procedures': ['procedure'],
  'health-maintenance': ['context-health'],
  'structured-closeout': ['closeout'],
  'stale-citation': ['context-health'],
  'contradiction-triage': ['context-health'],
  'projection-drift': ['guidance'],
  'output-budgets': ['context-brief', 'closeout'],
};

/** Canonical JSON is validated before native parsing; accessors and exotic objects never reach parsers. */
export function productCaptureCanonicalJson(value: unknown): string {
  const limits = PRODUCT_CAPTURE_LIMITS;
  const serialized = canonicalJson(value, {
    maximumContainerEntries: limits.entries,
    maximumDepth: limits.depth,
    maximumInputCodeUnits: limits.bytes,
    maximumStringCodeUnits: limits.stringBytes,
  });
  if (Buffer.byteLength(serialized, 'utf8') > limits.bytes) throw new Error('Product capture exceeds its byte bound.');
  const visit = (item: unknown): void => {
    if (typeof item === 'string' && Buffer.byteLength(item, 'utf8') > limits.stringBytes) {
      throw new Error('Product capture string exceeds its byte bound.');
    }
    if (EffectArray.isArray(item)) {
      if (item.length > limits.arrayItems) throw new Error('Product capture array exceeds its cardinality bound.');
      for (const entry of item) visit(entry);
    } else if (item !== null && typeof item === 'object') {
      const entries = EffectRecord.toEntries(item);
      if (entries.length > limits.objectFields) throw new Error('Product capture object exceeds its field bound.');
      for (const [key, entry] of entries) {
        if (Buffer.byteLength(key, 'utf8') > limits.keyBytes)
          throw new Error('Product capture key exceeds its byte bound.');
        visit(entry);
      }
    }
  };
  visit(value);
  return serialized;
}

export function parseThreadnote5ProductCaptureIdentityV1(value: unknown): Threadnote5ProductCaptureIdentityV1 {
  productCaptureCanonicalJson(value);
  const input = exactObject(value, identityKeys, 'Product capture identity');
  if (input.version !== 1 || !integerIn(input.attempt, 0, 63) || !integerIn(input.trial, 0, 63)) {
    throw new Error('Product capture version or trial/attempt identity is invalid.');
  }
  const scenario = EffectOption.getOrUndefined(
    EffectArray.findFirst(THREADNOTE_5_RELEASE_SCENARIOS, item => item === input.scenario),
  );
  if (scenario === undefined) throw new Error('Product capture scenario is unsupported.');
  return {
    attempt: input.attempt,
    candidate: parseThreadnote5TrustedSourceV1(input.candidate, 'candidate'),
    scenario,
    trial: input.trial,
    version: 1,
  };
}

export function createThreadnote5ProductCaptureV1(identity: unknown, event: unknown): Threadnote5ProductCaptureV1 {
  const parsedIdentity = parseThreadnote5ProductCaptureIdentityV1(identity);
  const snapshot: unknown = JSON.parse(productCaptureCanonicalJson(event));
  const parsedEvent = parseThreadnote5ProductEventV1(snapshot);
  if (!scenarioSources[parsedIdentity.scenario].includes(parsedEvent.source)) {
    throw new Error('Product capture source does not belong to the scenario.');
  }
  const body = {...parsedIdentity, ...parsedEvent, type: 'threadnote-product-capture' as const};
  const digest = sha256HexSync(`threadnote-product-capture-v1\0${productCaptureCanonicalJson(body)}`);
  const envelope = {...body, digest};
  productCaptureCanonicalJson(envelope);
  return envelope;
}

export function parseThreadnote5ProductCaptureV1(value: unknown): Threadnote5ProductCaptureV1 {
  productCaptureCanonicalJson(value);
  const input = exactObject(
    value,
    [...identityKeys, 'digest', 'event', 'payload', 'sequence', 'source', 'type'],
    'Product capture envelope',
  );
  if (input.type !== 'threadnote-product-capture') throw new Error('Product capture type is unsupported.');
  const parsed = createThreadnote5ProductCaptureV1(
    {
      attempt: input.attempt,
      candidate: input.candidate,
      scenario: input.scenario,
      trial: input.trial,
      version: input.version,
    },
    {event: input.event, payload: input.payload, sequence: input.sequence, source: input.source},
  );
  if (productCaptureCanonicalJson(input) !== productCaptureCanonicalJson(parsed)) {
    throw new Error('Product capture digest or native canonical form does not match.');
  }
  return parsed;
}

export function productCaptureIdentityDigest(identity: Threadnote5ProductCaptureIdentityV1): string {
  return sha256HexSync(
    `threadnote-product-capture-identity-v1\0${productCaptureCanonicalJson(parseThreadnote5ProductCaptureIdentityV1(identity))}`,
  );
}

export function productCaptureFilename(value: Threadnote5ProductCaptureV1): string {
  const parsed = parseThreadnote5ProductCaptureV1(value);
  return `${parsed.source}-${Effect.pipe(String(parsed.sequence), EffectString.padStart(3, '0'))}.json`;
}

export function parseProductCaptureConfiguration(value: string): {
  readonly identity: Threadnote5ProductCaptureIdentityV1;
  readonly root: string;
} {
  if (Buffer.byteLength(value, 'utf8') > PRODUCT_CAPTURE_LIMITS.configurationBytes)
    throw new Error('Product capture configuration is too large.');
  const parsed: CanonicalJsonValue = JSON.parse(value);
  productCaptureCanonicalJson(parsed);
  const input = exactObject(parsed, [...identityKeys, 'root'], 'Product capture configuration');
  if (
    typeof input.root !== 'string' ||
    Buffer.byteLength(input.root, 'utf8') > PRODUCT_CAPTURE_LIMITS.rootBytes ||
    EffectArray.some(
      [...input.root],
      character =>
        Effect.pipe(
          character,
          EffectString.charCodeAt(0),
          Effect.Option.getOrElse(() => NaN),
        ) < 32 ||
        Effect.pipe(
          character,
          EffectString.charCodeAt(0),
          Effect.Option.getOrElse(() => NaN),
        ) === 127 ||
        character === '\\',
    )
  ) {
    throw new Error('Product capture root is invalid.');
  }
  return {
    identity: parseThreadnote5ProductCaptureIdentityV1({
      attempt: input.attempt,
      candidate: input.candidate,
      scenario: input.scenario,
      trial: input.trial,
      version: input.version,
    }),
    root: input.root,
  };
}
