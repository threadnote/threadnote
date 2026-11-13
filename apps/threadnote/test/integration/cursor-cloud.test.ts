import {loadRecallIndexData} from '@threadnote/recall/index';
import {
  readRecallLexicalDemand,
  recallLexicalDemandKey,
  RECALL_LEXICAL_DEMAND_DIRECTORY,
  type RecallLexicalDemand,
  type RecallLexicalScope,
} from '@threadnote/recall/background/lexical-demand';
import {runEffect} from '../helpers/effect-runtime.js';
import {runShareSync} from '@threadnote/threadnote/effect/share';
import {Array as EffectArray, Schema} from 'effect';
import * as EffectString from 'effect/String';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createHash} from '@threadnote/testing/node-crypto';
import {execFile} from '@threadnote/testing/node-child-process';
import {watch} from '@threadnote/testing/node-fs';
import {access, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {promisify} from '@threadnote/testing/node-util';
import {describe, expect, it} from 'vitest';
import * as EffectRecord from 'effect/Record';

const execFilePromise = promisify(execFile);
const CLOUD_TOOL_NAMES = [
  'complete_activation_retrieval_proof',
  'recall_context',
  'read_context',
  'list_context',
  'remember_context',
  'finalize_code_refs',
  'threadnote_guide',
] as const;
const CLOUD_LOCAL_TOOL_NAMES = [
  'inspect_code_graph',
  'analyze_code_graph',
  'cursor_cloud_status',
  'complete_cursor_attestation',
  'threadnote_guide',
] as const;
const gitIdentityEnvironment = {
  GIT_AUTHOR_EMAIL: 'cursor-cloud@threadnote.local',
  GIT_AUTHOR_NAME: 'Cursor Cloud Test',
  GIT_COMMITTER_EMAIL: 'cursor-cloud@threadnote.local',
  GIT_COMMITTER_NAME: 'Cursor Cloud Test',
};

const expectColdUnavailableWarnings = (value: unknown): void => {
  expect(value).toMatchObject({results: []});
  if (value === null || typeof value !== 'object' || !('warnings' in value) || !EffectArray.isArray(value.warnings))
    throw new Error('Expected bounded recall warnings.');
  const codes = EffectArray.map(value.warnings, (warning: unknown) => {
    if (warning === null || typeof warning !== 'object' || !('code' in warning) || typeof warning.code !== 'string')
      throw new Error('Expected a typed recall warning.');
    return warning.code;
  });
  expect(codes).toContain('lexical_index_unavailable');
  expect(
    EffectArray.every(codes, code => code === 'lexical_index_unavailable' || code === 'lexical_read_budget_exhausted'),
  ).toBe(true);
  expect(new Set(codes).size).toBe(codes.length);
};

describe('Cursor Cloud integration', () => {
  it('rejects a failed terminal lexical demand before fixture publication', () => {
    const before: RecallLexicalDemand = {
      version: 2,
      account: 'local',
      user: 'cloud-user',
      includeInactive: false,
      manifestPath: '/tmp/seed-manifest.yaml',
      work: {kind: 'synchronize', sources: false, teams: ['docs', 'engineering']},
      completedAt: 1,
      failures: 0,
    };
    const failedTerminal = {...before, failures: 1};

    expect(() => classifyLexicalSyncSettlement(before, failedTerminal)).toThrow(
      'Lexical synchronization has a failed terminal outcome.',
    );
  });

  it('accepts durable completion when its timestamp predates fixture observation', () => {
    const active: RecallLexicalDemand = {
      version: 2,
      account: 'local',
      user: 'cloud-user',
      includeInactive: false,
      manifestPath: '/tmp/seed-manifest.yaml',
      work: {kind: 'synchronize', sources: false, teams: ['docs', 'engineering']},
      revision: '00000000-0000-4000-8000-000000000001',
      completedAt: 1,
      failures: 0,
    };
    const completed: RecallLexicalDemand = {
      version: 2,
      account: 'local',
      user: 'cloud-user',
      includeInactive: false,
      manifestPath: '/tmp/seed-manifest.yaml',
      work: {kind: 'synchronize', sources: false, teams: ['docs', 'engineering']},
      completedAt: 1,
      failures: 0,
    };

    expect(classifyLexicalSyncSettlement(active, completed)).toBe('complete');
  });

  it.each(['synchronization', 'lexical-publication'] as const)(
    'identifies a failed %s demand without exposing fixture configuration',
    phase => {
      const scope: RecallLexicalScope = {
        account: 'private-account',
        user: 'private-user',
        agentContextHome: '/private/fixture-home',
        manifestPath: '/private/fixture-manifest.yaml',
        includeInactive: false,
        ...(phase === 'synchronization'
          ? {work: {kind: 'synchronize' as const, sources: false, teams: ['private-team']}}
          : {}),
      };
      const failed: RecallLexicalDemand = {
        version: 2,
        account: scope.account,
        user: scope.user,
        includeInactive: false,
        revision: '00000000-0000-4000-8000-000000000001',
        failures: 1,
      };
      const error = lexicalSyncFenceFailure('Deferred lexical synchronization recorded a failure.', scope, failed);

      expect(error.message).toContain('Deferred lexical synchronization recorded a failure.');
      expect(error.message).toContain(JSON.stringify({phase, revisionPresent: true, failures: 1, completed: false}));
      expect(error.message).not.toContain('private-');
      expect(error.message).not.toContain(failed.revision);
    },
  );

  it('propagates a latched fence error after a complete terminal observation', () => {
    const completed: RecallLexicalDemand = {
      version: 2,
      account: 'local',
      user: 'cloud-user',
      includeInactive: false,
      manifestPath: '/tmp/seed-manifest.yaml',
      work: {kind: 'synchronize', sources: false, teams: ['docs', 'engineering']},
      completedAt: 1,
      failures: 0,
    };
    const observerFailure = new Error('Synthetic fence inspection failure.');

    expect(classifyLexicalSyncSettlement(undefined, completed)).toBe('complete');
    expect(() => assertLexicalFenceHealthy(observerFailure)).toThrow('Lexical synchronization observer failed.');
  });

  it('drains an in-flight inspection before accepting active settlement', async () => {
    let inspecting = true;
    const inspectionState: {failure?: Error} = {};
    let resolveInspection!: () => void;
    const inspectionTask = new Promise<void>(resolve => {
      resolveInspection = resolve;
    });
    let settlementReached = false;
    const checkSettlement = (async () => {
      await Promise.resolve();
      settlementReached = true;
      await drainLexicalFenceInspection(
        () => inspecting,
        () => inspectionTask,
        () => inspectionState.failure,
        <A>(operation: Promise<A>) => operation,
      );
    })();

    await Promise.resolve();
    expect(settlementReached).toBe(true);
    inspectionState.failure = new Error('Late lexical fence inspection failure.');
    inspecting = false;
    resolveInspection();

    await expect(checkSettlement).rejects.toThrow('Lexical synchronization observer failed.');
  });

  it('bounds a never-settling inspection by the shared fence failure', async () => {
    let rejectDeadline!: (error: Error) => void;
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const neverSettlingInspection = new Promise<void>(() => {});
    const draining = drainLexicalFenceInspection(
      () => true,
      () => neverSettlingInspection,
      () => undefined,
      <A>(operation: Promise<A>) => raceLexicalFenceFailure(operation, deadline),
    );

    rejectDeadline(new Error('Deferred lexical synchronization timed out.'));

    await expect(draining).rejects.toThrow('Deferred lexical synchronization timed out.');
  });

  it('waits for downstream publication after synchronization completes', async () => {
    let finishSync!: () => void;
    let finishPublication!: () => void;
    let publicationObserved!: () => void;
    const sync = new Promise<void>(resolve => {
      finishSync = resolve;
    });
    const publication = new Promise<void>(resolve => {
      finishPublication = resolve;
    });
    const observingPublication = new Promise<void>(resolve => {
      publicationObserved = resolve;
    });
    const failure = new Promise<never>(() => {});
    let settled = false;
    const settlement = settleLexicalSyncAndPublication(
      {failure, settleCurrent: () => sync},
      {
        failure,
        settleCurrent: () => {
          publicationObserved();
          return publication;
        },
      },
    ).then(() => {
      settled = true;
    });

    finishSync();
    await observingPublication;
    expect(settled).toBe(false);
    finishPublication();
    await settlement;
    expect(settled).toBe(true);
  });

  it.each(['synchronization', 'publication'] as const)(
    'propagates %s failure while the other scope is pending',
    async failedScope => {
      let rejectFailure!: (error: Error) => void;
      const failure = new Promise<never>((_resolve, reject) => {
        rejectFailure = reject;
      });
      const never = new Promise<never>(() => {});
      const original = new Error('Controlled lexical scope failure.');
      const settlement = settleLexicalSyncAndPublication(
        {failure: failedScope === 'synchronization' ? failure : never, settleCurrent: () => never},
        {failure: failedScope === 'publication' ? failure : never, settleCurrent: () => never},
      );
      rejectFailure(original);
      await expect(settlement).rejects.toBe(original);
    },
  );

  it('prints Dashboard share configuration and discovery selectors', async () => {
    const signal = AbortSignal.timeout(25_000);
    const root = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-cursor-config-')));
    const home = join(root, 'home');
    try {
      const firstConfig = await runCli(
        [
          'cloud',
          'cursor',
          'config',
          '--home',
          home,
          '--team',
          'engineering',
          '--user',
          'cloud-user',
          '--agent-id',
          'cloud-agent',
        ],
        {HOME: root},
        signal,
      );
      expect(JSON.parse(firstConfig.stdout)).toMatchObject({
        args: ['-lc', 'exec "$HOME/.local/bin/threadnote-mcp-server"'],
        command: '/bin/sh',
        env: {
          THREADNOTE_CURSOR_CLOUD_TEAM: 'engineering',
          THREADNOTE_MCP_TOOLSET: 'cursor-cloud-personal',
          THREADNOTE_USER: 'cloud-user',
        },
        type: 'stdio',
      });

      const discoveryConfig = JSON.parse(
        (
          await runCli(
            ['cloud', 'cursor', 'config', '--home', home, '--user', 'cloud-user', '--agent-id', 'cloud-agent'],
            {HOME: root},
            signal,
          )
        ).stdout,
      );
      expect(discoveryConfig.env.THREADNOTE_CURSOR_CLOUD_TEAM).toBeUndefined();
      expect(discoveryConfig.env.THREADNOTE_CURSOR_CLOUD_TEAMS).toBeUndefined();
      expect(discoveryConfig.env.THREADNOTE_MCP_TOOLSET).toBe('cursor-cloud-personal');
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  });

  it('idempotently bootstraps, verifies and starts a writable share', async () => {
    const signal = AbortSignal.timeout(25_000);
    const fixture = await cloudFixture(signal);
    try {
      const existingSkillPath = join(fixture.userHome, '.cursor', 'skills', 'threadnote-context', 'SKILL.md');
      const obsoleteGraphSkillPath = join(fixture.userHome, '.cursor', 'skills', 'threadnote-code-graph', 'SKILL.md');
      await mkdir(join(fixture.userHome, '.cursor', 'skills', 'threadnote-context'), {recursive: true});
      await writeFile(
        existingSkillPath,
        await readFile(join(process.cwd(), 'config', 'agent-skills', 'threadnote-context', 'SKILL.md'), 'utf8'),
      );
      await mkdir(join(fixture.userHome, '.cursor', 'skills', 'threadnote-code-graph'), {recursive: true});
      await writeFile(
        obsoleteGraphSkillPath,
        await readFile(join(process.cwd(), 'config', 'agent-skills', 'threadnote-code-graph', 'SKILL.md'), 'utf8'),
      );
      const first = await bootstrap(fixture, undefined, undefined, true, signal);
      const before = await readFile(join(fixture.home, 'share', 'teams.json'), 'utf8');
      const second = await bootstrap(fixture, undefined, undefined, false, signal);
      const after = await readFile(join(fixture.home, 'share', 'teams.json'), 'utf8');
      expect(first.stdout).toContain(
        'Cursor Cloud memory root: threadnote://user/cloud-user/memories/shared/engineering/',
      );
      expect(second.stdout).toContain('already configured read-write; reusing it');
      expect(after).toBe(before);
      expect(JSON.parse(after)).toMatchObject({
        defaultTeam: 'engineering',
        teams: {engineering: {name: 'engineering', remote: fixture.remote}},
      });
      expect(JSON.parse(await readFile(join(fixture.home, 'cursor-cloud', 'profile.json'), 'utf8'))).toEqual({
        account: 'local',
        agentId: 'cloud-agent',
        provider: 'cursor-cloud',
        user: 'cloud-user',
        version: 1,
      });
      expect(await readFile(join(fixture.userHome, '.cursor', 'rules', 'threadnote.mdc'), 'utf8')).toContain(
        'Personal Cursor Cloud',
      );
      expect(await readFile(existingSkillPath, 'utf8')).toContain('Threadnote context in Personal Cursor Cloud');
      const cloudMemorySkill = await readFile(
        join(fixture.userHome, '.cursor', 'skills', 'threadnote-memory', 'SKILL.md'),
        'utf8',
      );
      expect(cloudMemorySkill).toContain('pass `team`');
      expect(cloudMemorySkill).not.toContain('Git beta');
      await expect(access(obsoleteGraphSkillPath)).rejects.toThrow();

      const verified = await runCli(
        [
          'cloud',
          'cursor',
          'verify',
          '--home',
          fixture.home,
          '--team',
          'engineering',
          '--user',
          'cloud-user',
          '--agent-id',
          'cloud-agent',
          '--cwd',
          process.cwd(),
          '--json',
        ],
        {HOME: fixture.userHome},
        signal,
      );
      expect(JSON.parse(verified.stdout)).toMatchObject({
        memoryRoot: 'threadnote://user/cloud-user/memories/shared/engineering',
        profile: 'shared-read-write',
        status: 'ok',
      });
      const started = await runCli(
        ['cloud', 'cursor', 'start', '--home', fixture.home, '--cwd', process.cwd(), '--json'],
        {HOME: fixture.userHome},
        signal,
      );
      expect(JSON.parse(started.stdout)).toMatchObject({status: 'ok', profile: 'shared-read-write'});
      if (process.platform === 'linux') {
        const enrollment = await readFile(join(fixture.home, 'dev-skills', 'index.json'), 'utf8');
        expect(enrollment).toContain('cursor-cloud-personal');
        expect(enrollment).toContain('"enabled": true');
      }
    } finally {
      await rm(fixture.root, {force: true, recursive: true});
    }
  });

  it('uses the saved identity for config and remember and rejects a conflicting bootstrap', async () => {
    const signal = AbortSignal.timeout(25_000);
    const fixture = await cloudFixture(signal);
    try {
      await bootstrap(fixture, undefined, undefined, false, signal);
      const implicitConfig = await runCli(
        ['cloud', 'cursor', 'config', '--home', fixture.home, '--team', 'engineering'],
        {HOME: fixture.userHome},
        signal,
      );
      expect(JSON.parse(implicitConfig.stdout)).toMatchObject({
        env: {THREADNOTE_AGENT_ID: 'cloud-agent', THREADNOTE_USER: 'cloud-user'},
      });
      const implicitRemember = await runCli(
        [
          'remember',
          '--home',
          fixture.home,
          '--kind',
          'handoff',
          '--project',
          'threadnote',
          '--topic',
          'cursor-cloud-profile-fallback',
          '--text',
          'The saved Cursor Cloud profile selects the canonical user.',
        ],
        {HOME: fixture.userHome},
        signal,
      );
      expect(implicitRemember.stdout).toContain('threadnote://user/cloud-user/memories/handoffs/active/');
      await expect(
        runCli(
          [
            'cloud',
            'cursor',
            'bootstrap',
            '--home',
            fixture.home,
            '--remote',
            fixture.remote,
            '--team',
            'engineering',
            '--user',
            'different-user',
            '--agent-id',
            'cloud-agent',
          ],
          {HOME: fixture.userHome},
          signal,
        ),
      ).rejects.toMatchObject({stderr: expect.stringContaining('already uses user "cloud-user"')});
    } finally {
      await rm(fixture.root, {force: true, recursive: true});
    }
  });

  it('keeps MCP discovery available while declared shares are still bootstrapping', async () => {
    const fixture = await cloudFixture();
    try {
      await withCloudMcp(fixture, ['engineering', 'docs'], async client => {
        const tools = await client.listTools();
        expect(EffectArray.map(tools.tools, tool => tool.name)).toEqual(CLOUD_TOOL_NAMES);
        const recall = await client.callTool({
          name: 'recall_context',
          arguments: {
            callerCwd: process.cwd(),
            query: 'bootstrap race sentinel',
            budgetTokens: 700,
            responseFormat: 'dual',
          },
        });
        expect(recall.isError).not.toBe(true);
        expectColdUnavailableWarnings(recall.structuredContent);
        expect(recall.structuredContent).toMatchObject({
          memoryScope: {
            type: 'threadnote-memory-scope',
            version: 2,
            mode: 'shared-read-write',
            memoryRoots: ['memories/shared/docs', 'memories/shared/engineering'],
            teams: ['docs', 'engineering'],
          },
          nextAction: {tool: 'read_context', uris: []},
          output: {budgetTokens: 700, returnedResults: 0, totalResults: 0, truncated: false},
        });
        await expect(
          client.readResource({
            uri: 'threadnote://user/cloud-user/memories/shared/engineering/durable/projects/threadnote/bootstrap.md',
          }),
        ).rejects.toThrow('Threadnote resource was not found.');
      });
    } finally {
      await rm(fixture.root, {force: true, recursive: true});
    }
  });

  it('starts and verifies the discovered set with CLI restrictions taking precedence over environment selectors', async () => {
    const fixture = await cloudFixture();
    const docsRemote = await seedRemote(fixture.root, 'command-docs-share');
    const environment = {HOME: fixture.userHome, THREADNOTE_CURSOR_CLOUD_TEAM: '', THREADNOTE_CURSOR_CLOUD_TEAMS: ''};
    const command = async (name: 'start' | 'verify', extra: readonly string[] = [], env: Record<string, string> = {}) =>
      JSON.parse(
        (
          await runCli(['cloud', 'cursor', name, '--home', fixture.home, '--cwd', process.cwd(), '--json', ...extra], {
            ...environment,
            ...env,
          })
        ).stdout,
      );
    try {
      await expect(command('verify')).rejects.toMatchObject({
        stderr: expect.stringContaining('No writable Cursor Cloud memory shares'),
      });
      await bootstrap(fixture);
      await bootstrap(fixture, 'docs', docsRemote);
      expect((await command('verify')).teams).toEqual(['docs', 'engineering']);
      const registryPath = join(fixture.home, 'share', 'teams.json');
      const registry = JSON.parse(await readFile(registryPath, 'utf8'));
      registry.defaultTeam = 'engineering';
      await writeFile(registryPath, JSON.stringify(registry));
      expect((await command('start')).teams).toEqual(['docs', 'engineering']);
      expect((await command('verify', [], {THREADNOTE_CURSOR_CLOUD_TEAM: 'docs'})).teams).toEqual(['docs']);
      expect(
        (await command('start', ['--team', 'engineering'], {THREADNOTE_CURSOR_CLOUD_TEAMS: 'invalid'})).teams,
      ).toEqual(['engineering']);
      expect(
        (await command('verify', ['--team', 'docs'], {THREADNOTE_CURSOR_CLOUD_TEAM: 'engineering'})).teams,
      ).toEqual(['docs']);
      await writeFile(registryPath, JSON.stringify({version: 1, teams: {}}));
      for (const name of ['start', 'verify'] as const) {
        await expect(command(name)).rejects.toMatchObject({
          stderr: expect.stringContaining('No writable Cursor Cloud memory shares'),
        });
      }
    } finally {
      await rm(fixture.root, {force: true, recursive: true});
    }
  });

  it('discovers shares registered after startup without exposing local memory or choosing a default', async () => {
    const fixture = await cloudFixture();
    const docsRemote = await seedRemote(fixture.root, 'late-docs-share');
    const uri =
      'threadnote://user/cloud-user/memories/shared/engineering/durable/projects/threadnote/late-bootstrap.md';
    try {
      await withCloudMcp(fixture, [], async client => {
        expect(EffectArray.map((await client.listTools()).tools, tool => tool.name)).toEqual(CLOUD_TOOL_NAMES);
        await expect(client.readResource({uri})).rejects.toThrow('No writable Cursor Cloud memory shares');
        const handoff = await client.callTool({
          name: 'remember_context',
          arguments: {
            kind: 'handoff',
            project: 'threadnote',
            topic: 'local-only',
            text: 'LOCAL_ONLY_SENTINEL',
          },
        });
        expect(handoff.isError, JSON.stringify(handoff)).not.toBe(true);
        expect(
          await callError(client, 'recall_context', {callerCwd: process.cwd(), query: 'LOCAL_ONLY_SENTINEL'}),
        ).toContain('No writable Cursor Cloud memory shares');
        await bootstrap(fixture);
        const stored = await client.callTool({
          name: 'remember_context',
          arguments: {
            kind: 'durable',
            project: 'threadnote',
            topic: 'late-bootstrap',
            text: 'LATE_BOOTSTRAP_SENTINEL',
          },
        });
        expect(stored.isError, JSON.stringify(stored)).not.toBe(true);
        expect(JSON.stringify(await client.readResource({uri}))).toContain('LATE_BOOTSTRAP_SENTINEL');
        await bootstrap(fixture, 'docs', docsRemote);
        expect(
          await callError(client, 'remember_context', {kind: 'durable', text: 'Ambiguous', topic: 'no-default'}),
        ).toContain('requires team');
        const recalled = await client.callTool({
          name: 'recall_context',
          arguments: {
            callerCwd: process.cwd(),
            query: 'LATE_BOOTSTRAP_SENTINEL',
            responseFormat: 'dual',
          },
        });
        expect(JSON.stringify(recalled)).toContain('late-bootstrap.md');
        const registryPath = join(fixture.home, 'share', 'teams.json');
        const registry = JSON.parse(await readFile(registryPath, 'utf8'));
        delete registry.teams.engineering;
        await writeFile(registryPath, JSON.stringify(registry));
        expect(await callError(client, 'read_context', {uri})).toContain('must stay within');
        await expect(client.readResource({uri})).rejects.toThrow('outside the active Cursor Cloud memory scope');
      });
    } finally {
      await rm(fixture.root, {force: true, recursive: true});
    }
  });

  it('preserves actionable resource errors for invalid selectors and oversized discovery', async () => {
    const fixture = await cloudFixture();
    const uri = 'threadnote://user/cloud-user/memories/shared/engineering';
    try {
      await mkdir(join(fixture.home, 'share'), {recursive: true});
      await writeFile(
        join(fixture.home, 'share', 'teams.json'),
        JSON.stringify({
          version: 1,
          teams: EffectRecord.fromEntries(
            Array.from({length: 17}, (_, index) => [`team-${index}`, {remote: fixture.remote}]),
          ),
        }),
      );
      await withCloudMcp(fixture, [], async client => {
        await expect(client.readResource({uri})).rejects.toThrow('at most 16 shares');
      });
      for (const raw of ['[]', 'invalid']) {
        await withCloudMcp(
          fixture,
          [],
          async client => {
            expect((await client.listTools()).tools).toHaveLength(CLOUD_TOOL_NAMES.length);
            await expect(client.readResource({uri})).rejects.toThrow('THREADNOTE_CURSOR_CLOUD_TEAMS');
          },
          'cursor-cloud-personal',
          {THREADNOTE_CURSOR_CLOUD_TEAMS: raw},
        );
      }
    } finally {
      await rm(fixture.root, {force: true, recursive: true});
    }
  });

  it.each([true, false])(
    'exposes several personal Git shares through one bounded MCP server (selectors: %s)',
    async explicit => {
      const fixture = await cloudFixture();
      const docsRemote = await seedRemote(fixture.root, 'docs-share');
      try {
        await bootstrap(fixture, 'engineering', fixture.remote);
        await bootstrap(fixture, 'docs', docsRemote);
        const dashboard = await runCli([
          'cloud',
          'cursor',
          'config',
          '--home',
          fixture.home,
          '--team',
          'engineering',
          '--team',
          'docs',
          '--user',
          'cloud-user',
          '--agent-id',
          'cloud-agent',
        ]);
        expect(JSON.parse(dashboard.stdout)).toMatchObject({
          env: {
            THREADNOTE_CURSOR_CLOUD_TEAM: 'docs',
            THREADNOTE_CURSOR_CLOUD_TEAMS: '["docs","engineering"]',
            THREADNOTE_MCP_TOOLSET: 'cursor-cloud-personal',
          },
        });

        await withCloudMcp(fixture, explicit ? ['engineering', 'docs'] : [], async client => {
          await callText(client, 'list_context', {recursive: true, team: 'engineering'});
          const allSharesRemoteUri = 'memories/shared/docs/durable/projects/threadnote/remote-all-shares.md';
          await pushRemoteMemory(
            fixture.root,
            docsRemote,
            'durable/projects/threadnote/remote-all-shares.md',
            memoryDocument('remote-all-shares', 'REMOTE_ALL_SHARES_REFRESH_SENTINEL'),
          );
          const deferred = await client.callTool({
            name: 'recall_context',
            arguments: {
              callerCwd: process.cwd(),
              query: 'REMOTE_ALL_SHARES_REFRESH_SENTINEL',
              responseFormat: 'dual',
            },
          });
          expectColdUnavailableWarnings(deferred.structuredContent);
          // The recall already admitted background synchronization. Let that
          // writer and its publisher settle before explicit fixture preparation.
          await settlePendingLexicalSync({
            account: 'local',
            user: 'cloud-user',
            agentContextHome: fixture.home,
            manifestPath: join(fixture.home, 'seed-manifest.yaml'),
            includeInactive: false,
            work: {kind: 'synchronize', sources: false, teams: ['docs', 'engineering']},
          });
          await prepareCloudReadyFixture(fixture);
          const refreshedAllShares = await client.callTool({
            arguments: {callerCwd: process.cwd(), query: 'REMOTE_ALL_SHARES_REFRESH_SENTINEL'},
            name: 'recall_context',
          });
          expect(JSON.stringify(refreshedAllShares)).toContain(allSharesRemoteUri);

          await expect(
            callError(client, 'remember_context', {
              kind: 'durable',
              project: 'threadnote',
              text: 'An ambiguous write must be rejected.',
              topic: 'ambiguous-write',
            }),
          ).resolves.toContain('requires team');

          for (const [team, topic] of [
            ['engineering', 'engineering-contract'],
            ['docs', 'docs-contract'],
          ] as const) {
            const stored = await client.callTool({
              arguments: {
                kind: 'durable',
                project: 'threadnote',
                team,
                text: `Durable contract for ${team}.`,
                topic,
              },
              name: 'remember_context',
            });
            expect(stored.isError, JSON.stringify(stored)).not.toBe(true);
            expect(stored.structuredContent).toMatchObject({
              memoryUri: `threadnote://user/cloud-user/memories/shared/${team}/durable/projects/threadnote/${topic}.md`,
              persistence: 'shared-git-pushed',
            });
            await expect(
              callText(client, 'read_context', {
                uri: `threadnote://user/cloud-user/memories/shared/${team}/durable/projects/threadnote/${topic}.md`,
              }),
            ).resolves.toContain(`Durable contract for ${team}.`);
          }

          await expect(callError(client, 'list_context', {})).resolves.toContain('requires team or uri');
          await expect(callText(client, 'list_context', {recursive: true, team: 'docs'})).resolves.toContain(
            'docs-contract.md',
          );
          await expect(
            callError(client, 'list_context', {
              team: 'docs',
              uri: 'threadnote://user/cloud-user/memories/shared/engineering',
            }),
          ).resolves.toContain('team must match the share containing uri');
          const allSharesRecall = await client.callTool({
            arguments: {callerCwd: process.cwd(), query: 'Durable contract', responseFormat: 'dual'},
            name: 'recall_context',
          });
          expect(JSON.stringify(allSharesRecall.structuredContent)).toContain('/shared/docs/');
          expect(JSON.stringify(allSharesRecall.structuredContent)).toContain('/shared/engineering/');
          const docsRecall = await client.callTool({
            arguments: {
              callerCwd: process.cwd(),
              query: 'Durable contract',
              responseFormat: 'dual',
              team: 'docs',
            },
            name: 'recall_context',
          });
          const docsErrorText = EffectArray.isArray(docsRecall.content)
            ? EffectArray.flatMap(docsRecall.content, (item: unknown) =>
                typeof item === 'object' &&
                item !== null &&
                'type' in item &&
                item.type === 'text' &&
                'text' in item &&
                typeof item.text === 'string'
                  ? [item.text]
                  : [],
              )
            : [];
          const docsErrorTag = EffectArray.some(docsErrorText, text => /RecallIndexSourceChanged/u.test(text))
            ? 'RecallIndexSourceChanged'
            : EffectArray.some(docsErrorText, text => /ReadDeadlineExceeded|timed out/iu.test(text))
              ? 'read-timeout'
              : docsRecall.isError
                ? 'other-mcp-error'
                : 'none';
          expect(
            docsRecall.structuredContent,
            JSON.stringify({
              isError: docsRecall.isError === true,
              phase: docsRecall.isError ? 'recall-context-tool-error' : 'recall-context-response',
              errorTag: docsErrorTag,
              structuredContentPresent: docsRecall.structuredContent !== undefined,
            }),
          ).toBeDefined();
          expect(JSON.stringify(docsRecall.structuredContent)).toContain('/shared/docs/');
          expect(JSON.stringify(docsRecall.structuredContent)).not.toContain('/shared/engineering/');
          await expect(
            callError(client, 'recall_context', {
              callerCwd: process.cwd(),
              query: 'Durable contract',
              team: 'docs',
              uri: 'threadnote://user/cloud-user/memories/shared/engineering',
            }),
          ).resolves.toContain('team must match the share containing uri');
          await expect(
            callError(client, 'remember_context', {
              kind: 'durable',
              project: 'threadnote',
              relations: [
                {
                  type: 'references',
                  uri: 'threadnote://user/cloud-user/memories/shared/engineering/durable/projects/threadnote/engineering-contract.md',
                },
              ],
              team: 'docs',
              text: 'Cross-share relations remain forbidden.',
              topic: 'cross-share-relation',
            }),
          ).resolves.toContain('authorized memory scope');
        });

        const engineeringTree = await gitTree(fixture.remote);
        const docsTree = await gitTree(docsRemote);
        expect(engineeringTree).toContain('engineering-contract.md');
        expect(engineeringTree).not.toContain('docs-contract.md');
        expect(docsTree).toContain('docs-contract.md');
        expect(docsTree).not.toContain('engineering-contract.md');
      } finally {
        await rm(fixture.root, {force: true, recursive: true});
      }
    },
  );

  it('completes deferred exact-share synchronization before reading a newly pushed remote URI', async () => {
    const fixture = await cloudFixture();
    const docsRemote = await seedRemote(fixture.root, 'deferred-docs-share');
    const teamScopedRemoteUri =
      'threadnote://user/cloud-user/memories/shared/docs/durable/projects/threadnote/remote-team-scoped.md';
    try {
      await bootstrap(fixture, 'engineering', fixture.remote);
      await bootstrap(fixture, 'docs', docsRemote);
      await runEffect(
        runShareSync(
          {
            account: 'local',
            user: 'cloud-user',
            agentId: 'cloud-agent',
            agentContextHome: fixture.home,
          },
          {team: 'docs'},
        ),
      );
      await prepareCloudReadyFixture(fixture);
      await pushRemoteMemory(
        fixture.root,
        docsRemote,
        'durable/projects/threadnote/remote-team-scoped.md',
        memoryDocument('remote-team-scoped', 'REMOTE_TEAM_SCOPED_REFRESH_SENTINEL'),
      );
      await rm(join(fixture.home, 'share', 'fetch-receipts', 'docs.json'), {force: true});

      await withCloudMcp(fixture, ['engineering', 'docs'], async client => {
        const scope: RecallLexicalScope = {
          account: 'local',
          agentContextHome: fixture.home,
          user: 'cloud-user',
          manifestPath: join(fixture.home, 'seed-manifest.yaml'),
          includeInactive: false,
          work: {kind: 'synchronize', sources: false, teams: ['docs']},
        };
        const completionFence = await armLexicalSyncCompletionFence(scope);
        try {
          const firstRead = await callText(client, 'read_context', {uri: teamScopedRemoteUri});
          expect(
            EffectString.includes('REMOTE_TEAM_SCOPED_REFRESH_SENTINEL')(firstRead) ||
              EffectString.includes(`Memory resource does not exist: ${teamScopedRemoteUri}`)(firstRead),
          ).toBe(true);
          completionFence.check();
          await completionFence.wait;
          await expect(callText(client, 'read_context', {uri: teamScopedRemoteUri})).resolves.toContain(
            'REMOTE_TEAM_SCOPED_REFRESH_SENTINEL',
          );
        } finally {
          completionFence.close();
        }
      });
    } finally {
      await rm(fixture.root, {force: true, recursive: true});
    }
  });

  it('renders and idempotently prepares remote-hybrid mode without a memory checkout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-cursor-cloud-hybrid-'));
    const home = join(root, 'home');
    const endpoint = 'https://memory.threadnote.io/mcp';
    const shareId = 'share-engineering';
    try {
      await expect(
        runCli(['cloud', 'cursor', 'config', '--home', home, '--mode', 'remote-hybrid', '--endpoint', endpoint]),
      ).rejects.toMatchObject({stderr: expect.stringContaining('requires --share-id')});

      const config = await runCli([
        'cloud',
        'cursor',
        'config',
        '--home',
        home,
        '--mode',
        'remote-hybrid',
        '--endpoint',
        endpoint,
        '--share-id',
        shareId,
        '--user',
        'cloud-user',
        '--agent-id',
        'cloud-agent',
      ]);
      expect(JSON.parse(config.stdout)).toMatchObject({
        mcpServers: {
          'threadnote-local': {
            args: ['-lc', 'exec "$HOME/.local/bin/threadnote-mcp-server"'],
            command: '/bin/sh',
            env: {
              THREADNOTE_CURSOR_MEMORY_ENDPOINT: endpoint,
              THREADNOTE_CURSOR_MEMORY_SHARE_ID: shareId,
              THREADNOTE_MCP_TOOLSET: 'cursor-cloud-local',
            },
            type: 'stdio',
          },
          'threadnote-memory': {headers: {'threadnote-share-id': shareId}, url: endpoint},
        },
      });
      expect(EffectRecord.keys(JSON.parse(config.stdout).mcpServers['threadnote-memory'].headers)).toEqual([
        'threadnote-share-id',
      ]);

      const bootstrapArguments = [
        'cloud',
        'cursor',
        'bootstrap',
        '--home',
        home,
        '--mode',
        'remote-hybrid',
        '--endpoint',
        endpoint,
        '--share-id',
        shareId,
        '--cwd',
        process.cwd(),
      ] as const;
      const first = await runCli(bootstrapArguments);
      const second = await runCli(bootstrapArguments);
      expect(first.stdout).toContain('no local Git memory share was configured');
      expect(second.stdout).toBe(first.stdout);
      await expect(access(join(home, 'share', 'teams.json'))).rejects.toMatchObject({code: 'ENOENT'});

      const verified = await runCli([
        'cloud',
        'cursor',
        'verify',
        '--home',
        home,
        '--mode',
        'remote-hybrid',
        '--endpoint',
        endpoint,
        '--share-id',
        shareId,
        '--cwd',
        process.cwd(),
        '--json',
      ]);
      expect(JSON.parse(verified.stdout)).toMatchObject({
        endpoint,
        localMemoryFallback: 'disabled',
        mode: 'remote-hybrid',
        shareId,
        status: 'ok',
      });

      await expect(
        runCli(
          [
            'cloud',
            'cursor',
            'verify',
            '--home',
            home,
            '--mode',
            'remote-hybrid',
            '--endpoint',
            endpoint,
            '--share-id',
            shareId,
            '--cwd',
            process.cwd(),
            '--json',
          ],
          {THREADNOTE_CURSOR_MEMORY_SHARE_ID: 'share-other'},
        ),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining('verification failed'),
        stdout: expect.stringContaining('"status":"fail"'),
      });

      await withLocalMcp(home, endpoint, shareId, async client => {
        const tools = await client.listTools();
        expect(EffectArray.map(tools.tools, tool => tool.name)).toEqual(CLOUD_LOCAL_TOOL_NAMES);
        expect(EffectArray.map(tools.tools, tool => tool.name)).not.toContain('recall_context');
        expect((await client.listResourceTemplates()).resourceTemplates).toEqual([]);

        const status = await client.callTool({
          arguments: {callerCwd: process.cwd()},
          name: 'cursor_cloud_status',
        });
        expect(status.isError).not.toBe(true);
        expect(status.structuredContent).toMatchObject({
          localMemoryFallback: 'disabled',
          shareId,
          status: 'ok',
        });

        await expect(
          callError(client, 'complete_cursor_attestation', {
            audience: 'https://memory.threadnote.io/attest/cursor',
            challengeId: 'challenge_123',
            completionUrl: 'https://attacker.example/complete',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            nonce: 'nonce_1234567890',
          }),
        ).resolves.toContain('must match the configured remote memory service');
      });
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  });

  it('keeps legacy MCP toolset identifiers on the Personal Cursor Cloud boundary', async () => {
    const fixture = await cloudFixture();
    try {
      await bootstrap(fixture);
      for (const toolset of ['cursor-cloud', 'cursor-cloud-git-beta'] as const) {
        await withCloudMcp(
          fixture,
          ['engineering'],
          async client => {
            expect(EffectArray.map((await client.listTools()).tools, tool => tool.name)).toEqual(CLOUD_TOOL_NAMES);
            await expect(
              callError(client, 'read_context', {
                uri: 'threadnote://user/cloud-user/memories/durable/projects/threadnote/private.md',
              }),
            ).resolves.toContain('must stay within');
            const externalUri =
              'threadnote://resources/external/superhuman/docs-source/docs/doc_test/pages/page_test/chunk_test.md';
            await expect(callError(client, 'read_context', {uri: externalUri})).resolves.toContain('must stay within');
            await expect(
              callError(client, 'recall_context', {query: 'canvas notes', uri: externalUri}),
            ).resolves.toContain('must stay within');
            const listed = await client.callTool({
              arguments: {recursive: true, team: 'engineering'},
              name: 'list_context',
            });
            expect(listed.structuredContent).toMatchObject({
              memoryScope: {
                mode: 'shared-read-write',
                teams: ['engineering'],
                type: 'threadnote-memory-scope',
                version: 2,
              },
            });
          },
          toolset,
        );
      }
    } finally {
      await rm(fixture.root, {force: true, recursive: true});
    }
  });

  it('confines reads, persists durable writes to Git, and keeps handoffs local', async () => {
    const fixture = await cloudFixture();
    await bootstrap(fixture);
    try {
      const privateSentinel = 'CURSOR_CLOUD_RELOCATION_PRIVATE_SENTINEL';
      const privateUri =
        'threadnote://user/cloud-user/memories/durable/projects/threadnote/relocation-private-target.md';
      const formerSharedUri =
        'threadnote://user/cloud-user/memories/shared/engineering/durable/projects/threadnote/relocation-former-shared.md';
      await runCli(
        [
          'remember',
          '--home',
          fixture.home,
          '--kind',
          'durable',
          '--project',
          'threadnote',
          '--topic',
          'relocation-private-target',
          '--text',
          privateSentinel,
        ],
        {THREADNOTE_USER: 'cloud-user'},
      );
      const privatePath = join(
        fixture.home,
        'data',
        'local',
        'user',
        'cloud-user',
        'memories',
        'durable',
        'projects',
        'threadnote',
        'relocation-private-target.md',
      );
      const privateContent = await readFile(privatePath, 'utf8');
      const memoryId = /^memory_id: (tn_[A-Za-z0-9_-]+)$/mu.exec(privateContent)?.[1];
      expect(memoryId).toBeDefined();
      const receiptRoot = join(
        fixture.home,
        'data',
        'local',
        'user',
        'cloud-user',
        'private',
        'memory-relocations',
        'v1',
      );
      await mkdir(receiptRoot, {recursive: true, mode: 0o700});
      await writeFile(
        join(receiptRoot, `${createHash('sha256').update(formerSharedUri).digest('hex')}.json`),
        `${JSON.stringify({
          fromUri: formerSharedUri,
          memoryId,
          toUri: privateUri,
          type: 'threadnote-memory-relocation',
          version: 1,
          visibility: 'private-local',
        })}\n`,
        {mode: 0o600},
      );
      const referencedSourceUri = 'memories/shared/engineering/durable/projects/threadnote/reference-scope-source.md';
      await pushRemoteMemory(
        fixture.root,
        fixture.remote,
        'durable/projects/threadnote/reference-scope-source.md',
        memoryDocument('reference-scope-source', 'REFERENCE_SCOPE_SOURCE_SENTINEL', privateUri),
      );
      await runEffect(
        runShareSync(
          {
            account: 'local',
            user: 'cloud-user',
            agentId: 'cloud-agent',
            agentContextHome: fixture.home,
          },
          {team: 'engineering'},
        ),
      );
      await prepareCloudReadyFixture(fixture);

      await withCloudMcp(fixture, async client => {
        const tools = await client.listTools();
        expect(EffectArray.map(tools.tools, tool => tool.name)).toEqual(CLOUD_TOOL_NAMES);

        await expect(
          callError(client, 'read_context', {
            uri: 'threadnote://user/cloud-user/memories/durable/projects/threadnote/private.md',
          }),
        ).resolves.toContain('must stay within');
        const privateAlias = `threadnote://memory/${memoryId}`;
        const aliasReadError = await callError(client, 'read_context', {uri: privateAlias});
        expect(aliasReadError).toContain('does not resolve inside the authorized active corpus');
        expect(aliasReadError).not.toContain(privateSentinel);
        await expect(client.readResource({uri: privateAlias})).rejects.toThrow(
          'does not resolve inside the authorized active corpus',
        );
        const relocatedReadError = await callError(client, 'read_context', {uri: formerSharedUri});
        expect(relocatedReadError).toContain('relocated uri must stay within');
        expect(relocatedReadError).not.toContain(privateSentinel);
        await expect(client.readResource({uri: formerSharedUri})).rejects.toThrow(
          'relocated resource is outside the active Cursor Cloud memory scope',
        );
        const referencedRecall = await client.callTool({
          arguments: {callerCwd: process.cwd(), query: 'REFERENCE_SCOPE_SOURCE_SENTINEL'},
          name: 'recall_context',
        });
        expect(JSON.stringify(referencedRecall)).toContain(referencedSourceUri);
        expect(JSON.stringify(referencedRecall)).not.toContain(privateUri);
        await expect(
          callError(client, 'remember_context', {
            kind: 'preference',
            text: 'Do not persist this cloud preference.',
          }),
        ).resolves.toContain('durable shared memories and transient local handoffs');

        const handoff = await callText(client, 'remember_context', {
          kind: 'handoff',
          project: 'threadnote',
          text: 'Transient cloud checkout handoff.',
          topic: 'cursor-cloud-transient',
        });
        expect(handoff).toContain(
          'Stored memory: threadnote://user/cloud-user/memories/handoffs/active/threadnote/cursor-cloud-transient.md',
        );
        const handoffCanonicalOutside = await callError(client, 'remember_context', {
          kind: 'handoff',
          project: 'threadnote',
          relations: [{type: 'references', uri: privateUri}],
          text: 'This handoff relation must stay inside configured shares.',
          topic: 'cursor-cloud-handoff-canonical-outside',
        });
        expect(handoffCanonicalOutside).toContain('authorized memory scope');
        expect(handoffCanonicalOutside).not.toContain(privateSentinel);
        const handoffAliasOutside = await callError(client, 'remember_context', {
          kind: 'handoff',
          project: 'threadnote',
          relations: [{type: 'references', uri: privateAlias}],
          text: 'This handoff alias must stay inside configured shares.',
          topic: 'cursor-cloud-handoff-alias-outside',
        });
        expect(handoffAliasOutside).toContain('does not resolve inside the authorized active corpus');
        expect(handoffAliasOutside).not.toContain(privateSentinel);

        const durableAliasReplacementOutside = await callError(client, 'remember_context', {
          kind: 'durable',
          project: 'threadnote',
          replaceUri: privateAlias,
          text: 'A provider-neutral alias must not bypass the bound share.',
          topic: 'cursor-cloud-alias-replace-outside',
        });
        expect(durableAliasReplacementOutside).toContain(
          'replaceUri must stay within a configured Personal Cursor Cloud share',
        );
        expect(durableAliasReplacementOutside).not.toContain(privateSentinel);

        const sharedCitationWithoutReadyGraph = await client.callTool({
          arguments: {
            callerCwd: process.cwd(),
            codeRefs: ['apps/threadnote/src/types.ts'],
            kind: 'durable',
            project: 'threadnote',
            text: 'Shared memory must not publish before its requested citation is current.',
            topic: 'cursor-cloud-strict-citation',
          },
          name: 'remember_context',
        });
        expect(sharedCitationWithoutReadyGraph.isError).toBe(true);
        expect(sharedCitationWithoutReadyGraph.structuredContent).toMatchObject({
          retryable: true,
          state: 'blocked',
          type: 'memory-code-citation-write-recovery',
          writeApplied: false,
        });
        expect(JSON.stringify(sharedCitationWithoutReadyGraph)).toContain('No memory was written');
        await expect(
          access(
            join(
              fixture.home,
              'data',
              'local',
              'user',
              'cloud-user',
              'memories',
              'shared',
              'engineering',
              'durable',
              'projects',
              'threadnote',
              'cursor-cloud-strict-citation.md',
            ),
          ),
        ).rejects.toMatchObject({code: 'ENOENT'});
        await expect(
          access(join(fixture.home, 'data', 'local', 'user', 'cloud-user', 'private', 'deferred-code-anchors', 'v1')),
        ).rejects.toMatchObject({code: 'ENOENT'});

        const durable = await client.callTool({
          arguments: {
            kind: 'durable',
            project: 'threadnote',
            text: 'Cursor Cloud durable memory persisted through the designated share.',
            topic: 'cursor-cloud-persisted',
          },
          name: 'remember_context',
        });
        expect(durable.isError).not.toBe(true);
        expect(durable.structuredContent).toMatchObject({
          memoryUri:
            'threadnote://user/cloud-user/memories/shared/engineering/durable/projects/threadnote/cursor-cloud-persisted.md',
          persistence: 'shared-git-pushed',
        });
        const read = await callText(client, 'read_context', {
          uri: 'threadnote://user/cloud-user/memories/shared/engineering/durable/projects/threadnote/cursor-cloud-persisted.md',
        });
        expect(read).toContain('Cursor Cloud durable memory persisted through the designated share.');
        const targetMemoryId = /^memory_id: (tn_[A-Za-z0-9_-]+)$/mu.exec(read)?.[1];
        expect(targetMemoryId).toBeDefined();

        const relationSource = await client.callTool({
          arguments: {
            kind: 'durable',
            project: 'threadnote',
            relations: [
              {
                type: 'depends_on',
                uri: 'threadnote://user/cloud-user/memories/shared/engineering/durable/projects/threadnote/cursor-cloud-persisted.md',
              },
            ],
            text: 'This shared workflow explicitly depends on the persisted contract.',
            topic: 'cursor-cloud-relation-source',
          },
          name: 'remember_context',
        });
        expect(relationSource.isError, JSON.stringify(relationSource)).not.toBe(true);
        const relationRead = await callText(client, 'read_context', {
          uri: 'threadnote://user/cloud-user/memories/shared/engineering/durable/projects/threadnote/cursor-cloud-relation-source.md',
        });
        expect(relationRead).toContain(`relation: depends_on threadnote://memory/${targetMemoryId}`);

        const canonicalOutside = await callError(client, 'remember_context', {
          kind: 'durable',
          relations: [{type: 'references', uri: privateUri}],
          text: 'This cross-scope relation must not be stored.',
          topic: 'cursor-cloud-canonical-outside',
        });
        expect(canonicalOutside).toContain('authorized memory scope');
        expect(canonicalOutside).not.toContain(privateSentinel);
        const aliasOutside = await callError(client, 'remember_context', {
          kind: 'durable',
          relations: [{type: 'references', uri: privateAlias}],
          text: 'This cross-scope alias must not be stored.',
          topic: 'cursor-cloud-alias-outside',
        });
        expect(aliasOutside).toContain('does not resolve inside the authorized active corpus');
        expect(aliasOutside).not.toContain(privateSentinel);
      });

      const remoteTree = await execFilePromise(
        'git',
        ['--git-dir', fixture.remote, 'ls-tree', '-r', '--name-only', 'main'],
        {env: {...process.env, ...gitIdentityEnvironment}},
      );
      expect(remoteTree.stdout).toContain('durable/projects/threadnote/cursor-cloud-persisted.md');
      expect(remoteTree.stdout).toContain('durable/projects/threadnote/cursor-cloud-relation-source.md');
      expect(remoteTree.stdout).not.toContain('handoffs/');
    } finally {
      await rm(fixture.root, {force: true, recursive: true});
    }
  }, 60_000);
});

