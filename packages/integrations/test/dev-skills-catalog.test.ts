import {describe, expect, it} from 'vitest';
import {AGENT_CATALOG, validateAgentCatalog} from '../src/catalog.js';

describe('development skill catalog', () => {
  it('declares every managed native surface independently of MCP and personal bootstrap capability', () => {
    for (const entry of AGENT_CATALOG) {
      if (entry.capabilities.skills.status === 'managed') expect(entry.devSkills.status).toBe('managed');
      if (entry.devSkills.status === 'managed') {
        expect(entry.devSkills.scopes).toContain(entry.devSkills.defaultScope);
        expect(entry.devSkills.platforms.every(platform => entry.platforms.includes(platform))).toBe(true);
      } else expect(entry.devSkills.reason.trim()).not.toBe('');
    }
    expect(AGENT_CATALOG.find(entry => entry.id === 'claude-code')).toMatchObject({
      scopes: ['user', 'project', 'local'],
      devSkills: {scopes: ['user']},
    });
    expect(AGENT_CATALOG.find(entry => entry.id === 'cursor-cloud-personal')).toMatchObject({
      capabilities: {skills: {status: 'unsupported'}},
      devSkills: {status: 'managed', profile: 'cursor-cloud-personal', scopes: ['user']},
    });
    expect(
      AGENT_CATALOG.filter(entry => entry.devSkills.status === 'managed' && entry.devSkills.layout === 'flat').map(
        entry => entry.id,
      ),
    ).toEqual(['antigravity-cli']);
  });

  it('rejects missing scopes, unsupported defaults/platforms, unsafe roots and incomplete declarations', () => {
    const original = AGENT_CATALOG.find(entry => entry.id === 'codex-cli')!;
    const capability = original.devSkills;
    if (capability.status !== 'managed') throw new Error('Expected managed fixture');
    const invalid = [
      {...capability, scopes: []},
      {...capability, scopes: ['user', 'user']},
      {...capability, defaultScope: 'project'},
      {...capability, platforms: []},
      {...capability, platforms: ['linux', 'linux']},
      {...capability, root: {kind: 'home-relative', path: '../escape', discoveryPaths: ['../escape']}},
      {...capability, root: {kind: 'home-relative', path: '/absolute', discoveryPaths: ['/absolute']}},
      {...capability, root: {kind: 'home-relative', path: '.agents/skills', discoveryPaths: []}},
      {status: 'unsupported', reason: ''},
      undefined,
    ];
    for (const devSkills of invalid)
      expect(() => validateAgentCatalog({version: 1, agents: [{...original, devSkills}]})).toThrow();
    const zeno = AGENT_CATALOG.find(entry => entry.id === 'zeno-desktop')!;
    expect(() =>
      validateAgentCatalog({version: 1, agents: [{...zeno, devSkills: {...zeno.devSkills, platforms: ['win32']}}]}),
    ).toThrow();
  });
});
