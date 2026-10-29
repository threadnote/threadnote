import {Array as EffectArray} from 'effect';
import {Option} from 'effect';
import {trimTrailingCharacters} from '@threadnote/platform/string-boundaries';
import type {TreeSitterImport, TreeSitterReferenceInput, TreeSitterSymbolInput} from '../../tree_sitter/extractor.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export function jvmSymbolLookupKeys(input: TreeSitterSymbolInput): readonly string[] {
  const keys = [`jvm:q:${input.qualifiedName}`];
  if (Option.isSome(input.arity)) keys.unshift(`jvm:q:${input.qualifiedName}#${input.arity.value}`);
  return keys;
}

export function jvmReferenceLookupTiers(input: TreeSitterReferenceInput): readonly (readonly string[])[] {
  if (input.relation === 'imports') {
    return Effect.pipe(input.targetName, EffectString.endsWith('.*'))
      ? []
      : withArity(`jvm:q:${input.targetName}`, input.arity);
  }
  const target = Effect.pipe(input.targetName, EffectString.replace(/\?$/, ''));
  if (!target || /^(?:super|this)(?:\.|$)/.test(target)) return [];
  const namespace = Option.getOrUndefined(input.metadata.namespace);
  const ownerType = ownerTypeName(input.owner.qualifiedName, namespace);
  const tiers: string[][] = [];

  if (Effect.pipe(target, EffectString.includes('.'))) {
    const [head, ...tail] = Effect.pipe(target, EffectString.split('.'));
    const imported = importForLocalName(input.metadata.imports, head);
    if (Option.isSome(imported)) {
      tiers.push(...withArity(`jvm:q:${EffectArray.join([imported.value.module, ...tail], '.')}`, input.arity));
    } else if (/^[A-Z]/.test(head)) {
      tiers.push(...withArity(`jvm:q:${namespace ? `${namespace}.` : ''}${target}`, input.arity));
    }
    return tiers;
  }

  if (ownerType && ['calls', 'constructs', 'overrides', 'references'].includes(input.relation)) {
    tiers.push(...withArity(`jvm:q:${ownerType}.${target}`, input.arity));
  }
  const imported = importForLocalName(input.metadata.imports, target);
  if (Option.isSome(imported)) tiers.push(...withArity(`jvm:q:${imported.value.module}`, input.arity));
  if (namespace) tiers.push(...withArity(`jvm:q:${namespace}.${target}`, input.arity));
  return deduplicateTiers(tiers);
}

export function parseJvmImport(value: string): Option.Option<TreeSitterImport> {
  const withoutKeywords = trimJvmTerminator(stripJvmKeyword(stripJvmKeyword(value, 'import'), 'static'));
  if (!withoutKeywords) return Option.none();
  const aliasMatch = /\s+as\s+([A-Za-z_$][\w$]*)$/.exec(withoutKeywords);
  const module = Effect.pipe(
    aliasMatch ? Effect.pipe(withoutKeywords, EffectString.slice(0, aliasMatch.index)) : withoutKeywords,
    EffectString.trim,
  );
  const wildcard = Effect.pipe(module, EffectString.endsWith('.*'));
  const importedName = wildcard
    ? Option.none<string>()
    : Option.some(Effect.pipe(module, EffectString.split('.')).at(-1)!);
  return Option.some({
    alias: aliasMatch ? Option.some(aliasMatch[1]) : Option.none(),
    importedName,
    module,
    wildcard,
  });
}

export function parseJvmNamespace(value: string): Option.Option<string> {
  const namespace = trimJvmTerminator(stripJvmKeyword(value, 'package'));
  return namespace ? Option.some(namespace) : Option.none();
}

function stripJvmKeyword(value: string, keyword: string): string {
  const trimmed = Effect.pipe(value, EffectString.trimStart);
  if (!Effect.pipe(trimmed, EffectString.startsWith(keyword))) return trimmed;
  const boundary = trimmed[keyword.length];
  return boundary !== undefined && /\s/u.test(boundary)
    ? Effect.pipe(trimmed, EffectString.slice(keyword.length), EffectString.trimStart)
    : trimmed;
}

function trimJvmTerminator(value: string): string {
  return trimTrailingCharacters(value, '; \t\r\n\v\f');
}

function importForLocalName(imports: readonly TreeSitterImport[], name: string): Option.Option<TreeSitterImport> {
  const candidates = EffectArray.filter(imports, item => {
    const localName = Option.getOrElse(item.alias, () => Option.getOrElse(item.importedName, () => ''));
    return !item.wildcard && localName === name;
  });
  return candidates.length === 1 ? Option.some(candidates[0]) : Option.none();
}

function ownerTypeName(qualifiedName: string, namespace: string | undefined): string | undefined {
  const withoutNamespace = namespace
    ? Effect.pipe(qualifiedName, EffectString.replace(`${namespace}.`, ''))
    : qualifiedName;
  const components = Effect.pipe(withoutNamespace, EffectString.split('.'));
  if (components.length <= 1) return undefined;
  const owner = EffectArray.join(components.slice(0, -1), '.');
  return namespace ? `${namespace}.${owner}` : owner;
}

function withArity(key: string, arity: Option.Option<number>): readonly string[][] {
  return Option.isSome(arity) ? [[`${key}#${arity.value}`], [key]] : [[key]];
}

function deduplicateTiers(tiers: readonly (readonly string[])[]): readonly (readonly string[])[] {
  const seen = new Set<string>();
  return EffectArray.flatMap(tiers, tier => {
    const unique = EffectArray.filter(tier, key => {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return unique.length > 0 ? [unique] : [];
  });
}
