import {describe, expect, it} from 'vitest';
import {nativeTypeScriptManifestPinFailure} from '@threadnote/graph/typescript_native_asset_pins';
import {NativeTypeScriptUnavailable} from '@threadnote/graph/typescript_runtime';

// Digests of linux-x64 constructions from the same source and Go archive on two runner images (cgo links each image's
// C toolchain): the ubuntu-24.04 image every linux-x64 consumer runs on, and the ubuntu-26.04 image of the old pin.
const UBUNTU_2404_LINUX_X64 = '0faa85f91e05a506f9a5d61ce643a565960d3e332d55aeb2c28bdbf6372af026';
const UBUNTU_2604_LINUX_X64 = 'e822fbf40a9454e0f3dcb2e088d7b8b3dabf59f7d857c258a2c255abc305dfda';

describe('native TypeScript reviewed-binary admission', () => {
  it('admits only the linux-x64 binary built on the consumer image and names any refused check', () => {
    expect(nativeTypeScriptManifestPinFailure({sha256: UBUNTU_2404_LINUX_X64, executable: 'tsc'}, 'linux', 'x64')).toBe(
      undefined,
    );
    expect(nativeTypeScriptManifestPinFailure({sha256: UBUNTU_2604_LINUX_X64, executable: 'tsc'}, 'linux', 'x64')).toBe(
      'manifest-binary',
    );
    expect(
      nativeTypeScriptManifestPinFailure({sha256: UBUNTU_2404_LINUX_X64, executable: 'tsc.exe'}, 'linux', 'x64'),
    ).toBe('manifest-executable');
    // A reviewed pin never transfers to another host or architecture.
    expect(
      nativeTypeScriptManifestPinFailure({sha256: UBUNTU_2404_LINUX_X64, executable: 'tsc'}, 'linux', 'arm64'),
    ).toBe('manifest-binary');
    expect(
      nativeTypeScriptManifestPinFailure({sha256: UBUNTU_2404_LINUX_X64, executable: 'tsc'}, 'linux', 'riscv64'),
    ).toBe('no-reviewed-pin');
  });

  it('reports the failing pin check in a value-free message', () => {
    const error = NativeTypeScriptUnavailable.of('pin-mismatch', 'manifest-binary');
    expect(error).toMatchObject({reason: 'pin-mismatch', check: 'manifest-binary'});
    expect(error.message).toBe('Native TypeScript session unavailable [pin-mismatch: manifest-binary]');
    expect(error.message).not.toMatch(/[a-f0-9]{16}|\//u);
    expect(NativeTypeScriptUnavailable.of('missing-asset').message).toBe(
      'Native TypeScript session unavailable [missing-asset]',
    );
  });
});
