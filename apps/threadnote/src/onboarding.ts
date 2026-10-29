import {Array as EffectArray} from 'effect';
import {Effect} from 'effect';
import {readSeedManifest} from '@threadnote/workspace/manifest';
import {DEFAULT_MCP_TOOLSET, mcpToolCapabilities, type McpToolset} from './mcp/toolset.js';
import {readTeamsFile} from './share/index.js';
import * as EffectRecord from 'effect/Record';

// Minimal config shape the onboarding probes need, structurally satisfied by
// both the CLI and the MCP-adapter RuntimeConfig variants.
interface OnboardingConfig {
  readonly account: string;
  readonly agentContextHome: string;
  readonly agentId: string;
  readonly manifestPath: string;
  readonly user: string;
}

// State the onboarding guide tailors itself to. All fields are best-effort: a
// probe that fails leaves its field empty/undefined so the guide still renders.
export interface OnboardingState {
  readonly seededProjects: readonly string[];
  readonly runtimeReady?: boolean;
  readonly teams: readonly string[];
  readonly toolset?: McpToolset;
}

// Reads the local, cheap pieces of onboarding state (configured share teams and
// seeded projects). Runtime readiness is probed separately by the caller.
export const gatherOnboardingContext = Effect.fn('onboarding.gatherContext')(function* (config: OnboardingConfig) {
  const [seededProjects, teams] = yield* Effect.all([safeSeededProjects(config), safeTeams(config)]);
  return {seededProjects, teams};
});

const safeTeams = Effect.fn('onboarding.safeTeams')((config: OnboardingConfig) =>
  readTeamsFile(config).pipe(Effect.map(file => EffectRecord.keys(file.teams ?? {}).sort())),
);

const safeSeededProjects = Effect.fn('onboarding.safeSeededProjects')((config: OnboardingConfig) =>
  readSeedManifest(config.manifestPath).pipe(
    Effect.map(manifest => EffectArray.map(manifest.projects, project => project.name)),
  ),
);

