import {Array as EffectArray} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {Predicate} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {parseMemoryDocument} from '@threadnote/memory/document';
import {runCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {decodeNativeAuthoringDocument, nativeAuthoringDigest} from '@threadnote/workflow-automations/authoring';
import {persistCodexCloudProfile} from '../../src/codex/profile.js';
import {persistCursorCloudIdentityProfile} from '../../src/cursor/profile.js';
import {AuthoringRootSchema, decodeAuthoringArtifact} from '../../src/workflow_automation/authoring_artifacts.js';
import {nativeFixture, provideNative} from './native-automation-fixture.js';
import {
  executionDiagnosticPhase,
  workflowExecutionDiagnostics,
  withWorkflowExecutionDiagnostics,
} from './workflow-execution-diagnostics.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const object = (value: unknown): Record<string, unknown> => {
  if (!Predicate.isObject(value)) throw new Error('Expected an object response');
  return value;
};
const payload = (value: unknown) => object(object(value).authoring);
const reference = (value: unknown) => {
  const ref = object(value);
  if (typeof ref.uri !== 'string' || typeof ref.memoryId !== 'string' || typeof ref.revision !== 'string')
    throw new Error('Expected a native authoring memory reference');
  return {uri: ref.uri, memoryId: ref.memoryId, revision: ref.revision};
};
const context = {
  codeRefs: [] as string[],
  evidenceRefs: [] as [],
  note: 'Source-free personal-cloud fixture; no external evidence is claimed.',
};
const document = () =>
  decodeNativeAuthoringDocument({
    format: 'threadnote-native-authoring',
    schemaVersion: 1,
    kind: 'spec',
    id: 'feature',
    project: 'fixture',
    title: 'Private cloud authoring',
    objective: 'Save a private draft and reload its complete verified content.',
    requirements: [{id: 'req-private', behavior: 'The author can save and reload the complete private specification.'}],
    context,
    source: null,
    sourceFreeReason: 'This focused test verifies private authoring without inspected source.',
    actors: ['author'],
    inScope: ['Save and reload the specification in the task-local profile.'],
    outOfScope: ['Publishing any artifact to the configured shared Git remote.'],
    constraints: ['Keep all authoring memories in the task-local handoff scope.'],
    observations: [],
    scenarios: [
      {
        id: 'scenario-private-roundtrip',
        requirementIds: ['req-private'],
        given: 'A personal cloud workflow is bound to one project.',
        when: 'The author saves and reloads the specification.',
        then: 'The exact content remains private and complete.',
      },
    ],
    assumptions: [],
    questions: [],
    artifacts: [],
    review: {required: true, reason: 'A behavior specification requires independent review.'},
  });

