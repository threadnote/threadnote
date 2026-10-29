import {THREADNOTE_MCP_CLIENT_ENV} from '../constants.js';
import type {AgentClient} from '../types.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const IMAGE_PROJECTION_MODEL_ENVIRONMENT_KEY = 'THREADNOTE_IMAGE_PROJECTION_MODEL';
export const MCP_CLIENT_ENVIRONMENT_KEY = THREADNOTE_MCP_CLIENT_ENV;

const IMAGE_PROJECTION_MODEL_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/;

const HOST_PXPIPE_MODEL: Partial<Record<AgentClient, string>> = {
  claude: 'claude-sonnet-4-6',
  codex: 'gpt-5.6-sol',
  cursor: 'grok-4.5',
};

export interface ImageProjectionRenderOptions {
  readonly cols?: number;
  readonly maxHeightPx?: number;
  readonly model?: string;
  readonly reflow: true;
  readonly style?: {readonly font: 'jetbrains-mono-14'};
}

export function resolveImageProjectionPxpipeModel(environment: Record<string, string | undefined>): string | undefined {
  const explicit = sanitizePxpipeModelId(environment[IMAGE_PROJECTION_MODEL_ENVIRONMENT_KEY]);
  if (explicit !== undefined) return explicit;
  const client = parseMcpClient(environment[MCP_CLIENT_ENVIRONMENT_KEY]);
  return client === undefined ? undefined : HOST_PXPIPE_MODEL[client];
}

export function imageProjectionRenderOptions(model: string | undefined): ImageProjectionRenderOptions {
  if (model !== undefined) return {model, reflow: true};
  return {
    cols: 84,
    maxHeightPx: 728,
    reflow: true,
    style: {font: 'jetbrains-mono-14'},
  };
}

function sanitizePxpipeModelId(value: string | undefined): string | undefined {
  const model = Effect.pipe(value, effectOptionalString =>
    effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
  );
  if (model === undefined || !IMAGE_PROJECTION_MODEL_ID_PATTERN.test(model)) return undefined;
  return model;
}

function parseMcpClient(value: string | undefined): AgentClient | undefined {
  const client: string | undefined = Effect.pipe(
    value,
    effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
    effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.toLowerCase),
  );
  if (client === 'claude' || client === 'codex' || client === 'copilot' || client === 'cursor' || client === 'omp') {
    return client;
  }
  return undefined;
}
