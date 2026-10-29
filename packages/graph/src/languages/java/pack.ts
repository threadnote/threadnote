import {Option} from 'effect';
import type {Node} from 'web-tree-sitter';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  extractTreeSitterFacts,
  TREE_SITTER_EXTRACTOR_POLICY_VERSION,
  type TreeSitterLanguageDefinition,
} from '../../tree_sitter/extractor.js';
import {JAVA_GRAMMAR} from '../tree_sitter_assets.js';
import type {CodeGraphLanguagePack} from '../types.js';
import {jvmReferenceLookupTiers, jvmSymbolLookupKeys, parseJvmImport, parseJvmNamespace} from '../jvm/lookup.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const DECLARATIONS = `
(class_declaration name: (identifier) @name) @definition.class
(interface_declaration name: (identifier) @name) @definition.interface
(enum_declaration name: (identifier) @name) @definition.enum
(record_declaration name: (identifier) @name) @definition.record
(annotation_type_declaration name: (identifier) @name) @definition.annotation
(method_declaration name: (identifier) @name) @definition.method
(constructor_declaration name: (identifier) @name) @definition.constructor
(field_declaration declarator: (variable_declarator name: (identifier) @name)) @definition.field
(enum_constant name: (identifier) @name) @definition.enum_case
(module_declaration name: (_) @name) @definition.module
`;

const METADATA = `
(package_declaration) @metadata.namespace
(import_declaration) @metadata.import
`;

const REFERENCES = `
(import_declaration) @reference.import
(method_invocation name: (identifier) @reference.call)
(object_creation_expression type: (type_identifier) @reference.construct)
(superclass (type_identifier) @reference.extend)
(super_interfaces (type_list (type_identifier) @reference.implement))
(marker_annotation name: (identifier) @reference.annotation)
(annotation name: (identifier) @reference.annotation)
(requires_module_directive module: (_) @reference.import)
`;

const definition: TreeSitterLanguageDefinition = {
  asset: JAVA_GRAMMAR,
  declarationQuery: DECLARATIONS,
  exported: node => !/\bprivate\b/.test(header(node)),
  id: 'java',
  importFromNode: node => parseJvmImport(node.text),
  lookupKeysForSymbol: jvmSymbolLookupKeys,
  lookupTiersForReference: jvmReferenceLookupTiers,
  metadataQuery: METADATA,
  namespaceFromNode: node => parseJvmNamespace(node.text),
  referenceQuery: REFERENCES,
  referenceTarget: (capture, node) => {
    if (capture === 'reference.import') return importTarget(node.text);
    if (capture === 'reference.call') {
      const invocation = node.parent;
      const object = invocation?.childForFieldName('object');
      return object ? `${object.text}.${node.text}` : node.text;
    }
    return node.text;
  },
  resolutionDomain: 'jvm',
};

const extractorVersion = sha256HexSync(
  `tree-sitter-java-v1\n${TREE_SITTER_EXTRACTOR_POLICY_VERSION}\n${JAVA_GRAMMAR.sha256}\n${DECLARATIONS}\n${METADATA}\n${REFERENCES}`,
);

export const codeGraphLanguagePack: CodeGraphLanguagePack = {
  assets: [JAVA_GRAMMAR],
  capabilities: new Set(['calls', 'declarations', 'imports', 'inheritance']),
  extractor: {
    extract: (file, context) => extractTreeSitterFacts(definition, file, context),
    version: extractorVersion,
  },
  files: [{kind: 'extension', language: 'java', role: 'source', value: '.java'}],
  id: 'java',
  resolutionStrategy: {domain: 'jvm', version: 'jvm-static-v1'},
  version: '1.0.0',
  workspaceDetector: Option.none(),
};

function importTarget(value: string): string {
  return Effect.pipe(
    value,
    EffectString.replace(/^\s*import\s+/, ''),
    EffectString.replace(/^\s*static\s+/, ''),
    EffectString.replace(/[;\s]+$/g, ''),
    EffectString.trim,
  );
}

function header(node: Node): string {
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native split limit truncates results; Effect String split has no limit parameter.
  return node.text.split(/[{\n]/, 1)[0] ?? '';
}