interface CloudFixture {
  readonly home: string;
  readonly remote: string;
  readonly root: string;
  readonly userHome: string;
}

async function cloudFixture(signal?: AbortSignal): Promise<CloudFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-cursor-cloud-')));
  try {
    const remote = await seedRemote(root, 'memory-share', signal);
    const home = join(root, 'home');
    const userHome = join(root, 'user-home');
    await mkdir(userHome, {recursive: true});
    return {home, remote, root, userHome};
  } catch (error) {
    await rm(root, {force: true, recursive: true});
    throw error;
  }
}

async function seedRemote(root: string, name: string, signal?: AbortSignal): Promise<string> {
  const remote = join(root, `${name}.git`);
  const source = join(root, `${name}-seed`);
  await mkdir(source, {recursive: true});
  await execFilePromise('git', ['init', '--bare', '--initial-branch=main', remote], {
    env: {...process.env, ...gitIdentityEnvironment},
    ...(signal ? {signal, timeout: 20_000, killSignal: 'SIGKILL' as const} : {}),
  });
  await execFilePromise('git', ['-C', source, 'init', '--initial-branch=main'], {
    env: {...process.env, ...gitIdentityEnvironment},
    ...(signal ? {signal, timeout: 20_000, killSignal: 'SIGKILL' as const} : {}),
  });
  await writeFile(join(source, 'README.md'), '# Cursor Cloud memory share\n');
  await execFilePromise('git', ['-C', source, 'add', 'README.md'], {
    env: {...process.env, ...gitIdentityEnvironment},
    ...(signal ? {signal, timeout: 20_000, killSignal: 'SIGKILL' as const} : {}),
  });
  await execFilePromise('git', ['-C', source, 'commit', '-m', 'seed memory share'], {
    env: {...process.env, ...gitIdentityEnvironment},
    ...(signal ? {signal, timeout: 20_000, killSignal: 'SIGKILL' as const} : {}),
  });
  await execFilePromise('git', ['-C', source, 'remote', 'add', 'origin', remote], {
    env: {...process.env, ...gitIdentityEnvironment},
    ...(signal ? {signal, timeout: 20_000, killSignal: 'SIGKILL' as const} : {}),
  });
  await execFilePromise('git', ['-C', source, 'push', '-u', 'origin', 'main'], {
    env: {...process.env, ...gitIdentityEnvironment},
    ...(signal ? {signal, timeout: 20_000, killSignal: 'SIGKILL' as const} : {}),
  });
  return remote;
}

