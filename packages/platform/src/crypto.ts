import * as BunCrypto from '@effect/platform-bun/BunCrypto';
import {Layer} from 'effect';

/** Crypto families used by Threadnote; BunServices no longer supplies them. */
export const cryptoLayer = Layer.merge(BunCrypto.layerSecureRandom, BunCrypto.layerDigest);
