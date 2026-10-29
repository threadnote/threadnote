import {Effect, FileSystem, Path} from 'effect';
import {trimBoundaryCharacters} from '@threadnote/platform/string-boundaries';
import {readOptionalText} from './inventory/contained_file.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const THREADNOTE_IGNORE_FILE = '.threadnoteignore';
export const THREADNOTE_IGNORE_LOCAL_FILE = '.threadnoteignore.local';

export interface CompiledIgnoreRule {
  readonly ignored: boolean;
  readonly pattern: RegExp;
  readonly source: 'committed' | 'local';
}

export interface ThreadnoteIgnoreSources {
  readonly committed: string;
  readonly local: string;
}

export function isThreadnoteIgnorePath(repositoryPath: string): boolean {
  return repositoryPath === THREADNOTE_IGNORE_FILE || repositoryPath === THREADNOTE_IGNORE_LOCAL_FILE;
}

export function isOverlayAdmissionControlPath(repositoryPath: string): boolean {
  return isThreadnoteIgnorePath(repositoryPath) || /(?:^|\/)\.gitignore$/.test(repositoryPath);
}

export const readThreadnoteIgnoreSources = Effect.fn('codeGraph.readThreadnoteIgnoreSources')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  repoRoot: string,
) {
  const [committed, local] = yield* Effect.all(
    [
      readOptionalText(fs, path.join(repoRoot, THREADNOTE_IGNORE_FILE)),
      readOptionalText(fs, path.join(repoRoot, THREADNOTE_IGNORE_LOCAL_FILE)),
    ],
    {concurrency: 2},
  );
  return {committed, local} satisfies ThreadnoteIgnoreSources;
});

export function compileThreadnoteIgnore(content: string, localContent = ''): readonly CompiledIgnoreRule[] {
  return [...compileIgnoreContent(content, 'committed'), ...compileIgnoreContent(localContent, 'local')];
}

export function isIgnoredByThreadnote(path: string, rules: readonly CompiledIgnoreRule[]): boolean {
  let committed = false;
  let local = false;
  for (const rule of rules) {
    if (!rule.pattern.test(path)) continue;
    if (rule.source === 'local') local = rule.ignored;
    else committed = rule.ignored;
  }
  return committed || local;
}

export function emptyThreadnoteIgnoreAdmissionPath(repositoryPath: string, sources: ThreadnoteIgnoreSources): boolean {
  if (repositoryPath === THREADNOTE_IGNORE_FILE) return sources.committed.length === 0;
  if (repositoryPath === THREADNOTE_IGNORE_LOCAL_FILE) return sources.local.length === 0;
  return false;
}

function compileIgnoreContent(content: string, source: CompiledIgnoreRule['source']): readonly CompiledIgnoreRule[] {
  const rules: CompiledIgnoreRule[] = [];
  for (const rawLine of Effect2.pipe(content, EffectString.split(/\r?\n/))) {
    const trimmed = Effect2.pipe(rawLine, EffectString.trim);
    if (!trimmed || Effect2.pipe(trimmed, EffectString.startsWith('#'))) continue;
    const negated = Effect2.pipe(trimmed, EffectString.startsWith('!'));
    const pattern = normalizeRepositoryPath(negated ? Effect2.pipe(trimmed, EffectString.slice(1)) : trimmed);
    if (!pattern) continue;
    const compiled = compileIgnorePattern(pattern);
    if (compiled) rules.push({ignored: !negated, pattern: compiled, source});
  }
  return rules;
}

function compileIgnorePattern(pattern: string): RegExp | undefined {
  const directoryPattern = Effect2.pipe(pattern, EffectString.endsWith('/'));
  const normalized = trimBoundaryCharacters(pattern, '/');
  if (!normalized) return undefined;
  const escaped = Effect2.pipe(
    normalized,
    EffectString.replace(/[.+^${}()|[\]\\]/g, '\\$&'),
    EffectString.replaceAll('**', '\u0000'),
    EffectString.replaceAll('*', '[^/]*'),
    EffectString.replaceAll('?', '[^/]'),
    EffectString.replaceAll('\u0000', '.*'),
  );
  const prefix = Effect2.pipe(normalized, EffectString.includes('/')) ? '^' : '(?:^|/)';
  const suffix = directoryPattern ? '(?:/|$)' : '$';
  return new RegExp(`${prefix}${escaped}${suffix}`, 'i');
}

function normalizeRepositoryPath(value: string): string {
  return Effect2.pipe(value, EffectString.replace(/^\.\/+/, ''));
}