async function pushRemoteMemory(root: string, remote: string, relativePath: string, content: string): Promise<void> {
  const source = await mkdtemp(join(root, 'remote-memory-update-'));
  await execFilePromise('git', ['clone', remote, source], {env: {...process.env, ...gitIdentityEnvironment}});
  const target = join(source, relativePath);
  await mkdir(join(target, '..'), {recursive: true});
  await writeFile(target, content, 'utf8');
  await execFilePromise('git', ['-C', source, 'add', relativePath], {
    env: {...process.env, ...gitIdentityEnvironment},
  });
  await execFilePromise('git', ['-C', source, 'commit', '-m', `add ${relativePath}`], {
    env: {...process.env, ...gitIdentityEnvironment},
  });
  await execFilePromise('git', ['-C', source, 'push', 'origin', 'main'], {
    env: {...process.env, ...gitIdentityEnvironment},
  });
}

function memoryDocument(topic: string, body: string, reference?: string): string {
  return EffectArray.join(
    [
      'MEMORY',
      'kind: durable',
      'status: active',
      'project: threadnote',
      `topic: ${topic}`,
      ...(reference ? [`references: ${reference}`] : []),
      '',
      body,
      '',
    ],
    '\n',
  );
}

function bootstrap(
  fixture: CloudFixture,
  team = 'engineering',
  remote = fixture.remote,
  sync = true,
  signal?: AbortSignal,
) {
  return runCli(
    [
      'cloud',
      'cursor',
      'bootstrap',
      '--home',
      fixture.home,
      '--remote',
      remote,
      '--team',
      team,
      '--user',
      'cloud-user',
      '--agent-id',
      'cloud-agent',
      ...(sync ? [] : ['--no-sync']),
    ],
    {HOME: fixture.userHome},
    signal,
  );
}

