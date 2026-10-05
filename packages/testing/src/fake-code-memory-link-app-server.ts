#!/usr/bin/env bun

import {createInterface} from 'node:readline';

if (process.argv[2] === '--version') {
  process.stdout.write('codex-cli 0.149.0-alpha.4.1\n');
  process.exit(0);
}
if (process.argv[2] !== 'app-server') {
  process.stderr.write('expected app-server\n');
  process.exit(2);
}

const lines = createInterface({input: process.stdin});
const threadId = 'thr_transport_canary';
const turnId = 'turn_transport_canary';
const preflightViolation = process.env.THREADNOTE_TEST_PREFLIGHT_VIOLATION;
let pendingTurnParams: Record<string, unknown> | undefined;

lines.on('line', line => {
  const request = JSON.parse(line) as {
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
    result?: {decision?: string};
  };
  if (request.id === 899 && request.method === undefined) {
    if (request.result?.decision !== 'decline' || !pendingTurnParams) {
      process.stderr.write('expected denied command cancellation\n');
      process.exit(9);
    }
    emitDeclinedCommandAndRecovery(pendingTurnParams);
    return;
  }
  if (request.id === 900 && request.method === undefined) {
    if (request.result?.decision !== 'accept' || !pendingTurnParams) {
      process.stderr.write('expected reviewed command approval\n');
      process.exit(3);
    }
    emitApprovedTurn(pendingTurnParams);
    pendingTurnParams = undefined;
    return;
  }
  if (request.method === 'initialized') return;
  if (request.method === 'initialize') {
    respond(request.id, {serverInfo: {name: 'fake-codex-app-server', version: '0.149.0-alpha.4.1'}});
    return;
  }
  if (request.method === 'thread/start') {
    const params = request.params ?? {};
    if ('baseInstructions' in params || typeof params.developerInstructions !== 'string') {
      process.stderr.write('expected native base instructions plus sealed developer instructions\n');
      process.exit(6);
    }
    assertLocalEnvironment(params);
    notify('remoteControl/status/changed', {
      environmentId: null,
      installationId: 'fake-installation',
      serverName: 'fake-codex-app-server',
      status: 'disabled',
    });
    respond(request.id, {
      approvalPolicy: preflightViolation === 'wrong-approval' ? 'never' : params.approvalPolicy,
      approvalsReviewer: 'user',
      cwd: preflightViolation === 'wrong-cwd' ? '/private/foreign-repository' : params.cwd,
      instructionSources: preflightViolation === 'instruction-source' ? ['/private/AGENTS.md'] : [],
      model: params.model,
      modelProvider: params.modelProvider,
      reasoningEffort: 'medium',
      runtimeWorkspaceRoots: [params.cwd],
      sandbox: {
        networkAccess: preflightViolation === 'network-enabled',
        type: preflightViolation === 'read-only-sandbox' ? 'readOnly' : 'workspaceWrite',
      },
      serviceTier: null,
      thread: {id: threadId},
    });
    notify('thread/started', {thread: {id: threadId}});
    notify('mcpServer/startupStatus/updated', {name: 'context_brief_gate', status: 'ready', threadId});
    return;
  }
  if (request.method === 'mcpServerStatus/list') {
    const tools = {
      context_brief: {
        inputSchema: {type: 'object'},
        name: preflightViolation === 'rerouted-tool' ? 'recall_context' : 'context_brief',
      },
      ...(preflightViolation === 'extra-tool'
        ? {recall_context: {inputSchema: {type: 'object'}, name: 'recall_context'}}
        : {}),
    };
    const server = {
      authStatus: 'unsupported',
      name: preflightViolation === 'unexpected-server' ? 'threadnote' : 'context_brief_gate',
      resourceTemplates: [],
      resources: [],
      tools,
    };
    respond(request.id, {
      data: preflightViolation === 'extra-server' ? [server, {...server, name: 'unexpected_extra_server'}] : [server],
      nextCursor: null,
    });
    return;
  }
  if (request.method === 'turn/start') {
    if (preflightViolation) {
      process.stderr.write(`preflight violation reached turn/start: ${preflightViolation}\n`);
      process.exit(7);
    }
    assertLocalEnvironment(request.params ?? {});
    emitTurn(request.id, request.params ?? {});
    return;
  }
  respondError(request.id, -32_601, 'unsupported fake request');
});

