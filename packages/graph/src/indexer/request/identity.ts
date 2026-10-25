import type {CodeGraphVectorPolicy} from '../types.js';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {packDerivationIdentity, type CodeGraphLanguagePackRegistryShape} from '../../languages/registry.js';
import {compareCodeUnits} from '../../ordering.js';
import {codeGraphScopeIdentitySuffix, type CodeGraphScopeIdentity} from '../../scope/identity.js';
import {CODE_GRAPH_EXTRACTOR_SET_VERSION, type RepositoryIdentity} from '../../types.js';
import {CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION} from '../../store.js';

export function codeGraphBuildRequestKey(
  identity: Pick<RepositoryIdentity, 'checkoutId' | 'headCommit' | 'repositoryId' | 'worktreeId'>,
  overlay: {readonly dirty: boolean; readonly fingerprint?: string},
  languagePacks: CodeGraphLanguagePackRegistryShape,
  incrementalOverlay: boolean | undefined,
  vectorPolicy: CodeGraphVectorPolicy | boolean,
  environmentFingerprint: string,
  scope?: CodeGraphScopeIdentity,
): string {
  const parserIdentities = languagePacks.cacheIdentities.join('\n');
  const derivationIdentities = languagePacks.packs.map(packDerivationIdentity).sort(compareCodeUnits).join('\n');
  return sha256HexSync(
    [
      'code-graph-build-request-v5',
      CODE_GRAPH_EXTRACTOR_SET_VERSION,
      `lexical-storage:${CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION}`,
      identity.repositoryId,
      identity.checkoutId,
      overlay.dirty ? identity.worktreeId : 'shared-commit',
      identity.headCommit,
      overlay.dirty ? (overlay.fingerprint ?? 'dirty-without-fingerprint') : 'clean',
      overlay.dirty && incrementalOverlay === false ? 'direct-full' : 'default',
      vectorPolicy === 'background'
        ? 'vectors:background'
        : vectorPolicy === true || vectorPolicy === 'wait'
          ? 'vectors:required'
          : 'vectors:structural-only',
      'ignore-policy:3',
      environmentFingerprint,
      parserIdentities,
      derivationIdentities,
    ].join('\n') + codeGraphScopeIdentitySuffix(scope),
  );
}