function runCli(args: readonly string[], environment: Readonly<Record<string, string>> = {}, signal?: AbortSignal) {
  const started = performance.now();
  return execFilePromise(
    process.execPath,
    [
      'apps/threadnote/src/standalone.ts',
      ...args,
      ...(process.platform !== 'linux' &&
      args[0] === 'cloud' &&
      args[1] === 'cursor' &&
      args[2] === 'bootstrap' &&
      !args.includes('--mode')
        ? ['--no-dev-skills']
        : []),
    ],
    {
      cwd: process.cwd(),
      env: {...process.env, ...gitIdentityEnvironment, ...environment, NO_COLOR: '1'},
      ...(signal ? {signal, timeout: 20_000, killSignal: 'SIGKILL' as const} : {}),
      maxBuffer: 1_048_576,
    },
  ).catch((error: unknown) => {
    if (signal && error instanceof Error) {
      const stage = EffectArray.join(args.slice(0, args[0] === 'cloud' ? 3 : 1), ' ');
      const stderr =
        'stderr' in error && typeof error.stderr === 'string' ? EffectString.slice(-2048)(error.stderr) : '';
      error.message = `Cursor Cloud CLI ${stage} failed after ${Math.round(performance.now() - started)}ms.${stderr ? '\n' + stderr : ''}`;
    }
    throw error;
  });
}

