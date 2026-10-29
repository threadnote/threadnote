import {Array as EffectArray} from 'effect';
import {Option} from 'effect';
import type {TreeSitterImport, TreeSitterReferenceInput, TreeSitterSymbolInput} from '../../tree_sitter/extractor.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export function genericSymbolLookupKeys(domain: string, input: TreeSitterSymbolInput): readonly string[] {
  return withArity(
    [`${domain}:q:${normalizeQualifiedName(input.qualifiedName)}`, `${domain}:name:${normalizeName(input.name)}`],
    input.arity,
  );
}

export function genericReferenceLookupTiers(
  domain: string,
  input: TreeSitterReferenceInput,
): readonly (readonly string[])[] {
  const target = normalizeQualifiedName(input.targetName);
  if (!target || /^(?:self|super|this)$/.test(target)) return [];
  const tiers: string[][] = [];
  const imported = importForLocalName(
    input.metadata.imports,
    Effect.pipe(target, EffectString.split('.')).at(0) ?? target,
  );
  if (Option.isSome(imported)) {
    const tail = Effect.pipe(target, EffectString.split('.')).slice(1);
    tiers.push(...keyTiers(domain, EffectArray.join([imported.value.module, ...tail], '.'), input.arity));
  }
  if (Effect.pipe(target, EffectString.includes('.'))) tiers.push(...keyTiers(domain, target, input.arity));
  const namespace = Option.getOrUndefined(input.metadata.namespace);
  const owner = EffectArray.join(Effect.pipe(input.owner.qualifiedName, EffectString.split('.')).slice(0, -1), '.');
  if (owner) tiers.push(...keyTiers(domain, `${owner}.${target}`, input.arity));
  if (namespace) tiers.push(...keyTiers(domain, `${namespace}.${target}`, input.arity));
  tiers.push(...nameTiers(domain, Effect.pipe(target, EffectString.split('.')).at(-1) ?? target, input.arity));
  return deduplicateTiers(tiers);
}

export function simpleImport(module: string, importedName?: string, alias?: string): Option.Option<TreeSitterImport> {
  const normalized = normalizeQualifiedName(module);
  if (!normalized) return Option.none();
  return Option.some({
    alias: alias ? Option.some(alias) : Option.none(),
    importedName: importedName ? Option.some(importedName) : Option.none(),
    module: normalized,
    wildcard: Effect.pipe(normalized, EffectString.endsWith('.*')),
  });
}

export function normalizeQualifiedName(value: string): string {
  return Effect.pipe(
    value,
    EffectString.trim,
    EffectString.replace(/^["'`]|["'`;]$/g, ''),
    EffectString.replace(/^(?:&|\*|::)+/, ''),
    EffectString.replace(/(?:->|::|\\|\/)+/g, '.'),
    EffectString.replace(/^\.+|\.+$/g, ''),
    EffectString.replace(/\.+/g, '.'),
  );
}

function normalizeName(value: string): string {
  return Effect.pipe(normalizeQualifiedName(value), EffectString.split('.')).at(-1) ?? value;
}

function importForLocalName(imports: readonly TreeSitterImport[], name: string): Option.Option<TreeSitterImport> {
  const candidates = EffectArray.filter(imports, item => {
    const localName = Option.getOrElse(item.alias, () => Option.getOrElse(item.importedName, () => ''));
    return !item.wildcard && normalizeName(localName) === normalizeName(name);
  });
  return candidates.length === 1 ? Option.some(candidates[0]) : Option.none();
}

function keyTiers(domain: string, qualifiedName: string, arity: Option.Option<number>): string[][] {
  const key = `${domain}:q:${normalizeQualifiedName(qualifiedName)}`;
  return Option.isSome(arity) ? [[`${key}#${arity.value}`], [key]] : [[key]];
}

function nameTiers(domain: string, name: string, arity: Option.Option<number>): string[][] {
  const key = `${domain}:name:${normalizeName(name)}`;
  return Option.isSome(arity) ? [[`${key}#${arity.value}`], [key]] : [[key]];
}

function withArity(keys: readonly string[], arity: Option.Option<number>): readonly string[] {
  return Option.isSome(arity) ? [...EffectArray.map(keys, key => `${key}#${arity.value}`), ...keys] : keys;
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
