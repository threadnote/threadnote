import {join} from '@threadnote/testing/node-path';
import type {RuntimeConfig} from '@threadnote/workspace/config';

/** Builds a complete runtime config from the fields relevant to a focused test. */
export function runtimeConfigForTest(
  config: Pick<RuntimeConfig, 'agentContextHome'> & Partial<RuntimeConfig>,
): RuntimeConfig {
  return {
    account: 'local',
    agentId: 'threadnote',
    manifestPath: join(config.agentContextHome, 'threadnote.toml'),
    user: 'tester',
    ...config,
  };
}
