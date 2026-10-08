import {readFile} from '@threadnote/testing/node-fs-promises';
import {join} from '@threadnote/testing/node-path';
import {describe, expect, it} from 'vitest';

import {continueAdapter} from '@threadnote/threadnote/agent_integration/adapters/continue';

const skillNames = ['threadnote-context', 'threadnote-code-graph', 'threadnote-memory'] as const;
const personalCursorCloudSkillNames = ['threadnote-context', 'threadnote-memory'] as const;

async function agentInstructions(): Promise<string> {
  return readFile(join(process.cwd(), 'config', 'agent-instructions.md'), 'utf8');
}

async function agentSkills(): Promise<readonly string[]> {
  return Promise.all(
    skillNames.map(skill => readFile(join(process.cwd(), 'config', 'agent-skills', skill, 'SKILL.md'), 'utf8')),
  );
}

async function personalCursorCloudArtifacts(): Promise<readonly string[]> {
  const root = join(process.cwd(), 'config', 'agent-profiles', 'cursor-cloud-personal');
  return Promise.all([
    readFile(join(root, 'agent-instructions.md'), 'utf8'),
    ...personalCursorCloudSkillNames.map(skill => readFile(join(root, 'agent-skills', skill, 'SKILL.md'), 'utf8')),
  ]);
}

