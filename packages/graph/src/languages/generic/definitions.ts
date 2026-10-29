import {Array as EffectArray} from 'effect';
import {Option} from 'effect';
import type {Node} from 'web-tree-sitter';
import type {TreeSitterLanguageDefinition} from '../../tree_sitter/extractor.js';
import {
  BASH_GRAMMAR,
  CPP_GRAMMAR,
  CSHARP_GRAMMAR,
  C_GRAMMAR,
  GO_GRAMMAR,
  HCL_GRAMMAR,
  PHP_GRAMMAR,
  PYTHON_GRAMMAR,
  RUBY_GRAMMAR,
  RUST_GRAMMAR,
} from '../tree_sitter_assets.js';
import type {CodeGraphLanguagePack} from '../types.js';
import {createGenericTreeSitterLanguagePack} from './factory.js';
import {genericReferenceLookupTiers, genericSymbolLookupKeys, simpleImport} from './lookup.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const SOURCE_CAPABILITIES = new Set(['calls', 'declarations', 'imports', 'inheritance'] as const);

export const pythonLanguagePack = createGenericTreeSitterLanguagePack({
  capabilities: SOURCE_CAPABILITIES,
  definition: languageDefinition({
    asset: PYTHON_GRAMMAR,
    declarationQuery: `
      (class_definition name: (identifier) @name) @definition.class
      (function_definition name: (identifier) @name) @definition.function
    `,
    exported: node => !/^_/.test(node.childForFieldName('name')?.text ?? ''),
    id: 'python',
    importFromNode: node => pythonImport(node.text),
    metadataQuery: `
      (import_statement) @metadata.import
      (import_from_statement) @metadata.import
    `,
    namespaceFromNode: () => Option.none(),
    referenceQuery: `
      (import_statement) @reference.import
      (import_from_statement) @reference.import
      (call function: (_) @reference.call)
      (class_definition superclasses: (argument_list [(identifier) (attribute)] @reference.extend))
    `,
    referenceTarget: (capture, node) =>
      capture === 'reference.import'
        ? Option.getOrElse(pythonImport(node.text), () => emptyImport()).module
        : node.text,
    resolutionDomain: 'python',
  }),
  definitionVersion: 'python-structural-v1',
  files: [
    {kind: 'extension', language: 'python', role: 'source', value: '.py'},
    {kind: 'extension', language: 'python', role: 'source', value: '.pyi'},
  ],
});

export const goLanguagePack = createGenericTreeSitterLanguagePack({
  capabilities: SOURCE_CAPABILITIES,
  definition: languageDefinition({
    asset: GO_GRAMMAR,
    declarationKind: (capture, node) => {
      if (capture !== 'definition.type') return Effect.pipe(capture, EffectString.replace(/^definition\./, ''));
      const type = node.childForFieldName('type')?.type;
      return type === 'struct_type' ? 'struct' : type === 'interface_type' ? 'interface' : 'type';
    },
    declarationQuery: `
      (type_spec name: (type_identifier) @name) @definition.type
      (function_declaration name: (identifier) @name) @definition.function
      (method_declaration name: (field_identifier) @name) @definition.method
      (method_elem name: (field_identifier) @name) @definition.method
    `,
    exported: node => /^[A-Z]/.test(node.childForFieldName('name')?.text ?? ''),
    id: 'go',
    importFromNode: node => goImport(node.text),
    metadataQuery: `
      (package_clause) @metadata.namespace
      (import_spec) @metadata.import
    `,
    namespaceFromNode: node => {
      const name = Option.getOrUndefined(
        EffectArray.findFirst(node.namedChildren, child => child.type === 'package_identifier'),
      )?.text;
      return name ? Option.some(name) : Option.none();
    },
    referenceQuery: `
      (import_spec) @reference.import
      (call_expression function: (_) @reference.call)
      (composite_literal type: (_) @reference.construct)
    `,
    referenceRelation: capture => (capture === 'reference.construct' ? 'constructs' : relationForCapture(capture)),
    referenceTarget: (capture, node) =>
      capture === 'reference.import' ? Option.getOrElse(goImport(node.text), () => emptyImport()).module : node.text,
    resolutionDomain: 'go',
  }),
  definitionVersion: 'go-structural-v1',
  files: [{kind: 'extension', language: 'go', role: 'source', value: '.go'}],
});

