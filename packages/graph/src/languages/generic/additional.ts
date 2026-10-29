import {Array as EffectArray} from 'effect';
import {Option} from 'effect';
import type {Node} from 'web-tree-sitter';
import type {TreeSitterLanguageDefinition} from '../../tree_sitter/extractor.js';
import {
  DART_GRAMMAR,
  ELIXIR_GRAMMAR,
  JULIA_GRAMMAR,
  LUA_GRAMMAR,
  OBJC_GRAMMAR,
  POWERSHELL_GRAMMAR,
  SCALA_GRAMMAR,
  SOLIDITY_GRAMMAR,
  SVELTE_GRAMMAR,
  SYSTEMVERILOG_GRAMMAR,
  VUE_GRAMMAR,
  ZIG_GRAMMAR,
} from '../tree_sitter_assets.js';
import type {CodeGraphLanguagePack} from '../types.js';
import {createGenericTreeSitterLanguagePack} from './factory.js';
import {genericReferenceLookupTiers, genericSymbolLookupKeys, simpleImport} from './lookup.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const SOURCE_CAPABILITIES = new Set(['calls', 'declarations', 'imports', 'inheritance'] as const);

export const powershellLanguagePack = createGenericTreeSitterLanguagePack({
  capabilities: new Set(['calls', 'declarations', 'imports', 'inheritance']),
  definition: languageDefinition({
    asset: POWERSHELL_GRAMMAR,
    declarationQuery: `
      (function_statement (function_name) @name) @definition.function
      (class_statement . (simple_name) @name) @definition.class
      (class_method_definition (simple_name) @name) @definition.method
    `,
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native split limit truncates results; Effect String split has no limit parameter.
    exported: node => !/\bprivate\b/i.test(node.text.split(/[\n{]/, 1)[0] ?? ''),
    id: 'powershell',
    importFromNode: node => powershellImport(node.text),
    metadataQuery: `(command) @metadata.import`,
    namespaceFromNode: () => Option.none(),
    referenceQuery: `
      (command command_name: (command_name) @reference.call)
      (class_statement . (simple_name) @_class (simple_name) @reference.extend)
    `,
    referenceRelation: (_capture, node) =>
      /^(?:import-module|using)$/i.test(node.text) ? 'imports' : relationForCapture(_capture),
    referenceTarget: (_capture, node) => {
      const imported = powershellImport(node.parent?.text ?? node.text);
      return Option.isSome(imported) ? imported.value.module : node.text;
    },
    resolutionDomain: 'powershell',
  }),
  definitionVersion: 'powershell-structural-v1',
  files: [
    {kind: 'extension', language: 'powershell', role: 'source', value: '.ps1'},
    {kind: 'extension', language: 'powershell', role: 'source', value: '.psm1'},
    {kind: 'extension', language: 'powershell-data', role: 'manifest', value: '.psd1'},
  ],
});

export const dartLanguagePack = createGenericTreeSitterLanguagePack({
  capabilities: SOURCE_CAPABILITIES,
  definition: languageDefinition({
    asset: DART_GRAMMAR,
    declarationQuery: `
      (class_definition name: (identifier) @name) @definition.class
      (mixin_declaration name: (identifier) @name) @definition.mixin
      (enum_declaration name: (identifier) @name) @definition.enum
      (extension_declaration name: (identifier) @name) @definition.extension
      (extension_type_declaration name: (identifier) @name) @definition.extension_type
      (function_signature name: (identifier) @name) @definition.function
    `,
    exported: node => !/^_/.test(node.childForFieldName('name')?.text ?? ''),
    id: 'dart',
    importFromNode: node => dartImport(node.text),
    metadataQuery: `
      (library_import) @metadata.import
      (library_export) @metadata.import
    `,
    namespaceFromNode: () => Option.none(),
    referenceQuery: `
      (library_import) @reference.import
      (library_export) @reference.import
      (expression_statement (identifier) @reference.call (selector (argument_part)))
      (class_definition superclass: (superclass (type_identifier) @reference.extend))
      (class_definition interfaces: (interfaces (type_identifier) @reference.implement))
    `,
    referenceRelation: capture => relationForCapture(capture),
    referenceTarget: (capture, node) =>
      capture === 'reference.import' ? Option.getOrElse(dartImport(node.text), () => emptyImport()).module : node.text,
    resolutionDomain: 'dart',
  }),
  definitionVersion: 'dart-structural-v1',
  files: [{kind: 'extension', language: 'dart', role: 'source', value: '.dart'}],
});

export const solidityLanguagePack = createGenericTreeSitterLanguagePack({
  capabilities: SOURCE_CAPABILITIES,
  definition: languageDefinition({
    asset: SOLIDITY_GRAMMAR,
    declarationQuery: `
      (contract_declaration name: (identifier) @name) @definition.contract
      (interface_declaration name: (identifier) @name) @definition.interface
      (library_declaration name: (identifier) @name) @definition.library
      (struct_declaration name: (identifier) @name) @definition.struct
      (enum_declaration name: (identifier) @name) @definition.enum
      (error_declaration name: (identifier) @name) @definition.error
      (event_definition name: (identifier) @name) @definition.event
      (modifier_definition name: (identifier) @name) @definition.modifier
      (function_definition name: (identifier) @name) @definition.function
    `,
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native split limit truncates results; Effect String split has no limit parameter.
    exported: node => !/\b(?:internal|private)\b/.test(node.text.split(/[\n{]/, 1)[0] ?? ''),
    id: 'solidity',
    importFromNode: node => quotedImport(node.text),
    metadataQuery: `(import_directive) @metadata.import`,
    namespaceFromNode: () => Option.none(),
    referenceQuery: `
      (import_directive) @reference.import
      (call_expression function: (_) @reference.call)
      (inheritance_specifier ancestor: (user_defined_type) @reference.extend)
    `,
    referenceRelation: capture => relationForCapture(capture),
    referenceTarget: (capture, node) =>
      capture === 'reference.import'
        ? Option.getOrElse(quotedImport(node.text), () => emptyImport()).module
        : node.text,
    resolutionDomain: 'solidity',
  }),
  definitionVersion: 'solidity-structural-v1',
  files: [{kind: 'extension', language: 'solidity', role: 'source', value: '.sol'}],
});

export const luaLanguagePack = createGenericTreeSitterLanguagePack({
  capabilities: new Set(['calls', 'declarations', 'imports']),
  definition: languageDefinition({
    asset: LUA_GRAMMAR,
    declarationQuery: `(function_declaration name: (_) @name) @definition.function`,
    exported: node => !/^\s*local\b/.test(node.text) && !/^_/.test(node.childForFieldName('name')?.text ?? ''),
    id: 'lua',
    importFromNode: node => luaImport(node.text),
    metadataQuery: `(function_call) @metadata.import`,
    namespaceFromNode: () => Option.none(),
    referenceQuery: `(function_call name: (_) @reference.call)`,
    referenceRelation: (_capture, node) => (/^require$/.test(node.text) ? 'imports' : 'calls'),
    referenceTarget: (_capture, node) => {
      const imported = luaImport(node.parent?.text ?? node.text);
      return Option.isSome(imported) ? imported.value.module : node.text;
    },
    resolutionDomain: 'lua',
  }),
  definitionVersion: 'lua-structural-v1',
  files: [{kind: 'extension', language: 'lua', role: 'source', value: '.lua'}],
});

export const scalaLanguagePack = createGenericTreeSitterLanguagePack({
  capabilities: SOURCE_CAPABILITIES,
  definition: languageDefinition({
    asset: SCALA_GRAMMAR,
    declarationQuery: `
      (class_definition name: (_) @name) @definition.class
      (trait_definition name: (_) @name) @definition.trait
      (object_definition name: (_) @name) @definition.object
      (enum_definition name: (_) @name) @definition.enum
      (type_definition name: (_) @name) @definition.type
      (function_definition name: (_) @name) @definition.function
      (function_declaration name: (_) @name) @definition.function
    `,
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native split limit truncates results; Effect String split has no limit parameter.
    exported: node => !/\bprivate\b/.test(node.text.split(/[\n{=]/, 1)[0] ?? ''),
    id: 'scala',
    importFromNode: node => scalaImport(node.text),
    metadataQuery: `
      (package_clause) @metadata.namespace
      (import_declaration) @metadata.import
    `,
    namespaceFromNode: node => Option.fromNullishOr(node.childForFieldName('name')?.text),
    referenceQuery: `
      (import_declaration) @reference.import
      (call_expression function: (_) @reference.call)
      (extends_clause type: (_) @reference.extend)
    `,
    referenceRelation: capture => relationForCapture(capture),
    referenceTarget: (capture, node) =>
      capture === 'reference.import' ? Option.getOrElse(scalaImport(node.text), () => emptyImport()).module : node.text,
    resolutionDomain: 'jvm',
  }),
  definitionVersion: 'scala-structural-v1',
  files: [
    {kind: 'extension', language: 'scala', role: 'source', value: '.scala'},
    {kind: 'extension', language: 'scala', role: 'source', value: '.sc'},
  ],
});

export const elixirLanguagePack = createGenericTreeSitterLanguagePack({
  capabilities: SOURCE_CAPABILITIES,
  definition: languageDefinition({
    asset: ELIXIR_GRAMMAR,
    declarationKind: (_capture, node) => elixirDeclarationKind(node),
    declarationName: (_capture, declaration) => elixirDeclarationName(declaration),
    declarationQuery: `
      ((call target: (identifier) @_declaration) @definition.declaration @name
        (#match? @_declaration "^(def|defp|defmacro|defmacrop|defmodule|defprotocol|defimpl)$"))
    `,
    exported: node => !/^\s*(?:defp|defmacrop)\b/.test(node.text),
    id: 'elixir',
    ignoreReference: input =>
      input.relation === 'calls' &&
      /^(?:alias|def|defimpl|defmacro|defmacrop|defmodule|defp|defprotocol|import|require|use)$/.test(input.targetName),
    importFromNode: node => elixirImport(node.text),
    metadataQuery: `
      ((call target: (identifier) @_namespace) @metadata.namespace (#eq? @_namespace "defmodule"))
      ((call target: (identifier) @_import) @metadata.import (#match? @_import "^(alias|import|require|use)$"))
    `,
    namespaceFromNode: node => Option.fromNullishOr(/^\s*defmodule\s+([A-Z][\w.]*)/.exec(node.text)?.[1]),
    referenceQuery: `
      ((call target: (identifier) @reference.import) (#match? @reference.import "^(alias|import|require|use)$"))
      (call target: (identifier) @reference.call)
    `,
    referenceRelation: capture => relationForCapture(capture),
    referenceTarget: (capture, node) => {
      if (capture !== 'reference.import') return node.text;
      const imported = elixirImport(node.parent?.text ?? node.text);
      return Option.isSome(imported) ? imported.value.module : node.text;
    },
    resolutionDomain: 'beam',
  }),
  definitionVersion: 'elixir-structural-v1',
  files: [
    {kind: 'extension', language: 'elixir', role: 'source', value: '.ex'},
    {kind: 'extension', language: 'elixir', role: 'source', value: '.exs'},
  ],
});

export const zigLanguagePack = createGenericTreeSitterLanguagePack({
  capabilities: new Set(['calls', 'declarations', 'imports']),
  definition: languageDefinition({
    asset: ZIG_GRAMMAR,
    declarationQuery: `
      (function_declaration name: (identifier) @name) @definition.function
      (variable_declaration (identifier) @name (struct_declaration)) @definition.struct
      (variable_declaration (identifier) @name (enum_declaration)) @definition.enum
      (variable_declaration (identifier) @name (union_declaration)) @definition.union
      (variable_declaration (identifier) @name (opaque_declaration)) @definition.opaque
    `,
    exported: node => /^\s*pub\b/.test(node.text),
    id: 'zig',
    importFromNode: node => zigImport(node.text),
    metadataQuery: `(builtin_function) @metadata.import`,
    namespaceFromNode: () => Option.none(),
    referenceQuery: `
      (call_expression function: (_) @reference.call)
      (builtin_function) @reference.import
    `,
    referenceRelation: capture => relationForCapture(capture),
    referenceTarget: (capture, node) =>
      capture === 'reference.import' ? Option.getOrElse(zigImport(node.text), () => emptyImport()).module : node.text,
    resolutionDomain: 'zig',
  }),
  definitionVersion: 'zig-structural-v1',
  files: [{kind: 'extension', language: 'zig', role: 'source', value: '.zig'}],
});

export const juliaLanguagePack = createGenericTreeSitterLanguagePack({
  capabilities: SOURCE_CAPABILITIES,
  definition: languageDefinition({
    asset: JULIA_GRAMMAR,
    declarationName: (_capture, declaration, name) => juliaDeclarationName(declaration, name),
    declarationQuery: `
      (module_definition name: (identifier) @name) @definition.module
      (function_definition (signature (call_expression . (_) @name))) @definition.function
      (macro_definition (signature (call_expression . (_) @name))) @definition.macro
      (struct_definition (type_head . (_) @name)) @definition.struct
      (abstract_definition (type_head . (_) @name)) @definition.abstract_type
      (primitive_definition (type_head . (_) @name)) @definition.primitive_type
    `,
    exported: node => !/^_/.test(juliaDeclarationName(node, node)),
    id: 'julia',
    importFromNode: node => juliaImport(node.text),
    metadataQuery: `
      (using_statement) @metadata.import
      (import_statement) @metadata.import
    `,
    namespaceFromNode: () => Option.none(),
    referenceQuery: `
      (using_statement) @reference.import
      (import_statement) @reference.import
      (call_expression . (_) @reference.call)
      (macrocall_expression . (_) @reference.call)
    `,
    referenceRelation: capture => relationForCapture(capture),
    referenceTarget: (capture, node) =>
      capture === 'reference.import' ? Option.getOrElse(juliaImport(node.text), () => emptyImport()).module : node.text,
    resolutionDomain: 'julia',
  }),
  definitionVersion: 'julia-structural-v1',
  files: [{kind: 'extension', language: 'julia', role: 'source', value: '.jl'}],
});

export const objectiveCLanguagePack = createGenericTreeSitterLanguagePack({
  capabilities: SOURCE_CAPABILITIES,
  definition: languageDefinition({
    asset: OBJC_GRAMMAR,
    declarationName: (capture, declaration, name) =>
      capture === 'definition.method' ? objectiveCMethodName(declaration) : name.text,
    declarationQuery: `
      (class_interface . (identifier) @name) @definition.class
      (class_implementation . (identifier) @name) @definition.class
      (protocol_declaration . (identifier) @name) @definition.protocol
      (method_declaration) @definition.method @name
      (method_definition) @definition.method @name
      (function_definition declarator: (function_declarator declarator: (identifier) @name)) @definition.function
      (struct_specifier name: (type_identifier) @name) @definition.struct
      (enum_specifier name: (type_identifier) @name) @definition.enum
    `,
    exported: node => !/^\s*static\b/.test(node.text),
    id: 'objective-c',
    importFromNode: node => objectiveCImport(node.text),
    metadataQuery: `
      (preproc_include) @metadata.import
      (module_import) @metadata.import
    `,
    namespaceFromNode: () => Option.none(),
    referenceQuery: `
      (preproc_include) @reference.import
      (module_import) @reference.import
      (call_expression function: (_) @reference.call)
      (message_expression method: (_) @reference.call)
      (class_interface superclass: (identifier) @reference.extend)
      (class_implementation superclass: (identifier) @reference.extend)
      (protocol_reference_list (identifier) @reference.implement)
      (class_interface (parameterized_arguments (type_name (type_identifier) @reference.implement)))
    `,
    referenceRelation: capture => relationForCapture(capture),
    referenceTarget: (capture, node) =>
      capture === 'reference.import'
        ? Option.getOrElse(objectiveCImport(node.text), () => emptyImport()).module
        : node.text,
    resolutionDomain: 'objective-c',
  }),
  definitionVersion: 'objective-c-structural-v1',
  files: [
    {kind: 'extension', language: 'objective-c', role: 'source', value: '.m'},
    {kind: 'extension', language: 'objective-cpp', role: 'source', value: '.mm'},
  ],
});

export const systemVerilogLanguagePack = createGenericTreeSitterLanguagePack({
  capabilities: SOURCE_CAPABILITIES,
  definition: languageDefinition({
    asset: SYSTEMVERILOG_GRAMMAR,
    declarationQuery: `
      (module_declaration (module_ansi_header name: (_) @name)) @definition.module
      (module_declaration (module_nonansi_header name: (_) @name)) @definition.module
      (interface_declaration (interface_ansi_header name: (_) @name)) @definition.interface
      (interface_declaration (interface_nonansi_header name: (_) @name)) @definition.interface
      (package_declaration name: (_) @name) @definition.package
      (class_declaration name: (_) @name) @definition.class
      (interface_class_declaration name: (_) @name) @definition.interface_class
      (function_body_declaration name: (_) @name) @definition.function
      (task_body_declaration name: (_) @name) @definition.task
    `,
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native split limit truncates results; Effect String split has no limit parameter.
    exported: node => !/\blocal\b|\bprotected\b/.test(node.text.split(/[;\n]/, 1)[0] ?? ''),
    id: 'systemverilog',
    importFromNode: node => systemVerilogImport(node.text),
    metadataQuery: `(package_import_declaration) @metadata.import`,
    namespaceFromNode: () => Option.none(),
    referenceQuery: `
      (package_import_declaration) @reference.import
      (module_instantiation instance_type: (_) @reference.construct)
      (interface_instantiation instance_type: (_) @reference.construct)
      (tf_call [(hierarchical_identifier) (simple_identifier)] @reference.call)
      (class_declaration (class_type) @reference.extend)
      (class_declaration (interface_class_type) @reference.implement)
      (interface_class_declaration (interface_class_type) @reference.extend)
    `,
    referenceRelation: capture => relationForCapture(capture),
    referenceTarget: (capture, node) =>
      capture === 'reference.import'
        ? Option.getOrElse(systemVerilogImport(node.text), () => emptyImport()).module
        : node.text,
    resolutionDomain: 'systemverilog',
  }),
  definitionVersion: 'systemverilog-structural-v1',
  files: [
    {kind: 'extension', language: 'verilog', role: 'source', value: '.v'},
    {kind: 'extension', language: 'verilog', role: 'source', value: '.vh'},
    {kind: 'extension', language: 'systemverilog', role: 'source', value: '.sv'},
    {kind: 'extension', language: 'systemverilog', role: 'source', value: '.svh'},
  ],
});

export const vueLanguagePack = componentLanguagePack('vue', VUE_GRAMMAR, '.vue');
export const svelteLanguagePack = componentLanguagePack('svelte', SVELTE_GRAMMAR, '.svelte');

function componentLanguagePack(
  id: 'svelte' | 'vue',
  asset: typeof SVELTE_GRAMMAR | typeof VUE_GRAMMAR,
  extension: string,
): CodeGraphLanguagePack {
  return createGenericTreeSitterLanguagePack({
    capabilities: new Set(['dependencies']),
    definition: languageDefinition({
      asset,
      declarationQuery: '',
      exported: () => true,
      id,
      ignoreReference: input => /^[a-z][a-z0-9]*$/.test(input.targetName),
      importFromNode: () => Option.none(),
      metadataQuery: '',
      namespaceFromNode: () => Option.none(),
      referenceQuery: `
        (start_tag (tag_name) @reference.construct)
        (self_closing_tag (tag_name) @reference.construct)
      `,
      referenceRelation: () => 'constructs',
      resolutionDomain: 'web-component',
    }),
    definitionVersion: `${id}-component-structure-v1`,
    files: [{kind: 'extension', language: id, role: 'source', value: extension}],
  });
}

function languageDefinition(
  definition: Omit<TreeSitterLanguageDefinition, 'lookupKeysForSymbol' | 'lookupTiersForReference'>,
): TreeSitterLanguageDefinition {
  return {
    ...definition,
    lookupKeysForSymbol: input => genericSymbolLookupKeys(definition.resolutionDomain, input),
    lookupTiersForReference: input => genericReferenceLookupTiers(definition.resolutionDomain, input),
  };
}

function powershellImport(value: string) {
  const match = /(?:^|\s)(?:Import-Module|using\s+module)\s+["']?([^\s"';]+)/i.exec(value);
  return match ? simpleImport(match[1]) : Option.none();
}

function dartImport(value: string) {
  const match = /\b(?:import|export)\s+["']([^"']+)["']/.exec(value);
  return match ? simpleImport(match[1]) : Option.none();
}

function quotedImport(value: string) {
  const match = /["']([^"']+)["']/.exec(value);
  return match ? simpleImport(match[1]) : Option.none();
}

function luaImport(value: string) {
  const match = /\brequire\s*\(?\s*["']([^"']+)["']/.exec(value);
  return match ? simpleImport(match[1]) : Option.none();
}

function scalaImport(value: string) {
  const match = /^\s*import\s+([^\s;{]+)(?:\s*\{[^}]*\})?/.exec(value);
  return match ? simpleImport(Effect.pipe(match[1], EffectString.replace(/\.(?:_|\*)$/, ''))) : Option.none();
}

function elixirImport(value: string) {
  const match = /^\s*(?:alias|import|require|use)\s+([A-Z][\w.]*)/.exec(value);
  return match ? simpleImport(match[1], Effect.pipe(match[1], EffectString.split('.')).at(-1)) : Option.none();
}

function elixirDeclarationKind(node: Node): string {
  const keyword = /^\s*(\w+)/.exec(node.text)?.[1];
  if (keyword === 'defmodule') return 'module';
  if (keyword === 'defprotocol') return 'protocol';
  if (keyword === 'defimpl') return 'implementation';
  if (
    Effect.pipe(keyword, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.startsWith('defmacro')),
    )
  )
    return 'macro';
  return 'function';
}

function elixirDeclarationName(node: Node): string {
  return (
    /^\s*(?:defmodule|defprotocol|defimpl)\s+([A-Z][\w.]*)/.exec(node.text)?.[1] ??
    /^\s*def(?:p|macro|macrop)?\s+([a-zA-Z_][\w!?]*)/.exec(node.text)?.[1] ??
    'anonymous'
  );
}

function zigImport(value: string) {
  const match = /@import\s*\(\s*["']([^"']+)["']\s*\)/.exec(value);
  return match ? simpleImport(match[1]) : Option.none();
}

function juliaImport(value: string) {
  const match = /^\s*(?:using|import)\s+([\w.]+)/.exec(value);
  return match ? simpleImport(match[1], Effect.pipe(match[1], EffectString.split('.')).at(-1)) : Option.none();
}

function juliaDeclarationName(declaration: Node, fallback: Node): string {
  const keyword = /^\s*(?:mutable\s+)?(?:struct|abstract\s+type|primitive\s+type)\s+([A-Za-z_]\w*)/.exec(
    declaration.text,
  );
  return (
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native split limit truncates results; Effect String split has no limit parameter.
    keyword?.[1] ?? Effect.pipe(fallback.text, EffectString.replace(/^@/, '')).split(/[({<:\s]/, 1)[0] ?? fallback.text
  );
}

function objectiveCImport(value: string) {
  const include = /#\s*(?:import|include)\s*[<"]([^>"]+)[>"]/.exec(value);
  if (include) return simpleImport(include[1]);
  const module = /@import\s+([\w.]+)/.exec(value);
  return module ? simpleImport(module[1]) : Option.none();
}

function systemVerilogImport(value: string) {
  const match = /\bimport\s+([A-Za-z_]\w*)::/.exec(value);
  return match ? simpleImport(match[1]) : Option.none();
}

function objectiveCMethodName(node: Node): string {
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native split limit truncates results; Effect String split has no limit parameter.
  const header = node.text.split(/[;{]/, 1)[0] ?? node.text;
  const selectors = EffectArray.map(
    [...Effect.pipe(header, EffectString.matchAll(/([A-Za-z_]\w*)\s*:/g))],
    match => `${match[1]}:`,
  );
  if (selectors.length > 0) return EffectArray.join(selectors, '');
  return /\)\s*([A-Za-z_]\w*)/.exec(header)?.[1] ?? 'method';
}

function relationForCapture(capture: string) {
  if (capture === 'reference.import') return 'imports' as const;
  if (capture === 'reference.call') return 'calls' as const;
  if (capture === 'reference.construct') return 'constructs' as const;
  if (capture === 'reference.extend') return 'extends' as const;
  if (capture === 'reference.implement') return 'implements' as const;
  return 'references' as const;
}

function emptyImport() {
  return {alias: Option.none<string>(), importedName: Option.none<string>(), module: '', wildcard: false};
}
