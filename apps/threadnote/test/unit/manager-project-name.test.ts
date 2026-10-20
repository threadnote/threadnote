import {describe, expect, it} from 'vitest';
import {isManagerProjectName} from '../../src/manager/project/name.js';

describe('Manager project display names', () => {
  it.each(['Example Project', 'Example  Project', 'repo.name-1_', 'A', 'A'.repeat(128), `${'A'.repeat(126)} B`])(
    'accepts %s without changing its identity',
    project => expect(isManagerProjectName(project)).toBe(true),
  );

  it.each([
    '',
    ' ',
    ' Example',
    'Example ',
    '../outside',
    'a/b',
    'a\\b',
    'a\tb',
    'a\nb',
    'a\0b',
    'a\u007fb',
    '-project',
    '.project',
    'a%20b',
    'A'.repeat(129),
  ])('rejects unsafe or out-of-bounds input %j', project => expect(isManagerProjectName(project)).toBe(false));
});