export const rustLanguagePack = createGenericTreeSitterLanguagePack({
  capabilities: SOURCE_CAPABILITIES,
  definition: languageDefinition({
    asset: RUST_GRAMMAR,
    declarationQuery: `
      (struct_item name: (type_identifier) @name) @definition.struct
      (enum_item name: (type_identifier) @name) @definition.enum
      (trait_item name: (type_identifier) @name) @definition.trait
      (union_item name: (type_identifier) @name) @definition.union
      (type_item name: (type_identifier) @name) @definition.type
      (function_item name: (identifier) @name) @definition.function
      (function_signature_item name: (identifier) @name) @definition.method
      (mod_item name: (identifier) @name) @definition.module
      (const_item name: (identifier) @name) @definition.constant
      (static_item name: (identifier) @name) @definition.static
      (impl_item type: (_) @name) @definition.impl
    `,
    exported: rustExported,
    id: 'rust',
    importFromNode: node => rustImport(node.text),
    metadataQuery: `(use_declaration) @metadata.import`,
    namespaceFromNode: () => Option.none(),
    referenceQuery: `
      (use_declaration) @reference.import
      (call_expression function: (_) @reference.call)
      (macro_invocation macro: (_) @reference.call)
      (struct_expression name: (_) @reference.construct)
      (impl_item trait: (_) @reference.implement)
    `,
    referenceRelation: capture => relationForCapture(capture),
    referenceTarget: (capture, node) =>
      capture === 'reference.import' ? Option.getOrElse(rustImport(node.text), () => emptyImport()).module : node.text,
    resolutionDomain: 'rust',
  }),
  definitionVersion: 'rust-structural-v1',
  files: [{kind: 'extension', language: 'rust', role: 'source', value: '.rs'}],
});

export const cLanguagePack = createGenericTreeSitterLanguagePack({
  capabilities: SOURCE_CAPABILITIES,
  definition: languageDefinition({
    asset: C_GRAMMAR,
    declarationQuery: `
      (struct_specifier name: (type_identifier) @name) @definition.struct
      (union_specifier name: (type_identifier) @name) @definition.union
      (enum_specifier name: (type_identifier) @name) @definition.enum
      (type_definition declarator: (type_identifier) @name) @definition.type
      (function_definition declarator: (function_declarator declarator: (identifier) @name)) @definition.function
      (declaration declarator: (function_declarator declarator: (identifier) @name)) @definition.function
    `,
    exported: node => !/^\s*static\b/.test(node.text),
    id: 'c',
    importFromNode: node => includeImport(node.text),
    metadataQuery: `(preproc_include) @metadata.import`,
    namespaceFromNode: () => Option.none(),
    referenceQuery: `
      (preproc_include) @reference.import
      (call_expression function: (_) @reference.call)
    `,
    referenceTarget: (capture, node) =>
      capture === 'reference.import'
        ? Option.getOrElse(includeImport(node.text), () => emptyImport()).module
        : node.text,
    resolutionDomain: 'c-family',
  }),
  definitionVersion: 'c-structural-v1',
  files: [
    {kind: 'extension', language: 'c', role: 'source', value: '.c'},
    {kind: 'extension', language: 'c', role: 'source', value: '.h'},
  ],
});

