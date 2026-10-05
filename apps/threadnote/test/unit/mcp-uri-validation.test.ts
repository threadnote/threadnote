import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {optionalResourceUri} from '@threadnote/threadnote/mcp/server/common';

describe('MCP optional resource URI validation', () => {
  it('names replaceUri when rejecting a compact write reference', () => {
    const result = optionalResourceUri('memories/handoffs/active/example/status.md', 'remember_context', 'replaceUri');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.isError).toBe(true);
      expect(JSON.stringify(result.error.content)).toContain('optional \\"replaceUri\\"');
      expect(JSON.stringify(result.error.content)).toContain('must be a threadnote:// URI');
    }
  });

  it('retains the default uri field label for existing callers', () => {
    const result = optionalResourceUri('memories/example.md', 'finalize_code_refs');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(JSON.stringify(result.error.content)).toContain('optional \\"uri\\"');
  });

  it('keeps omitted optional values absent', () => {
    for (const value of [undefined, '', ' \t\n']) {
      expect(optionalResourceUri(value, 'remember_context', 'replaceUri')).toEqual({ok: true, value: undefined});
    }
  });

  it('preserves strict URI authority independently of the diagnostic field', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z][a-z0-9-]{0,12}$/u),
        fc.constantFrom('uri', 'replaceUri'),
        fc.constantFrom('', ' ', '\t'),
        (suffix, field, whitespace) => {
          const compact = `memories/handoffs/active/example/status-${suffix}.md`;
          const uri = `threadnote://user/tester/${compact}`;
          expect(optionalResourceUri(`${whitespace}${uri}${whitespace}`, 'remember_context', field)).toEqual({
            ok: true,
            value: uri,
          });
          const result = optionalResourceUri(`${whitespace}${compact}${whitespace}`, 'remember_context', field);
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.error.isError).toBe(true);
        },
      ),
      {numRuns: 40},
    );
  });
});
