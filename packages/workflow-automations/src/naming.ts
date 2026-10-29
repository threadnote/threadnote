import {WorkflowAutomationError} from './contracts.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const workflowNamingPolicyVersion = 1 as const;

export interface WorkflowNameFamily {
  readonly policyVersion: typeof workflowNamingPolicyVersion;
  readonly slug: string;
  readonly ordinal: number;
}

const MAX_ORDINAL = 1_000_000;
const MAX_TITLE_BYTES = 4_096;
const MAX_SLUG_BYTES = 80;
const MAX_ROLE_BYTES = 48;
const MAX_COMPONENT_BYTES_WITH_JSON = 200;
const encoder = new TextEncoder();

const invalidName = (message: string): WorkflowAutomationError =>
  WorkflowAutomationError.make({code: 'invalid-name', message});

const utf8Bytes = (value: string) => encoder.encode(value).byteLength;

const assertWellFormed = (value: string, label: string) => {
  for (let index = 0; index < value.length; index++) {
    const code = Effect.pipe(
      value,
      EffectString.charCodeAt(index),
      Effect.Option.getOrElse(() => NaN),
    );
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = Effect.pipe(
        value,
        EffectString.charCodeAt(index + 1),
        Effect.Option.getOrElse(() => NaN),
      );
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw invalidName(`${label} contains an unpaired Unicode surrogate.`);
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw invalidName(`${label} contains an unpaired Unicode surrogate.`);
    }
  }
};

const truncateUtf8 = (value: string, maximumBytes: number): string => {
  let result = '';
  let bytes = 0;
  for (const codePoint of value) {
    const size = utf8Bytes(codePoint);
    if (bytes + size > maximumBytes) break;
    result += codePoint;
    bytes += size;
  }
  return Effect.pipe(result, EffectString.replace(/-+$/u, ''));
};

/** Stable, readable title normalization. Collisions are resolved by family ordinals. */
export function workflowTitleSlug(title: string): string {
  if (typeof title !== 'string') throw invalidName('Workflow title must be text.');
  assertWellFormed(title, 'Workflow title');
  if (Effect.pipe(title, EffectString.trim).length === 0) throw invalidName('Workflow title must not be blank.');
  if (utf8Bytes(title) > MAX_TITLE_BYTES) throw invalidName('Workflow title exceeds 4096 UTF-8 bytes.');
  if (/\p{Cc}/u.test(title)) throw invalidName('Workflow title contains a control character.');

  const normalized = Effect.pipe(
    title,
    EffectString.normalize('NFKD'),
    EffectString.toLowerCase,
    EffectString.replace(/\p{M}+/gu, ''),
    EffectString.replace(/[^a-z0-9]+/gu, '-'),
    EffectString.replace(/-+/gu, '-'),
    EffectString.replace(/^-|-$/gu, ''),
  );
  const bounded = truncateUtf8(normalized, MAX_SLUG_BYTES);
  return bounded || 'untitled';
}

const assertOrdinal: (value: unknown, label: string) => asserts value is number = (value, label) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_ORDINAL)
    throw invalidName(`${label} must be a positive safe integer no greater than ${MAX_ORDINAL}.`);
};

function validateFamily(value: unknown): WorkflowNameFamily {
  if (typeof value !== 'object' || value === null)
    throw invalidName('Workflow name family has an unsupported policy version.');
  const policyVersion = 'policyVersion' in value ? value.policyVersion : undefined;
  if (policyVersion !== workflowNamingPolicyVersion)
    throw invalidName('Workflow name family has an unsupported policy version.');
  const slug = 'slug' in value ? value.slug : undefined;
  if (typeof slug !== 'string' || utf8Bytes(slug) > MAX_SLUG_BYTES)
    throw invalidName(`Workflow family slug must be at most ${MAX_SLUG_BYTES} UTF-8 bytes.`);
  assertWellFormed(slug, 'Workflow family slug');
  if (slug.length === 0 || workflowTitleSlug(slug) !== slug)
    throw invalidName('Workflow family slug must already be in canonical title-slug form.');
  const ordinal = 'ordinal' in value ? value.ordinal : undefined;
  assertOrdinal(ordinal, 'Workflow family ordinal');
  return {ordinal, policyVersion, slug};
}

const validateRole = (role: string) => {
  if (typeof role !== 'string' || utf8Bytes(role) > MAX_ROLE_BYTES || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(role))
    throw invalidName(`Workflow role must be canonical lowercase ASCII and at most ${MAX_ROLE_BYTES} bytes.`);
};

const assertComponentLimit = (stem: string) => {
  if (utf8Bytes(`${stem}.json`) > MAX_COMPONENT_BYTES_WITH_JSON)
    throw invalidName('Workflow filename component exceeds 200 UTF-8 bytes including .json.');
  return stem;
};

export function workflowFamilyStem(input: unknown): string {
  const family = validateFamily(input);
  return assertComponentLimit(`workflow-${family.slug}${family.ordinal === 1 ? '' : `-${family.ordinal}`}`);
}

export function workflowMemoryStem(family: WorkflowNameFamily, role: string, version = 1): string {
  validateRole(role);
  assertOrdinal(version, 'Workflow memory version');
  const suffix = version === 1 ? '' : `-v${version}`;
  return assertComponentLimit(`${workflowFamilyStem(family)}-${role}${suffix}`);
}

export function workflowArchiveStem(
  family: WorkflowNameFamily,
  role: string,
  version: number,
  archiveOrdinal: number,
): string {
  validateRole(role);
  assertOrdinal(version, 'Workflow memory version');
  assertOrdinal(archiveOrdinal, 'Workflow archive ordinal');
  const versionSuffix = version === 1 ? '' : `-v${version}`;
  return assertComponentLimit(`${workflowFamilyStem(family)}-${role}${versionSuffix}-archive-${archiveOrdinal}`);
}