export const cppLanguagePack = createGenericTreeSitterLanguagePack({
  capabilities: SOURCE_CAPABILITIES,
  definition: languageDefinition({
    asset: CPP_GRAMMAR,
    declarationKind: (capture, node) => {
      if (capture !== 'definition.class') return Effect.pipe(capture, EffectString.replace(/^definition\./, ''));
      return /^\s*struct\b/.test(node.text) ? 'struct' : /^\s*union\b/.test(node.text) ? 'union' : 'class';
    },
    declarationQuery: `
      (namespace_definition name: (namespace_identifier) @name) @definition.namespace
      (class_specifier name: (type_identifier) @name) @definition.class
      (enum_specifier name: (type_identifier) @name) @definition.enum
      (alias_declaration name: (type_identifier) @name) @definition.type
      (function_definition declarator: (function_declarator declarator: [(identifier) (field_identifier)] @name)) @definition.function
      (function_definition declarator: (function_declarator declarator: (qualified_identifier name: (_) @name))) @definition.function
      (declaration declarator: (function_declarator declarator: [(identifier) (field_identifier)] @name)) @definition.function
    `,
    exported: node => !/^\s*static\b/.test(node.text) && !/\bprivate\s*:/.test(node.parent?.text ?? ''),
    id: 'cpp',
    importFromNode: node => includeImport(node.text),
    metadataQuery: `(preproc_include) @metadata.import`,
    namespaceFromNode: () => Option.none(),
    referenceQuery: `
      (preproc_include) @reference.import
      (call_expression function: (_) @reference.call)
      (new_expression type: (_) @reference.construct)
      (base_class_clause [(type_identifier) (qualified_identifier)] @reference.extend)
    `,
    referenceRelation: capture => relationForCapture(capture),
    referenceTarget: (capture, node) =>
      capture === 'reference.import'
        ? Option.getOrElse(includeImport(node.text), () => emptyImport()).module
        : node.text,
    resolutionDomain: 'c-family',
  }),
  definitionVersion: 'cpp-structural-v1',
  files: [
    {kind: 'extension', language: 'cpp', role: 'source', value: '.cc'},
    {kind: 'extension', language: 'cpp', role: 'source', value: '.cpp'},
    {kind: 'extension', language: 'cpp', role: 'source', value: '.cxx'},
    {kind: 'extension', language: 'cpp', role: 'source', value: '.hh'},
    {kind: 'extension', language: 'cpp', role: 'source', value: '.hpp'},
    {kind: 'extension', language: 'cpp', role: 'source', value: '.hxx'},
    {kind: 'extension', language: 'cpp', role: 'source', value: '.ipp'},
    {kind: 'extension', language: 'cpp', role: 'source', value: '.tpp'},
  ],
});

export const csharpLanguagePack = createGenericTreeSitterLanguagePack({
  capabilities: SOURCE_CAPABILITIES,
  definition: languageDefinition({
    asset: CSHARP_GRAMMAR,
    declarationQuery: `
      (class_declaration name: (identifier) @name) @definition.class
      (interface_declaration name: (identifier) @name) @definition.interface
      (struct_declaration name: (identifier) @name) @definition.struct
      (record_declaration name: (identifier) @name) @definition.record
      (enum_declaration name: (identifier) @name) @definition.enum
      (delegate_declaration name: (identifier) @name) @definition.delegate
      (method_declaration name: (identifier) @name) @definition.method
      (constructor_declaration name: (identifier) @name) @definition.constructor
      (property_declaration name: (identifier) @name) @definition.property
      (enum_member_declaration name: (identifier) @name) @definition.enum_case
      (variable_declarator name: (identifier) @name) @definition.field
    `,
    exported: node => /\bpublic\b|\bprotected\b/.test(header(node)) && !/\bprivate\b/.test(header(node)),
    id: 'csharp',
    importFromNode: node => csharpImport(node.text),
    metadataQuery: `
      (namespace_declaration) @metadata.namespace
      (file_scoped_namespace_declaration) @metadata.namespace
      (using_directive) @metadata.import
    `,
    namespaceFromNode: node => {
      const name = node.childForFieldName('name')?.text;
      return name ? Option.some(name) : Option.none();
    },
    referenceQuery: `
      (using_directive) @reference.import
      (invocation_expression function: (_) @reference.call)
      (object_creation_expression type: (_) @reference.construct)
      (base_list [(identifier) (qualified_name)] @reference.extend)
    `,
    referenceRelation: (capture, node) => {
      if (capture === 'reference.extend' && /^I[A-Z]/.test(node.text)) return 'implements';
      return relationForCapture(capture);
    },
    referenceTarget: (capture, node) =>
      capture === 'reference.import'
        ? Option.getOrElse(csharpImport(node.text), () => emptyImport()).module
        : node.text,
    resolutionDomain: 'dotnet',
  }),
  definitionVersion: 'csharp-structural-v1',
  files: [{kind: 'extension', language: 'csharp', role: 'source', value: '.cs'}],
});

