import {describe, expect, it} from 'vitest';
import {it as effectIt} from '@effect/vitest';
import {Command} from 'effect/cli';
import {Effect, FileSystem, Path, Schema} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import {TestClock} from 'effect/testing';
import {runCommandEffect} from '@threadnote/platform/command';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {ResourceStore} from '@threadnote/store/resource-store';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {prepareMemoryMaintenanceBasis} from '@threadnote/context/memory_maintenance';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import {createNativeDocument} from '@threadnote/workflow-automations/templates';
import {applyDevSkills} from '../../src/dev_skills/index.js';
import {runShareInit} from '../../src/share/admin.js';
import {runShareSync} from '../../src/share/sync.js';
import {teamWorktreePath} from '../../src/share/core.js';
import {runNativeTaskAuthoring} from '../../src/workflow_automation/task_authoring.js';
import {runNativeTaskStart} from '../../src/workflow_automation/task_actions.js';
import {EffectMcpServerAdapter} from '../../src/effect/ai/mcp.js';
import {registerWorkflowTaskTool} from '../../src/mcp/server/workflow.js';
import {makeWorkflowAutomationCommand} from '../../src/effect/workflow_automation_cli.js';
import {makeNativeTaskAuthoringCommand} from '../../src/effect/task_authoring_cli.js';
import {readNativeWorkflowState} from '../../src/workflow_automation/store.js';
import {
  AuthoringRootSchema,
  decodeAuthoringArtifact,
  encodeAuthoringDocument,
} from '../../src/workflow_automation/authoring_artifacts.js';
import {encodeNativeAuthoringTaskRef} from '../../src/workflow_automation/task_authoring.js';
import {nativeFixture, provideNative} from './native-automation-fixture.js';
import {CurrentNativeProgress, type NativeProgressPhase} from './native-authoring-progress-diagnostics.js';
import {Array as EffectArray, Option as EffectOption, pipe} from 'effect';
import * as EffectString from 'effect/String';
import {
  canonicalAuthoringJson,
  decodeNativeAuthoringDocument,
  nativeAuthoringDigest,
  nativeSpecIntentDigest,
} from '@threadnote/workflow-automations/authoring';
import {sha256HexSync} from '../../src/workflow_memory/native_digest.js';
import {stableJson} from '../../src/workflow_memory/protocol.js';
import {
  decodePortablePlanPages,
  decodePortablePlanPayload,
  decodePortablePlanRef,
  encodePortablePlanPages,
  encodePortablePlanRef,
  publishPortablePlanPayload,
  readPortablePlanPayload,
  portableEvidenceBody,
} from '../../src/workflow_automation/portable_plan.js';

const h = (value: string) => sha256HexSync(value);
const ref = (name: string, content: string) => ({
  uri: `threadnote://user/alice/memories/shared/team/durable/projects/project/${name}.md`,
  memoryId: `tn_${pipe(h(name), EffectString.slice(0, 24))}`,
  revision: h(content),
});
const plan = decodeNativeAuthoringDocument({
  format: 'threadnote-native-authoring',
  schemaVersion: 1,
  id: 'feature',
  project: 'project',
  title: 'Fixture plan',
  objective: 'Preserve one fixture behavior.',
  requirements: [{id: 'r', behavior: 'The behavior is preserved.'}],
  context: {codeRefs: [], evidenceRefs: [], note: 'Synthetic fixture.'},
  source: null,
  sourceFreeReason: 'The fixture has no source files.',
  kind: 'plan',
  current: {summary: 'The behavior is absent.', components: [], contracts: [], diagram: ''},
  target: {summary: 'The behavior exists.', components: [], contracts: [], diagram: ''},
  phases: [
    {
      id: 'phase',
      title: 'Implement behavior',
      outcome: 'The behavior exists.',
      dependsOn: [],
      affectedPaths: [],
      newPaths: [],
      contracts: [],
      safeBoundary: 'The fixture remains isolated.',
      acceptance: [
        {id: 'a', criterion: 'The behavior works.', verification: 'Run the fixture.', requirementIds: ['r']},
      ],
    },
  ],
  decisions: [],
  openQuestions: [],
  review: {required: true, reason: 'Review fixture.'},
});
if (plan.kind !== 'plan') throw new Error('Invalid fixture');
const planText = canonicalAuthoringJson(plan);
const payload = {
  format: 'threadnote-portable-plan',
  version: 1,
  project: 'project',
  plan: {document: planText, documentHash: nativeAuthoringDigest(plan)},
  evidence: [],
  provenance: {
    root: ref('donor', 'donor'),
    documentHash: nativeAuthoringDigest(plan),
    intentHash: nativeSpecIntentDigest(plan, 2),
    review: {outcome: 'accepted', blockingIssueCount: 0},
    approval: 'approved',
  },
} as const;
const body = stableJson(payload);
const root = {
  format: 'threadnote-portable-plan-root',
  version: 1,
  project: 'project',
  team: 'team',
  payloadHash: h(body),
  pages: [{reference: ref('page', body), contentHash: h(body)}],
} as const;

