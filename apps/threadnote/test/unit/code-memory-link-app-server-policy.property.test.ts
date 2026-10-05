import {mkdtempSync, rmSync, symlinkSync, writeFileSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {approveCodeMemoryLinkAppServerRequest} from '../../../../scripts/code-memory-link-app-server-policy.js';

const ROOT = '/sealed/public-repository';
const SCOPE = {repositoryRoot: ROOT, threadId: 'thr_gate', turnId: 'turn_gate'};

describe('Code Memory Link pre-execution app-server policy', () => {
  it('accepts only a scope-matched bounded repository read', () => {
    const {item, params} = commandApproval("sed -n '1,40p' src/service.ts", 'src/service.ts');
    expect(
      approveCodeMemoryLinkAppServerRequest({
        method: 'item/commandExecution/requestApproval',
        params,
        scope: SCOPE,
        startedItem: item,
      }),
    ).toMatchObject({itemType: 'commandExecution'});
    expect(
      approveCodeMemoryLinkAppServerRequest({
        method: 'item/commandExecution/requestApproval',
        params: {...params, additionalPermissions: null},
        scope: SCOPE,
        startedItem: item,
      }),
    ).toMatchObject({itemType: 'commandExecution'});
    expect(() =>
      approveCodeMemoryLinkAppServerRequest({
        method: 'item/commandExecution/requestApproval',
        params: {...params, additionalPermissions: {fileSystem: null, network: {enabled: true}}},
        scope: SCOPE,
        startedItem: item,
      }),
    ).toThrow('additional permissions');
    expect(
      approveCodeMemoryLinkAppServerRequest({
        method: 'item/commandExecution/requestApproval',
        params: {...params, proposedExecpolicyAmendment: Array.from({length: 64}, () => 'pwd')},
        scope: SCOPE,
        startedItem: item,
      }),
    ).toMatchObject({itemType: 'commandExecution'});
    expect(() =>
      approveCodeMemoryLinkAppServerRequest({
        method: 'item/commandExecution/requestApproval',
        params: {...params, turnId: 'turn_other'},
        scope: SCOPE,
        startedItem: item,
      }),
    ).toThrow('outside the selected thread');

    const od = commandApproval('od -An -tx1 -N 3 src/service.ts', 'src/service.ts');
    expect(
      approveCodeMemoryLinkAppServerRequest({
        method: 'item/commandExecution/requestApproval',
        params: od.params,
        scope: SCOPE,
        startedItem: od.item,
      }),
    ).toMatchObject({itemType: 'commandExecution'});

    const grep = commandApproval("grep -n -F 'thread identity' src/service.ts", 'src/service.ts');
    expect(
      approveCodeMemoryLinkAppServerRequest({
        method: 'item/commandExecution/requestApproval',
        params: grep.params,
        scope: SCOPE,
        startedItem: grep.item,
      }),
    ).toMatchObject({itemType: 'commandExecution'});

    for (const command of [
      'grep -R identity .',
      'grep -f patterns.txt src/service.ts',
      'grep -n identity ../outside',
    ]) {
      const unsafeGrep = commandApproval(command, 'src/service.ts');
      expect(() =>
        approveCodeMemoryLinkAppServerRequest({
          method: 'item/commandExecution/requestApproval',
          params: unsafeGrep.params,
          scope: SCOPE,
          startedItem: unsafeGrep.item,
        }),
      ).toThrow();
    }

    for (const command of [
      "find . -maxdepth 3 -type f -name '*.ts' -print",
      'git status --short',
      'git rev-parse --show-toplevel',
      'git ls-files --cached -- src/service.ts',
      'git diff',
      'git diff --check',
      'git diff -- src/service.ts',
      'git diff --cached --no-ext-diff --no-renames --color=never -- src/service.ts',
    ]) {
      const git = commandApproval(command, 'src/service.ts');
      expect(
        approveCodeMemoryLinkAppServerRequest({
          method: 'item/commandExecution/requestApproval',
          params: git.params,
          scope: SCOPE,
          startedItem: git.item,
        }),
      ).toMatchObject({itemType: 'commandExecution'});
    }
  });

  it('evaluates forbidden control directories relative to the selected repository root', () => {
    const repositoryRoot = '/Users/test/.codex/worktrees/evaluation/repository';
    const scope = {...SCOPE, repositoryRoot};
    const safe = commandApproval("sed -n '1p' src/service.ts", 'src/service.ts', repositoryRoot);

    expect(
      approveCodeMemoryLinkAppServerRequest({
        method: 'item/commandExecution/requestApproval',
        params: safe.params,
        scope,
        startedItem: safe.item,
      }),
    ).toMatchObject({itemType: 'commandExecution'});

    const control = commandApproval("sed -n '1p' .git/config", '.git/config', repositoryRoot);
    expect(() =>
      approveCodeMemoryLinkAppServerRequest({
        method: 'item/commandExecution/requestApproval',
        params: control.params,
        scope,
        startedItem: control.item,
      }),
    ).toThrow('forbidden parent or control segment');
  });

  it('keeps generated bounded grep reads inside the selected repository', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9_]{1,24}$/u),
        fc.stringMatching(/^[A-Za-z0-9_-]{1,24}$/u),
        (pattern, stem) => {
          const path = `src/${stem}.ts`;
          const safe = commandApproval(`grep -n -F ${pattern} ${path}`, path);
          expect(
            approveCodeMemoryLinkAppServerRequest({
              method: 'item/commandExecution/requestApproval',
              params: safe.params,
              scope: SCOPE,
              startedItem: safe.item,
            }),
          ).toMatchObject({itemType: 'commandExecution'});

          const escaped = commandApproval(`grep -n -F ${pattern} ../${stem}.ts`, path);
          expect(() =>
            approveCodeMemoryLinkAppServerRequest({
              method: 'item/commandExecution/requestApproval',
              params: escaped.params,
              scope: SCOPE,
              startedItem: escaped.item,
            }),
          ).toThrow('forbidden parent or control segment');
        },
      ),
      {numRuns: 50},
    );
  });

  it('rejects grep operands whose repository symlink resolves outside the selected repository', () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), 'threadnote-grep-policy-repository-'));
    const externalRoot = mkdtempSync(join(tmpdir(), 'threadnote-grep-policy-external-'));
    try {
      const externalFile = join(externalRoot, 'private.txt');
      writeFileSync(externalFile, 'private evidence\n');
      symlinkSync(externalFile, join(repositoryRoot, 'linked.txt'));
      const linked = commandApproval('grep -n evidence linked.txt', 'linked.txt', repositoryRoot);

      expect(() =>
        approveCodeMemoryLinkAppServerRequest({
          method: 'item/commandExecution/requestApproval',
          params: linked.params,
          scope: {...SCOPE, repositoryRoot},
          startedItem: linked.item,
        }),
      ).toThrow('symlink target outside');
    } finally {
      rmSync(repositoryRoot, {force: true, recursive: true});
      rmSync(externalRoot, {force: true, recursive: true});
    }
  });

  it('accepts the pinned code-mode shell wrapper only when every projected command is a bounded read', () => {
    const projected = "pwd && sed -n '1,40p' src/service.ts";
    const command = `/bin/zsh -lc ${shellWord(projected)}`;
    const commandActions = [{command: projected, type: 'unknown'}];
    const item = {
      command,
      commandActions,
      cwd: ROOT,
      id: 'item_code_mode_command',
      source: 'agent',
      status: 'inProgress',
      type: 'commandExecution',
    };
    const params = {
      approvalId: null,
      availableDecisions: [
        'accept',
        {acceptWithExecpolicyAmendment: {execpolicy_amendment: ['pwd']}},
        'decline',
        'cancel',
      ],
      command,
      commandActions,
      cwd: ROOT,
      environmentId: 'local',
      itemId: item.id,
      networkApprovalContext: null,
      proposedExecpolicyAmendment: ['pwd'],
      proposedNetworkPolicyAmendments: null,
      reason: null,
      startedAtMs: 1,
      threadId: SCOPE.threadId,
      turnId: SCOPE.turnId,
    };

    expect(
      approveCodeMemoryLinkAppServerRequest({
        method: 'item/commandExecution/requestApproval',
        params,
        scope: SCOPE,
        startedItem: item,
      }),
    ).toMatchObject({itemType: 'commandExecution'});

    const escapedRegexProjected = 'rg -n "@overload|def application\\\\(" src tests | head -80';
    const escapedRegexCommand = `/bin/zsh -c "${escapedRegexProjected
      .replaceAll('\\\\', '\\\\\\\\')
      .replaceAll('"', '\\"')}"`;
    const escapedRegexActions = [
      {
        command: 'rg -n "@overload|def application\\\\(" src tests',
        path: `${ROOT}/src`,
        query: '@overload|def application\\(',
        type: 'search',
      },
    ];
    expect(
      approveCodeMemoryLinkAppServerRequest({
        method: 'item/commandExecution/requestApproval',
        params: {...params, command: escapedRegexCommand, commandActions: escapedRegexActions},
        scope: SCOPE,
        startedItem: {...item, command: escapedRegexCommand, commandActions: escapedRegexActions},
      }),
    ).toMatchObject({itemType: 'commandExecution'});

    for (const flag of ['-c', '-lc']) {
      const completedDisplayCommand = `${shellWord('/bin/zsh')} ${flag} ${shellWord(projected)}`;
      expect(
        approveCodeMemoryLinkAppServerRequest({
          method: 'item/commandExecution/requestApproval',
          params: {...params, command: completedDisplayCommand},
          scope: SCOPE,
          startedItem: {...item, command: completedDisplayCommand, source: 'unifiedExecStartup'},
        }),
      ).toMatchObject({itemType: 'commandExecution'});
    }

    const sequence = "pwd; sed -n '1,40p' src/service.ts";
    const sequenceCommand = `/bin/zsh -c ${shellWord(sequence)}`;
    const sequenceActions = [
      {command: 'pwd', type: 'read'},
      {command: "sed -n '1,40p' src/service.ts", path: `${ROOT}/src/service.ts`, type: 'read'},
    ];
    expect(
      approveCodeMemoryLinkAppServerRequest({
        method: 'item/commandExecution/requestApproval',
        params: {...params, command: sequenceCommand, commandActions: sequenceActions},
        scope: SCOPE,
        startedItem: {...item, command: sequenceCommand, commandActions: sequenceActions},
      }),
    ).toMatchObject({itemType: 'commandExecution'});

    const pipeline = 'rg -n service src | head -n 5';
    const pipelineCommand = `/bin/zsh -c ${shellWord(pipeline)}`;
    const pipelineActions = [
      {command: 'rg -n service src', path: `${ROOT}/src`, type: 'search'},
      {command: 'head -n 5', type: 'read'},
    ];
    expect(
      approveCodeMemoryLinkAppServerRequest({
        method: 'item/commandExecution/requestApproval',
        params: {...params, command: pipelineCommand, commandActions: pipelineActions},
        scope: SCOPE,
        startedItem: {...item, command: pipelineCommand, commandActions: pipelineActions},
      }),
    ).toMatchObject({itemType: 'commandExecution'});

    for (const unsafe of [
      'pwd || cat src/service.ts',
      'cat src/service.ts > result.json',
      'cat $(pwd)/src/service.ts',
      'rg -n "$HOME" src/service.ts',
      'sed -i 1d src/service.ts',
    ]) {
      const unsafeCommand = `/bin/zsh -lc ${shellWord(unsafe)}`;
      const unsafeActions = [{command: unsafe, type: 'unknown'}];
      expect(() =>
        approveCodeMemoryLinkAppServerRequest({
          method: 'item/commandExecution/requestApproval',
          params: {...params, command: unsafeCommand, commandActions: unsafeActions},
          scope: SCOPE,
          startedItem: {...item, command: unsafeCommand, commandActions: unsafeActions},
        }),
      ).toThrow();
    }
  });

  it('accepts only an exact task-scoped command token sequence', () => {
    const approved = [
      'PYTHONPATH=src',
      'pytest',
      '-q',
      'tests/test_markers.py',
      '-k',
      'test_marker_str_roundtrip_preserves_nested_group_precedence',
    ] as const;
    const policy = {approvedCommandTokens: [approved]};
    const exact = shellCommandApproval(approved.join(' '));

    expect(() =>
      approveCodeMemoryLinkAppServerRequest({
        method: 'item/commandExecution/requestApproval',
        params: exact.params,
        scope: SCOPE,
        startedItem: exact.item,
      }),
    ).toThrow('outside the reviewed read-only allowlist');
    expect(
      approveCodeMemoryLinkAppServerRequest(
        {
          method: 'item/commandExecution/requestApproval',
          params: exact.params,
          scope: SCOPE,
          startedItem: exact.item,
        },
        policy,
      ),
    ).toMatchObject({itemType: 'commandExecution'});

    fc.assert(
      fc.property(
        fc.integer({max: approved.length - 1, min: 0}),
        fc.constantFrom('PYTHONPATH=other', 'python', '--collect-only', 'tests/other.py', 'other_test'),
        (index, replacement) => {
          const mutated: string[] = [...approved];
          mutated[index] = replacement;
          const attempt = shellCommandApproval(mutated.join(' '));
          expect(() =>
            approveCodeMemoryLinkAppServerRequest(
              {
                method: 'item/commandExecution/requestApproval',
                params: attempt.params,
                scope: SCOPE,
                startedItem: attempt.item,
              },
              policy,
            ),
          ).toThrow();
        },
      ),
      {numRuns: 50},
    );

    for (const command of [
      `${approved.join(' ')} --collect-only`,
      `PYTHONPATH=other ${approved.slice(1).join(' ')}`,
      `PYTHONPATH=src pytest -q ../outside/test_markers.py -k ${approved.at(-1)}`,
      `${approved.join(' ')}; pwd`,
    ]) {
      const attempt = shellCommandApproval(command);
      expect(() =>
        approveCodeMemoryLinkAppServerRequest(
          {
            method: 'item/commandExecution/requestApproval',
            params: attempt.params,
            scope: SCOPE,
            startedItem: attempt.item,
          },
          policy,
        ),
      ).toThrow();
    }

    const repositoryRoot = '/private/tmp/matched-evaluation-codex-abc/repository';
    const duplicatedWorkingDirectory =
      '/private/tmp/matched-evaluation-codex-abc/matched-evaluation-codex-abc/repository';
    const rootBoundScope = {...SCOPE, repositoryRoot};
    const wrongCwd = shellCommandApproval(approved.join(' '), duplicatedWorkingDirectory);
    expect(() =>
      approveCodeMemoryLinkAppServerRequest(
        {
          method: 'item/commandExecution/requestApproval',
          params: wrongCwd.params,
          scope: rootBoundScope,
          startedItem: wrongCwd.item,
        },
        policy,
      ),
    ).toThrow('outside the public task repository');
  });

  it('rejects shell-control, expansion, unquoted glob, and mutating sed syntax before execution', () => {
    fc.assert(
      fc.property(fc.constantFrom(';', '|', '&', '$', '`', '>', '<', '*', '?', '[x]'), operator => {
        const command = `cat src/service.ts ${operator} private`;
        const {item, params} = commandApproval(command, 'src/service.ts');
        expect(() =>
          approveCodeMemoryLinkAppServerRequest({
            method: 'item/commandExecution/requestApproval',
            params,
            scope: SCOPE,
            startedItem: item,
          }),
        ).toThrow();
      }),
      {numRuns: 50},
    );
    for (const command of ["sed -n '1,20w /tmp/leak' src/service.ts", "sed -n '1e id' src/service.ts"]) {
      const {item, params} = commandApproval(command, 'src/service.ts');
      expect(() =>
        approveCodeMemoryLinkAppServerRequest({
          method: 'item/commandExecution/requestApproval',
          params,
          scope: SCOPE,
          startedItem: item,
        }),
      ).toThrow('numeric print range');
    }
  });

  it('rejects Git mutation, configuration overrides, and paths outside the public repository', () => {
    for (const command of [
      'git add src/service.ts',
      'git config core.pager cat',
      'git -c core.pager=cat status --short',
      'git diff HEAD -- src/service.ts',
      'git diff --ext-diff -- src/service.ts',
      'git diff -- ../private',
      'git ls-files --exclude-from=/tmp/patterns',
      'git ls-files -- ../private',
    ]) {
      const git = commandApproval(command, 'src/service.ts');
      expect(() =>
        approveCodeMemoryLinkAppServerRequest({
          method: 'item/commandExecution/requestApproval',
          params: git.params,
          scope: SCOPE,
          startedItem: git.item,
        }),
      ).toThrow();
    }
  });

  it('rejects find execution, mutation, writes, and paths outside the public repository', () => {
    for (const command of [
      'find . -exec cat src/service.ts',
      'find . -delete',
      'find . -fprint result.txt',
      'find ../private -type f',
      'find . -type s',
    ]) {
      const find = commandApproval(command, 'src/service.ts');
      expect(() =>
        approveCodeMemoryLinkAppServerRequest({
          method: 'item/commandExecution/requestApproval',
          params: find.params,
          scope: SCOPE,
          startedItem: find.item,
        }),
      ).toThrow();
    }
  });

  it('rejects persistent grants and paths outside the public repository', () => {
    const item = {
      changes: [{diff: '+safe', kind: {update: {movePath: null}}, path: `${ROOT}/result.json`}],
      id: 'item_change',
      status: 'inProgress',
      type: 'fileChange',
    };
    const params = {
      grantRoot: ROOT,
      itemId: item.id,
      reason: null,
      startedAtMs: 1,
      threadId: SCOPE.threadId,
      turnId: SCOPE.turnId,
    };
    expect(() =>
      approveCodeMemoryLinkAppServerRequest({
        method: 'item/fileChange/requestApproval',
        params,
        scope: SCOPE,
        startedItem: item,
      }),
    ).toThrow('persistent file-change grants');
    expect(() =>
      approveCodeMemoryLinkAppServerRequest({
        method: 'item/fileChange/requestApproval',
        params: {...params, grantRoot: null},
        scope: SCOPE,
        startedItem: {...item, changes: [{...item.changes[0], path: '/private/rubric.json'}]},
      }),
    ).toThrow('outside the public task repository');
  });

  it('accepts the current app-server file-change shape only for contained bounded changes', () => {
    const item = {
      changes: [
        {
          diff: '@@ -1 +1 @@\n-old\n+new\n',
          kind: {move_path: null, type: 'update'},
          path: `${ROOT}/src/service.ts`,
        },
      ],
      id: 'item_current_change',
      status: 'inProgress',
      type: 'fileChange',
    };
    const params = {
      grantRoot: null,
      itemId: item.id,
      reason: null,
      startedAtMs: 1,
      threadId: SCOPE.threadId,
      turnId: SCOPE.turnId,
    };

    expect(
      approveCodeMemoryLinkAppServerRequest({
        method: 'item/fileChange/requestApproval',
        params,
        scope: SCOPE,
        startedItem: item,
      }),
    ).toMatchObject({itemType: 'fileChange'});
    expect(() =>
      approveCodeMemoryLinkAppServerRequest({
        method: 'item/fileChange/requestApproval',
        params,
        scope: SCOPE,
        startedItem: {
          ...item,
          changes: [{...item.changes[0], kind: {move_path: '/private/escape', type: 'update'}}],
        },
      }),
    ).toThrow('outside the public task repository');
  });
});

