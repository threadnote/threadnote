import {Array as EffectArray} from 'effect';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export function globToRegExp(glob: string): RegExp {
  let output = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*') {
      const next = glob[index + 1];
      if (next === '*') {
        const afterNext = glob[index + 2];
        if (afterNext === '/') {
          output += '(?:.*/)?';
          index += 2;
        } else {
          output += '.*';
          index += 1;
        }
      } else {
        output += '[^/]*';
      }
    } else if (char === '?') {
      output += '[^/]';
    } else {
      output += escapeRegExp(char);
    }
  }
  output += '$';
  return new RegExp(output);
}

export function getGlobBase(pattern: string): string {
  const parts = Effect.pipe(pattern, EffectString.split('/'));
  const baseParts: string[] = [];
  for (const part of parts) {
    if (hasGlob(part)) break;
    baseParts.push(part);
  }
  return baseParts.length === 0 ? '.' : EffectArray.join(baseParts, '/');
}

export function hasGlob(path: string): boolean {
  return Effect.pipe(path, EffectString.includes('*')) || Effect.pipe(path, EffectString.includes('?'));
}

export function escapeRegExp(value: string): string {
  return Effect.pipe(value, EffectString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}
