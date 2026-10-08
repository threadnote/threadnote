import {sha256HexSync} from '@threadnote/platform/sha256';
import type {LinearSourceConfig} from './config.js';
import type {createLinearClient} from './client.js';
import type {LinearComment} from './schema.js';

export const LINEAR_RENDERER_VERSION = 'linear-markdown-v1';
export const LINEAR_COVERAGE =
  'issue-description-and-threaded-comments; selected-project-overview-native-documents-and-updates; inline-and-update-comments-excluded';
export interface LinearChunk {
  readonly pageId: string;
  readonly chunkId: string;
  readonly title: string;
  readonly body: string;
  readonly browserLink: string;
  readonly remoteRevision: string;
}
export interface LinearRenderedObject {
  readonly documentId: string;
  readonly chunks: readonly LinearChunk[];
}
export const linearDocumentId = (
  organizationId: string,
  kind: 'issue' | 'project' | 'document' | 'update',
  id: string,
) => `${kind}-${sha256HexSync(`${organizationId}:${kind}:${id}`).slice(0, 40)}`;
export function scrubLinearMarkdown(value: string): string {
  return value
    .replace(/!\[[^\]\n]{0,2048}\]\([^\n)]{1,4096}\)/g, '[Attachment image omitted]')
    .replace(/https?:\/\/[^\s<>"\]]+/gi, candidate => {
      const suffix = candidate.endsWith(')') ? ')' : '';
      const target = suffix ? candidate.slice(0, -1) : candidate;
      try {
        const url = new URL(target);
        if (
          url.username ||
          url.password ||
          [...url.searchParams.keys()].some(key =>
            /^(?:token|access_token|auth|authorization|signature|sig|key|expires|x-amz-.+|x-goog-.+)$/i.test(key),
          )
        )
          return `[Capability link omitted]${suffix}`;
        return candidate;
      } catch {
        return candidate;
      }
    });
}
function chunks(title: string, body: string, url: string, revision: string, pageId = 'text'): readonly LinearChunk[] {
  body = scrubLinearMarkdown(body);
  if (body.length > 2000000) throw new Error('Linear logical object exceeds rendering budget.');
  const result: LinearChunk[] = [];
  for (let offset = 0; offset < body.length;) {
    let end = Math.min(body.length, offset + 12000);
    if (end < body.length) {
      const newline = body.lastIndexOf('\n', end);
      if (newline > offset + 6000) end = newline + 1;
      if (/[\uD800-\uDBFF]/.test(body[end - 1] ?? '')) end--;
    }
    result.push({
      pageId,
      chunkId: `part-${String(result.length + 1).padStart(4, '0')}`,
      title,
      body: body.slice(offset, end),
      browserLink: url,
      remoteRevision: revision,
    });
    offset = end;
  }
  return result;
}
const provenance = (source: LinearSourceConfig, kind: string, id: string, url: string) =>
  `Source: Linear (${source.id})\nOrganization: ${source.organizationId}\nObject: ${kind} ${id}\nURL: ${url}\nEvidence: untrusted provider text, read-only observation\nCoverage: ${LINEAR_COVERAGE}\n\n`;
function thread(comments: readonly LinearComment[], root: LinearComment): string {
  const descendants = (parent: string): string =>
    comments
      .filter(c => c.parentId === parent)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(c => render(c) + descendants(c.id))
      .join('');
  const render = (c: LinearComment) =>
    `### ${c.parentId ? 'Reply' : 'Comment'} ${c.id}\nAuthor: ${c.user?.name ?? 'Unattributed author'}\nCreated: ${c.createdAt}\nUpdated: ${c.updatedAt}\n${c.editedAt ? `Edited: ${c.editedAt}\n` : ''}${c.resolvedAt ? `Resolved observation: ${c.resolvedAt}; resolving comment ${c.resolvingCommentId ?? 'unavailable'}\n` : ''}URL: ${c.url}\n\n${c.body}\n\n`;
  return render(root) + descendants(root.id);
}
export function renderLinearIssue(
  source: LinearSourceConfig,
  snapshot: Awaited<ReturnType<ReturnType<typeof createLinearClient>['issueSnapshot']>>,
): LinearRenderedObject {
  const i = snapshot.issue;
  const id = linearDocumentId(source.organizationId, 'issue', i.id);
  const header = provenance(source, 'issue', i.id, i.url);
  const body = `${header}# ${i.identifier}: ${i.title}\nState: ${i.state.name} (${i.state.type}; ${i.state.id})\nTeam: ${i.team.name} (${i.team.id})\nProject: ${i.project ? `${i.project.name} (${i.project.id})` : 'none'}\nCreated: ${i.createdAt}\nUpdated: ${i.updatedAt}\nArchived: ${i.archivedAt ?? 'no'}\n\n## Description\n${i.description ?? '[Description unavailable]'}\n`;
  const result = [...chunks(i.title, body, i.url, i.updatedAt, 'description')];
  for (const root of snapshot.comments
    .filter(c => c.parentId === null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)))
    result.push(
      ...chunks(
        i.title,
        header + `## Complete issue thread ${root.id}\n\n` + thread(snapshot.comments, root),
        root.url,
        sha256HexSync(JSON.stringify([...snapshot.comments].sort((a, b) => a.id.localeCompare(b.id)))),
        `thread-${root.id}`,
      ),
    );
  if (result.length > 2048) throw new Error('Linear chunk budget exceeded.');
  return {documentId: id, chunks: result};
}
export function renderLinearProject(
  source: LinearSourceConfig,
  snapshot: Awaited<ReturnType<ReturnType<typeof createLinearClient>['projectSnapshot']>>,
): readonly LinearRenderedObject[] {
  const p = snapshot.project;
  const objects: LinearRenderedObject[] = [
    {
      documentId: linearDocumentId(source.organizationId, 'project', p.id),
      chunks: chunks(
        p.name,
        provenance(source, 'project', p.id, p.url) +
          `# ${p.name}\n\n${p.description}\n\n${p.content ?? '[Overview content unavailable]'}\n\nInline discussions, milestones and relations are outside V1 coverage.\n`,
        p.url,
        p.updatedAt,
      ),
    },
  ];
  for (const d of snapshot.documents)
    objects.push({
      documentId: linearDocumentId(source.organizationId, 'document', d.id),
      chunks: chunks(
        d.title,
        provenance(source, 'document', d.id, d.url) +
          `# ${d.title}\nProject: ${p.id}\n\n${d.content ?? '[Document content unavailable]'}\n\nInline discussions excluded.\n`,
        d.url,
        d.updatedAt,
      ),
    });
  for (const u of snapshot.updates)
    objects.push({
      documentId: linearDocumentId(source.organizationId, 'update', u.id),
      chunks: chunks(
        `${p.name} update`,
        provenance(source, 'update', u.id, u.url) +
          `# ${p.name}: ${u.health}\nAuthor: ${u.user.name}\nCreated: ${u.createdAt}\nUpdated: ${u.updatedAt}\n\n${u.body}\n\nUpdate comments excluded: Slack origin and discussion completeness are unverified.\n`,
        u.url,
        u.updatedAt,
      ),
    });
  return objects;
}
