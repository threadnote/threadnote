import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  CODE_MEMORY_LINK_RETAINED_ARTIFACT_ROLES,
  codeMemoryLinkRetainedBundleHashV1,
  createCodeMemoryLinkRetainedBundleV1,
  verifyCodeMemoryLinkRetainedBundleV1,
  type CodeMemoryLinkRetainedArtifactRole,
} from '@threadnote/threadnote/evaluation/code-memory-link-retained-bundle';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const CANDIDATE = Effect.pipe('a', EffectString.repeat(40));
const CLIENTS = [
  {
    clientId: `cli_${Effect.pipe('1', EffectString.repeat(16))}`,
    configProjection: json({
      appServerVersion: '0.149.0-alpha.4.1',
      model: 'gpt-5.6-luna',
      roleBinding: Effect.pipe('b', EffectString.repeat(64)),
    }),
    descriptor: json({descriptorHash: Effect.pipe('c', EffectString.repeat(64)), version: 1}),
  },
  {
    clientId: `cli_${Effect.pipe('2', EffectString.repeat(16))}`,
    configProjection: json({
      appServerVersion: '0.149.0-alpha.4.1',
      model: 'gpt-5.6-terra',
      roleBinding: Effect.pipe('d', EffectString.repeat(64)),
    }),
    descriptor: json({descriptorHash: Effect.pipe('e', EffectString.repeat(64)), version: 1}),
  },
] as const;
const SEALED_FILES = [
  {content: json({task: 'hidden'}), path: `tasks/tsk_${Effect.pipe('3', EffectString.repeat(16))}/packet.json`},
  {content: 'export const judge = 1;\n', path: `artifacts/judge/art_${Effect.pipe('4', EffectString.repeat(16))}.ts`},
] as const;