async function prepareCloudReadyFixture(fixture: CloudFixture): Promise<void> {
  await runEffect(
    loadRecallIndexData(
      {
        account: 'local',
        user: 'cloud-user',
        agentContextHome: fixture.home,
        manifestPath: join(fixture.home, 'seed-manifest.yaml'),
      },
      {includeInactive: false, validateNow: true},
    ),
  );
}

async function settlePendingLexicalSync(scope: RecallLexicalScope): Promise<void> {
  const deadline = performance.now() + 20_000;
  const completionFence = await armLexicalSyncCompletionFence(scope, deadline);
  try {
    // Synchronization enqueues this separately keyed publisher before completing.
    // Observe it before waiting, then read its current state after synchronization.
    const publicationFence = await armLexicalSyncCompletionFence(
      {...scope, work: undefined},
      deadline,
      completionFence.failure,
    );
    try {
      await settleLexicalSyncAndPublication(completionFence, publicationFence);
    } finally {
      publicationFence.close();
    }
  } finally {
    completionFence.close();
  }
}

async function settleLexicalSyncAndPublication(
  synchronization: {readonly failure: Promise<never>; settleCurrent(): Promise<void>},
  publication: {readonly failure: Promise<never>; settleCurrent(): Promise<void>},
): Promise<void> {
  const failure = Promise.race([synchronization.failure, publication.failure]);
  await raceLexicalFenceFailure(synchronization.settleCurrent(), failure);
  await raceLexicalFenceFailure(publication.settleCurrent(), failure);
}