function assertLocalEnvironment(params: Record<string, unknown>): void {
  const expected = [{cwd: params.cwd, environmentId: 'local', runtimeWorkspaceRoots: [params.cwd]}];
  if (JSON.stringify(params.environments) !== JSON.stringify(expected)) {
    process.stderr.write('expected one explicit local execution environment\n');
    process.exit(8);
  }
}

function emitTurn(responseId: number | undefined, params: Record<string, unknown>): void {
  pendingTurnParams = params;
  const deniedCommand = process.env.THREADNOTE_TEST_RECOVER_FROM_DENIED_COMMAND === '1';
  const command = deniedCommand
    ? {
        command: "/bin/zsh -lc 'printf x > src/service.ts'",
        commandActions: [{command: 'printf x > src/service.ts', type: 'unknown'}],
        cwd: params.cwd,
        id: 'item_denied_command',
        source: 'agent',
        status: 'inProgress',
        type: 'commandExecution',
      }
    : reviewedCommand(params);
  const response = {
    id: responseId,
    result: {
      turn: {
        error: null,
        id: process.env.THREADNOTE_TEST_MALFORMED_TURN_RESPONSE === '1' ? null : turnId,
        items: [],
        status: 'inProgress',
      },
    },
  };
  const events: Record<string, unknown>[] = [
    turnSettings(params),
    {
      method: 'turn/started',
      params: {threadId, turn: {error: null, id: turnId, items: [], status: 'inProgress'}},
    },
    {method: 'item/started', params: {item: command, threadId, turnId}},
  ];
  if (process.env.THREADNOTE_TEST_AUTO_APPROVAL_REVIEW === '1' && !deniedCommand) {
    events.push(...autoApprovalReview(command));
  } else events.push(approvalRequest(deniedCommand ? 899 : 900, command));
  writeMessages(
    process.env.THREADNOTE_TEST_APPROVAL_BEFORE_RESPONSE === '1' ? [...events, response] : [response, ...events],
  );
  if (process.env.THREADNOTE_TEST_AUTO_APPROVAL_REVIEW === '1' && !deniedCommand) {
    emitApprovedTurn(params, false);
    pendingTurnParams = undefined;
  }
}

function reviewedCommand(params: Record<string, unknown>): Record<string, unknown> {
  return {
    command: 'cat src/service.ts',
    commandActions: [
      {
        command: 'cat src/service.ts',
        name: 'service.ts',
        path: `${String(params.cwd)}/src/service.ts`,
        type: 'read',
      },
    ],
    cwd: params.cwd,
    id: 'item_reviewed_command',
    status: 'inProgress',
    type: 'commandExecution',
  };
}

function turnSettings(params: Record<string, unknown>): Record<string, unknown> {
  return {
    method: 'thread/settings/updated',
    params: {
      threadId,
      threadSettings: {
        activePermissionProfile: null,
        approvalPolicy: 'untrusted',
        approvalsReviewer: 'user',
        cwd: params.cwd,
        sandboxPolicy: {
          excludeSlashTmp: true,
          excludeTmpdirEnvVar: true,
          networkAccess: false,
          type: 'workspaceWrite',
          writableRoots: [],
        },
      },
    },
  };
}

function approvalRequest(id: number, command: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    method: 'item/commandExecution/requestApproval',
    params: {
      approvalId: null,
      command: command.command,
      commandActions: command.commandActions,
      cwd: command.cwd,
      environmentId: null,
      itemId: command.id,
      networkApprovalContext: null,
      proposedExecpolicyAmendment: null,
      proposedNetworkPolicyAmendments: null,
      reason: 'Inspect the public fixture source.',
      startedAtMs: 1,
      threadId,
      turnId,
    },
  };
}

function emitDeclinedCommandAndRecovery(params: Record<string, unknown>): void {
  notify('serverRequest/resolved', {requestId: 899, threadId});
  notify('item/completed', {
    item: {
      command: "/bin/zsh -lc 'printf x > src/service.ts'",
      commandActions: [{command: 'printf x > src/service.ts', type: 'unknown'}],
      cwd: params.cwd,
      id: 'item_denied_command',
      source: 'agent',
      status: 'declined',
      type: 'commandExecution',
    },
    threadId,
    turnId,
  });
  const command = reviewedCommand(params);
  writeMessages([{method: 'item/started', params: {item: command, threadId, turnId}}, approvalRequest(900, command)]);
}