describe('agent instructions', () => {
  it('keeps the packaged bootstrap aligned with the contributor-facing copy', async () => {
    const [runtime, documentation] = await Promise.all([
      agentInstructions(),
      readFile(join(process.cwd(), 'docs', 'agent-instructions.md'), 'utf8'),
    ]);
    expect(runtime).toBe(documentation);
  });

  it('ships Personal Cursor Cloud skills that match its one-MCP multi-share capabilities', async () => {
    const artifacts = (await personalCursorCloudArtifacts()).join('\n').replace(/\s+/g, ' ');
    for (const requiredText of [
      'one Threadnote MCP',
      'several configured Git memory shares',
      'pass `team`',
      '`recall_context`',
      '`read_context`',
      '`list_context`',
      '`remember_context`',
      'commits and pushes',
      'VM-local',
      'Never store secrets, credentials, customer data, or raw production logs',
    ]) {
      expect(artifacts).toContain(requiredText);
    }
    expect(artifacts).not.toContain('Call `context_brief`');
    expect(artifacts).not.toContain('Git beta');
    expect(artifacts).not.toContain('`inspect_code_graph`');
    expect(artifacts).not.toContain('`analyze_code_graph`');
    expect(artifacts).not.toContain('local code graph');
  });

  it('keeps the always-loaded bootstrap compact and routes detailed work to skills', async () => {
    const instructions = await agentInstructions();
    const normalized = instructions.replace(/\s+/g, ' ');
    expect(Buffer.byteLength(instructions)).toBeLessThanOrEqual(800);
    for (const requiredText of [
      ...skillNames,
      'non-trivial work',
      'Route non-trivial work by situation',
      'for context',
      'only for unfamiliar source relationships, unresolved evidence gaps, or repo instructions',
      'for memory retrieval and closeout',
      'Exact-path/literal checks need no graph',
      'Repository files',
      'authoritative',
      'On an initial route, call MCP `context_brief`',
      'proposals are never auto-applied/auto-shared',
      'secrets, credentials, customer data, or raw production logs',
      'Confirm before durable sharing',
      'MCP `context_brief` with task + absolute `callerCwd`',
      '`threadnote context brief --cwd <cwd> --task <task>`',
    ]) {
      expect(normalized).toContain(requiredText);
    }
    expect(normalized).toContain('Follow the selected skill');
    expect(normalized).toContain('initial route');
    expect(normalized).not.toContain('threadnote context brief --caller-cwd');
    expect(normalized).not.toContain('use the installed threadnote skills');
  });

  it('preserves detailed context, graph, memory, and code-brief contracts in progressive skills', async () => {
    const instructions = await agentInstructions();
    const skillFiles = await agentSkills();
    const skills = skillFiles.join('\n').replace(/\s+/g, ' ');
    const [context, graph, memory] = skillFiles;
    const normalizedContext = context.replace(/\s+/g, ' ');
    const normalizedGraph = graph.replace(/\s+/g, ' ');
    const shippedGuidanceBytes = [instructions, ...skillFiles].reduce(
      (total, artifact) => total + Buffer.byteLength(artifact),
      0,
    );
    expect(shippedGuidanceBytes).toBeLessThanOrEqual(9_507);
    expect(context.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(400);
    expect(graph.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(425);
    expect(memory.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(500);
    for (const requiredText of [
      '`context_brief`',
      '`codeRefs`',
      'Context Brief lifecycle',
      'absolute `callerCwd`',
      'Use only for unfamiliar source relationships, unresolved evidence gaps, or repo instructions',
      '`inspect_code_graph({"callerCwd":"/abs/repo","operation":"query","query":"exclusive file lock"})`',
      '`analyze_code_graph({"callerCwd":"/abs/repo","operation":"stats","freshness":"allow-stale"})`',
      'both tools require absolute `callerCwd` + `operation`',
      '`query`',
      '`node`',
      '`neighbors`',
      '`explain`',
      '`path`',
      '`impact`',
      '`topology`',
      '`analyze_code_graph`',
      '`projectCoverage`',
      '`outside-project-graph`',
      'never guess, silently widen, or force a full rebuild',
      '`threadnote workset prepare <name>`',
      '`kind: durable`',
      '`kind: handoff`',
      '`replaceUri`',
      '`relations`',
      'replacement supplies the complete set',
      'carry forward every still-valid relation',
      'five-field Knowledge Delta',
      '`decisions` + `rationale`',
      '`constraints`',
      '`verificationPerformed`',
      '`knowledgeInvalidated`',
      '`unresolvedRisks`',
      '`review_session_context`',
      '`apply_memory_candidates`',
      '`approve` (optionally with `editedText`), `defer`, or `reject`',
      '`remember_context(kind=handoff)`',
      'Always write the required private handoff directly',
      'Handoffs accept explicit `keywords` and preserve them on replacement',
      'Omit `regenerateKeywords`: handoffs never generate keywords',
      'Only when the session produced reusable durable knowledge',
      'Treat the Knowledge Delta and returned candidates as one optional review lifecycle',
      'without a user decision leave candidates unapplied',
      '`citationPolicy: "defer"`',
      '`--defer-code-refs`',
      '`citationPolicy: "require-current"`',
      '1-4 key changed paths or graph handles',
      'compact exact-current resume cannot activate',
      '`finalize_code_refs`',
      'private pending anchor',
      '`share_publish`',
      '`share_propose`',
      '`context_health`',
      '`context_health_aggregate`',
      '`context_health_repair_preview`',
      '`context_health_repair_apply`',
      '`context_health_schedule`',
      '`context_metadata_preview`',
      '`context_metadata_apply`',
      '`recall_feedback`',
      '`recall_context`',
      '`read_context`',
      'pointers are not evidence until read',
      '`threadnote value report`',
      '`procedure_publish_preview`',
      '`procedure_publish_apply`',
      '`threadnote procedure verify <manifest>`',
      '`threadnote guidance import`',
      '`threadnote guidance project`',
      '`complete_activation_retrieval_proof`',
      '`threadnote_guide`',
      'tool-returned actions guide uncommon recovery',
      'Do not store secrets, credentials, customer data, or raw production logs',
    ]) {
      expect(skills).toContain(requiredText);
    }
    expect(normalizedContext).toContain('mode (`brief`, `locate`, `trace`, `impact`, `explain`, or `resume`)');
    expect(normalizedContext).toContain('MCP `context_brief`');
    expect(normalizedContext).toContain('`threadnote context brief --cwd <cwd> --task <task>`');
    expect(normalizedContext.toLowerCase()).toContain('same active session/native context');
    expect(normalizedContext.toLowerCase()).toContain(
      'same active session/native context can continue without repeating brief/recall unless the work state is stale/missing, after compaction/handoff/new agent, or the user explicitly asks',
    );
    expect(normalizedContext).toContain('`mode=resume`');
    expect(normalizedContext).toContain('`threadnote-memory`');
    expect(normalizedContext).not.toContain('threadnote context brief --caller-cwd');
    expect(normalizedContext).not.toContain('`inspect_code_graph`/`analyze_code_graph`');
    expect(normalizedGraph).toContain(
      'Use only for unfamiliar source relationships, unresolved evidence gaps, or repo instructions',
    );
    expect(normalizedGraph).toContain('exact-path/literal checks go directly to source');
    expect(normalizedGraph).toContain('`node`/`neighbors` round-trip `cgs_`/`cgr_`');
    expect(normalizedGraph).toContain('`explain` expands symbols');
    expect(normalizedGraph).toContain('`path` connects local');
    expect(normalizedGraph).toContain('qualified Workset endpoints');
    expect(normalizedGraph).toContain('For local `inspect_code_graph`');
    expect(normalizedGraph).toContain('omit `responseFormat` for schema-aware text-only `agent`');
    expect(normalizedGraph).toContain('formatting/truncation');
    expect(normalizedGraph).toContain('default to lossless JSON');
    expect(normalizedGraph).toContain('request `dual` for canonical structured content');
    expect(normalizedGraph).toContain('Worksets lack agent projection');
    for (const analysisOperation of [
      '`stats`',
      '`communities`',
      '`community`',
      '`groups`',
      '`hubs`',
      '`surprises`',
      '`confidence`',
      '`full`',
    ]) {
      expect(graph).toContain(analysisOperation);
    }
    expect(memory).toContain('memory-specific retrieval and closeout');
    expect(memory).toContain('required private handoff');
    expect(memory).toContain(
      'labeled `task`, `decisions`/`invariants`, `verification`, `blockers`/`risks`, and `next_step`',
    );
    for (const retiredDetail of [
      '`offsetBytes`',
      '`sourceHash`',
      '`canonicalUri`',
      '`recoveryAction`',
      'identity-fenced relocation',
      '`--fixture',
      '`--available-manifest',
      '`validTo`',
      '`ttl`',
    ]) {
      expect(skills).not.toContain(retiredDetail);
    }
    expect(skills).not.toContain('4.6');
  });

  it('gives non-skill Continue sessions the exact normal lifecycle tools', () => {
    const instructions = continueAdapter.json?.instructionContent ?? '';
    expect(Buffer.byteLength(instructions)).toBeLessThanOrEqual(800);
    for (const tool of [
      '`context_brief`',
      '`recall_context`',
      '`read_context`',
      '`inspect_code_graph`',
      '`analyze_code_graph`',
      '`remember_context(kind=handoff)`',
      '`review_session_context`',
      '`apply_memory_candidates`',
    ]) {
      expect(instructions).toContain(tool);
    }
    expect(instructions).toContain('`approve` (`editedText` optional), `defer`, or `reject`');
    for (const route of [
      'fresh/lost',
      'warm sufficient -> no bootstrap',
      'handoff/new session -> `mode=resume`',
      'Memory -> `recall_context` then `read_context`',
      'unfamiliar relationships/evidence gaps/repo instructions',
      'exact paths/literals -> source',
      'repo guidance authoritative',
      'Verify exact source',
      'End private `remember_context(kind=handoff)`',
      '`review_session_context` optional five-field Knowledge Delta',
      'never auto-apply/share, confirm durable sharing',
    ]) {
      expect(instructions).toContain(route);
    }
    expect(instructions).toContain('`threadnote context brief --cwd <cwd> --task <task>`');
    expect(instructions).not.toContain('threadnote context brief --caller-cwd');
  });
});
