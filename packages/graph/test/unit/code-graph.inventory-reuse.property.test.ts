import {Array as EffectArray} from 'effect';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {
  codeGraphAttributionContextFilesForReceipt,
  decodeCodeGraphInventoryReuseReceipt,
  encodeCodeGraphInventoryReuseReceipt,
} from '@threadnote/graph/inventory/reuse';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '@threadnote/graph/languages/registry';
import {CODE_GRAPH_INVENTORY_EXCLUSION_REASONS} from '@threadnote/graph/inventory/policy';
import {CODE_GRAPH_INVENTORY_REUSE_RECEIPT_VERSION} from '@threadnote/graph/store/models';
import {mergeCodeGraphWorkspaces} from '@threadnote/graph/workspace';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Option as EffectOption} from 'effect';

const emptyWorkspace = mergeCodeGraphWorkspaces([]);

describe('code graph inventory reuse receipts', () => {
  it('retains only manifests consumed by repository attribution', () => {
    const file = (path: string, content: string) => ({
      blobId: `blob:${path}`,
      content,
      contentHash: Effect.pipe('a', EffectString.repeat(64)),
      language: 'fixture',
      mode: '100644',
      path,
      size: new TextEncoder().encode(content).byteLength,
      source: 'commit' as const,
    });
    const files = [
      file('package.json', '{"name":"root"}'),
      file('packages/app/tsconfig.json', '{"compilerOptions":{"baseUrl":"."}}'),
      file('pom.xml', '<project/>'),
      file('packages/app/BUILD.bazel', 'java_library(name = "app")'),
    ];

    expect(
      EffectOption.getOrUndefined(
        EffectOption.map(
          EffectOption.fromNullishOr(codeGraphAttributionContextFilesForReceipt(files, BUILTIN_LANGUAGE_PACK_REGISTRY)),
          __effectArrayReceiver => EffectArray.map(__effectArrayReceiver, item => item.path),
        ),
      ),
    ).toEqual(['package.json', 'packages/app/tsconfig.json']);
  });

  fcProp(
    it,
    'round-trips bounded admission evidence without changing its normalized workspace',
    {
      diagnostics: FC.array(FC.string({maxLength: 80}), {maxLength: 8}),
      skipped: FC.integer({max: 1_000_000, min: 0}),
    },
    ({diagnostics, skipped}) => {
      const receipt = {
        attributionFiles: [
          {
            blobId: 'blob:package',
            content: '{"name":"fixture"}',
            contentHash: Effect.pipe('c', EffectString.repeat(64)),
            language: 'json',
            mode: '100644',
            path: 'package.json',
            size: 18,
            source: 'commit' as const,
          },
        ],
        contract: Effect.pipe('a', EffectString.repeat(64)),
        diagnostics,
        environmentFingerprint: Effect.pipe('b', EffectString.repeat(64)),
        includeOpaqueCorpusAssets: true,
        policyExclusions: {
          bytes: 0,
          files: 0,
          policyVersion: 2,
          reasons: EffectArray.map(CODE_GRAPH_INVENTORY_EXCLUSION_REASONS, reason => ({bytes: 0, files: 0, reason})),
        },
        skipped,
        version: CODE_GRAPH_INVENTORY_REUSE_RECEIPT_VERSION,
        workspace: emptyWorkspace,
      } as const;

      expect(decodeCodeGraphInventoryReuseReceipt(encodeCodeGraphInventoryReuseReceipt(receipt))).toEqual(receipt);
    },
    {fastCheck: {numRuns: 100}},
  );

  fcProp(
    it,
    'rejects arbitrary non-receipt payloads instead of trusting persisted JSON',
    {
      payload: FC.string({maxLength: 2_000}).filter(
        payload => !Effect.pipe(payload, EffectString.trimStart, EffectString.startsWith('{')),
      ),
    },
    ({payload}) => {
      expect(decodeCodeGraphInventoryReuseReceipt(payload)).toBeUndefined();
    },
    {fastCheck: {numRuns: 100}},
  );
});
