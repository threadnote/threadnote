import {describe, expect, it} from 'vitest';
import {obsidianOpenUri} from '../src/open.js';

describe('Obsidian navigation', () => {
  it('percent-encodes absolute note paths for the official URI contract', () => {
    expect(obsidianOpenUri('/Vault name/Threadnote/Auth #1.md')).toBe(
      'obsidian://open?path=%2FVault%20name%2FThreadnote%2FAuth%20%231.md',
    );
    expect(obsidianOpenUri('C:\\Vault name\\Threadnote\\Auth #1.md')).toBe(
      'obsidian://open?path=C%3A%5CVault%20name%5CThreadnote%5CAuth%20%231.md',
    );
  });
});