function commandApproval(command: string, path: string, repositoryRoot = ROOT) {
  const commandActions = [{command, name: path.split('/').at(-1), path: `${repositoryRoot}/${path}`, type: 'read'}];
  const item = {
    command,
    commandActions,
    cwd: repositoryRoot,
    id: 'item_command',
    status: 'inProgress',
    type: 'commandExecution',
  };
  return {
    item,
    params: {
      approvalId: null,
      command,
      commandActions,
      cwd: repositoryRoot,
      environmentId: null,
      itemId: item.id,
      networkApprovalContext: null,
      proposedExecpolicyAmendment: null,
      proposedNetworkPolicyAmendments: null,
      reason: null,
      startedAtMs: 1,
      threadId: SCOPE.threadId,
      turnId: SCOPE.turnId,
    },
  };
}

function shellCommandApproval(projected: string, repositoryRoot = ROOT) {
  const command = `/bin/zsh -c ${shellWord(projected)}`;
  const commandActions = [{command: projected, type: 'unknown'}];
  const item = {
    command,
    commandActions,
    cwd: repositoryRoot,
    id: 'item_task_command',
    source: 'agent',
    status: 'inProgress',
    type: 'commandExecution',
  };
  return {
    item,
    params: {
      approvalId: null,
      availableDecisions: ['accept', 'cancel'],
      command,
      commandActions,
      cwd: repositoryRoot,
      environmentId: 'local',
      itemId: item.id,
      networkApprovalContext: null,
      proposedExecpolicyAmendment: null,
      proposedNetworkPolicyAmendments: null,
      reason: null,
      startedAtMs: 1,
      threadId: SCOPE.threadId,
      turnId: SCOPE.turnId,
    },
  };
}

function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
