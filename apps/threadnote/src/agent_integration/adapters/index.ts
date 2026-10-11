import {ampAdapter} from './amp.js';
import {factoryAdapter} from './factory.js';
import {geminiAdapter} from './gemini.js';
import {legacyAdapterDefinitions} from './legacy.js';
import {qwenAdapter} from './qwen.js';
import {clineAdapter} from './cline.js';
import {kiroAdapter} from './kiro.js';
import {devinAdapter} from './devin.js';
import {junieAdapter} from './junie.js';
import {zedAdapter} from './zed.js';
import {rooAdapter} from './roo.js';
import {continueAdapter} from './continue.js';
import {antigravityCliAdapter, antigravityIdeAdapter} from './antigravity.js';
import {kiloAdapter} from './kilo.js';
import {windsurfAdapter} from './windsurf.js';
import {opencodeAdapter} from './opencode.js';

export const managedAgentAdapterDefinitions = [
  ...legacyAdapterDefinitions,
  geminiAdapter,
  qwenAdapter,
  opencodeAdapter,
  ampAdapter,
  factoryAdapter,
  clineAdapter,
  kiroAdapter,
  devinAdapter,
  junieAdapter,
  zedAdapter,
  rooAdapter,
  continueAdapter,
  antigravityCliAdapter,
  antigravityIdeAdapter,
  kiloAdapter,
  windsurfAdapter,
] as const;

export {LEGACY_ARTIFACT_TARGETS} from './legacy.js';
export type {AgentAdapter, AgentAdapterDefinition, JsonAgentStrategy} from './contract.js';