// Builds the agent-facing onboarding walkthrough. Pure and deterministic so it is
// unit-testable without MCP plumbing. The text is instructions FOR
// the agent (present conversationally, offer to run), not a message to paste.
export function buildOnboardingGuide(state: OnboardingState): string {
  if (state.toolset === 'cursor-cloud-local') {
    return EffectArray.join(
      [
        '# Threadnote remote-hybrid mode for Cursor Cloud Agents',
        '',
        'Use the managed threadnote-memory HTTP server for every historical memory read and write.',
        'It is bound to exactly one remote memory share by the threadnote-share-id Dashboard header.',
        'Do not remove, replace, or infer that share binding from a memory URI.',
        'This local server deliberately has no recall, read, list, remember, resource, or Git-share tools.',
        'Never fall back to personal or VM-local memory when the managed service is unavailable.',
        '',
        'Use inspect_code_graph before broad text search and analyze_code_graph for repository-wide',
        'structure in the current checkout. Named worksets are unavailable in this cloud-local profile.',
        'Use cursor_cloud_status to check the two planes and confirm the same share binding independently.',
        '',
        'When the managed server returns an attestation challenge, pass its exact metadata to',
        'complete_cursor_attestation. The helper sends the Cursor OIDC token directly to Threadnote',
        'and returns only the opaque attestation ID.',
      ],
      '\n',
    );
  }
  if (
    state.toolset === 'cursor-cloud-personal' ||
    state.toolset === 'cursor-cloud' ||
    state.toolset === 'cursor-cloud-git-beta'
  ) {
    return EffectArray.join(
      [
        '# Threadnote Personal Cursor Cloud',
        '',
        'This session has one MCP bounded to its configured Git memory shares. Start with recall_context.',
        'Its results are unread pointers, not evidence; use read_context before relying on relevant URIs.',
        'Read only the threadnote:// URIs it returns. Pass team to narrow recall or select a list root.',
        '',
        'Store durable knowledge with remember_context. When several shares are configured, pass team explicitly.',
        'Each write is committed and pushed only to that share. A kind=handoff write stays local and may not survive',
        'a new cloud session; all other personal/local memory kinds stay inaccessible.',
        'Review/apply actions, separate publishing, Obsidian operations, and maintenance tools are unavailable.',
        'Use the remote-hybrid profile instead when managed Threadnote memory is enabled for the environment.',
      ],
      '\n',
    );
  }
  const runtimeLine =
    state.runtimeReady === false
      ? 'The Threadnote home is not ready — run `threadnote install`, then `threadnote doctor`. Offer to walk the user through that first.'
      : state.runtimeReady === true
        ? 'The self-contained Threadnote runtime is ready.'
        : 'Runtime status is unknown — run `threadnote doctor` if a native storage or model operation fails.';

  const teamLine =
    state.teams.length > 0
      ? `Team sharing is configured: ${EffectArray.join(state.teams, ', ')}. They can publish memories and skills to teammates.`
      : 'No share team configured yet — team sharing is available but needs a one-time `threadnote share init <git-remote>`.';

  const seedLine =
    state.seededProjects.length > 0
      ? `Seeded project guidance is available for: ${EffectArray.join(state.seededProjects, ', ')} (recall surfaces it when the query names the project).`
      : 'No seeded project guidance yet — recall draws on personal memories and shared team memories.';

  const hasTeam = state.teams.length > 0;
  const capabilities = mcpToolCapabilities(state.toolset ?? DEFAULT_MCP_TOOLSET);

  return EffectArray.join(
    [
      '# Threadnote — what you can do here',
      '',
      'You are onboarding the user to Threadnote. Do NOT paste this list verbatim. Read it,',
      'then guide the user conversationally: lead with what is most useful given the state',
      'below, explain one capability in a sentence, and OFFER to run it for them (with their',
      'go-ahead) instead of only describing it. Start small.',
      '',
      '## Current setup',
      `- ${runtimeLine}`,
      `- ${teamLine}`,
      `- ${seedLine}`,
      '',
      '## Capabilities to offer',
      '',
      'Start with a Context Brief for non-trivial local repo work: run it with the task and absolute callerCwd;',
      'it combines bounded graph evidence with freshness, decisions, and handoffs. Recall is the memory-focused alternative.',
      '  Run context_brief({"task":"<task>","callerCwd":"<abs cwd>","mode":"locate"}); otherwise use',
      '  recall_context({"query":"<repo> latest handoff","callerCwd":"<abs cwd>"}), then read the most relevant',
      '  threadnote:// URI with read_context. Results are unread pointers, not evidence.',
      '  Next inspect_code_graph/analyze_code_graph, then verify exact source; use the CLI `threadnote context check`',
      '  and `threadnote procedure status` / `threadnote procedure verify <manifest>` for maintenance and procedures.',
      '  Use `threadnote guidance import` / `threadnote guidance project`, `threadnote activate start` /',
      '  `threadnote activate continue`, and `threadnote value report` for the corresponding workflows.',
      '',
      'Close out with a required handoff. Separately, optionally review a five-field Knowledge Delta:',
      'decisions + rationale, constraints, verificationPerformed, knowledgeInvalidated, and unresolvedRisks.',
      'The required handoff is a private direct write; optional Knowledge Delta proposals are never auto-applied or auto-shared,',
      'and durable sharing requires explicit user confirmation. Preview candidates and get an explicit disposition.',
      '  Record the required handoff with remember_context(kind=handoff, ...). Durable memories may include owner,',
      '  review_after, and optional validTo/valid_to; review deltas separately with review_session_context(...) then use apply_memory_candidates with approve (optional editedText), defer, or reject.',
      '',
      'Share with your team — publish a durable memory teammates’ agents can recall. Secrets are',
      'scrubbed/blocked; handoffs/preferences/local-path notes are never shared.',
      hasTeam
        ? '  Run: share_publish({"uri":"threadnote://user/<you>/memories/durable/projects/<p>/<m>.md"}).'
        : '  First (one-time): `threadnote share init git@github.com:org/team-memories.git`, then share_publish({"uri":"..."}).',
      '',
      ...(capabilities.lifecycle
        ? [
            'Health and repair are available here: inspect health/metadata, preview repair, then apply only after confirmation.',
            '  Run: context_health({"project":"<repo>","callerCwd":"<abs cwd>"}), context_health_aggregate({"project":"<repo>","callerCwd":"<abs cwd>"}),',
            '  context_health_schedule({"project":"<repo>","cadenceMinutes":60}), context_health_repair_preview({"project":"<repo>","callerCwd":"<abs cwd>"}),',
            '  context_health_repair_apply({"project":"<repo>","callerCwd":"<abs cwd>","proposalId":"<preview id>","revision":"<preview revision>","approved":true}),',
            '  context_metadata_preview({"uri":"threadnote://...","owner":"<owner>"}), or context_metadata_apply({"uri":"threadnote://...","owner":"<owner>","approved":true,"expectedContentHash":"<preview hash>","proposalId":"<preview id>","revision":"<preview revision>"}).',
            '  Record recall feedback with recall_feedback({"action":"useful","query":"<recall query>","uri":"threadnote://..."}). Publish verified procedures with',
            '  procedure_publish_preview({"artifact":"<path>","manifest":"<path>","receipt":"<path>"}) then explicit procedure_publish_apply({"artifact":"<path>","manifest":"<path>","receipt":"<path>","proposalId":"<preview id>","approved":true}); they are admitted only when compatible and never auto-execute.',
            'Use complete_activation_retrieval_proof for activation proof. Use the CLI only for workflows that do not have an MCP call.',
            '',
          ]
        : []),
      ...(capabilities.maintenance
        ? [
            'Tidy memory — when recall surfaces overlapping notes for one topic, preview a scoped merge.',
            '  Run: compact_context({"project":"<repo>","topic":"<topic>","dryRun":true}) and review before applying.',
            '',
            'Share skills & packs — publish a skill, or a multi-skill pack (skills + shared',
            'scripts), into the team catalog; teammates install them on demand.',
            '  Run: share_skill({"path":"<agent-skill-dir>/<name>/SKILL.md"}) or',
            '  share_bundle({"path":"<repo>/threadnote-bundle.json"}). Teammates: list_shared_skills({})',
            '  then install_shared_skill({"name":"<name>"}).',
            '',
          ]
        : []),
      'Setup & health — verify the local home, indexes, and optional model files.',
      state.runtimeReady === false
        ? '  Run: `threadnote install`, then `threadnote doctor`.'
        : '  Run: `threadnote doctor` to check prerequisites.',
      '',
      '## How to proceed',
      'Pick the single most useful step for right now given the setup above (if the runtime is',
      'not ready, fix that first; otherwise a Context Brief is the usual starting point),',
      'describe it in one sentence, and ask whether to run it. Then chain into the others as the',
      'user shows interest. Keep it interactive — one offer at a time, not a wall of options.',
    ],
    '\n',
  );
}
