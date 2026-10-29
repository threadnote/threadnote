import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  CODE_GRAPH_GIT_STATUS_CACHE_INDEX_BYTES_MAXIMUM,
  CODE_GRAPH_GIT_STATUS_CACHE_RECEIPT_VERSION,
  parseCodeGraphGitStatusCacheReceipt,
} from '@threadnote/graph/git/status_cache';

describe('code graph private Git status cache receipt', () => {
  it('round-trips every bounded source-index identity', () => {
    fc.assert(
      fc.property(
        fc.integer({max: CODE_GRAPH_GIT_STATUS_CACHE_INDEX_BYTES_MAXIMUM, min: 0}),
        fc.nat(Number.MAX_SAFE_INTEGER),
        fc.nat(Number.MAX_SAFE_INTEGER),
        fc.nat(Number.MAX_SAFE_INTEGER),
        fc.option(fc.stringMatching(/^[0-9a-f]{64}$/), {nil: undefined}),
        (indexBytes, sourceIndexDevice, sourceIndexInode, sourceIndexModifiedAtMilliseconds, semanticSha256) => {
          const receipt = {
            indexBytes,
            sourceIndexDevice: sourceIndexDevice.toString(),
            sourceIndexInode: sourceIndexInode.toString(),
            sourceIndexModifiedAtMilliseconds,
            ...(semanticSha256 === undefined ? {} : {sourceIndexSemanticSha256: semanticSha256}),
            version: CODE_GRAPH_GIT_STATUS_CACHE_RECEIPT_VERSION,
          };
          expect(parseCodeGraphGitStatusCacheReceipt(JSON.stringify(receipt))).toEqual(receipt);
        },
      ),
      {numRuns: 100},
    );
  });

  it('round-trips exact filesystem identities beyond JavaScript safe integers', () => {
    fc.assert(
      fc.property(
        fc.bigInt({min: 2n ** 53n, max: 2n ** 64n - 1n}),
        fc.bigInt({min: 2n ** 53n, max: 2n ** 64n - 1n}),
        (device, inode) => {
          const receipt = {
            version: CODE_GRAPH_GIT_STATUS_CACHE_RECEIPT_VERSION,
            indexBytes: 100,
            sourceIndexDevice: device.toString(),
            sourceIndexInode: inode.toString(),
            sourceIndexModifiedAtMilliseconds: 1,
          };
          expect(parseCodeGraphGitStatusCacheReceipt(JSON.stringify(receipt))).toEqual(receipt);
        },
      ),
      {numRuns: 100},
    );
  });

  it.each([
    {
      indexBytes: -1,
      sourceIndexDevice: 1,
      sourceIndexInode: 1,
      sourceIndexModifiedAtMilliseconds: 1,
      version: CODE_GRAPH_GIT_STATUS_CACHE_RECEIPT_VERSION,
    },
    {
      indexBytes: CODE_GRAPH_GIT_STATUS_CACHE_INDEX_BYTES_MAXIMUM + 1,
      sourceIndexDevice: 1,
      sourceIndexInode: 1,
      sourceIndexModifiedAtMilliseconds: 1,
      version: CODE_GRAPH_GIT_STATUS_CACHE_RECEIPT_VERSION,
    },
    {
      indexBytes: 1,
      sourceIndexDevice: -1,
      sourceIndexInode: 1,
      sourceIndexModifiedAtMilliseconds: 1,
      version: CODE_GRAPH_GIT_STATUS_CACHE_RECEIPT_VERSION,
    },
    {
      indexBytes: 1,
      sourceIndexDevice: 1,
      sourceIndexInode: 1,
      sourceIndexModifiedAtMilliseconds: 1,
      version: 1,
    },
    {
      indexBytes: 1,
      sourceIndexDevice: 1,
      sourceIndexInode: 1,
      sourceIndexModifiedAtMilliseconds: 1,
      version: CODE_GRAPH_GIT_STATUS_CACHE_RECEIPT_VERSION + 1,
    },
    {
      indexBytes: 1,
      sourceIndexDevice: 1,
      sourceIndexInode: 1,
      sourceIndexModifiedAtMilliseconds: 1,
      sourceIndexSemanticSha256: 'not-a-digest',
      version: CODE_GRAPH_GIT_STATUS_CACHE_RECEIPT_VERSION,
    },
  ])('rejects an invalid receipt %#', receipt => {
    expect(parseCodeGraphGitStatusCacheReceipt(JSON.stringify(receipt))).toBeUndefined();
  });
});