export const rubyLanguagePack = createGenericTreeSitterLanguagePack({
  capabilities: SOURCE_CAPABILITIES,
  definition: languageDefinition({
    asset: RUBY_GRAMMAR,
    declarationQuery: `
      (module name: (_) @name) @definition.module
      (class name: (_) @name) @definition.class
      (method name: (identifier) @name) @definition.method
      (singleton_method name: (identifier) @name) @definition.method
    `,
    exported: node => !/^_/.test(node.childForFieldName('name')?.text ?? ''),
    id: 'ruby',
    importFromNode: node => rubyImport(node.text),
    metadataQuery: `(call) @metadata.import`,
    namespaceFromNode: () => Option.none(),
    referenceQuery: `
      (call method: (identifier) @reference.call)
      (class superclass: (superclass (_) @reference.extend))
    `,
    referenceRelation: (capture, node) =>
      capture === 'reference.call' && /^(?:require|require_relative|load)$/.test(node.text)
        ? 'imports'
        : relationForCapture(capture),
    referenceTarget: (capture, node) => {
      if (capture !== 'reference.call') return node.text;
      const call = node.parent;
      const imported = call ? rubyImport(call.text) : Option.none();
      return Option.isSome(imported) ? imported.value.module : node.text;
    },
    resolutionDomain: 'ruby',
  }),
  definitionVersion: 'ruby-structural-v1',
  files: [
    {kind: 'extension', language: 'ruby', role: 'source', value: '.rb'},
    {kind: 'extension', language: 'ruby', role: 'source', value: '.rake'},
    {kind: 'basename', language: 'ruby', role: 'source', value: 'Rakefile'},
  ],
});

export const phpLanguagePack = createGenericTreeSitterLanguagePack({
  capabilities: SOURCE_CAPABILITIES,
  definition: languageDefinition({
    asset: PHP_GRAMMAR,
    declarationQuery: `
      (class_declaration name: (name) @name) @definition.class
      (interface_declaration name: (name) @name) @definition.interface
      (trait_declaration name: (name) @name) @definition.trait
      (enum_declaration name: (name) @name) @definition.enum
      (function_definition name: (name) @name) @definition.function
      (method_declaration name: (name) @name) @definition.method
    `,
    exported: node => !/\bprivate\b/.test(header(node)),
    id: 'php',
    importFromNode: node => phpImport(node.text),
    metadataQuery: `
      (namespace_definition) @metadata.namespace
      (namespace_use_declaration) @metadata.import
    `,
    namespaceFromNode: node => {
      const name = node.childForFieldName('name')?.text;
      return name ? Option.some(name) : Option.none();
    },
    referenceQuery: `
      (namespace_use_declaration) @reference.import
      (function_call_expression function: (_) @reference.call)
      (member_call_expression name: (_) @reference.call)
      (object_creation_expression (name) @reference.construct)
      (base_clause (name) @reference.extend)
      (class_interface_clause (name) @reference.implement)
    `,
    referenceRelation: capture => relationForCapture(capture),
    referenceTarget: (capture, node) =>
      capture === 'reference.import' ? Option.getOrElse(phpImport(node.text), () => emptyImport()).module : node.text,
    resolutionDomain: 'php',
  }),
  definitionVersion: 'php-structural-v1',
  files: [
    {kind: 'extension', language: 'php', role: 'source', value: '.php'},
    {kind: 'extension', language: 'php', role: 'source', value: '.phtml'},
  ],
});

