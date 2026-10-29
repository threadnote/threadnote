import {Array as EffectArray, Schema} from 'effect';
import type {Sql} from 'postgres';
import {buildHostedContextCiPolicyV1} from './context_ci.js';
import {
  archiveHostedContextCiJobs,
  enqueueHostedContextCiWebhook,
  registerHostedContextCiTarget,
  setHostedContextCiEnabled,
  setHostedContextCiOptIn,
} from './context_ci_postgres.js';
import * as EffectRecord from 'effect/Record';

/** Trusted operator input, never a public HTTP request. Each action still uses its dedicated database grants. */
export async function controlHostedContextCi(sql: Sql, input: unknown, webhookKey?: string): Promise<unknown> {
  if (!isRecord(input)) throw new Error('Context CI control input is invalid.');
  const value = input;
  if (value.action === 'register') {
    exactKeys(value, ['action', 'policy']);
    const policyInput = Schema.decodeUnknownSync(PolicyInputSchema)(value.policy);
    const policy = buildHostedContextCiPolicyV1(policyInput);
    await registerHostedContextCiTarget(sql, policy);
    return {version: 1, status: 'registered', policyDigest: policy.digest};
  }
  if (value.action === 'enable') {
    exactKeys(value, ['action', 'enabled']);
    if (typeof value.enabled !== 'boolean') throw new Error('Context CI enabled flag is invalid.');
    await setHostedContextCiEnabled(sql, value.enabled);
    return {version: 1, status: value.enabled ? 'enabled' : 'disabled'};
  }
  if (value.action === 'opt-in') {
    exactKeys(value, ['action', 'tenantId', 'repositoryId', 'enabled']);
    const tenantId = requiredString(value.tenantId, 'tenantId');
    const repositoryId = requiredString(value.repositoryId, 'repositoryId');
    if (typeof value.enabled !== 'boolean') throw new Error('Context CI enabled flag is invalid.');
    await setHostedContextCiOptIn(sql, tenantId, repositoryId, value.enabled);
    return {version: 1, status: value.enabled ? 'opted-in' : 'opted-out'};
  }
  if (value.action === 'archive') {
    exactKeys(value, ['action', 'tenantId', 'repositoryId']);
    const count = await archiveHostedContextCiJobs(
      sql,
      requiredString(value.tenantId, 'tenantId'),
      requiredString(value.repositoryId, 'repositoryId'),
    );
    return {version: 1, status: 'archived', count};
  }
  if (value.action === 'enqueue') {
    exactKeys(value, ['action', 'tenantId', 'repositoryId', 'webhook']);
    if (!webhookKey) throw new Error('Context CI webhook verification key is unavailable.');
    const webhook = Schema.decodeUnknownSync(WebhookSchema)(value.webhook);
    return enqueueHostedContextCiWebhook(sql, {
      tenantId: requiredString(value.tenantId, 'tenantId'),
      repositoryId: requiredString(value.repositoryId, 'repositoryId'),
      webhook,
      webhookKey,
    });
  }
  throw new Error('Context CI control action is invalid.');
}

const PolicyInputSchema = Schema.Struct({
  baseRefs: Schema.Array(Schema.String),
  installationId: Schema.String,
  maxAttempts: Schema.Finite,
  project: Schema.String,
  publisherIdentity: Schema.String,
  queueLimit: Schema.Finite,
  readerIdentity: Schema.String,
  refs: Schema.Array(Schema.String),
  repositoryId: Schema.String,
  requestsPerMinute: Schema.Finite,
  shareId: Schema.String,
  source: Schema.String,
  tenantId: Schema.String,
});
const WebhookSchema = Schema.Struct({
  body: Schema.String,
  deliveryId: Schema.String,
  signature: Schema.String,
  source: Schema.String,
  timestamp: Schema.String,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`Context CI ${name} is invalid.`);
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (
    EffectRecord.keys(value).length !== keys.length ||
    EffectArray.some(EffectRecord.keys(value), key => !keys.includes(key))
  ) {
    throw new Error('Context CI control fields are invalid.');
  }
}
