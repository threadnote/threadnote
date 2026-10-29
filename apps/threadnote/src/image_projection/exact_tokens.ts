import {Array as EffectArray} from 'effect';
import {trimTrailingCharacters} from '@threadnote/platform/string-boundaries';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const IMAGE_PROJECTION_EXACT_TOKEN_LIMIT = 256 as const;

const TOKEN_PATTERNS = [
  /threadnote:\/\/[^\s)\]>'"`]+/gu,
  /\btn_[a-z0-9]+/giu,
  /\btnrc_[a-f0-9]+/giu,
  /\btncc_[a-f0-9]+/giu,
  /\bcgs_[a-f0-9]{32}\b/giu,
  /\bcgr_[a-z0-9_]+/giu,
  /\bcgsn_[a-f0-9]+/giu,
  /\bcgwc_[a-z0-9_]+/giu,
] as const;

export function extractExactMemoryTokens(text: string): readonly string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const pattern of TOKEN_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of Effect.pipe(text, EffectString.matchAll(pattern))) {
      const token = trimTrailingUriPunctuation(match[0]);
      if (token.length === 0 || seen.has(token)) continue;
      seen.add(token);
      tokens.push(token);
      if (tokens.length >= IMAGE_PROJECTION_EXACT_TOKEN_LIMIT) return tokens;
    }
  }
  return tokens;
}

export function renderExactTokenAppendix(tokens: readonly string[]): string | undefined {
  if (tokens.length === 0) return undefined;
  return `Exact values (verbatim — trust these over the image):\n${EffectArray.join(tokens, '\n')}`;
}

function trimTrailingUriPunctuation(value: string): string {
  return Effect.pipe(value, EffectString.startsWith('threadnote://')) ? trimTrailingCharacters(value, '.,;:') : value;
}