describe('portable plan admission', () => {
  it('admits a complete hash-pinned page and rejects scope, missing, changed and malformed content', () => {
    const pages = [{reference: root.pages[0].reference, content: body}];
    expect(decodePortablePlanPages(root, pages, {team: 'team', project: 'project'}).plan).toEqual(plan);
    for (const change of [
      () => decodePortablePlanPages(root, pages, {team: 'other', project: 'project'}),
      () => decodePortablePlanPages(root, pages, {team: 'team', project: 'other'}),
      () => decodePortablePlanPages(root, [], {team: 'team', project: 'project'}),
      () => decodePortablePlanPages(root, [{...pages[0], content: body + ' '}], {team: 'team', project: 'project'}),
      () => decodePortablePlanPages(root, [{...pages[0], content: '{'}], {team: 'team', project: 'project'}),
      () => decodePortablePlanPayload({...payload, spec: {document: planText, documentHash: h(planText)}}),
      () => decodePortablePlanPayload({...payload, provenance: {...payload.provenance, documentHash: h('changed')}}),
    ])
      expect(change).toThrow();
  });

  it('rejects oversized pages without inspecting their content', () => {
    expect(() =>
      decodePortablePlanPages(
        root,
        [{reference: root.pages[0].reference, content: pipe('x', EffectString.repeat(24_001))}],
        {
          team: 'team',
          project: 'project',
        },
      ),
    ).toThrow();
  });

  it('rejects an evidence body whose URI matches but pinned identity or revision differs', () => {
    const pinned = ref('evidence', 'Original evidence');
    const withEvidence = decodeNativeAuthoringDocument({
      ...plan,
      context: {...plan.context, evidenceRefs: [pinned]},
    });
    if (withEvidence.kind !== 'plan') throw new Error('Expected a plan with pinned evidence.');
    const documentHash = nativeAuthoringDigest(withEvidence);
    const changedBody = 'Different evidence';
    const changedReference = {...pinned, memoryId: 'tn_substitute', revision: h(changedBody)};
    const substitution = {
      ...payload,
      plan: {document: canonicalAuthoringJson(withEvidence), documentHash},
      evidence: [
        {reference: changedReference, body: changedBody, bodyHash: h(changedBody), review: 'approved-durable'},
      ],
      provenance: {...payload.provenance, documentHash, intentHash: nativeSpecIntentDigest(withEvidence, 2)},
    };
    expect(() => decodePortablePlanPayload(substitution)).toThrowError(
      expect.objectContaining({code: 'portable-plan-conflict'}),
    );
    const matching = {
      ...substitution,
      evidence: [
        {...substitution.evidence[0], reference: pinned, body: 'Original evidence', bodyHash: h('Original evidence')},
      ],
    };
    expect(decodePortablePlanPayload(matching).plan).toEqual(withEvidence);
  });

  it('splits a canonical snapshot and round-trips a user-independent reference', () => {
    expect(EffectArray.join(encodePortablePlanPages(payload), '')).toBe(body);
    const reference = encodePortablePlanRef({version: 1, team: 'team', project: 'project', payloadHash: h(body)});
    expect(decodePortablePlanRef(reference).payloadHash).toBe(h(body));
    expect(() => decodePortablePlanRef(reference + 'A')).toThrow();
  });

  it('retains a complete multibyte document across bounded pages', () => {
    const expandedPlan = decodeNativeAuthoringDocument({
      ...plan,
      current: {
        ...plan.current,
        components: Array.from(
          {length: 30},
          (_, index) => `Component ${index} ${pipe('🌊', EffectString.repeat(200))}`,
        ),
      },
    });
    if (expandedPlan.kind !== 'plan') throw new Error('Invalid fixture');
    const expanded = {
      ...payload,
      plan: {document: canonicalAuthoringJson(expandedPlan), documentHash: nativeAuthoringDigest(expandedPlan)},
      provenance: {
        ...payload.provenance,
        documentHash: nativeAuthoringDigest(expandedPlan),
        intentHash: nativeSpecIntentDigest(expandedPlan, 2),
      },
    };
    const chunks = encodePortablePlanPages(expanded);
    expect(chunks.length).toBeGreaterThan(1);
    expect(EffectArray.join(chunks, '')).toBe(stableJson(expanded));
    expect(EffectArray.every(chunks, chunk => new TextEncoder().encode(chunk).byteLength <= 24_000)).toBe(true);
  });

  it('excludes an approved native handoff stored under a durable memory path', () => {
    const uri = 'threadnote://user/donor/memories/durable/projects/project/neutral-evidence.md';
    const body = formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        status: 'active',
        project: 'project',
        topic: 'neutral-evidence',
        memoryId: 'tn_native_handoff',
        sourceAgentClient: 'fixture',
        timestamp: '2026-11-11T00:00:00.000Z',
        visibility: 'personal',
        trust: 'approved',
        authority: 'user_approved',
      },
      encodeAuthoringDocument(
        createNativeDocument({
          kind: 'handoff',
          title: 'Synthetic private closeout',
          sections: {task: 'Synthetic task.', 'next-step': 'Keep this private.'},
        }),
      ),
    );
    expect(() =>
      portableEvidenceBody({uri, memoryId: 'tn_native_handoff', revision: h(body)}, body, 'project'),
    ).toThrowError(/handoff/u);
  });

  it('allows an approved durable decision whose topic mentions handoffs', () => {
    const uri = 'threadnote://user/donor/memories/durable/projects/project/handoff-policy.md';
    const body = formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        status: 'active',
        project: 'project',
        topic: 'handoff-policy',
        memoryId: 'tn_handoff_policy',
        sourceAgentClient: 'fixture',
        timestamp: '2026-11-11T00:00:00.000Z',
        visibility: 'personal',
        trust: 'approved',
        authority: 'user_approved',
      },
      'Share only reviewed decisions.',
    );
    expect(portableEvidenceBody({uri, memoryId: 'tn_handoff_policy', revision: h(body)}, body, 'project')).toBe(
      'Share only reviewed decisions.',
    );
  });
});

