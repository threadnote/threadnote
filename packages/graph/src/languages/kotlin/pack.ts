import {Array as EffectArray} from 'effect';
import {Option} from 'effect';
import type {Node} from 'web-tree-sitter';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  extractTreeSitterFacts,
  TREE_SITTER_EXTRACTOR_POLICY_VERSION,
  type TreeSitterLanguageDefinition,
} from '../../tree_sitter/extractor.js';
import {jvmReferenceLookupTiers, jvmSymbolLookupKeys, parseJvmImport, parseJvmNamespace} from '../jvm/lookup.js';
import {KOTLIN_GRAMMAR} from '../tree_sitter_assets.js';
import type {CodeGraphLanguagePack} from '../types.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const DECLARATIONS = `
(class_declaration (type_identifier) @name) @definition.class
(object_declaration (type_identifier) @name) @definition.object
(companion_object "companion" @name) @definition.object
(function_declaration (simple_identifier) @name) @definition.function
(property_declaration (variable_declaration (simple_identifier) @name)) @definition.property
(type_alias (type_identifier) @name) @definition.type
(class_declaration (type_identifier) @name (primary_constructor) @definition.constructor)
(secondary_constructor "constructor" @name) @definition.constructor
`;

const METADATA = `
(package_header) @metadata.namespace
(import_header) @metadata.import
`;

const REFERENCES = `
(import_header) @reference.import
(call_expression) @reference.call
(delegation_specifier (constructor_invocation (user_type (type_identifier) @reference.extend)))
(delegation_specifier (user_type (type_identifier) @reference.implement))
(annotation (user_type (type_identifier) @reference.annotation))
(function_declaration
  (modifiers (member_modifier) @_override)
  (simple_identifier) @reference.override
  (#eq? @_override "override"))
`;

const definition: TreeSitterLanguageDefinition = {
  asset: KOTLIN_GRAMMAR,
  declarationKind: (capture, node) => {
    if (capture !== 'definition.class') return Effect.pipe(capture, EffectString.replace(/^definition\./, ''));
    const declaration = header(node);
    if (/\bannotation\s+class\b/.test(declaration)) return 'annotation';
    if (/\benum\s+class\b/.test(declaration)) return 'enum';
    if (/\binterface\b/.test(declaration)) return 'interface';
    return 'class';
  },
  declarationName: (capture, declaration, name) => {
    if (capture === 'definition.object' && declaration.type === 'companion_object') {
      return (
        Option.getOrUndefined(
          EffectArray.findFirst(declaration.namedChildren, child => child.type === 'type_identifier'),
        )?.text ?? 'Companion'
      );
    }
    if (capture === 'definition.constructor') {
      for (let current = declaration.parent; current; current = current.parent) {
        if (current.type !== 'class_declaration') continue;
        return (
          Option.getOrUndefined(EffectArray.findFirst(current.namedChildren, child => child.type === 'type_identifier'))
            ?.text ?? name.text
        );
      }
    }
    return name.text;
  },
  declarationQuery: DECLARATIONS,
  exported: node => !/\bprivate\b/.test(header(node)),
  id: 'kotlin',
  importFromNode: node => parseJvmImport(node.text),
  lookupKeysForSymbol: jvmSymbolLookupKeys,
  lookupTiersForReference: jvmReferenceLookupTiers,
  metadataQuery: METADATA,
  namespaceFromNode: node => parseJvmNamespace(node.text),
  referenceQuery: REFERENCES,
  referenceRelation: (capture, node) => {
    if (capture === 'reference.call') {
      const target = callTarget(node);
      return /^[A-Z]/.test(Effect.pipe(target, EffectString.split('.')).at(-1) ?? '') ? 'constructs' : 'calls';
    }
    if (capture === 'reference.import') return 'imports';
    if (capture === 'reference.extend') return 'extends';
    if (capture === 'reference.implement') return 'implements';
    if (capture === 'reference.override') return 'overrides';
    return 'references';
  },
  referenceTarget: (capture, node) => {
    if (capture === 'reference.import') {
      return Effect.pipe(
        node.text,
        EffectString.replace(/^\s*import\s+/, ''),
        EffectString.replace(/\s+as\s+[A-Za-z_$][\w$]*\s*$/, ''),
        EffectString.trim,
      );
    }
    return capture === 'reference.call' ? callTarget(node) : node.text;
  },
  resolutionDomain: 'jvm',
};

const extractorVersion = sha256HexSync(
  `tree-sitter-kotlin-v1\n${TREE_SITTER_EXTRACTOR_POLICY_VERSION}\n${KOTLIN_GRAMMAR.sha256}\n${DECLARATIONS}\n${METADATA}\n${REFERENCES}`,
);

export const codeGraphLanguagePack: CodeGraphLanguagePack = {
  assets: [KOTLIN_GRAMMAR],
  capabilities: new Set(['calls', 'declarations', 'imports', 'inheritance']),
  extractor: {
    extract: (file, context) => extractTreeSitterFacts(definition, file, context),
    version: extractorVersion,
  },
  files: [
    {kind: 'extension', language: 'kotlin', role: 'source', value: '.kt'},
    {kind: 'extension', language: 'kotlin', role: 'source', value: '.kts'},
  ],
  id: 'kotlin',
  resolutionStrategy: {domain: 'jvm', version: 'jvm-static-v1'},
  version: '1.0.0',
  workspaceDetector: Option.none(),
};

function callTarget(node: Node): string {
  const target = Option.getOrUndefined(
    EffectArray.findFirst(node.namedChildren, child => child.type !== 'call_suffix'),
  );
  return (
    Effect.pipe(
      target?.text,
      effectOptionalString =>
        effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
      // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native split limit truncates results; Effect String split has no limit parameter.
    ) ?? Effect.pipe(node.text.split('(', 1)[0], EffectString.trim)
  );
}

function header(node: Node): string {
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native split limit truncates results; Effect String split has no limit parameter.
  return node.text.split(/[={\n]/, 1)[0] ?? '';
}