function classifyLexicalSyncSettlement(
  before: RecallLexicalDemand | undefined,
  current: RecallLexicalDemand | undefined,
): 'no-demand' | 'active' | 'complete' {
  if (!current) {
    if (!before) return 'no-demand';
    throw new Error('Lexical synchronization demand disappeared before successful completion.');
  }
  if (current.failures > (before?.failures ?? 0) || current.failures > 0)
    throw new Error('Lexical synchronization has a failed terminal outcome.');
  if (current.revision !== undefined) return 'active';
  if (
    current.completedAt !== undefined &&
    (before?.completedAt === undefined || current.completedAt >= before.completedAt)
  )
    return 'complete';
  throw new Error('Lexical synchronization terminal outcome is unknown.');
}

function assertLexicalFenceHealthy(failure: Error | undefined): void {
  if (failure !== undefined) throw new Error('Lexical synchronization observer failed.', {cause: failure});
}

async function drainLexicalFenceInspection(
  isInspecting: () => boolean,
  inspection: () => Promise<void> | undefined,
  failure: () => Error | undefined,
  awaitForeground: <A>(operation: Promise<A>) => Promise<A>,
): Promise<void> {
  while (isInspecting()) {
    const task = inspection();
    if (!task) break;
    await awaitForeground(task);
  }
  assertLexicalFenceHealthy(failure());
}

