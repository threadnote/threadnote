import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const MANAGER_WORKSET_NAME_BYTES_MAXIMUM = 256;

export const MANAGER_WORKSET_DESCRIPTION_BYTES_MAXIMUM = 4_096;

export const MANAGER_WORKSET_SELECTOR_BYTES_MAXIMUM = 4_096;

export function safeLabel(value: string): string {
  return (
    Effect2.pipe(
      value,
      EffectString.replace(/[\r\n\t\0]/gu, ' '),
      EffectString.trim,
      EffectString.slice(0, MANAGER_WORKSET_NAME_BYTES_MAXIMUM),
    ) || 'unknown'
  );
}

export function safeDescription(value: string): string {
  return Effect2.pipe(
    value,
    EffectString.replace(/[\r\n\t\0]/gu, ' '),
    EffectString.trim,
    EffectString.slice(0, MANAGER_WORKSET_DESCRIPTION_BYTES_MAXIMUM),
  );
}

export function safeLocalPath(value: string): string {
  return Effect2.pipe(
    value,
    EffectString.replace(/[\r\n\t\0]/gu, ' '),
    EffectString.trim,
    EffectString.slice(0, MANAGER_WORKSET_SELECTOR_BYTES_MAXIMUM),
  );
}
