#!/usr/bin/env bun

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createInterface} from 'node:readline';

if (process.argv[2] === '--version') {
  process.stdout.write('codex-cli matched-evaluation-test-v1\n');
  process.exit(0);
}
if (process.argv[2] !== 'app-server') {
  process.stderr.write('expected app-server\n');
  process.exit(2);
}

const scratchDirectory = process.env.TMPDIR;
const codexHome = process.env.CODEX_HOME;
if (scratchDirectory === undefined || codexHome === undefined) {
  process.stderr.write('expected isolated TMPDIR and CODEX_HOME\n');
  process.exit(2);
}
const codexConfig = readFileSync(join(codexHome, 'config.toml'), 'utf8');
if (!codexConfig.includes(`TMPDIR = ${JSON.stringify(scratchDirectory)}`)) {
  process.stderr.write('expected isolated TMPDIR in shell environment policy\n');
  process.exit(2);
}

const lines = createInterface({input: process.stdin});
let turnIndex = 0;
let pendingApproval:
  | {
      readonly final: Record<string, unknown>;
      readonly fileItem: Record<string, unknown>;
      readonly requestId: number;
      readonly stage: 'command' | 'file';
      readonly threadId: string;
      readonly turnId: string;
    }
  | undefined;

lines.on('line', line => {
  const request = JSON.parse(line) as {id?: number; method?: string; params?: Record<string, unknown>};
  if (pendingApproval && request.id === pendingApproval.requestId && request.method === undefined) {
    const decision = (request as {result?: {decision?: string}}).result?.decision;
    if (decision !== 'accept') {
      respondError(request.id, -32_000, 'fake approval was not accepted');
      return;
    }
    if (pendingApproval.stage === 'command') {
      const commandItem = approvalCommandItem(pendingApproval.threadId, pendingApproval.turnId).item;
      notify('item/completed', {
        item: {
          ...commandItem,
          aggregatedOutput: 'export const value = 1;\n',
          durationMs: 1,
          exitCode: 0,
          status: 'completed',
        },
        threadId: pendingApproval.threadId,
        turnId: pendingApproval.turnId,
      });
      notify('item/started', {
        item: pendingApproval.fileItem,
        threadId: pendingApproval.threadId,
        turnId: pendingApproval.turnId,
      });
      const requestId = pendingApproval.requestId + 1;
      sendRequest(requestId, 'item/fileChange/requestApproval', {
        grantRoot: null,
        itemId: pendingApproval.fileItem.id,
        reason: null,
        startedAtMs: 2,
        threadId: pendingApproval.threadId,
        turnId: pendingApproval.turnId,
      });
      pendingApproval = {...pendingApproval, requestId, stage: 'file'};
      return;
    }
    notify('item/completed', {
      item: {...pendingApproval.fileItem, status: 'completed'},
      threadId: pendingApproval.threadId,
      turnId: pendingApproval.turnId,
    });
    finishTurn(pendingApproval.threadId, pendingApproval.turnId, pendingApproval.final);
    pendingApproval = undefined;
    return;
  }
  if (request.method === 'initialized') return;
  if (request.method === 'initialize') {
    respond(request.id, {serverInfo: {name: 'fake-matched-evaluation-app-server', version: 'test-v1'}});
    return;
  }
  if (request.method === 'thread/start') {
    const params = request.params ?? {};
    const threadId = `thr_matched_${turnIndex}`;
    respond(request.id, {
      approvalPolicy: params.approvalPolicy,
      approvalsReviewer: params.approvalsReviewer,
      cwd: params.cwd,
      instructionSources: [],
      model: params.model,
      modelProvider: params.modelProvider,
      reasoningEffort: 'medium',
      runtimeWorkspaceRoots: params.runtimeWorkspaceRoots,
      sandbox: {networkAccess: false, type: params.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite'},
      thread: {id: threadId},
    });
    notify('thread/started', {thread: {id: threadId}});
    if (process.argv.includes('--failed-context')) {
      notify('mcpServer/startupStatus/updated', {threadId, name: 'matched_evaluation_context', status: 'ready'});
    }
    return;
  }
  if (request.method === 'mcpServerStatus/list') {
    respond(request.id, {
      data: [
        {
          name: 'matched_evaluation_context',
          tools: {context_brief: {name: 'context_brief'}},
          resources: [],
          resourceTemplates: [],
        },
      ],
      nextCursor: null,
    });
    return;
  }
  if (request.method === 'turn/start') {
    const params = request.params ?? {};
    const sandboxPolicy = params.sandboxPolicy as Record<string, unknown> | undefined;
    const workspaceRoots = params.runtimeWorkspaceRoots as readonly unknown[] | undefined;
    if (
      JSON.stringify(workspaceRoots) !== JSON.stringify([params.cwd, scratchDirectory]) ||
      sandboxPolicy === undefined ||
      sandboxPolicy.excludeSlashTmp !== true ||
      sandboxPolicy.excludeTmpdirEnvVar !== false ||
      sandboxPolicy.networkAccess !== false ||
      sandboxPolicy.type !== 'workspaceWrite' ||
      JSON.stringify(sandboxPolicy.writableRoots) !== JSON.stringify([params.cwd, scratchDirectory])
    ) {
      respondError(request.id, -32_000, 'expected repository plus isolated writable scratch sandbox');
      return;
    }
    const threadId = String(params.threadId);
    const turnId = `turn_matched_${turnIndex++}`;
    const schema = params.outputSchema as {properties?: Record<string, unknown>} | undefined;
    const judge = schema?.properties !== undefined && 'scoreMilli' in schema.properties;
    const taskFailure = judge && JSON.stringify(params.input).includes('provider-token-budget');
    const final = judge
      ? {
          authorizationLeaks: 0,
          citations: [],
          completed: !taskFailure,
          failureReasons: taskFailure ? ['fixture task-quality failure'] : [],
          falseCurrentOutcomes: taskFailure ? 1 : 0,
          harmfulActions: 0,
          recalledEvidenceIds: [],
          scoreMilli: taskFailure ? 620 : 1_000,
          supportedEvidenceIds: [],
        }
      : {citations: [], completed: true, summary: 'completed by fake app-server'};
    const usage = judge
      ? {cachedInputTokens: 5, inputTokens: 50, outputTokens: 25, reasoningOutputTokens: 10, totalTokens: 75}
      : {cachedInputTokens: 10, inputTokens: 100, outputTokens: 50, reasoningOutputTokens: 20, totalTokens: 150};
    respond(request.id, {turn: {error: null, id: turnId, items: [], status: 'inProgress'}});
    notify('turn/started', {threadId, turn: {error: null, id: turnId, items: [], status: 'inProgress'}});
    const initialUsage = judge
      ? {cachedInputTokens: 2, inputTokens: 20, outputTokens: 10, reasoningOutputTokens: 4, totalTokens: 30}
      : {cachedInputTokens: 4, inputTokens: 40, outputTokens: 20, reasoningOutputTokens: 8, totalTokens: 60};
    notify('thread/tokenUsage/updated', {
      threadId,
      tokenUsage: {
        last: initialUsage,
        modelContextWindow: 200_000,
        total: initialUsage,
      },
      turnId,
    });
    notify('thread/tokenUsage/updated', {
      threadId,
      tokenUsage: {last: usage, modelContextWindow: 200_000, total: usage},
      turnId,
    });
    if (!judge && process.argv.includes('--exercise-approvals')) {
      const approval = approvalCommandItem(threadId, turnId);
      const fileItem = {
        changes: [
          {
            diff: '@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n',
            kind: {move_path: null, type: 'update'},
            path: `${String(params.cwd)}/service.ts`,
          },
        ],
        id: `file_matched_${turnIndex}`,
        status: 'inProgress',
        type: 'fileChange',
      };
      notify('item/started', {item: approval.item, threadId, turnId});
      const requestId = 10_000 + turnIndex * 2;
      if (process.argv.includes('--exercise-auto-approval')) {
        const action = {command: approval.item.command, cwd: approval.item.cwd, source: 'unifiedExec', type: 'command'};
        const review = {
          action,
          reviewId: `review_matched_${turnIndex}`,
          startedAtMs: 1,
          targetItemId: approval.item.id,
          threadId,
          turnId,
        };
        notify('item/autoApprovalReview/started', {
          ...review,
          review: {rationale: null, riskLevel: null, status: 'inProgress', userAuthorization: null},
        });
        notify('item/autoApprovalReview/completed', {
          ...review,
          completedAtMs: 2,
          decisionSource: 'agent',
          review: {rationale: 'sealed task command', riskLevel: 'low', status: 'approved', userAuthorization: 'low'},
        });
        notify('item/completed', {
          item: {
            ...approval.item,
            aggregatedOutput: 'true (fixture)\n',
            durationMs: 1,
            exitCode: 0,
            status: 'completed',
          },
          threadId,
          turnId,
        });
        notify('item/started', {item: fileItem, threadId, turnId});
        sendRequest(requestId, 'item/fileChange/requestApproval', {
          grantRoot: null,
          itemId: fileItem.id,
          reason: null,
          startedAtMs: 2,
          threadId,
          turnId,
        });
        pendingApproval = {fileItem, final, requestId, stage: 'file', threadId, turnId};
        return;
      }
      sendRequest(requestId, 'item/commandExecution/requestApproval', approval.params);
      pendingApproval = {fileItem, final, requestId, stage: 'command', threadId, turnId};
      return;
    }
    if (!judge && process.argv.includes('--failed-context')) {
      const failed = {
        id: 'context_failed',
        type: 'mcpToolCall',
        server: 'matched_evaluation_context',
        tool: 'context_brief',
        status: 'failed',
        error: null,
        result: {
          isError: true,
          content: [{type: 'text', text: 'Context request task differs from the sealed task prompt.'}],
        },
      };
      notify('item/started', {item: {...failed, status: 'inProgress', result: null}, threadId, turnId});
      notify('item/completed', {item: failed, threadId, turnId});
    }
    finishTurn(threadId, turnId, final);
    return;
  }
  respondError(request.id, -32_601, 'unsupported fake request');
});

function approvalCommandItem(threadId: string, turnId: string) {
  const projected = process.argv.includes('--exercise-task-command')
    ? 'PYTHONPATH=src true --version'
    : "sed -n '1p' service.ts";
  const command = `/bin/zsh -c "${projected}"`;
  const commandActions = process.argv.includes('--exercise-task-command')
    ? [{command: projected, type: 'unknown'}]
    : [{command: projected, name: 'service.ts', path: `${process.cwd()}/service.ts`, type: 'read'}];
  const item = {
    aggregatedOutput: null,
    command,
    commandActions,
    cwd: process.cwd(),
    durationMs: null,
    exitCode: null,
    id: `command_matched_${turnIndex}`,
    processId: null,
    source: 'agent',
    status: 'inProgress',
    type: 'commandExecution',
  };
  return {
    item,
    params: {
      additionalPermissions: null,
      approvalId: null,
      availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
      command,
      commandActions,
      cwd: process.cwd(),
      environmentId: 'local',
      itemId: item.id,
      networkApprovalContext: null,
      proposedExecpolicyAmendment: ['/bin/zsh'],
      proposedNetworkPolicyAmendments: null,
      reason: null,
      startedAtMs: 1,
      threadId,
      turnId,
    },
  };
}

function finishTurn(threadId: string, turnId: string, final: Record<string, unknown>): void {
  const item = {
    id: `item_matched_${turnIndex}`,
    phase: 'final_answer',
    text: JSON.stringify(final),
    type: 'agentMessage',
  };
  notify('item/started', {item, threadId, turnId});
  notify('item/completed', {item, threadId, turnId});
  notify('turn/completed', {threadId, turn: {error: null, id: turnId, items: [], status: 'completed'}});
}

function notify(method: string, params: unknown): void {
  process.stdout.write(`${JSON.stringify({method, params})}\n`);
}

function sendRequest(id: number, method: string, params: unknown): void {
  process.stdout.write(`${JSON.stringify({id, method, params})}\n`);
}

function respond(id: number | undefined, result: unknown): void {
  process.stdout.write(`${JSON.stringify({id, result})}\n`);
}

function respondError(id: number | undefined, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({error: {code, message}, id})}\n`);
}
