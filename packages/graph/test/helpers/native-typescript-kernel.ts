import * as EffectString from 'effect/String';
import {arch, platform, release} from '@threadnote/testing/node-os';

/**
 * macOS 15 (Darwin 24) and earlier do not report CS_KILL for the linker-signed reviewed compiler and run a changed page
 * of such an image, so the runtime refuses it there: only a signed release runs native TypeScript on those kernels.
 * A test in code-graph.extractor-lazy-loading.test.ts proves this predicate against the real kernel. This module has
 * no load-time checks, so end-to-end tests of built payloads can import it.
 */
export const nativeTypeScriptSourceModeRefused =
  platform() === 'darwin' && arch() === 'arm64' && Number(EffectString.split('.')(release())[0]) <= 24;
