import {describe, expect, it} from 'vitest';
import {classifyUserPrimaryGroup} from '../src/user-account.js';

const passwd =
  'root:x:0:0::/root:/bin/sh\nalice:x:1000:1000::/home/alice:/bin/sh\nbob:x:1001:1001::/home/bob:/bin/sh\n';
const nsswitch =
  '# local accounts\npasswd: files systemd\ngroup: files [SUCCESS=merge] systemd # resolved\nhosts: files dns\n';
const group = 'alice:x:1000:\nusers:x:100:alice,bob\n';
const classify = (overrides: {passwd?: string; group?: string; nsswitch?: string} = {}, uid = 1000, gid = 1000) =>
  classifyUserPrimaryGroup(uid, gid, {passwd, group, nsswitch, ...overrides}).kind;

describe('user primary group classification', () => {
  it('answers private only for a local user-private group', () => {
    // The Ubuntu/Fedora layout: alice alone owns group 1000 and NSS reads local files only.
    expect(classifyUserPrimaryGroup(1000, 1000, {passwd, group, nsswitch})).toEqual({gid: 1000, kind: 'private'});
    expect(classify({nsswitch: 'passwd: altfiles files\ngroup: files\n'})).toBe('private');
  });

  it('answers shared for another member, another primary account or a duplicated gid', () => {
    expect(classify({group: 'alice:x:1000:bob\n'})).toBe('shared');
    expect(classify({passwd: `${passwd}carol:x:1002:1000::/home/carol:/bin/sh\n`})).toBe('shared');
    expect(classify({group: 'alice:x:1000:\nalias:x:1000:\n'})).toBe('shared');
    expect(classify({group: 'alice:x:1000:\nalias:x:1000:alice\n'})).toBe('shared');
  });

  it('answers unknown whenever the local files cannot settle it', () => {
    // Directory services or compat lookups can add members the files do not show.
    for (const sources of [
      'passwd: files sss\ngroup: files sss\n',
      'passwd: compat\ngroup: compat\n',
      'group: files\n',
      '',
    ])
      expect(classify({nsswitch: sources})).toBe('unknown');
    expect(classify({passwd: `${passwd}+::::::\n`})).toBe('unknown');
    expect(classify({group: `${group}+:::\n`})).toBe('unknown');
    expect(classify({group: `${group}-bob:::\n`})).toBe('unknown');
    // Ids must be plain decimal: '0x3e8' and '' never match uid or gid 1000.
    expect(classify({passwd: 'alice:x:0x3e8:0x3e8::/home/alice:/bin/sh\n'})).toBe('unknown');
    expect(classify({group: 'alice:x::\n'})).toBe('unknown');
    expect(classify({passwd: 'other:x:1001:1000::/home/other:/bin/sh\n'}, 1000, 1000)).toBe('shared');
    expect(classify({passwd: 'alice:x:1000:1000::/home/alice:/bin/sh\nother:x:1001::/x:/bin/sh\n'})).toBe('private');
    expect(classify({}, 5000, 5000)).toBe('unknown');
    expect(classifyUserPrimaryGroup(1000, 1000, undefined).kind).toBe('unknown');
  });
});
