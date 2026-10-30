import {mergeConfig} from 'vitest/config';
import {createVitestConfig} from '../../vitest.config.js';
import WindowsSmokeSequencer from './windows-smoke-sequencer.js';

export default mergeConfig(createVitestConfig(), {
  test: {sequence: {sequencer: WindowsSmokeSequencer}},
});
