import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  admitHostedContextCiWebhookV1,
  buildHostedContextCiPolicyV1,
  hostedContextCiDiagnosticsV1,
  type HostedContextCiEventV1,
} from '@threadnote/remote-memory/hosted/context_ci';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const secret = 'webhook-test-key-at-least-thirty-two-bytes';
const now = 1_800_000_000_000;
const event: HostedContextCiEventV1 = {
  version: 1,
  installationId: 'install-1',
  repositoryId: 'repo-1',
  headRepositoryId: 'repo-1',
  ref: 'refs/heads/main',
  baseRef: 'refs/heads/main',
  headCommit: Effect.pipe('a', EffectString.repeat(40)),
  baseCommit: Effect.pipe('b', EffectString.repeat(40)),
  kind: 'push',
  trusted: true,
};
const policy = buildHostedContextCiPolicyV1({
  tenantId: 'tenant-1',
  shareId: 'share-1',
  project: 'threadnote',
  source: 'git-events',
  installationId: 'install-1',
  repositoryId: 'repo-1',
  refs: ['refs/heads/main'],
  baseRefs: ['refs/heads/main'],
  readerIdentity: 'reader',
  publisherIdentity: 'publisher',
  queueLimit: 10,
  requestsPerMinute: 20,
  maxAttempts: 3,
});
function webhook(value: unknown = event, deliveryId = 'delivery-1') {
  const body = JSON.stringify(value);
  const timestamp = String(now);
  const source = policy.source;
  const signature = new Bun.CryptoHasher('sha256', secret)
    .update(JSON.stringify([source, deliveryId, timestamp, body]))
    .digest('hex');
  return {body, deliveryId, timestamp, source, signature};
}

describe('hosted Context CI admission and content-free contracts', () => {
  it('accepts canonical portable project names', () => {
    const project = 'Team Notes Café';
    expect(buildHostedContextCiPolicyV1({...policy, project}).project).toBe(project);
  });

  it('binds signed delivery to exact allowlists and immutable refs', () => {
    const job = admitHostedContextCiWebhookV1(policy, webhook(), secret, now);
    expect(job.event).toEqual(event);
    for (const patch of [
      {installationId: 'other'},
      {repositoryId: 'other'},
      {headRepositoryId: 'fork'},
      {ref: 'refs/heads/other'},
      {baseRef: 'refs/heads/other'},
      {trusted: false},
      {headCommit: 'main'},
      {baseCommit: 'HEAD~1'},
      {kind: 'pull_request_target'},
    ])
      expect(() => admitHostedContextCiWebhookV1(policy, webhook({...event, ...patch}), secret, now)).toThrow();
    expect(() => admitHostedContextCiWebhookV1(policy, {...webhook(), source: 'other'}, secret, now)).toThrow();
    expect(() => admitHostedContextCiWebhookV1(policy, {...webhook(), body: '{}'}, secret, now)).toThrow();
    expect(() => admitHostedContextCiWebhookV1(policy, webhook(), secret, now + 300_001)).toThrow();
  });

  it('deduplicates reruns independently of signed delivery identity', () => {
    fc.assert(
      fc.property(fc.uuid(), delivery => {
        const first = admitHostedContextCiWebhookV1(policy, webhook(), secret, now);
        const replay = admitHostedContextCiWebhookV1(policy, webhook({...event, kind: 'rerun'}, delivery), secret, now);
        expect(replay.jobId).toBe(first.jobId);
        expect(replay.inputDigest).toBe(first.inputDigest);
      }),
      {numRuns: 40},
    );
  });

  it('canonicalizes refs and base refs without mutating inputs', () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[A-Za-z0-9_-]{1,12}$/u), {minLength: 1, maxLength: 12}),
        fc.array(fc.stringMatching(/^[A-Za-z0-9_-]{1,12}$/u), {minLength: 1, maxLength: 12}),
        (refValues, baseRefValues) => {
          const refs = EffectArray.map(refValues, value => `refs/heads/${value}`);
          const baseRefs = EffectArray.map(baseRefValues, value => `refs/heads/${value}`);
          const permutedRefs = [...refs].reverse();
          const permutedBaseRefs = [...baseRefs].reverse();
          const duplicatedRefs = [...permutedRefs, refs[0]];
          const duplicatedBaseRefs = [...permutedBaseRefs, baseRefs[0]];
          const refsBefore = [...refs];
          const baseRefsBefore = [...baseRefs];
          const duplicatedRefsBefore = [...duplicatedRefs];
          const duplicatedBaseRefsBefore = [...duplicatedBaseRefs];
          const canonical = buildHostedContextCiPolicyV1({...policy, refs, baseRefs});
          const permutationInvariant = buildHostedContextCiPolicyV1({
            ...policy,
            refs: permutedRefs,
            baseRefs: permutedBaseRefs,
          });
          const duplicateInvariant = buildHostedContextCiPolicyV1({
            ...policy,
            refs: duplicatedRefs,
            baseRefs: duplicatedBaseRefs,
          });
          expect(permutationInvariant.digest).toBe(canonical.digest);
          expect(duplicateInvariant.digest).toBe(canonical.digest);
          expect(refs).toEqual(refsBefore);
          expect(baseRefs).toEqual(baseRefsBefore);
          expect(duplicatedRefs).toEqual(duplicatedRefsBefore);
          expect(duplicatedBaseRefs).toEqual(duplicatedBaseRefsBefore);

          let changedRef = 'refs/heads/__added__';
          while (refs.includes(changedRef)) changedRef += '_';
          const changed = buildHostedContextCiPolicyV1({...policy, refs: [...refs, changedRef], baseRefs});
          expect(changed.digest).not.toBe(canonical.digest);
        },
      ),
      {numRuns: 40},
    );
  });

  it('rejects undeclared payload fields and identity privilege overlap', () => {
    expect(() =>
      admitHostedContextCiWebhookV1(policy, webhook({...event, body: 'private-memory'}), secret, now),
    ).toThrow();
    expect(() => buildHostedContextCiPolicyV1({...policy, publisherIdentity: policy.readerIdentity})).toThrow();
  });

  it('projects deterministic bounded JSON and SARIF without project or arbitrary content', () => {
    const raw = JSON.stringify({
      version: 1,
      project: 'private-project',
      evidenceStatus: 'complete',
      exitClassification: 'clean',
      exitCode: 0,
      findings: [],
      limit: 100,
      omittedFindings: 0,
    });
    const result = hostedContextCiDiagnosticsV1(raw);
    expect(result.report.project).toBe('hosted-context-ci');
    expect(JSON.stringify(result)).not.toContain('private-project');
    expect(result).toEqual(hostedContextCiDiagnosticsV1(raw));
    expect(() =>
      hostedContextCiDiagnosticsV1(
        Effect.pipe(raw, EffectString.replace('"findings":[]', '"body":"private-memory","findings":[]')),
      ),
    ).toThrow();
    expect(() => hostedContextCiDiagnosticsV1(Effect.pipe('x', EffectString.repeat(262_145)))).toThrow();
  });
});
