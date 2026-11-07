import {Array as EffectArray} from 'effect';
import {mkdir, mkdtemp, readFile, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {dirname, join} from '@threadnote/testing/node-path';
import {afterEach, describe, expect, it} from 'vitest';
import {parseMemoryDocument} from '@threadnote/memory/document';
import {
  runSharePublish as runSharePublishEffect,
  runShareSync as runShareSyncEffect,
} from '@threadnote/threadnote/effect/share';
import {sharedUriFor} from '@threadnote/threadnote/share/index';
import type {ShareRuntime, ShareTeamsFile} from '@threadnote/threadnote/types';
import {runCommand} from '@threadnote/threadnote/utils';
import {runEffect} from '../helpers/effect-runtime.js';
import {
  canonicalAuthoringJson,
  decodeNativeAuthoringDocument,
  nativeAuthoringDigest,
  nativeSpecIntentDigest,
} from '@threadnote/workflow-automations/authoring';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  decodePortablePlanRef,
  publishPortablePlanPayload,
  readPortablePlanPayload,
} from '../../src/workflow_automation/portable_plan.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const runSharePublish = (...args: Parameters<typeof runSharePublishEffect>) =>
  runEffect(runSharePublishEffect(...args));
const runShareSync = (...args: Parameters<typeof runShareSyncEffect>) => runEffect(runShareSyncEffect(...args));

const homes: string[] = [];

async function git(args: readonly string[], cwd?: string): Promise<void> {
  await runEffect(runCommand('git', args, {cwd}));
}

function canonicalResourceFile(home: string, uri: string): string {
  return join(
    home,
    'data',
    'local',
    ...Effect.pipe(uri, __effectPipeInput => {
      const __effectPipeStage0 = Effect.pipe(__effectPipeInput, EffectString.slice('threadnote://'.length));
      const __effectPipeStage1 = Effect.pipe(__effectPipeStage0, EffectString.split('/'));
      return __effectPipeStage1;
    }),
  );
}

async function writeCanonicalResource(home: string, uri: string, content: string): Promise<void> {
  const file = canonicalResourceFile(home, uri);
  await mkdir(dirname(file), {recursive: true});
  await writeFile(file, content, 'utf8');
}

async function cloneShareHome(
  root: string,
  remote: string,
  user: string,
): Promise<{
  readonly config: ShareRuntime;
  readonly home: string;
  readonly worktree: string;
}> {
  const home = join(root, `home-${user}`);
  const worktree = join(home, 'share', 'worktrees', 'default');
  const gitdir = join(home, 'share', 'teams', 'default.gitdir');
  await mkdir(dirname(worktree), {recursive: true});
  await mkdir(dirname(gitdir), {recursive: true});
  await git(['clone', `--separate-git-dir=${gitdir}`, '--branch', 'main', '--', remote, worktree]);
  await git(['config', 'user.email', 'threadnote-test@example.com'], worktree);
  await git(['config', 'user.name', 'Threadnote Test'], worktree);
  const config: ShareRuntime = {account: 'local', agentContextHome: home, agentId: 'threadnote', user};
  const teams: ShareTeamsFile = {
    defaultTeam: 'default',
    teams: {
      default: {
        addedAt: new Date(0).toISOString(),
        gitdir,
        name: 'default',
        remote,
        worktree,
      },
    },
    version: 1,
  };
  await mkdir(join(home, 'share'), {recursive: true});
  await writeFile(join(home, 'share', 'teams.json'), `${JSON.stringify(teams, undefined, 2)}\n`, 'utf8');
  return {config, home, worktree};
}