function raceLexicalFenceFailure<A>(operation: Promise<A>, failure: Promise<never>): Promise<A> {
  return Promise.race([operation, failure]);
}

function lexicalSyncFenceFailure(message: string, scope: RecallLexicalScope, demand: RecallLexicalDemand): Error {
  const phase = scope.work?.kind === 'synchronize' ? 'synchronization' : (scope.work?.kind ?? 'lexical-publication');
  return new Error(
    `${message} Demand observation: ${JSON.stringify({
      phase,
      revisionPresent: demand.revision !== undefined,
      failures: demand.failures,
      completed: demand.completedAt !== undefined,
    })}`,
  );
}

async function armLexicalSyncCompletionFence(
  scope: RecallLexicalScope,
  deadline = performance.now() + 20_000,
  precedingFailure?: Promise<never>,
): Promise<{
  readonly wait: Promise<void>;
  readonly failure: Promise<never>;
  check(): void;
  settleCurrent(): Promise<void>;
  close(): void;
}> {
  const directory = join(scope.agentContextHome, 'recall', RECALL_LEXICAL_DEMAND_DIRECTORY);
  const filename = `${recallLexicalDemandKey(scope)}.json`;
  let before: RecallLexicalDemand | undefined;
  let requestedAt = 0;
  let waitSettled = false;
  let settlementSettled = false;
  let settlementRequested = false;
  let observedActive = false;
  let inspecting = false;
  let dirty = false;
  let lastObserved = 'before=unread';
  let observerError: Error | undefined;
  let closed = false;
  let watcher: ReturnType<typeof watch> | undefined;
  const readScopedDemand = () => {
    const demand = readRecallLexicalDemand(scope);
    return runEffect(demand);
  };
  let resolveWait!: () => void;
  let rejectWait!: (error: Error) => void;
  let resolveSettlement!: () => void;
  let rejectSettlement!: (error: Error) => void;
  const wait = new Promise<void>((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });
  const settlement = new Promise<void>((resolve, reject) => {
    resolveSettlement = resolve;
    rejectSettlement = reject;
  });
  let rejectTerminalFailure!: (error: Error) => void;
  let terminalFailureSettled = false;
  const terminalFailure = new Promise<never>((_resolve, reject) => {
    rejectTerminalFailure = reject;
  });
  let inspect = () => {};
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    watcher?.close();
  };
  const fail = (error: Error) => {
    if (observerError === undefined) observerError = error;
    if (!terminalFailureSettled) {
      terminalFailureSettled = true;
      rejectTerminalFailure(observerError);
    }
    if (waitSettled && settlementSettled) return;
    waitSettled = true;
    settlementSettled = true;
    close();
    rejectWait(error);
    rejectSettlement(error);
  };
  const timer = setTimeout(
    () =>
      fail(new Error(`Deferred lexical synchronization timed out; last demand state: ${lastObserved ?? 'unread'}.`)),
    Math.max(0, deadline - performance.now()),
  );
  void wait.catch(() => undefined);
  void settlement.catch(() => undefined);
  void terminalFailure.catch(() => undefined);
  const failure = precedingFailure ? Promise.race([terminalFailure, precedingFailure]) : terminalFailure;
  const awaitForeground = <A>(operation: Promise<A>) => raceLexicalFenceFailure(operation, failure);
  try {
    before = await awaitForeground(readScopedDemand());
    lastObserved = `before=${before?.completedAt ?? 'absent'}`;
    await awaitForeground(mkdir(directory, {recursive: true, mode: 0o700}));
    requestedAt = Date.now();
    watcher = watch(directory, {persistent: false}, (_event, changedFile) => {
      if (changedFile === null || changedFile.toString() === filename) inspect();
    });
    watcher.on('error', fail);
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error('Could not arm lexical synchronization fence.');
    fail(error);
    throw error;
  }
  let inspectionTask: Promise<void> | undefined;
  inspect = () => {
    dirty = true;
    if (inspecting || (waitSettled && settlementSettled)) return;
    inspecting = true;
    inspectionTask = (async () => {
      try {
        while (dirty && !(waitSettled && settlementSettled)) {
          dirty = false;
          const current = await awaitForeground(readScopedDemand());
          lastObserved = current
            ? JSON.stringify({revision: current.revision, completedAt: current.completedAt, failures: current.failures})
            : 'absent';
          if (!current) {
            if (before !== undefined || observedActive) {
              fail(new Error('Lexical synchronization demand disappeared before successful completion.'));
              return;
            }
            continue;
          }
          if (current.failures > (before?.failures ?? 0)) {
            fail(lexicalSyncFenceFailure('Deferred lexical synchronization recorded a failure.', scope, current));
            return;
          }
          if (current.failures > 0) {
            fail(
              lexicalSyncFenceFailure(
                'Deferred lexical synchronization has a failed terminal outcome.',
                scope,
                current,
              ),
            );
            return;
          }
          if (current.revision !== undefined) {
            if (settlementRequested) observedActive = true;
            continue;
          }
          if (current.completedAt === undefined) {
            fail(new Error('Lexical synchronization terminal outcome is unknown.'));
            return;
          }
          if (settlementRequested && observedActive && !settlementSettled) {
            settlementSettled = true;
            resolveSettlement();
          }
          if (
            current.completedAt >= requestedAt &&
            (before?.completedAt === undefined || current.completedAt > before.completedAt)
          ) {
            if (!waitSettled) {
              waitSettled = true;
              resolveWait();
            }
          }
        }
      } catch (cause) {
        fail(cause instanceof Error ? cause : new Error('Could not read lexical synchronization state.'));
      } finally {
        inspecting = false;
        if (dirty && !(waitSettled && settlementSettled)) inspect();
      }
    })();
  };
  const settleCurrent = async () => {
    inspect();
    await drainLexicalFenceInspection(
      () => inspecting,
      () => inspectionTask,
      () => observerError,
      awaitForeground,
    );
    assertLexicalFenceHealthy(observerError);
    const current = await awaitForeground(readScopedDemand());
    assertLexicalFenceHealthy(observerError);
    const status = classifyLexicalSyncSettlement(before, current);
    if (status === 'active') {
      settlementRequested = true;
      observedActive = true;
      inspect();
      await awaitForeground(settlement);
      await drainLexicalFenceInspection(
        () => inspecting,
        () => inspectionTask,
        () => observerError,
        awaitForeground,
      );
      return;
    }
    await drainLexicalFenceInspection(
      () => inspecting,
      () => inspectionTask,
      () => observerError,
      awaitForeground,
    );
  };
  return {wait, failure, check: inspect, settleCurrent, close};
}

