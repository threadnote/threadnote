import {describe, expect, it} from 'vitest';
import {linuxLibcFromReport} from '../src/system.js';

describe('Linux libc identity', () => {
  it('uses the actual process libc report without filesystem loader guesses', () => {
    expect(linuxLibcFromReport({header: {glibcVersionRuntime: '2.28'}})).toBe('glibc');
    expect(linuxLibcFromReport({header: {glibcVersionRuntime: ''}})).toBe('musl');
    expect(linuxLibcFromReport({header: {}})).toBe('musl');
    expect(linuxLibcFromReport(undefined)).toBeUndefined();
  });
});
