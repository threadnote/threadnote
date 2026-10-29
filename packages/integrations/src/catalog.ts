import {Array as EffectArray} from 'effect';
import {Schema} from 'effect';
import catalog from './catalog.json' with {type: 'json'};
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Option as EffectOption} from 'effect';

const capability = Schema.Struct({
  status: Schema.Literals(['managed', 'partial', 'unsupported']),
  reason: Schema.optionalKey(Schema.String),
});

const skillScope = Schema.Literals(['user', 'project', 'local']);
const skillPlatform = Schema.Literals(['darwin', 'linux', 'win32']);

/** Workflow discovery is independent of the surface's MCP/instruction scopes. */
export const AgentDevSkills = Schema.Union([
  Schema.Struct({status: Schema.Literal('unsupported'), reason: Schema.String}),
  Schema.Struct({
    status: Schema.Literal('managed'),
    profile: Schema.Literals(['desktop', 'codex-cloud-personal', 'cursor-cloud-personal']),
    scopes: Schema.Array(skillScope),
    scopeReason: Schema.optionalKey(Schema.String),
    defaultScope: skillScope,
    platforms: Schema.Array(skillPlatform),
    layout: Schema.Literals(['directory', 'flat']),
    root: Schema.Union([
      Schema.Struct({kind: Schema.Literal('json-strategy')}),
      Schema.Struct({kind: Schema.Literal('omp-profile')}),
      Schema.Struct({
        kind: Schema.Literal('home-relative'),
        path: Schema.String,
        discoveryPaths: Schema.Array(Schema.String),
      }),
    ]),
  }),
]);
export type AgentDevSkills = typeof AgentDevSkills.Type;

export const AgentCatalogEntry = Schema.Struct({
  id: Schema.String,
  agentId: Schema.String,
  displayName: Schema.String,
  tier: Schema.Literals(['full', 'core', 'project', 'manual', 'experimental']),
  aliases: Schema.Array(Schema.String),
  scopes: Schema.Array(Schema.Literals(['user', 'project', 'local'])),
  platforms: Schema.Array(Schema.Literals(['darwin', 'linux', 'win32'])),
  capabilities: Schema.Struct({mcp: capability, instructions: capability, skills: capability, hooks: capability}),
  devSkills: AgentDevSkills,
  projectGuidance: Schema.Union([
    Schema.Struct({status: Schema.Literal('managed'), targetPath: Schema.String}),
    Schema.Struct({status: Schema.Literal('unsupported'), reason: Schema.String}),
  ]),
  officialDocs: Schema.Array(Schema.String),
  lastVerified: Schema.String,
  caveats: Schema.Array(Schema.String),
  setup: Schema.Array(Schema.String),
  verification: Schema.String,
});

export type AgentCatalogEntry = typeof AgentCatalogEntry.Type;
export type AgentId = AgentCatalogEntry['agentId'];
export type AgentSurfaceId = AgentCatalogEntry['id'];

export function validateAgentCatalog(value: unknown): readonly AgentCatalogEntry[] {
  const parsed = Schema.decodeUnknownSync(
    Schema.Struct({version: Schema.Literal(1), agents: Schema.Array(AgentCatalogEntry)}),
  )(value);
  const selectors = new Set<string>();
  for (const entry of parsed.agents) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.lastVerified) || entry.officialDocs.length === 0) {
      throw new Error(`Missing verification evidence for ${entry.id}`);
    }
    for (const selector of new Set([entry.id, ...entry.aliases])) {
      if (!/^[a-z][a-z0-9-]*$/.test(selector) || selectors.has(selector))
        throw new Error(`Duplicate or invalid agent selector: ${selector}`);
      selectors.add(selector);
    }
    for (const url of entry.officialDocs) {
      if (new URL(url).protocol !== 'https:') throw new Error(`Agent documentation must use HTTPS: ${entry.id}`);
    }
    for (const value of EffectRecord.values(entry.capabilities)) {
      if (
        value.status !== 'managed' &&
        !Effect.pipe(value.reason, effectOptionalString =>
          effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
        )
      )
        throw new Error(`Missing capability reason: ${entry.id}`);
    }
    const skills = entry.devSkills;
    if (skills.status === 'unsupported') {
      if (!Effect.pipe(skills.reason, EffectString.trim) || entry.capabilities.skills.status === 'managed')
        throw new Error(`Missing declared development skill target: ${entry.id}`);
    } else {
      if (
        skills.scopes.length === 0 ||
        new Set(skills.scopes).size !== skills.scopes.length ||
        !skills.scopes.includes(skills.defaultScope) ||
        skills.platforms.length === 0 ||
        new Set(skills.platforms).size !== skills.platforms.length ||
        EffectArray.some(skills.platforms, platform => !entry.platforms.includes(platform)) ||
        (skills.root.kind !== 'json-strategy' && EffectArray.some(skills.scopes, scope => scope !== 'user'))
      )
        throw new Error(`Invalid development skill scopes/platforms: ${entry.id}`);
      if (skills.root.kind === 'home-relative') {
        const portable = (value: string) =>
          /^[A-Za-z0-9_./-]+$/u.test(value) &&
          EffectArray.every(Effect.pipe(value, EffectString.split('/')), part =>
            Boolean(part && part !== '.' && part !== '..'),
          );
        if (
          !portable(skills.root.path) ||
          !skills.root.discoveryPaths.includes(skills.root.path) ||
          new Set(skills.root.discoveryPaths).size !== skills.root.discoveryPaths.length ||
          !EffectArray.every(skills.root.discoveryPaths, portable)
        )
          throw new Error(`Invalid development skill discovery roots: ${entry.id}`);
      }
    }
    if (
      (entry.projectGuidance.status === 'managed' &&
        !Effect.pipe(entry.projectGuidance.targetPath, EffectString.trim)) ||
      (entry.projectGuidance.status === 'unsupported' && !Effect.pipe(entry.projectGuidance.reason, EffectString.trim))
    )
      throw new Error(`Missing project-guidance capability detail: ${entry.id}`);
  }
  return parsed.agents;
}

export const AGENT_CATALOG = validateAgentCatalog(catalog);

export function findAgentSurface(selector: string): AgentCatalogEntry | undefined {
  return EffectOption.getOrUndefined(
    EffectArray.findFirst(
      AGENT_CATALOG,
      __effectArrayValue => !!(entry => entry.id === selector || entry.aliases.includes(selector))(__effectArrayValue),
    ),
  );
}