function autoApprovalReview(command: Record<string, unknown>): readonly Record<string, unknown>[] {
  const action = {command: command.command, cwd: command.cwd, source: 'unifiedExec', type: 'command'};
  const common = {
    action,
    reviewId: 'review_auto_approved_command',
    startedAtMs: 1,
    targetItemId: command.id,
    threadId,
    turnId,
  };
  return [
    {
      method: 'item/autoApprovalReview/started',
      params: {
        ...common,
        review: {rationale: null, riskLevel: null, status: 'inProgress', userAuthorization: null},
      },
    },
    {
      method: 'item/autoApprovalReview/completed',
      params: {
        ...common,
        completedAtMs: 2,
        decisionSource: 'agent',
        review: {
          rationale: 'read-only fixture command',
          riskLevel: 'low',
          status: 'approved',
          userAuthorization: 'low',
        },
      },
    },
  ];
}

function emitApprovedTurn(params: Record<string, unknown>, manualApproval = true): void {
  const completedActionViolation = process.env.THREADNOTE_TEST_COMPLETED_ACTION_VIOLATION === '1';
  if (manualApproval) notify('serverRequest/resolved', {requestId: 900, threadId});
  notify('item/completed', {
    item: {
      command: completedActionViolation ? 'rm -f src/service.ts' : 'cat src/service.ts',
      commandActions: completedActionViolation
        ? [{command: 'rm -f src/service.ts', type: 'unknown'}]
        : [
            {
              command: 'cat src/service.ts',
              name: 'service.ts',
              path: `${String(params.cwd)}/src/service.ts`,
              type: 'read',
            },
          ],
      cwd: params.cwd,
      id: 'item_reviewed_command',
      status: 'completed',
      type: 'commandExecution',
    },
    threadId,
    turnId,
  });
  const tool = {
    arguments: {callerCwd: params.cwd, codeRefs: ['src/service.ts'], task: 'task'},
    error: null,
    id: 'item_context_brief',
    result: null,
    server: 'context_brief_gate',
    status: 'inProgress',
    tool: 'context_brief',
    type: 'mcpToolCall',
  };
  notify('item/started', {item: tool, threadId, turnId});
  notify('item/completed', {
    item: {
      ...tool,
      result: {
        content: [{text: 'context', type: 'text'}],
        structuredContent: {activeHandoffs: [], durableDecisions: [], type: 'context-brief', version: 3},
      },
      status: 'completed',
    },
    threadId,
    turnId,
  });
  notify('thread/tokenUsage/updated', {
    threadId,
    tokenUsage: {
      last: {cachedInputTokens: 0, inputTokens: 70, outputTokens: 30, reasoningOutputTokens: 10, totalTokens: 100},
      modelContextWindow: 200_000,
      total: {cachedInputTokens: 0, inputTokens: 70, outputTokens: 30, reasoningOutputTokens: 10, totalTokens: 100},
    },
    turnId,
  });
  const message = {id: 'item_agent_message', phase: 'final_answer', text: '{"status":"done"}', type: 'agentMessage'};
  notify('item/started', {item: message, threadId, turnId});
  notify('item/completed', {
    item: message,
    threadId,
    turnId,
  });
  notify('thread/tokenUsage/updated', {
    threadId,
    tokenUsage: {
      last: {cachedInputTokens: 0, inputTokens: 90, outputTokens: 60, reasoningOutputTokens: 20, totalTokens: 150},
      modelContextWindow: 200_000,
      total: {cachedInputTokens: 0, inputTokens: 90, outputTokens: 60, reasoningOutputTokens: 20, totalTokens: 150},
    },
    turnId,
  });
  notify('turn/completed', {
    threadId,
    turn: {error: null, id: turnId, items: [], status: 'completed'},
  });
}

function notify(method: string, params: unknown): void {
  process.stdout.write(`${JSON.stringify({method, params})}\n`);
}

function writeMessages(messages: readonly Record<string, unknown>[]): void {
  process.stdout.write(`${messages.map(message => JSON.stringify(message)).join('\n')}\n`);
}

function respond(id: number | undefined, result: unknown): void {
  process.stdout.write(`${JSON.stringify({id, result})}\n`);
}

function respondError(id: number | undefined, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({error: {code, message}, id})}\n`);
}
