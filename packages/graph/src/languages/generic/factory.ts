import {Option} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  extractTreeSitterFacts,
  TREE_SITTER_EXTRACTOR_POLICY_VERSION,
  type TreeSitterLanguageDefinition,
} from '../../tree_sitter/extractor.js';
import type {CodeGraphCapability, CodeGraphFileMatcher, CodeGraphLanguagePack} from '../types.js';
import {Array as EffectArray} from 'effect';

export interface GenericTreeSitterLanguagePackOptions {
  readonly capabilities: ReadonlySet<CodeGraphCapability>;
  readonly definition: TreeSitterLanguageDefinition;
  readonly definitionVersion: string;
  readonly files: readonly CodeGraphFileMatcher[];
  readonly version?: string;
}

export function createGenericTreeSitterLanguagePack(
  options: GenericTreeSitterLanguagePackOptions,
): CodeGraphLanguagePack {
  const {definition} = options;
  const extractorVersion = sha256HexSync(
    EffectArray.join(
      [
        'threadnote-generic-tree-sitter-pack-v1',
        TREE_SITTER_EXTRACTOR_POLICY_VERSION,
        definition.id,
        options.definitionVersion,
        definition.asset.sha256,
        definition.declarationQuery,
        definition.metadataQuery,
        definition.referenceQuery,
      ],
      '\n',
    ),
  );
  return {
    assets: [definition.asset],
    capabilities: options.capabilities,
    extractor: {
      extract: (file, context) => extractTreeSitterFacts(definition, file, context),
      version: extractorVersion,
    },
    files: options.files,
    id: definition.id,
    resolutionStrategy: {
      domain: definition.resolutionDomain,
      version: `${definition.resolutionDomain}-static-v1`,
    },
    version: options.version ?? '1.0.0',
    workspaceDetector: Option.none(),
  };
}