describe('share two-home round trip', () => {
  afterEach(async () => {
    await Promise.all(EffectArray.map(homes.splice(0), path => rm(path, {force: true, recursive: true})));
  });

  it('publishes from one home and recalls the same canonical identity after sync on another', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-share-two-home-'));
    homes.push(root);
    const remote = join(root, 'remote.git');
    const seed = join(root, 'seed');
    await mkdir(seed, {recursive: true});
    await git(['init', '--bare', remote]);
    await git(['init'], seed);
    await git(['checkout', '-b', 'main'], seed);
    await git(['config', 'user.email', 'threadnote-test@example.com'], seed);
    await git(['config', 'user.name', 'Threadnote Test'], seed);
    await writeFile(join(seed, 'README.md'), '# Shared memories\n', 'utf8');
    await git(['add', 'README.md'], seed);
    await git(['commit', '-m', 'initial'], seed);
    await git(['remote', 'add', 'origin', remote], seed);
    await git(['push', '-u', 'origin', 'main'], seed);
    await git(['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);

    const publisher = await cloneShareHome(root, remote, 'denys');
    const subscriber = await cloneShareHome(root, remote, 'teammate');
    const sourceUri = 'threadnote://user/denys/memories/durable/projects/threadnote/two-home-roundtrip.md';
    const publisherSharedUri = sharedUriFor(publisher.config, sourceUri, 'default');
    const subscriberSharedUri = sharedUriFor(
      subscriber.config,
      'threadnote://user/teammate/memories/durable/projects/threadnote/two-home-roundtrip.md',
      'default',
    );
    await writeCanonicalResource(
      publisher.home,
      sourceUri,
      'MEMORY\nkind: durable\nstatus: active\nproject: threadnote\ntopic: two-home-roundtrip\nmemory_id: tn_two_home_roundtrip_fixture\n\nTwo-home Git share body.\n',
    );

    await runSharePublish(publisher.config, sourceUri, {team: 'default'});
    const published = await readFile(canonicalResourceFile(publisher.home, publisherSharedUri), 'utf8');
    const publishedDoc = parseMemoryDocument(publisherSharedUri, published);
    expect(publishedDoc?.metadata.memoryId).toBe('tn_two_home_roundtrip_fixture');

    await runShareSync(subscriber.config, {push: false});
    const ingested = await readFile(canonicalResourceFile(subscriber.home, subscriberSharedUri), 'utf8');
    const ingestedDoc = parseMemoryDocument(subscriberSharedUri, ingested);
    expect(ingestedDoc?.metadata.memoryId).toBe(publishedDoc?.metadata.memoryId);
    expect(ingestedDoc?.body).toBe(publishedDoc?.body);
    expect(ingestedDoc?.metadata.topic).toBe(publishedDoc?.metadata.topic);

    const plan = decodeNativeAuthoringDocument({
      format: 'threadnote-native-authoring',
      schemaVersion: 1,
      id: 'fixture',
      project: 'threadnote',
      title: 'Shared fixture',
      objective: 'Transfer one exact plan.',
      requirements: [{id: 'r', behavior: 'Preserve the fixture.'}],
      context: {codeRefs: [], evidenceRefs: [], note: 'Synthetic test fixture.'},
      source: null,
      sourceFreeReason: 'This share boundary fixture has no repository source.',
      kind: 'plan',
      current: {summary: 'The fixture is local.', components: [], contracts: [], diagram: ''},
      target: {summary: 'The fixture is shared.', components: [], contracts: [], diagram: ''},
      phases: [
        {
          id: 'phase',
          title: 'Share fixture',
          outcome: 'A recipient reads it.',
          dependsOn: [],
          affectedPaths: [],
          newPaths: [],
          contracts: [],
          safeBoundary: 'Only synthetic data is published.',
          acceptance: [
            {
              id: 'a',
              criterion: 'Recipient reads the plan.',
              verification: 'Compare the decoded plan.',
              requirementIds: ['r'],
            },
          ],
        },
      ],
      decisions: [],
      openQuestions: [],
      review: {required: true, reason: 'Fixture review.'},
    });
    if (plan.kind !== 'plan') throw new Error('Invalid fixture');
    const documentHash = nativeAuthoringDigest(plan);
    const payload = {
      format: 'threadnote-portable-plan' as const,
      version: 1 as const,
      project: 'threadnote',
      plan: {document: canonicalAuthoringJson(plan), documentHash},
      evidence: [],
      provenance: {
        root: {
          uri: sourceUri,
          memoryId: 'tn_two_home_roundtrip_fixture',
          revision: sha256HexSync('synthetic-donor-root'),
        },
        documentHash,
        intentHash: nativeSpecIntentDigest(plan, 2),
        review: {outcome: 'accepted' as const, blockingIssueCount: 0 as const},
        approval: 'approved' as const,
      },
    };
    const first = await runEffect(publishPortablePlanPayload(publisher.config, payload, 'default'));
    const second = await runEffect(publishPortablePlanPayload(publisher.config, payload, 'default'));
    expect(second.sharedPlanRef).toBe(first.sharedPlanRef);
    await runShareSync(subscriber.config, {push: false});
    const recipient = await runEffect(readPortablePlanPayload(subscriber.config, first.sharedPlanRef, 'threadnote'));
    expect(recipient.plan).toEqual(plan);
    const pin = decodePortablePlanRef(first.sharedPlanRef);
    const rootUri = `threadnote://user/teammate/memories/shared/default/durable/projects/threadnote/portable-plans/${pin.payloadHash}/root.md`;
    const rootRelative = Effect.pipe(
      rootUri,
      EffectString.replace('threadnote://user/teammate/memories/shared/default/', ''),
    );
    const rootFile = canonicalResourceFile(subscriber.home, rootUri);
    const committedRootFile = join(subscriber.worktree, rootRelative);
    const originalRoot = await readFile(rootFile, 'utf8');
    await writeFile(
      rootFile,
      Effect.pipe(originalRoot, EffectString.replace('visibility: shared', 'visibility: personal')),
      'utf8',
    );
    await expect(
      runEffect(readPortablePlanPayload(subscriber.config, first.sharedPlanRef, 'threadnote')),
    ).rejects.toMatchObject({code: 'portable-plan-conflict'});
    await writeFile(rootFile, originalRoot, 'utf8');

    const privateRoot = Effect.pipe(originalRoot, EffectString.replace('visibility: shared', 'visibility: personal'));
    await writeFile(rootFile, privateRoot, 'utf8');
    await writeFile(committedRootFile, privateRoot, 'utf8');
    await git(['add', '--', rootRelative], subscriber.worktree);
    await git(['commit', '-m', 'fixture private shared plan root'], subscriber.worktree);
    await expect(
      runEffect(readPortablePlanPayload(subscriber.config, first.sharedPlanRef, 'threadnote')),
    ).rejects.toMatchObject({code: 'portable-plan-private'});
    await git(['revert', '--no-edit', 'HEAD'], subscriber.worktree);
    await writeFile(rootFile, originalRoot, 'utf8');

    const childUri = `threadnote://user/teammate/memories/shared/default/durable/projects/threadnote/portable-plans/${pin.payloadHash}/page-0.md`;
    await rm(canonicalResourceFile(subscriber.home, childUri));
    await expect(
      runEffect(readPortablePlanPayload(subscriber.config, first.sharedPlanRef, 'threadnote')),
    ).rejects.toMatchObject({code: 'portable-plan-missing'});
  });
});