async function withCloudMcp<T>(
  fixture: CloudFixture,
  teamsOrUse: readonly string[] | ((client: Client) => Promise<T>),
  maybeUse?: (client: Client) => Promise<T>,
  toolset: 'cursor-cloud' | 'cursor-cloud-git-beta' | 'cursor-cloud-personal' = 'cursor-cloud-personal',
  environment: Readonly<Record<string, string>> = {},
): Promise<T> {
  const teams = typeof teamsOrUse === 'function' ? ['engineering'] : teamsOrUse;
  const use = typeof teamsOrUse === 'function' ? teamsOrUse : maybeUse!;
  const transport = new StdioClientTransport({
    args: [join(process.cwd(), 'apps', 'threadnote', 'src', 'standalone.ts'), 'mcp-server'],
    command: process.execPath,
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...gitIdentityEnvironment,
      THREADNOTE_ACCOUNT: 'local',
      THREADNOTE_AGENT_ID: 'cloud-agent',
      THREADNOTE_CURSOR_CLOUD_TEAM: teams[0] ?? '',
      THREADNOTE_CURSOR_CLOUD_TEAMS: teams.length > 1 ? JSON.stringify([...teams].sort()) : '',
      THREADNOTE_HOME: fixture.home,
      THREADNOTE_MANIFEST: join(fixture.home, 'seed-manifest.yaml'),
      THREADNOTE_MCP_TOOLSET: toolset,
      THREADNOTE_USER: 'cloud-user',
      ...environment,
    },
    stderr: 'pipe',
  });
  const client = new Client({name: 'threadnote-cursor-cloud-test', version: '0.0.0'});
  try {
    await client.connect(transport);
    return await use(client);
  } finally {
    await client.close();
  }
}

async function gitTree(remote: string): Promise<string> {
  const result = await execFilePromise('git', ['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main'], {
    env: {...process.env, ...gitIdentityEnvironment},
  });
  return result.stdout;
}

async function withLocalMcp<T>(
  home: string,
  endpoint: string,
  shareId: string,
  use: (client: Client) => Promise<T>,
): Promise<T> {
  const transport = new StdioClientTransport({
    args: [join(process.cwd(), 'apps', 'threadnote', 'src', 'standalone.ts'), 'mcp-server'],
    command: process.execPath,
    cwd: process.cwd(),
    env: {
      ...process.env,
      THREADNOTE_ACCOUNT: 'local',
      THREADNOTE_AGENT_ID: 'cloud-agent',
      THREADNOTE_CURSOR_MEMORY_ENDPOINT: endpoint,
      THREADNOTE_CURSOR_MEMORY_SHARE_ID: shareId,
      THREADNOTE_HOME: home,
      THREADNOTE_MANIFEST: join(home, 'seed-manifest.yaml'),
      THREADNOTE_MCP_TOOLSET: 'cursor-cloud-local',
      THREADNOTE_USER: 'cloud-user',
    },
    stderr: 'pipe',
  });
  const client = new Client({name: 'threadnote-cursor-cloud-local-test', version: '0.0.0'});
  try {
    await client.connect(transport);
    return await use(client);
  } finally {
    await client.close();
  }
}

const cursorToolContentSchema = Schema.Array(
  Schema.StructWithRest(Schema.Struct({text: Schema.optional(Schema.String), type: Schema.String}), [
    Schema.Record(Schema.String, Schema.Unknown),
  ]),
);

async function callText(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({arguments: args, name});
  const content = Schema.decodeUnknownSync(cursorToolContentSchema)(result.content);
  return EffectArray.join(
    EffectArray.map(
      EffectArray.filter(content, item => item.type === 'text'),
      item => item.text ?? '',
    ),
    '\n',
  );
}

async function callError(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({arguments: args, name});
  expect(result.isError).toBe(true);
  const content = Schema.decodeUnknownSync(cursorToolContentSchema)(result.content);
  return EffectArray.join(
    EffectArray.map(content, item => item.text ?? ''),
    '\n',
  );
}
