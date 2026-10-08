import {describe, expect, it} from 'vitest';
import {inspectCliInvocation} from '@threadnote/threadnote/effect/cli';

describe('CLI production log policy', () => {
  it('uses the registered canonical command names and aliases', () => {
    expect(inspectCliInvocation(['init-manifest'])).toMatchObject({
      operation: 'init-manifest',
      writeProductionLog: true,
    });
    expect(inspectCliInvocation(['install-hooks', '--apply'])).toMatchObject({
      operation: 'install-hooks',
      writeProductionLog: true,
    });
    expect(inspectCliInvocation(['pre-compact-hook'])).toMatchObject({
      operation: 'pre-compact-hook',
      writeProductionLog: true,
    });
    expect(inspectCliInvocation(['session-start-hook'])).toMatchObject({
      operation: 'session-start-hook',
      writeProductionLog: true,
    });
    expect(inspectCliInvocation(['ls'])).toMatchObject({operation: 'list', writeProductionLog: true});
    expect(inspectCliInvocation(['closeout', 'apply', '--approved'])).toMatchObject({
      operation: 'closeout',
      writeProductionLog: true,
    });
    expect(inspectCliInvocation(['project', 'create', 'mobile'])).toMatchObject({
      operation: 'project',
      writeProductionLog: true,
    });
    expect(inspectCliInvocation(['project', 'update', 'mobile'])).toMatchObject({
      operation: 'project',
      writeProductionLog: true,
    });
  });

  it('does not log explicit or implicit preview operations', () => {
    expect(inspectCliInvocation(['setup', 'gemini-cli'])).toMatchObject({
      operation: 'setup',
      writeProductionLog: false,
    });
    expect(inspectCliInvocation(['setup', 'gemini-cli', '--apply'])).toMatchObject({
      operation: 'setup',
      writeProductionLog: true,
    });
    expect(inspectCliInvocation(['setup', 'gemini-cli', '--undo'])).toMatchObject({
      operation: 'setup',
      writeProductionLog: false,
    });
    expect(inspectCliInvocation(['setup', 'gemini-cli', '--undo', '--apply'])).toMatchObject({
      operation: 'setup',
      writeProductionLog: true,
    });
    for (const action of ['import', 'project', 'remove']) {
      expect(inspectCliInvocation(['guidance', action, 'codex-cli', '--project', 'threadnote'])).toMatchObject({
        operation: 'guidance',
        writeProductionLog: false,
      });
      expect(
        inspectCliInvocation(['guidance', action, 'codex-cli', '--project', 'threadnote', '--apply']),
      ).toMatchObject({
        operation: 'guidance',
        writeProductionLog: true,
      });
    }
    expect(inspectCliInvocation(['guidance', 'status', 'codex-cli', '--project', 'threadnote'])).toMatchObject({
      operation: 'guidance',
      writeProductionLog: false,
    });
    for (const action of ['install', 'repair', 'remove']) {
      expect(inspectCliInvocation(['agents', action, 'gemini-cli'])).toMatchObject({
        operation: 'agents',
        writeProductionLog: false,
      });
      expect(inspectCliInvocation(['agents', action, 'gemini-cli', '--apply'])).toMatchObject({
        operation: 'agents',
        writeProductionLog: true,
      });
    }
    expect(inspectCliInvocation(['agents', 'list', '--json'])).toMatchObject({
      operation: 'agents',
      writeProductionLog: false,
    });
    expect(inspectCliInvocation(['agents', 'status', '--json'])).toMatchObject({
      operation: 'agents',
      writeProductionLog: false,
    });
    expect(inspectCliInvocation(['value', 'report', '--json'])).toMatchObject({
      operation: 'value',
      writeProductionLog: false,
    });
    expect(inspectCliInvocation(['value', 'report', 'export'])).toMatchObject({
      operation: 'value',
      writeProductionLog: false,
    });
    expect(inspectCliInvocation(['value', 'report', 'export', '--apply'])).toMatchObject({
      operation: 'value',
      writeProductionLog: true,
    });
    expect(inspectCliInvocation(['remember', '--dry-run', '--text', 'preview'])).toMatchObject({
      operation: 'remember',
      writeProductionLog: false,
    });
    expect(inspectCliInvocation(['source', 'add', '--id', 'docs'])).toMatchObject({
      operation: 'source',
      writeProductionLog: false,
    });
    expect(inspectCliInvocation(['source', 'add', '--id', 'docs', '--apply'])).toMatchObject({
      operation: 'source',
      writeProductionLog: true,
    });
    expect(inspectCliInvocation(['report-issue', '--apply'])).toMatchObject({
      operation: 'report-issue',
      writeProductionLog: false,
    });
    for (const command of ['status', 'enable', 'disable']) {
      expect(inspectCliInvocation(['telemetry', command, '--apply'])).toMatchObject({
        operation: 'telemetry',
        writeProductionLog: false,
      });
    }
    expect(inspectCliInvocation(['migrate-memories'])).toMatchObject({
      operation: 'migrate-memories',
      writeProductionLog: true,
    });
    expect(inspectCliInvocation(['migrate-lifecycle'])).toMatchObject({
      operation: 'migrate-lifecycle',
      writeProductionLog: false,
    });
    expect(
      inspectCliInvocation(['init-manifest', '--replace', '--dry-run', '--repo', '/tmp/repository']),
    ).toMatchObject({
      operation: 'init-manifest',
      writeProductionLog: false,
    });
    for (const command of ['publish', 'publish-artifact', 'publish-bundle']) {
      expect(inspectCliInvocation(['share', command, '--preview'])).toMatchObject({
        operation: 'share',
        writeProductionLog: false,
      });
      expect(inspectCliInvocation(['share', command, '--preview=false'])).toMatchObject({
        operation: 'share',
        writeProductionLog: true,
      });
    }
  });

  it('uses effective boolean values for logging policy', () => {
    for (const falseValue of ['false', 'no', 'off', '0']) {
      expect(inspectCliInvocation(['remember', `--dry-run=${falseValue}`])).toMatchObject({
        writeProductionLog: true,
      });
      expect(inspectCliInvocation(['source', 'add', '--apply', falseValue])).toMatchObject({
        writeProductionLog: false,
      });
    }
    for (const trueValue of ['true', 'yes', 'on', '1']) {
      expect(inspectCliInvocation(['remember', '--dry-run', trueValue])).toMatchObject({
        writeProductionLog: false,
      });
      expect(inspectCliInvocation(['source', 'add', `--apply=${trueValue}`])).toMatchObject({
        writeProductionLog: true,
      });
    }
  });

  it('does not mistake dash-prefixed string values for policy flags', () => {
    expect(
      inspectCliInvocation([
        '--log-level',
        'info',
        '--home',
        '/tmp/threadnote-test',
        'remember',
        '--text',
        '--dry-run',
      ]),
    ).toEqual({
      homeOverride: '/tmp/threadnote-test',
      operation: 'remember',
      telemetryOperation: 'remember',
      writeAnonymousTelemetry: true,
      writeProductionLog: true,
    });
    expect(inspectCliInvocation(['remember', '--text', '--help'])).toMatchObject({
      operation: 'remember',
      writeProductionLog: true,
    });
  });

  it('covers preview and diagnostic commands after consent while excluding consent management', () => {
    expect(inspectCliInvocation(['remember', '--dry-run', '--text', 'preview'])).toMatchObject({
      writeAnonymousTelemetry: true,
    });
    expect(inspectCliInvocation(['processes'])).toMatchObject({writeAnonymousTelemetry: true});
    expect(inspectCliInvocation(['report-issue'])).toMatchObject({writeAnonymousTelemetry: true});
    expect(inspectCliInvocation(['telemetry', 'status'])).toMatchObject({writeAnonymousTelemetry: false});
    expect(inspectCliInvocation(['image-projection', '--enable'])).toMatchObject({
      operation: 'image-projection',
      writeAnonymousTelemetry: true,
      writeProductionLog: false,
    });
    expect(inspectCliInvocation(['jev', 'status', '--json'])).toEqual({
      operation: 'jev',
      telemetryOperation: 'jev.status',
      writeAnonymousTelemetry: true,
      writeProductionLog: false,
    });
    expect(inspectCliInvocation(['slack', 'probe', '--input', '/private/pilot.json'])).toMatchObject({
      operation: 'slack',
      writeProductionLog: false,
    });
  });

  it('derives anonymous graph operations only from registered command words', () => {
    expect(inspectCliInvocation(['graph', 'index', '/private/repository'])).toMatchObject({
      operation: 'graph',
      telemetryOperation: 'graph.index',
    });
    expect(
      inspectCliInvocation([
        'graph',
        'query',
        '--query',
        'private symbol and customer text',
        '/private/repository/src/secret.ts',
      ]),
    ).toMatchObject({
      operation: 'graph',
      telemetryOperation: 'graph.query',
    });
    expect(inspectCliInvocation(['graph', 'query', 'private positional query text'])).toMatchObject({
      operation: 'graph',
      telemetryOperation: 'graph.query',
    });
  });

  it('recognizes nested share conflict resolution without including its identifier', () => {
    expect(inspectCliInvocation(['share', 'conflict', 'resolve', 'threadnote://team/private-memory'])).toMatchObject({
      operation: 'share',
      telemetryOperation: 'share.conflict.resolve',
    });
  });

  it('distinguishes the closed Cursor attestation operation without including challenge data', () => {
    expect(inspectCliInvocation(['cloud', 'cursor', 'attest', '--challenge', 'private-challenge'])).toMatchObject({
      operation: 'cloud',
      telemetryOperation: 'cloud.cursor.attest',
    });
  });

  it('falls back to closed operations for unregistered command words', () => {
    expect(inspectCliInvocation(['share', 'private-subcommand', 'customer-value'])).toMatchObject({
      operation: 'share',
      telemetryOperation: 'share',
    });
    expect(inspectCliInvocation(['private-command', 'customer-value'])).toMatchObject({
      operation: 'unknown',
      telemetryOperation: 'unknown',
    });
  });
});
