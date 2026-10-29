import {describe, expect, it, vi} from 'vitest';
import {admitHostedContextCiWebhookV1, buildHostedContextCiPolicyV1} from '@threadnote/remote-memory/hosted/context_ci';
import {
  evaluateHostedContextCiJobV1,
  publishHostedContextCiJobV1,
  type HostedContextCiReadIdentityV1,
  type HostedContextCiPublicationIdentityV1,
} from '@threadnote/remote-memory/hosted/context_ci_operator';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const policy = buildHostedContextCiPolicyV1({
  tenantId: 'tenant',
  shareId: 'share',
  project: 'project',
  source: 'gateway',
  installationId: 'installation',
  repositoryId: 'repository',
  refs: ['refs/heads/feature'],
  baseRefs: ['refs/heads/main'],
  readerIdentity: 'reader',
  publisherIdentity: 'publisher',
  queueLimit: 10,
  requestsPerMinute: 10,
  maxAttempts: 3,
});
const event = {
  version: 1,
  trusted: true,
  kind: 'pull_request',
  installationId: 'installation',
  repositoryId: 'repository',
  headRepositoryId: 'repository',
  ref: 'refs/heads/feature',
  baseRef: 'refs/heads/main',
  headCommit: Effect.pipe('a', EffectString.repeat(40)),
  baseCommit: Effect.pipe('b', EffectString.repeat(40)),
};
const body = JSON.stringify(event);
const timestamp = '1800000000000';
const key = 'test-key-that-is-longer-than-thirty-two-bytes';
const signature = new Bun.CryptoHasher('sha256', key)
  .update(JSON.stringify(['gateway', 'delivery', timestamp, body]))
  .digest('hex');
const job = admitHostedContextCiWebhookV1(
  policy,
  {source: 'gateway', deliveryId: 'delivery', timestamp, body, signature},
  key,
  Number(timestamp),
);
const raw = JSON.stringify({
  version: 1,
  project: 'project',
  evidenceStatus: 'complete',
  exitClassification: 'clean',
  exitCode: 0,
  findings: [],
  limit: 100,
  omittedFindings: 0,
});
function identities() {
  const reader: HostedContextCiReadIdentityV1 = {
    identity: 'reader',
    capabilities: ['repository:read', 'context:check'],
    resolve: vi.fn(async () => event),
    evaluate: vi.fn(async () => raw),
  };
  const publisher: HostedContextCiPublicationIdentityV1 = {
    identity: 'publisher',
    capabilities: ['checks:publish'],
    publish: vi.fn(async input => ({publicationId: 'private-provider-id', digest: input.diagnostics.digest})),
  };
  return {reader, publisher};
}

describe('hosted Context CI staged operator', () => {
  it('revalidates both commits and publishes only canonical diagnostics with an immutable idempotency key', async () => {
    const {reader, publisher} = identities();
    const evaluation = await evaluateHostedContextCiJobV1(policy, job, reader);
    expect(evaluation.status).toBe('evaluated');
    if (evaluation.status !== 'evaluated') throw new Error('missing evaluation');
    const published = await publishHostedContextCiJobV1(policy, job, evaluation.diagnostics, reader, publisher);
    expect(published.status).toBe('published');
    expect(JSON.stringify(published)).not.toContain('private-provider-id');
    expect(reader.resolve).toHaveBeenCalledTimes(3);
    expect(publisher.publish).toHaveBeenCalledWith(
      expect.objectContaining({idempotencyKey: job.jobId, headCommit: event.headCommit}),
    );
    expect(JSON.stringify(vi.mocked(publisher.publish).mock.calls)).not.toContain('threadnote://');
  });

  it('never evaluates a moved head/base or publishes evidence after either ref moves', async () => {
    for (const changed of [
      {headCommit: Effect.pipe('c', EffectString.repeat(40))},
      {baseCommit: Effect.pipe('d', EffectString.repeat(40))},
      {repositoryId: 'other'},
    ]) {
      const {reader, publisher} = identities();
      const evaluated = await evaluateHostedContextCiJobV1(policy, job, reader);
      if (evaluated.status !== 'evaluated') throw new Error('missing evaluation');
      vi.mocked(reader.resolve).mockResolvedValue({...event, ...changed});
      expect(await evaluateHostedContextCiJobV1(policy, job, reader)).toEqual({
        status: 'retry',
        reason: 'immutable-ref-changed',
      });
      expect(await publishHostedContextCiJobV1(policy, job, evaluated.diagnostics, reader, publisher)).toEqual({
        status: 'retry',
        reason: 'immutable-ref-changed',
      });
      expect(publisher.publish).not.toHaveBeenCalled();
      expect(reader.evaluate).toHaveBeenCalledTimes(1);
    }
  });

  it('returns closed retry reasons without exception, source, or memory content', async () => {
    const {reader, publisher} = identities();
    const evaluated = await evaluateHostedContextCiJobV1(policy, job, reader);
    if (evaluated.status !== 'evaluated') throw new Error('missing evaluation');
    vi.mocked(publisher.publish).mockRejectedValue(new Error('token=secret private-memory'));
    expect(await publishHostedContextCiJobV1(policy, job, evaluated.diagnostics, reader, publisher)).toEqual({
      status: 'retry',
      reason: 'publication-unavailable',
    });
    vi.mocked(reader.evaluate).mockResolvedValue(
      Effect.pipe(raw, EffectString.replace('"project"', '"privateMemory":"secret","project"')),
    );
    expect(await evaluateHostedContextCiJobV1(policy, job, reader)).toEqual({
      status: 'retry',
      reason: 'evaluation-unavailable',
    });
  });

  it('rejects extra credential authority before invoking adapters', async () => {
    const {reader} = identities();
    await expect(
      (() => {
        const readerWithUnexpectedCapability = {...reader};
        expect(
          Reflect.set(readerWithUnexpectedCapability, 'capabilities', [
            'repository:read',
            'context:check',
            'repository:write',
          ]),
        ).toBe(true);
        return evaluateHostedContextCiJobV1(policy, job, readerWithUnexpectedCapability);
      })(),
    ).rejects.toThrow(/identity/);
    expect(reader.resolve).not.toHaveBeenCalled();
    expect(reader.evaluate).not.toHaveBeenCalled();
  });
});
