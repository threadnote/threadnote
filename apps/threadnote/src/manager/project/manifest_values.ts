import {Array as EffectArray} from 'effect';
import {parseResourceId} from '@threadnote/store/resource-id';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const UTF8 = new TextEncoder();

export function validateManagerConfiguredProjectPath(value: string, maximumBytes: number): string {
  if (value.length === 0 || UTF8.encode(value).byteLength > maximumBytes || hasControlCharacter(value)) {
    throw new Error('Project path must be bounded text without control characters.');
  }
  if (!isAbsoluteProjectPath(value)) throw new Error('Project path must be absolute or start with ~/.');
  const normalized = Effect.pipe(value, EffectString.replaceAll('\\', '/'));
  if (Effect.pipe(normalized, EffectString.split('/')).includes('..'))
    throw new Error('Project path must not contain parent traversal segments.');
  return value;
}

export function validateManagerConfiguredProjectUri(value: string, retainedCanonicalUri?: string): string {
  try {
    const parsed = parseResourceId(value);
    if (
      parsed.anchor !== undefined ||
      parsed.namespace !== 'resources' ||
      parsed.segments[0] !== 'repos' ||
      parsed.segments.length < 2
    ) {
      throw new Error('unsupported project resource root');
    }
    if (parsed.canonicalUri !== value && parsed.canonicalUri !== retainedCanonicalUri) {
      throw new Error('noncanonical project resource root');
    }
    return parsed.canonicalUri;
  } catch {
    throw new Error('Project URI must be a canonical anchorless threadnote://resources/repos/... root.');
  }
}

function isAbsoluteProjectPath(value: string): boolean {
  return (
    Effect.pipe(value, EffectString.startsWith('/')) ||
    value === '~' ||
    Effect.pipe(value, EffectString.startsWith('~/')) ||
    Effect.pipe(value, EffectString.startsWith('~\\')) ||
    /^[a-z]:[\\/]/iu.test(value) ||
    /^\\\\/u.test(value)
  );
}

function hasControlCharacter(value: string): boolean {
  return EffectArray.some([...value], character => {
    const code =
      Effect.pipe(
        character,
        EffectString.codePointAt(0),
        Effect.Option.getOrElse(() => undefined),
      ) ?? 0;
    return code <= 31 || code === 127;
  });
}
