import {existsSync, mkdtempSync, rmSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {inspectMcpServerInvocation} from '@threadnote/threadnote/mcp/launcher';

describe('MCP launcher invocation', () => {
  it('recognizes the command after a home override', () => {
    expect(inspectMcpServerInvocation(['--home', '/isolated', 'mcp-server'], 'threadnote')).toEqual({
      selected: true,
      help: false,
    });
    expect(inspectMcpServerInvocation(['--home=/isolated', 'mcp-server', '-h'], 'threadnote')).toEqual({
      selected: true,
      help: true,
    });
  });

  it('does not select an MCP route from another command or an option value', () => {
    for (const args of [
      ['--home', 'mcp-server', 'doctor'],
      ['remember', 'mcp-server'],
      ['--unknown', 'mcp-server'],
    ]) {
      expect(inspectMcpServerInvocation(args, 'threadnote').selected).toBe(false);
    }
  });

  it('supports dedicated launcher help while keeping home values opaque', () => {
    expect(inspectMcpServerInvocation(['--help'], 'threadnote-mcp-server.exe')).toEqual({
      selected: true,
      help: true,
    });
    expect(inspectMcpServerInvocation(['mcp-server', '--home', '--help'], 'threadnote')).toEqual({
      selected: true,
      help: false,
    });
  });

  it('preserves routing and help across home placement and spelling without mutating argv', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string({minLength: 1, maxLength: 80}), fc.constantFrom('mcp-server', '--help', '-h')),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (home, inline, beforeCommand, help) => {
          const flag = inline ? [`--home=${home}`] : ['--home', home];
          const args = beforeCommand ? [...flag, 'mcp-server'] : ['mcp-server', ...flag];
          if (help) args.push('--help');
          const original = [...args];
          expect(inspectMcpServerInvocation(args, 'threadnote')).toEqual({selected: true, help});
          expect(args).toEqual(original);
        },
      ),
      {numRuns: 64},
    );
  });

  it.each(['mcp-server', 'mcp-broker'])(
    '%s prints help and exits without starting the adapter or creating a data home',
    async route => {
      const fixture = mkdtempSync(join(tmpdir(), 'threadnote-mcp-help-'));
      const home = join(fixture, 'home');
      const args = route === 'mcp-server' ? ['--home', home, route, '--help'] : [route, '--home', home, '--help'];
      const child = Bun.spawn([process.execPath, 'apps/threadnote/src/standalone.ts', ...args], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(code).toBe(0);
        expect(stdout).toContain('Usage: threadnote [--home PATH] mcp-server [--help]');
        expect(stdout).toContain('THREADNOTE_MANIFEST');
        expect(stdout).toContain('THREADNOTE_MCP_TOOLSET');
        expect(stderr).not.toContain('MCP adapter running');
        expect(existsSync(home)).toBe(false);
      } finally {
        child.kill();
        rmSync(fixture, {recursive: true, force: true});
      }
    },
  );
});