export const bashLanguagePack = createGenericTreeSitterLanguagePack({
  capabilities: new Set(['calls', 'declarations', 'imports']),
  definition: languageDefinition({
    asset: BASH_GRAMMAR,
    declarationQuery: `(function_definition name: (word) @name) @definition.function`,
    exported: () => true,
    id: 'bash',
    importFromNode: node => bashImport(node.text),
    metadataQuery: `(command) @metadata.import`,
    namespaceFromNode: () => Option.none(),
    referenceQuery: `(command name: (command_name (word) @reference.call))`,
    referenceRelation: (_capture, node) => (/^(?:source|\.)$/.test(node.text) ? 'imports' : 'calls'),
    referenceTarget: (_capture, node) => {
      const command = node.parent?.parent;
      const imported = command ? bashImport(command.text) : Option.none();
      return Option.isSome(imported) ? imported.value.module : node.text;
    },
    resolutionDomain: 'bash',
  }),
  definitionVersion: 'bash-structural-v1',
  files: [
    {kind: 'extension', language: 'bash', role: 'source', value: '.sh'},
    {kind: 'extension', language: 'bash', role: 'source', value: '.bash'},
    {kind: 'basename', language: 'bash', role: 'source', value: 'Bashfile'},
  ],
});

export const hclLanguagePack = createGenericTreeSitterLanguagePack({
  capabilities: new Set(['declarations', 'dependencies']),
  definition: languageDefinition({
    asset: HCL_GRAMMAR,
    declarationKind: (capture, node) =>
      capture === 'definition.block'
        ? (Option.getOrUndefined(EffectArray.findFirst(node.namedChildren, child => child.type === 'identifier'))
            ?.text ?? 'block')
        : 'property',
    declarationName: (capture, declaration, name) =>
      capture === 'definition.block' ? hclBlockName(declaration) : name.text,
    declarationQuery: `
      (block (identifier) @name) @definition.block
      (attribute (identifier) @name) @definition.property
    `,
    exported: () => true,
    id: 'hcl',
    importFromNode: node => simpleImport(stripQuotes(node.text)),
    metadataQuery: `(config_file) @metadata.ignore`,
    namespaceFromNode: () => Option.none(),
    referenceQuery: `
      (variable_expr (identifier) @reference.reference)
      (attribute
        (identifier) @_source
        (expression (literal_value (string_lit) @reference.import))
        (#eq? @_source "source"))
    `,
    referenceRelation: capture => (capture === 'reference.import' ? 'imports' : 'references'),
    referenceTarget: (_capture, node) => stripQuotes(node.text),
    resolutionDomain: 'hcl',
  }),
  definitionVersion: 'hcl-terraform-structural-v1',
  files: [
    {kind: 'extension', language: 'hcl', role: 'source', value: '.hcl'},
    {kind: 'extension', language: 'terraform', role: 'source', value: '.tf'},
    {kind: 'extension', language: 'terraform-vars', role: 'manifest', value: '.tfvars'},
  ],
});

function languageDefinition(
  definition: Omit<TreeSitterLanguageDefinition, 'lookupKeysForSymbol' | 'lookupTiersForReference'>,
): TreeSitterLanguageDefinition {
  return {
    ...definition,
    lookupKeysForSymbol: input => genericSymbolLookupKeys(definition.resolutionDomain, input),
    lookupTiersForReference: input => genericReferenceLookupTiers(definition.resolutionDomain, input),
  };
}

function pythonImport(value: string) {
  const from = /^\s*from\s+([\w.]+)\s+import\s+([\w.*]+)/.exec(value);
  if (from) return simpleImport(`${from[1]}.${from[2]}`, Effect.pipe(from[2], EffectString.split('.')).at(-1));
  const direct = /^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?/.exec(value);
  return direct
    ? simpleImport(direct[1], Effect.pipe(direct[1], EffectString.split('.')).at(-1), direct[2])
    : Option.none();
}