describe('Code Memory Link retained evidence bundle', () => {
  it('round trips the exact complete role set through a canonical content-addressed blob map', () => {
    const bundle = createCodeMemoryLinkRetainedBundleV1({
      artifacts: artifacts(),
      candidateCommit: CANDIDATE,
      clients: CLIENTS,
      sealedFiles: SEALED_FILES,
    });
    const verified = verifyCodeMemoryLinkRetainedBundleV1({blobs: bundle.blobs, indexContent: bundle.indexContent});

    expect(codeMemoryLinkRetainedBundleHashV1(bundle.indexContent)).toBe(bundle.bundleHash);
    expect(EffectRecord.keys(verified.artifacts)).toEqual(CODE_MEMORY_LINK_RETAINED_ARTIFACT_ROLES);
    expect(EffectArray.map(verified.clients, client => client.clientId)).toEqual(
      EffectArray.map(CLIENTS, client => client.clientId),
    );
    expect(EffectArray.map(verified.sealedFiles, file => file.path)).toEqual(
      EffectArray.map([...SEALED_FILES], file => file.path).sort(),
    );
    expect(EffectArray.every(bundle.index.blobs, blob => blob.path === `blobs/${blob.sha256}`)).toBe(true);
  });

  it('rejects changed bytes, unreferenced blobs, and noncanonical indexes', () => {
    const bundle = createCodeMemoryLinkRetainedBundleV1({
      artifacts: artifacts(),
      candidateCommit: CANDIDATE,
      clients: CLIENTS,
      sealedFiles: SEALED_FILES,
    });
    const first = bundle.index.blobs[0];
    const changed = new Map(bundle.blobs);
    changed.set(first.sha256, `${changed.get(first.sha256)} `);
    expect(() => verifyCodeMemoryLinkRetainedBundleV1({blobs: changed, indexContent: bundle.indexContent})).toThrow(
      /byte length or SHA-256/u,
    );
    const extra = new Map(bundle.blobs);
    extra.set(Effect.pipe('f', EffectString.repeat(64)), json({extra: true}));
    expect(() => verifyCodeMemoryLinkRetainedBundleV1({blobs: extra, indexContent: bundle.indexContent})).toThrow(
      /blob map differs/u,
    );
    expect(() => codeMemoryLinkRetainedBundleHashV1(JSON.stringify(JSON.parse(bundle.indexContent)))).toThrow(
      /canonical JSON encoding/u,
    );
  });

  it.each([
    json({authSourcePath: 'redacted'}),
    json({api_key: 'redacted'}),
    json({value: '/Users/operator/private/auth.json'}),
    json({value: String.raw`C:\Users\operator\auth.json`}),
    json({value: 'Bearer abcdefghijklmnopqrstuvwxyz'}),
    json({value: 'sk-abcdefghijklmnopqrstuvwxyz'}),
  ])('rejects auth configuration, absolute paths, and credential-shaped content', unsafe => {
    const input = artifacts();
    input.result = unsafe;
    expect(() =>
      createCodeMemoryLinkRetainedBundleV1({
        artifacts: input,
        candidateCommit: CANDIDATE,
        clients: CLIENTS,
        sealedFiles: SEALED_FILES,
      }),
    ).toThrow(/absolute path|credential/u);
  });

  it('retains ordinary relative repository paths and token accounting', () => {
    const input = artifacts();
    input.result = json({providerUsage: {tokens: 1200}, source: 'src/recall/code_links.ts'});
    expect(() =>
      createCodeMemoryLinkRetainedBundleV1({
        artifacts: input,
        candidateCommit: CANDIDATE,
        clients: CLIENTS,
        sealedFiles: SEALED_FILES,
      }),
    ).not.toThrow();
  });

  it.each(['../private.json', '/Users/operator/private.json', 'calibration/task.json', 'tasks/../private.json'])(
    'rejects a sealed source outside the reviewed artifacts/tasks tree',
    path => {
      expect(() =>
        createCodeMemoryLinkRetainedBundleV1({
          artifacts: artifacts(),
          candidateCommit: CANDIDATE,
          clients: CLIENTS,
          sealedFiles: [{content: json({version: 1}), path}],
        }),
      ).toThrow(/safe relative artifacts\/ or tasks\/ path/u);
    },
  );

  it('rejects a private absolute path embedded in a retained sealed text artifact', () => {
    expect(() =>
      createCodeMemoryLinkRetainedBundleV1({
        artifacts: artifacts(),
        candidateCommit: CANDIDATE,
        clients: CLIENTS,
        sealedFiles: [{content: 'const source = "/Users/operator/private.json";\n', path: 'artifacts/judge/judge.ts'}],
      }),
    ).toThrow(/absolute path/u);
  });

  it('rejects every text absolute path while allowing the reviewed portable interpreter shebang', () => {
    expect(() =>
      createCodeMemoryLinkRetainedBundleV1({
        artifacts: artifacts(),
        candidateCommit: CANDIDATE,
        clients: CLIENTS,
        sealedFiles: [{content: 'const source = "/etc/passwd";\n', path: 'artifacts/judge/judge.ts'}],
      }),
    ).toThrow(/absolute path/u);
    expect(() =>
      createCodeMemoryLinkRetainedBundleV1({
        artifacts: artifacts(),
        candidateCommit: CANDIDATE,
        clients: CLIENTS,
        sealedFiles: [{content: '#!/usr/bin/env bun\nexport const judge = 1;\n', path: 'artifacts/judge/judge.ts'}],
      }),
    ).not.toThrow();
  });

  it('rejects every generated Unix home path in any retained JSON role (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'), {minLength: 1, maxLength: 20}),
        characters => {
          const input = artifacts();
          input.sealedLayout = json({observed: `/home/${EffectArray.join(characters, '')}/private.json`});
          expect(() =>
            createCodeMemoryLinkRetainedBundleV1({
              artifacts: input,
              candidateCommit: CANDIDATE,
              clients: CLIENTS,
              sealedFiles: SEALED_FILES,
            }),
          ).toThrow(/absolute path/u);
        },
      ),
      {numRuns: 32},
    );
  });
});

function artifacts(): Record<CodeMemoryLinkRetainedArtifactRole, string> {
  return {
    assignment: json({assignmentHash: Effect.pipe('1', EffectString.repeat(64)), version: 1}),
    attempts: jsonl({attemptHash: Effect.pipe('2', EffectString.repeat(64)), version: 1}),
    dogfood: json({artifactHash: Effect.pipe('3', EffectString.repeat(64)), version: 1}),
    evidence: jsonl({evidenceHash: Effect.pipe('4', EffectString.repeat(64)), version: 1}),
    manifest: json({manifestHash: Effect.pipe('5', EffectString.repeat(64)), version: 1}),
    result: json({gate: {status: 'passed'}, version: 1}),
    sealedLayout: json({layoutArtifactId: `art_${Effect.pipe('6', EffectString.repeat(16))}`, version: 1}),
    sealedSuite: json({suiteHash: Effect.pipe('7', EffectString.repeat(64)), version: 1}),
    trials: jsonl({receiptHash: Effect.pipe('8', EffectString.repeat(64)), version: 1}),
  };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, undefined, 2)}\n`;
}

function jsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