for (const profile of ['codex-cloud-personal', 'cursor-cloud-personal'] as const) {
  effectIt.effect(`${profile} keeps the authoring lifecycle task-local and unpublished`, testContext => {
    const diagnostics = workflowExecutionDiagnostics(testContext, {testTag: 'native-authoring-cloud'});
    executionDiagnosticPhase(diagnostics, 'authoring-provisioning');
    return withWorkflowExecutionDiagnostics(
      Effect.gen(function* () {
        const system = yield* SystemInfo;
        const environment = EffectRecord.fromEntries(
          EffectArray.filter(
            EffectRecord.toEntries(system.environment()),
            ([key]) => !Effect2.pipe(key, EffectString.startsWith('THREADNOTE_')),
          ),
        );
        if (profile === 'cursor-cloud-personal') environment.THREADNOTE_CURSOR_CLOUD_TEAM = 'default';
        const f = yield* nativeFixture(environment);
        const config = {...f.config, manifestSource: 'bundled-example' as const};
        const git = (cwd: string, args: readonly string[]) => runCommandEffect('git', ['-C', cwd, ...args]);

        executionDiagnosticPhase(diagnostics, 'authoring-git-setup');
        yield* git(f.repo, ['config', 'user.email', 'test@example.invalid']);
        yield* git(f.repo, ['config', 'user.name', 'Native Authoring Cloud Test']);
        yield* git(f.repo, ['add', 'source.ts']);
        yield* git(f.repo, ['commit', '-m', 'source']);
        const remote = f.path.join(f.root, 'remote.git');
        const worktree = f.path.join(f.root, 'shared');
        yield* git(f.root, ['init', '--bare', '--initial-branch=main', remote]);
        yield* git(f.root, ['clone', remote, worktree]);
        yield* git(worktree, ['config', 'user.email', 'test@example.invalid']);
        yield* git(worktree, ['config', 'user.name', 'Native Authoring Cloud Test']);
        yield* f.fs.writeFileString(f.path.join(worktree, 'README.md'), 'Seed only.\n');
        yield* git(worktree, ['add', 'README.md']);
        yield* git(worktree, ['commit', '-m', 'seed']);
        yield* git(worktree, ['push', 'origin', 'main']);
        yield* f.fs.makeDirectory(f.path.join(f.home, 'share'));
        yield* f.fs.writeFileString(
          f.path.join(f.home, 'share', 'teams.json'),
          JSON.stringify({
            version: 1,
            defaultTeam: 'default',
            teams: {
              default: {
                name: 'default',
                access: 'read-write',
                remote,
                worktree,
                gitdir: f.path.join(worktree, '.git'),
              },
            },
          }),
        );
        executionDiagnosticPhase(diagnostics, 'authoring-profile-setup');
        if (profile === 'codex-cloud-personal') yield* persistCodexCloudProfile(config, ['default']);
        else yield* persistCursorCloudIdentityProfile(config);

        executionDiagnosticPhase(diagnostics, 'authoring-init');
        const init = yield* f.call(
          {
            ...f.base('init'),
            project: 'fixture',
            featureId: 'feature',
            title: 'Private Cloud Authoring',
            profile,
            team: 'default',
          },
          config,
        );
        if (!('bindingId' in init)) return yield* Effect.die('Expected a private-cloud native binding.');
        const authoringCall = (command: string, changes: Record<string, unknown> = {}) =>
          f.call({...f.base('authoring'), command, ...changes}, config);
        const spec = document();
        executionDiagnosticPhase(diagnostics, 'authoring-draft-save');
        const first = payload(yield* authoringCall('save', {document: spec, ready: false, expectedRevision: null}));
        expect(first.readiness).toBe('draft');
        expect(first.readinessBlockers).toEqual(expect.any(Array));
        const root = reference(first.root);
        expect(root.uri).toContain('/memories/handoffs/active/fixture/');
        expect(root.uri).not.toContain('/shared/');

        const statePath = f.statePath();
        const journalPath = f.journalPath(init.bindingId);
        const stateBytes = yield* f.fs.readFileString(statePath);
        const journalBytes = yield* f.fs.readFileString(journalPath);
        const rootBytes = yield* f.store.read(f.location, root.uri);
        executionDiagnosticPhase(diagnostics, 'authoring-replay');
        const replay = payload(
          yield* authoringCall('save', {
            document: spec,
            ready: false,
            uri: root.uri,
            expectedRevision: root.revision,
          }),
        );
        expect(replay.changed).toBe(false);
        expect(reference(replay.root)).toEqual(root);
        expect(yield* f.fs.readFileString(statePath)).toBe(stateBytes);
        expect(yield* f.fs.readFileString(journalPath)).toBe(journalBytes);
        expect(yield* f.store.read(f.location, root.uri)).toBe(rootBytes);

        executionDiagnosticPhase(diagnostics, 'authoring-load');
        const complete = payload(yield* authoringCall('load', {uri: root.uri, detail: 'document'}));
        expect(complete.document).toEqual(spec);
        expect(complete.readiness).toBe('draft');
        expect(nativeAuthoringDigest(decodeNativeAuthoringDocument(complete.document))).toBe(
          nativeAuthoringDigest(spec),
        );

        const rootRecord = parseMemoryDocument(root.uri, rootBytes);
        if (!rootRecord) throw new Error('Expected canonical root memory metadata.');
        const storedRoot = decodeAuthoringArtifact(
          Effect2.pipe(rootRecord.body, EffectString.trimEnd) + '\n',
          AuthoringRootSchema,
        );
        executionDiagnosticPhase(diagnostics, 'authoring-child-reads');
        const reachable = new Map<string, ReturnType<typeof reference>>();
        const queue = [
          reference(root),
          reference(storedRoot.data),
          ...EffectArray.map(storedRoot.documents, item => reference(item.reference)),
        ];
        while (queue.length) {
          const current = queue.shift()!;
          if (reachable.has(current.uri)) continue;
          reachable.set(current.uri, current);
          const result = yield* f.call({...f.base('read'), uri: current.uri}, config);
          if (!('artifact' in result)) return yield* Effect.die('Expected native child readback.');
          const artifact = result.artifact;
          expect(artifact.uri).toBe(current.uri);
          expect(artifact.memoryId).toBe(current.memoryId);
          expect(artifact.revision).toBe(current.revision);
          expect(artifact.state).toBe('active');
          expect(artifact.storageKind).toBe('handoff');
          expect(artifact.uri).toContain('/memories/handoffs/active/fixture/');
          const record = parseMemoryDocument(artifact.uri, yield* f.store.read(f.location, artifact.uri));
          expect(record?.metadata.kind).toBe('handoff');
          const marker = Effect2.pipe(
            artifact.body,
            EffectString.match(/<!-- threadnote-authoring:v1 (.+) -->\n?$/u),
            Effect2.Option.getOrElse(() => null),
          );
          if (!marker) continue;
          const value = object(JSON.parse(marker[1]));
          if (value.format === 'threadnote-native-authoring-index' && EffectArray.isArray(value.children))
            queue.push(...EffectArray.map(value.children, item => reference(item)));
        }
        expect(reachable.size).toBeGreaterThanOrEqual(3);

        executionDiagnosticPhase(diagnostics, 'authoring-acceptance');
        const packet = payload(yield* authoringCall('acceptance-packet', {document: spec}));
        const documentHash = packet.documentHash;
        const intentHash = packet.intentHash;
        if (typeof documentHash !== 'string' || typeof intentHash !== 'string')
          return yield* Effect.die('Expected exact authoring approval hashes.');
        const confirmed = payload(
          yield* authoringCall('confirm', {
            document: spec,
            userDecision: 'approve',
            userResponse: 'I approve this exact private-cloud specification.',
          }),
        );
        expect(confirmed.confirmation).toMatchObject({intentHash, decision: 'approved'});
        executionDiagnosticPhase(diagnostics, 'authoring-review');
        const acceptedReview = {documentHash, outcome: 'accepted', blockingIssueCount: 0};
        executionDiagnosticPhase(diagnostics, 'authoring-ready-save');
        const ready = payload(
          yield* authoringCall('save', {
            document: spec,
            ready: true,
            uri: root.uri,
            expectedRevision: root.revision,
            confirmation: confirmed.confirmation,
            review: acceptedReview,
          }),
        );
        expect(ready.readiness).toBe('ready');
        expect(reference(ready.root).uri).toBe(root.uri);
        executionDiagnosticPhase(diagnostics, 'authoring-readback');
        const readyLoad = payload(yield* authoringCall('load', {uri: root.uri, detail: 'document'}));
        expect(readyLoad.document).toEqual(spec);
        expect(readyLoad.readiness).toBe('ready');

        executionDiagnosticPhase(diagnostics, 'authoring-private-remote');
        expect(Effect2.pipe((yield* git(remote, ['rev-list', '--count', 'main'])).stdout, EffectString.trim)).toBe('1');
        expect(
          EffectArray.filter(
            Effect2.pipe(
              (yield* git(remote, ['ls-tree', '-r', '--name-only', 'main'])).stdout,
              EffectString.split('\n'),
            ),
            Boolean,
          ),
        ).toEqual(['README.md']);
        executionDiagnosticPhase(diagnostics, 'teardown');
      }).pipe(TestClock.withLive, provideNative),
      diagnostics,
    );
  });
}