function goImport(value: string) {
  const match = /^\s*(?:(\w+|\.|_)\s+)?["`]([^"`]+)["`]/.exec(Effect.pipe(value, EffectString.trim));
  const module = match?.[2];
  return module
    ? simpleImport(
        module,
        Effect.pipe(module, EffectString.split('/')).at(-1),
        match?.[1] === '.' || match?.[1] === '_' ? undefined : match?.[1],
      )
    : Option.none();
}

function rustImport(value: string) {
  const match = /^\s*use\s+(.+?);?\s*$/.exec(value);
  if (!match) return Option.none();
  const module = Effect.pipe(match[1], EffectString.replace(/\s+as\s+\w+$/, ''), EffectString.replace(/[{}\s]/g, ''));
  const alias = /\s+as\s+(\w+)\s*;?$/.exec(value)?.[1];
  return simpleImport(module, Effect.pipe(module, EffectString.split('::')).at(-1), alias);
}

function includeImport(value: string) {
  const match = /#\s*include\s*[<"]([^>"]+)[>"]/.exec(value);
  return match ? simpleImport(match[1]) : Option.none();
}

function csharpImport(value: string) {
  const match = /^\s*(?:global\s+)?using\s+(?:(\w+)\s*=\s*)?([^;]+);/.exec(value);
  if (!match || /^static\s+/.test(match[2])) return Option.none();
  const module = Effect.pipe(match[2], EffectString.trim);
  return simpleImport(module, Effect.pipe(module, EffectString.split('.')).at(-1), match[1]);
}

function rubyImport(value: string) {
  const match = /^\s*(?:require|require_relative|load)\s*\(?\s*["']([^"']+)["']/.exec(value);
  return match ? simpleImport(match[1]) : Option.none();
}

function phpImport(value: string) {
  const match = /^\s*use\s+([^;{,]+?)(?:\s+as\s+(\w+))?\s*;/i.exec(value);
  if (!match) return Option.none();
  const module = Effect.pipe(match[1], EffectString.trim);
  return simpleImport(module, Effect.pipe(module, EffectString.split('\\')).at(-1), match[2]);
}

function bashImport(value: string) {
  const match = /^\s*(?:source|\.)\s+(["']?)([^\s"']+)\1/.exec(value);
  return match ? simpleImport(match[2]) : Option.none();
}

function relationForCapture(capture: string) {
  if (capture === 'reference.import') return 'imports' as const;
  if (capture === 'reference.call') return 'calls' as const;
  if (capture === 'reference.construct') return 'constructs' as const;
  if (capture === 'reference.extend') return 'extends' as const;
  if (capture === 'reference.implement') return 'implements' as const;
  return 'references' as const;
}

function rustExported(node: Node): boolean {
  for (let current: Node | null = node; current; current = current.parent) {
    if (EffectArray.some(current.namedChildren, child => child.type === 'visibility_modifier')) return true;
    if (current.type === 'source_file') break;
  }
  return false;
}

function hclBlockName(node: Node): string {
  const components = EffectArray.map(
    EffectArray.filter(node.namedChildren, child => child.type === 'identifier' || child.type === 'string_lit'),
    child => stripQuotes(child.text),
  );
  return components.length > 1 ? EffectArray.join(components.slice(1), '.') : (components[0] ?? 'block');
}

function stripQuotes(value: string): string {
  return Effect.pipe(value, EffectString.trim, EffectString.replace(/^["']|["']$/g, ''));
}

function header(node: Node): string {
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native split limit truncates results; Effect String split has no limit parameter.
  return node.text.split(/[={\n]/, 1)[0] ?? '';
}

function emptyImport() {
  return {alias: Option.none<string>(), importedName: Option.none<string>(), module: '', wildcard: false};
}

export const genericTreeSitterLanguagePacks: readonly CodeGraphLanguagePack[] = [
  pythonLanguagePack,
  goLanguagePack,
  rustLanguagePack,
  cLanguagePack,
  cppLanguagePack,
  csharpLanguagePack,
  rubyLanguagePack,
  phpLanguagePack,
  bashLanguagePack,
  hclLanguagePack,
];
