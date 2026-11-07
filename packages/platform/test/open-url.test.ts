import {describe, expect, it} from '@effect/vitest';
import {openUrlCommand} from '@threadnote/platform/open-url';

describe('loopback URL opener', () => {
  it.each([
    ['darwin', 'open'],
    ['linux', 'xdg-open'],
    ['win32', 'explorer.exe'],
  ] as const)('uses one direct argv argument on %s', (platform, executable) => {
    const url = 'http://127.0.0.1:4411/private-token';
    expect(openUrlCommand(platform, url)).toEqual({executable, args: [url]});
  });

  it.each([
    'https://threadnote.io/open/',
    'http://localhost:4411/private-token',
    'http://127.0.0.2:4411/private-token',
    'http://user:pass@127.0.0.1:4411/private-token',
    'javascript:alert(1)',
  ])('rejects a non-loopback launch %s', url => {
    expect(() => openUrlCommand('darwin', url)).toThrow();
  });
});
