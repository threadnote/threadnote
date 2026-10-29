import {Array as EffectArray} from 'effect';
import {parseLinuxHardwareInfo} from '@threadnote/platform/system';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const maximumSafeKibibytes = Math.floor(Number.MAX_SAFE_INTEGER / 1024);
// Linux ARM Docker observation: numeric CPU fields are present, but neither descriptive field exists.
const armCpuInfo = EffectArray.join(
  [
    'processor\t: 0',
    'BogoMIPS\t: 48.00',
    'Features\t: fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics',
    'CPU implementer\t: 0x61',
    'CPU architecture: 8',
    'CPU variant\t: 0x0',
    'CPU part\t: 0x000',
    'CPU revision\t: 0',
    '',
    'processor\t: 1',
    'CPU implementer\t: 0x61',
    'CPU architecture: 8',
    'CPU part\t: 0x000',
  ],
  '\n',
);

describe('Linux hardware metadata', () => {
  it('retains valid Docker ARM memory without inventing a descriptive CPU model', () => {
    expect(parseLinuxHardwareInfo(armCpuInfo, 'MemTotal:        8022316 kB\n', 'arm64')).toEqual({
      cpuModel: 'unknown (arm64)',
      memoryBytes: 8_214_851_584,
    });
  });

  it.each([
    ['model name\t: Intel(R) Xeon(R) CPU\n', 'Intel(R) Xeon(R) CPU'],
    ['Hardware\t: Raspberry Pi 4 Model B\n', 'Raspberry Pi 4 Model B'],
    ['Hardware: \nmodel name: Known CPU\n', 'Known CPU'],
  ])('preserves a descriptive CPU field in %j', (cpuInfo, cpuModel) => {
    expect(parseLinuxHardwareInfo(cpuInfo, 'MemTotal: 1024 kB\n', 'x64')).toEqual({
      cpuModel,
      memoryBytes: 1_048_576,
    });
  });

  it('does not borrow a following CPU field as a blank model label', () => {
    expect(parseLinuxHardwareInfo('model name: \nCPU architecture: 8\n', 'MemTotal: 1 kB\n', 'arm64')).toEqual({
      cpuModel: 'unknown (arm64)',
      memoryBytes: 1024,
    });
  });

  it('accepts the largest exactly representable whole-KiB memory value', () => {
    expect(parseLinuxHardwareInfo('model name: CPU', `MemTotal: ${maximumSafeKibibytes} kB`, 'x64').memoryBytes).toBe(
      Number(BigInt(maximumSafeKibibytes) * 1024n),
    );
  });

  it.each([
    '',
    'MemAvailable: 8022316 kB\n',
    'MemTotal: 0 kB\n',
    'MemTotal: -1 kB\n',
    'MemTotal: 1.5 kB\n',
    'MemTotal: NaN kB\n',
    'MemTotal: 1 MB\n',
    'MemTotal:\n1 kB\n',
    `MemTotal: ${maximumSafeKibibytes + 1} kB\n`,
  ])('rejects missing, malformed or unsafe memory %j even with a known CPU', memoryInfo => {
    expect(() => parseLinuxHardwareInfo('model name: Known CPU\n', memoryInfo, 'x64')).toThrow();
  });

  fcProp(
    it,
    'CPU description contents cannot change a valid memory measurement',
    {cpuInfo: FC.string({maxLength: 200}), kibibytes: FC.integer({min: 1, max: maximumSafeKibibytes})},
    ({cpuInfo, kibibytes}) => {
      const parsed = parseLinuxHardwareInfo(cpuInfo, `MemTotal: ${kibibytes} kB\n`, 'arm64');
      expect(parsed.memoryBytes).toBe(Number(BigInt(kibibytes) * 1024n));
      expect(Effect.pipe(parsed.cpuModel, EffectString.trim)).not.toBe('');
    },
    {fastCheck: {numRuns: 64}},
  );

  fcProp(
    it,
    'a CPU description cannot grant usable hardware metadata for invalid memory',
    {
      description: FC.string({maxLength: 80}),
      invalidKibibytes: FC.oneof(
        FC.bigInt({min: -1_000_000n, max: 0n}),
        FC.bigInt({min: BigInt(maximumSafeKibibytes) + 1n, max: 1n << 80n}),
      ),
    },
    ({description, invalidKibibytes}) => {
      expect(() =>
        parseLinuxHardwareInfo(`model name: ${description}\n`, `MemTotal: ${invalidKibibytes} kB\n`, 'arm64'),
      ).toThrow();
    },
    {fastCheck: {numRuns: 64}},
  );
});