const authorResult = Schema.Struct({authoringRef: Schema.String, root: Schema.Unknown, status: Schema.String});
const shareResult = Schema.Struct({sharedPlanRef: Schema.String});
const startResult = Schema.Struct({status: Schema.String, taskRef: Schema.String, view: Schema.Unknown});

effectIt.effect.each([
  {name: 'LF donor to CRLF recipient', donorAutocrlf: false, recipientAutocrlf: true, fullEvidence: false},
  {name: 'CRLF donor to LF recipient', donorAutocrlf: true, recipientAutocrlf: false, fullEvidence: true},
] as const)(
  'publishes a linked reviewed plan and starts recipient-owned work from one shared reference ($name)',
  direction =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const progress = yield* CurrentNativeProgress;
      const markPhase = (phase: NativeProgressPhase) => progress?.enterPhase(phase);
      markPhase('fixture-git-setup');
      const donorFixture = yield* nativeFixture();
      const recipientFixture = yield* nativeFixture();
      const donor = {
        ...donorFixture,
        root: yield* fs.realPath(donorFixture.root),
        home: yield* fs.realPath(donorFixture.home),
        repo: yield* fs.realPath(donorFixture.repo),
      };
      const recipient = {
        ...recipientFixture,
        root: yield* fs.realPath(recipientFixture.root),
        home: yield* fs.realPath(recipientFixture.home),
        repo: yield* fs.realPath(recipientFixture.repo),
      };
      const system = yield* SystemInfo;
      const git = (cwd: string, args: readonly string[]) => runCommandEffect('git', ['-C', cwd, ...args]);
      const setGitIdentity = (cwd: string) =>
        Effect.gen(function* () {
          yield* git(cwd, ['config', '--local', 'user.name', 'Fixture']);
          yield* git(cwd, ['config', '--local', 'user.email', 'fixture@example.invalid']);
        });
      const remote = path.join(donor.root, 'portable.git');
      yield* git(donor.root, ['init', '--bare', '--initial-branch=main', remote]);
      const seed = path.join(donor.root, 'seed');
      yield* git(donor.root, ['clone', remote, seed]);
      yield* setGitIdentity(seed);
      yield* fs.writeFileString(path.join(seed, 'README.md'), 'Shared fixture\n');
      yield* fs.writeFileString(path.join(seed, '.gitignore'), '**/.abstract.md\n**/.overview.md\n');
      yield* git(seed, ['add', 'README.md', '.gitignore']);
      yield* git(seed, ['commit', '-m', 'seed']);
      yield* git(seed, ['push', 'origin', 'main']);
      yield* setGitIdentity(donor.repo);
      yield* git(donor.repo, ['config', '--local', 'core.autocrlf', String(direction.donorAutocrlf)]);
      if (direction.donorAutocrlf)
        yield* fs.writeFileString(path.join(donor.repo, 'source.ts'), 'export const fixture = true;\r\n');
      yield* git(donor.repo, ['add', 'source.ts']);
      yield* git(donor.repo, ['commit', '-m', 'source']);
      yield* git(recipient.repo, ['config', '--local', 'core.autocrlf', String(direction.recipientAutocrlf)]);
      yield* git(recipient.repo, ['fetch', donor.repo, 'main']);
      yield* git(recipient.repo, ['reset', '--hard', 'FETCH_HEAD']);
      expect(EffectString.includes('\r\n')(yield* fs.readFileString(path.join(recipient.repo, 'source.ts')))).toBe(
        direction.recipientAutocrlf,
      );
      yield* setGitIdentity(recipient.repo);
      const donorConfig = {
        ...donor.config,
        user: 'donor',
        account: 'donor-account',
        agentContextHome: donor.home,
        manifestPath: path.join(donor.home, 'manifest.json'),
      };
      const recipientConfig = {
        ...recipient.config,
        user: 'recipient',
        account: 'recipient-account',
        agentContextHome: recipient.home,
        manifestPath: path.join(recipient.home, 'manifest.json'),
      };
      const donorSystem = {...system, currentDirectory: () => donor.repo, homeDirectory: donor.home};
      const recipientSystem = {...system, currentDirectory: () => recipient.repo, homeDirectory: recipient.home};
      markPhase('install-index-share-setup');
      yield* applyDevSkills(donorConfig, 'install', {agent: 'codex'}).pipe(
        Effect.provideService(SystemInfo, donorSystem),
      );
      yield* applyDevSkills(recipientConfig, 'install', {agent: 'codex'}).pipe(
        Effect.provideService(SystemInfo, recipientSystem),
      );
      expect(
        (yield* (yield* CodeGraphIndexer).index({cwd: donor.repo, threadnoteHome: donor.home})).snapshot.state,
      ).toBe('ready');
      expect(
        (yield* (yield* CodeGraphIndexer).index({cwd: recipient.repo, threadnoteHome: recipient.home})).snapshot.state,
      ).toBe('ready');
      yield* runShareInit(donorConfig, remote, {team: 'default'});
      yield* runShareInit(recipientConfig, remote, {team: 'default'});
      yield* setGitIdentity(yield* teamWorktreePath(donorConfig, 'default'));
      const recipientWorktree = yield* teamWorktreePath(recipientConfig, 'default');
      yield* setGitIdentity(recipientWorktree);
      yield* git(recipientWorktree, ['config', '--local', 'core.autocrlf', 'true']);
      markPhase('full-evidence-donor-authoring');
      const location = {account: donorConfig.account, home: donor.home, user: donorConfig.user};
      const store = yield* ResourceStore;
      const evidenceDirectory = 'threadnote://user/donor/memories/durable/projects/repo';
      for (const directory of [
        'threadnote://user/donor/memories/durable',
        'threadnote://user/donor/memories/durable/projects',
        evidenceDirectory,
      ])
        yield* store.makeDirectory(location, directory);
      const evidenceUri = `${evidenceDirectory}/approved-fixture.md`;
      const evidenceBody = formatMemoryDocument(
        'MEMORY',
        {
          kind: 'durable',
          status: 'active',
          project: 'repo',
          topic: 'approved-fixture',
          memoryId: 'tn_approved_fixture',
          sourceAgentClient: 'fixture',
          timestamp: '2026-11-11T00:00:00.000Z',
          visibility: 'personal',
          trust: 'approved',
          authority: 'user_approved',
        },
        'Approved synthetic evidence.',
      );
      yield* store.write(location, evidenceUri, evidenceBody, {mode: 'create'});
      const evidence = {uri: evidenceUri, memoryId: 'tn_approved_fixture', revision: h(evidenceBody)};
      const specEvidenceUri = `${evidenceDirectory}/spec-only-fixture.md`;
      const specEvidenceBody = formatMemoryDocument(
        'MEMORY',
        {
          kind: 'durable',
          status: 'active',
          project: 'repo',
          topic: 'spec-only-fixture',
          memoryId: 'tn_spec_only_fixture',
          sourceAgentClient: 'fixture',
          timestamp: '2026-11-11T00:00:00.000Z',
          visibility: 'personal',
          trust: 'approved',
          authority: 'user_approved',
        },
        'Approved specification-only evidence.',
      );
      yield* store.write(location, specEvidenceUri, specEvidenceBody, {mode: 'create'});
      const specEvidence = {uri: specEvidenceUri, memoryId: 'tn_spec_only_fixture', revision: h(specEvidenceBody)};
      const evidenceRefs = direction.fullEvidence ? [evidence] : [];
      if (direction.fullEvidence) {
        for (let index = 0; index < 14; index++) {
          const topic = `capacity-fixture-${index}`;
          const uri = `${evidenceDirectory}/${topic}.md`;
          const memoryId = `tn_capacity_fixture_${index}`;
          const content = formatMemoryDocument(
            'MEMORY',
            {
              kind: 'durable',
              status: 'active',
              project: 'repo',
              topic,
              memoryId,
              sourceAgentClient: 'fixture',
              timestamp: '2026-11-11T00:00:00.000Z',
              visibility: 'personal',
              trust: 'approved',
              authority: 'user_approved',
            },
            'Approved capacity evidence.',
          );
          yield* store.write(location, uri, content, {mode: 'create'});
          evidenceRefs.push({uri, memoryId, revision: h(content)});
        }
      }
      const context = {
        codeRefs: ['source.ts'],
        evidenceRefs,
        note: pipe('P', EffectString.repeat(4096)),
        sharedPlanRef: encodePortablePlanRef({version: 1, team: 'older', project: 'repo', payloadHash: h('older')}),
      };
      const specContext = {
        ...context,
        evidenceRefs: direction.fullEvidence ? [...evidenceRefs, specEvidence] : [],
        note: pipe('S', EffectString.repeat(4096)),
      };
      const specBusiness = {
        title: 'Fixture specification',
        objective: 'Preserve the fixture.',
        requirements: [{id: 'r', behavior: 'Fixture works.'}],
        context: specContext,
        actors: ['Recipient'],
        inScope: ['Fixture behavior'],
        outOfScope: [],
        constraints: [],
        observations: [],
        scenarios: [
          {id: 's', requirementIds: ['r'], given: 'Source exists.', when: 'Work begins.', then: 'Fixture works.'},
        ],
        assumptions: [],
        questions: [],
        artifacts: [],
        review: {required: true, reason: 'Review required.'},
      };
      const planBusiness = {
        title: 'Fixture plan',
        objective: 'Preserve the fixture.',
        context,
        current: {summary: 'Fixture not transferred.', components: ['Fixture reader'], contracts: ['Read source']},
        target: {summary: 'Fixture transferred.', components: ['Fixture reader'], contracts: ['Read source']},
        phases: [
          {
            id: 'phase',
            title: 'Transfer fixture',
            outcome: 'Recipient owns work.',
            dependsOn: [],
            affectedPaths: ['source.ts'],
            newPaths: [],
            contracts: [],
            acceptance: [
              {
                id: 'a',
                criterion: 'Fixture works.',
                verification: 'Read source.',
                requirementIds: ['r'],
                scenarioIds: ['s'],
              },
            ],
            safeBoundary: 'Synthetic source remains intact.',
          },
        ],
        decisions: [
          {
            id: 'reuse',
            question: 'Which fixture reader owns the behavior?',
            selection: 'no-better-alternative',
            selected: 'Use the existing fixture reader.',
            alternatives: [],
            rationale: 'The reader already owns the source.',
            affectedPhases: ['phase'],
            authority: 'orchestrator',
          },
        ],
        openQuestions: [],
        review: {required: true, reason: 'Review required.'},
      };
      const specFile = path.join(donor.root, 'spec.json');
      const planFile = path.join(donor.root, 'plan.json');
      yield* fs.writeFileString(specFile, stableJson(specBusiness));
      yield* fs.writeFileString(planFile, stableJson(planBusiness));
      const donorAuthor = (input: object) =>
        runNativeTaskAuthoring(donorConfig, {callerCwd: donor.repo, ...input}).pipe(
          Effect.provideService(SystemInfo, donorSystem),
        );
      const decodeAuthor = (label: string, value: unknown) =>
        Schema.decodeUnknownEffect(authorResult)(value).pipe(
          Effect.mapError(() =>
            WorkflowAutomationError.make({
              code: 'invalid-readback',
              message: `Fixture author result is missing at ${label}.`,
            }),
          ),
        );
      const draftSpec = yield* decodeAuthor(
        'draft spec',
        yield* donorAuthor({
          command: 'start',
          featureName: 'Fixture',
          kind: 'spec',
          contentFile: specFile,
          installationTarget: 'codex',
        }),
      );
      const readySpec = yield* decodeAuthor(
        'ready spec',
        yield* donorAuthor({
          command: 'decide',
          authoringRef: draftSpec.authoringRef,
          userDecision: 'approve',
          userResponse: 'I approve the fixture specification.',
          review: {outcome: 'accepted', blockingIssueCount: 0},
        }),
      );
      expect(readySpec.status).toBe('ready');
      const draftPlan = yield* decodeAuthor(
        'draft plan',
        yield* donorAuthor({
          command: 'start',
          featureName: 'Fixture',
          kind: 'plan',
          contentFile: planFile,
          specRef: readySpec.authoringRef,
        }),
      );
      const readyPlan = yield* decodeAuthor(
        'ready plan',
        yield* donorAuthor({
          command: 'decide',
          authoringRef: draftPlan.authoringRef,
          userDecision: 'approve',
          userResponse: 'I approve the fixture plan.',
          review: {outcome: 'accepted', blockingIssueCount: 0},
        }),
      );
      expect(readyPlan.status).toBe('ready');
      markPhase('donor-publication-and-admission');
      const published = yield* Schema.decodeUnknownEffect(shareResult)(
        yield* donorAuthor({
          command: 'share',
          authoringRef: readyPlan.authoringRef,
          team: 'default',
        }),
      );
      const standalone = system.environment().THREADNOTE_STANDALONE_SMOKE;
      // Replay, opaque-reference transports and source-independent conflicts run once; both directions keep full import.
      if (!direction.fullEvidence) {
        expect(yield* donorAuthor({command: 'share', authoringRef: readyPlan.authoringRef, team: 'default'})).toEqual(
          published,
        );
        const donorMcp = new EffectMcpServerAdapter('portable-test', '1', 'fixture');
        registerWorkflowTaskTool(donorMcp, donorConfig);
        const mcpShared = yield* donorMcp
          .invokeTool('workflow_task_author', {
            command: 'share',
            callerCwd: donor.repo,
            authoringRef: readyPlan.authoringRef,
            team: 'default',
          })
          .pipe(Effect.provideService(SystemInfo, donorSystem));
        expect(
          (yield* Schema.decodeUnknownEffect(shareResult)(
            (yield* Schema.decodeUnknownEffect(Schema.Struct({structuredContent: Schema.Unknown}))(mcpShared))
              .structuredContent,
          )).sharedPlanRef,
        ).toBe(published.sharedPlanRef);
        const authorCli = Command.make('threadnote').pipe(
          Command.withSubcommands([makeNativeTaskAuthoringCommand(program => program(donorConfig))]),
        );
        yield* Command.runWith(authorCli, {version: 'fixture'})([
          'task-author',
          '--operation',
          'share',
          '--caller-cwd',
          donor.repo,
          '--authoring-ref',
          readyPlan.authoringRef,
          '--team',
          'default',
        ]).pipe(Effect.provideService(SystemInfo, donorSystem));
        if (standalone) {
          const result = yield* runCommandEffect(
            standalone,
            [
              'workflow-automation',
              'task-author',
              '--operation',
              'share',
              '--caller-cwd',
              donor.repo,
              '--authoring-ref',
              readyPlan.authoringRef,
              '--team',
              'default',
            ],
            {
              cwd: donor.repo,
              env: {
                ...system.environment(),
                THREADNOTE_HOME: donor.home,
                THREADNOTE_ACCOUNT: donorConfig.account,
                THREADNOTE_USER: donorConfig.user,
                THREADNOTE_AGENT_ID: donorConfig.agentId,
              },
              timeoutMs: 30_000,
              maxOutputBytes: 16_000,
            },
          );
          expect(result.exitCode).toBe(0);
          expect(JSON.parse(result.stdout)).toMatchObject({sharedPlanRef: published.sharedPlanRef});
        }
      }
      const donorPlanRead = yield* donorAuthor({
        command: 'read',
        authoringRef: readyPlan.authoringRef,
        detail: 'document',
      });
      const donorSpecRead = yield* donorAuthor({
        command: 'read',
        authoringRef: readySpec.authoringRef,
        detail: 'document',
      });
      expect(donorPlanRead).toMatchObject({root: readyPlan.root, status: 'ready', document: {context}});
      expect(donorSpecRead).toMatchObject({root: readySpec.root, status: 'ready', document: {context: specContext}});
      expect(
        yield* donorAuthor({
          command: 'admit',
          authoringRef: readyPlan.authoringRef,
          delivery: 'local',
          bindings: {phase: {branch: 'main', baseBranch: 'main'}},
        }),
      ).toMatchObject({status: 'admitted'});
      const donorRunBefore = yield* readNativeWorkflowState(
        donorConfig,
        'task-' + pipe(h('repo\nfixture'), EffectString.slice(0, 48)),
      );
      yield* runShareSync(recipientConfig, {team: 'default', push: false});
      const recipientPage = path.join(
        recipientWorktree,
        'durable',
        'projects',
        'repo',
        'portable-plans',
        decodePortablePlanRef(published.sharedPlanRef).payloadHash,
        'page-0.md',
      );
      expect(yield* fs.readFileString(recipientPage)).toContain('\r\n');
      markPhase('recipient-start-and-ownership');
      const recipientStart = {
        callerCwd: recipient.repo,
        sharedPlanRef: published.sharedPlanRef,
        installationTarget: 'codex',
        delivery: 'local',
        bindings: {phase: {branch: 'main', baseBranch: 'main'}},
        userResponse: 'I authorize execution of this exact shared fixture plan.',
        review: {outcome: 'accepted', blockingIssueCount: 0},
      } as const;
      const started = yield* Schema.decodeUnknownEffect(startResult)(
        yield* runNativeTaskStart(recipientConfig, recipientStart).pipe(
          Effect.provideService(SystemInfo, recipientSystem),
        ),
      );
      expect(started.status).toBe('admitted');
      expect(started.view).toMatchObject({next: {action: 'implement', phaseId: 'phase'}});
      const recipientState = yield* readNativeWorkflowState(recipientConfig, started.taskRef);
      const donorState = yield* readNativeWorkflowState(donorConfig, started.taskRef);
      expect(recipientState?.state.bindingId).not.toBe(donorState?.state.bindingId);
      expect(donorState?.revision).toBe(donorRunBefore?.revision);
      expect(recipientState?.state.cycle?.state.plan.source.root.uri).toContain('threadnote://user/recipient/');
      const localOperations = recipientState?.state.operations ?? [];
      const localRoot = (kind: 'spec' | 'plan') =>
        EffectOption.getOrUndefined(
          EffectArray.findFirst(
            [...localOperations].reverse(),
            operation => operation.status === 'verified' && operation.intent.artifactKey === `author-root-${kind}`,
          ),
        );
      const localSpec = localRoot('spec');
      const localPlan = localRoot('plan');
      expect(localSpec?.artifact?.uri).toContain('threadnote://user/recipient/');
      expect(localPlan?.artifact?.uri).toContain('threadnote://user/recipient/');
      if (!recipientState || !localSpec?.artifact || !localPlan?.artifact) throw new Error('Missing recipient roots');
      const planRoot = decodeAuthoringArtifact(localPlan.artifact.body, AuthoringRootSchema);
      const readPlan = yield* runNativeTaskAuthoring(recipientConfig, {
        callerCwd: recipient.repo,
        command: 'read',
        detail: 'document',
        authoringRef: encodeNativeAuthoringTaskRef({
          version: 1,
          kind: 'plan',
          runId: started.taskRef,
          generationHash: h(recipientState.state.generation),
          operationId: localPlan.intent.operationId,
          documentHash: planRoot.documentHash,
          stateRevision: recipientState.revision,
        }),
      }).pipe(Effect.provideService(SystemInfo, recipientSystem));
      const localDocument = yield* Schema.decodeUnknownEffect(Schema.Struct({document: Schema.Unknown}))(readPlan);
      const localPlanDocument = decodeNativeAuthoringDocument(localDocument.document);
      if (localPlanDocument.kind !== 'plan') throw new Error('Recipient did not author a plan');
      expect(localPlanDocument.spec?.root.uri).toBe(localSpec.artifact.uri);
      expect(localPlanDocument.context.note).toBe(context.note);
      expect(localPlanDocument.context.sharedPlanRef).toBe(published.sharedPlanRef);
      expect(localPlanDocument.context.evidenceRefs).toHaveLength(direction.fullEvidence ? 15 : 0);
      const specRoot = decodeAuthoringArtifact(localSpec.artifact.body, AuthoringRootSchema);
      const readSpec = yield* runNativeTaskAuthoring(recipientConfig, {
        callerCwd: recipient.repo,
        command: 'read',
        detail: 'document',
        authoringRef: encodeNativeAuthoringTaskRef({
          version: 1,
          kind: 'spec',
          runId: started.taskRef,
          generationHash: h(recipientState.state.generation),
          operationId: localSpec.intent.operationId,
          documentHash: specRoot.documentHash,
          stateRevision: recipientState.revision,
        }),
      }).pipe(Effect.provideService(SystemInfo, recipientSystem));
      const localSpecDocument = decodeNativeAuthoringDocument(
        (yield* Schema.decodeUnknownEffect(Schema.Struct({document: Schema.Unknown}))(readSpec)).document,
      );
      expect(localSpecDocument.context.note).toBe(specContext.note);
      expect(localSpecDocument.context.sharedPlanRef).toBe(published.sharedPlanRef);
      expect(localSpecDocument.context.evidenceRefs).toHaveLength(direction.fullEvidence ? 16 : 0);
      expect(
        EffectArray.every(localSpecDocument.context.evidenceRefs, ref =>
          pipe(ref.uri, EffectString.includes('/user/recipient/')),
        ),
      ).toBe(true);
      for (const reference of localSpecDocument.context.evidenceRefs) {
        const content = yield* store.read(
          {account: recipientConfig.account, home: recipient.home, user: recipientConfig.user},
          reference.uri,
        );
        const imported = parseMemoryDocument(reference.uri, content);
        expect(imported?.metadata).toMatchObject({
          kind: 'durable',
          visibility: 'external',
          authority: 'external',
          trust: 'untrusted',
        });
        if (!imported) throw new Error('Recipient evidence is missing');
        expect(prepareMemoryMaintenanceBasis(imported).assessment.capabilities).toMatchObject({
          apply: false,
          publish: false,
          reviewRoute: 'read-only',
        });
      }
      const donorSpecReference = yield* Schema.decodeUnknownEffect(Schema.Struct({uri: Schema.String}))(readySpec.root);
      expect(localPlanDocument.spec?.root.uri).not.toBe(donorSpecReference.uri);
      if (direction.fullEvidence) return;
      expect(
        yield* runNativeTaskStart(recipientConfig, recipientStart).pipe(
          Effect.provideService(SystemInfo, recipientSystem),
        ),
      ).toMatchObject({taskRef: started.taskRef});
      expect((yield* readNativeWorkflowState(recipientConfig, started.taskRef))?.revision).toBe(
        recipientState.revision,
      );
      const recipientSourcePath = path.join(recipient.repo, 'source.ts');
      const recipientSource = yield* fs.readFileString(recipientSourcePath);
      yield* fs.writeFileString(recipientSourcePath, recipientSource + 'export const changed = true;\r\n');
      expect(
        yield* runNativeTaskStart(recipientConfig, recipientStart).pipe(
          Effect.provideService(SystemInfo, recipientSystem),
          Effect.result,
        ),
      ).toMatchObject({failure: {code: 'source-drift'}});
      yield* fs.writeFileString(recipientSourcePath, recipientSource);
      expect((yield* readNativeWorkflowState(recipientConfig, started.taskRef))?.revision).toBe(
        recipientState.revision,
      );
      if (!direction.fullEvidence) {
        const recipientMcp = new EffectMcpServerAdapter('portable-test', '1', 'fixture');
        registerWorkflowTaskTool(recipientMcp, recipientConfig);
        const mcpStarted = yield* recipientMcp
          .invokeTool('workflow_task_start', recipientStart)
          .pipe(Effect.provideService(SystemInfo, recipientSystem));
        expect(
          (yield* Schema.decodeUnknownEffect(startResult)(
            (yield* Schema.decodeUnknownEffect(Schema.Struct({structuredContent: Schema.Unknown}))(mcpStarted))
              .structuredContent,
          )).taskRef,
        ).toBe(started.taskRef);
        const bindingsFile = path.join(recipient.root, 'bindings.json');
        yield* fs.writeFileString(bindingsFile, stableJson(recipientStart.bindings));
        const startCli = Command.make('threadnote').pipe(
          Command.withSubcommands([makeWorkflowAutomationCommand(program => program(recipientConfig))]),
        );
        yield* Command.runWith(startCli, {version: 'fixture'})([
          'workflow-automation',
          'task-start',
          '--caller-cwd',
          recipient.repo,
          '--shared-plan-ref',
          published.sharedPlanRef,
          '--installation-target',
          'codex',
          '--bindings-file',
          bindingsFile,
          '--delivery',
          'local',
          '--response',
          recipientStart.userResponse,
          '--review-outcome',
          'accepted',
        ]).pipe(Effect.provideService(SystemInfo, recipientSystem));
        expect((yield* readNativeWorkflowState(recipientConfig, started.taskRef))?.revision).toBe(
          recipientState.revision,
        );
        markPhase('negative-integrity-cases');
        const originalPayload = yield* readPortablePlanPayload(donorConfig, published.sharedPlanRef, 'repo');
        const changedPlanRef = yield* publishPortablePlanPayload(
          donorConfig,
          {
            ...originalPayload.payload,
            provenance: {
              ...originalPayload.payload.provenance,
              root: {...originalPayload.payload.provenance.root, revision: h('different-plan-root')},
            },
          },
          'default',
        );
        yield* runShareSync(recipientConfig, {team: 'default', push: false});
        expect(
          yield* runNativeTaskStart(recipientConfig, {
            ...recipientStart,
            sharedPlanRef: changedPlanRef.sharedPlanRef,
          }).pipe(Effect.provideService(SystemInfo, recipientSystem), Effect.result),
        ).toMatchObject({failure: {code: 'portable-plan-conflict'}});
        expect((yield* readNativeWorkflowState(recipientConfig, started.taskRef))?.revision).toBe(
          recipientState.revision,
        );
        expect(
          yield* runNativeTaskStart(recipientConfig, {
            ...recipientStart,
            bindings: {phase: {branch: 'different', baseBranch: 'main'}},
          }).pipe(Effect.provideService(SystemInfo, recipientSystem), Effect.result),
        ).toMatchObject({failure: {code: 'cycle-conflict'}});
        expect((yield* readNativeWorkflowState(recipientConfig, started.taskRef))?.revision).toBe(
          recipientState.revision,
        );
        const mismatchFixture = yield* nativeFixture();
        const mismatchHome = yield* fs.realPath(mismatchFixture.home);
        const mismatchRepo = yield* fs.realPath(mismatchFixture.repo);
        yield* setGitIdentity(mismatchRepo);
        const mismatchConfig = {
          ...mismatchFixture.config,
          user: 'mismatch',
          account: 'mismatch-account',
          agentContextHome: mismatchHome,
          manifestPath: path.join(mismatchHome, 'manifest.json'),
        };
        yield* runShareInit(mismatchConfig, remote, {team: 'default'});
        yield* setGitIdentity(yield* teamWorktreePath(mismatchConfig, 'default'));
        yield* runShareSync(mismatchConfig, {team: 'default', push: false});
        const mismatchResult = yield* runNativeTaskStart(mismatchConfig, {
          ...recipientStart,
          callerCwd: mismatchRepo,
        }).pipe(Effect.result);
        expect(mismatchResult, JSON.stringify(mismatchResult)).toMatchObject({failure: {code: 'source-drift'}});
        expect(yield* readNativeWorkflowState(mismatchConfig, started.taskRef)).toBeUndefined();
        if (standalone) {
          yield* git(mismatchRepo, ['fetch', donor.repo, 'main']);
          yield* git(mismatchRepo, ['reset', '--hard', 'FETCH_HEAD']);
          const env = {
            ...system.environment(),
            HOME: mismatchHome,
            THREADNOTE_HOME: mismatchHome,
            THREADNOTE_ACCOUNT: mismatchConfig.account,
            THREADNOTE_USER: mismatchConfig.user,
            THREADNOTE_AGENT_ID: mismatchConfig.agentId,
          };
          yield* runCommandEffect(
            standalone,
            ['dev-skills', 'install', '--agent', 'codex', '--scope', 'user', '--profile', 'desktop'],
            {cwd: mismatchRepo, env, timeoutMs: 30_000, maxOutputBytes: 16_000},
          );
          yield* runCommandEffect(standalone, ['graph', 'index', '--cwd', mismatchRepo, '--no-vectors'], {
            cwd: mismatchRepo,
            env,
            timeoutMs: 30_000,
            maxOutputBytes: 16_000,
          });
          const result = yield* runCommandEffect(
            standalone,
            [
              'workflow-automation',
              'task-start',
              '--caller-cwd',
              mismatchRepo,
              '--shared-plan-ref',
              published.sharedPlanRef,
              '--installation-target',
              'codex',
              '--bindings-file',
              bindingsFile,
              '--delivery',
              'local',
              '--response',
              recipientStart.userResponse,
              '--review-outcome',
              'accepted',
            ],
            {cwd: mismatchRepo, env, timeoutMs: 30_000, maxOutputBytes: 32_000},
          );
          expect(result.exitCode).toBe(0);
          expect(JSON.parse(result.stdout)).toMatchObject({taskRef: started.taskRef});
          const binaryState = yield* readNativeWorkflowState(mismatchConfig, started.taskRef);
          expect(binaryState?.state.cycle?.state.plan.source.root.uri).toContain('threadnote://user/mismatch/');
        }
      }
    }).pipe(TestClock.withLive, provideNative),
  {timeout: process.platform === 'win32' ? 180_000 : 120_000},
);
