import {Redacted} from 'effect';
import type {LinearSourceConfig} from './config.js';
import {LINEAR_MAX_COLLECTION_ITEMS, linearUuid} from './config.js';
import {createLinearTransport, fail, type LinearClientOptions} from './transport.js';
import {
  COMMENT_FIELDS,
  DOCUMENT_FIELDS,
  ISSUE_FIELDS,
  PAGE_INFO,
  PROJECT_FIELDS,
  UPDATE_FIELDS,
  comment,
  connection,
  document,
  issue,
  object,
  project,
  text,
  update,
  uuid,
  type LinearComment,
  type LinearIssue,
} from './schema.js';
export {
  LinearClientError,
  makeLinearClientBudget,
  type LinearClientOptions,
  type LinearClientBudget,
} from './transport.js';
const CHILD_HINT = `children(first: 1, includeArchived: true) { nodes { id } ${PAGE_INFO} }`;
const COMMENT_NODE = `${COMMENT_FIELDS} ${CHILD_HINT}`;
export function linearIssueInScope(source: LinearSourceConfig, item: LinearIssue): boolean {
  return (
    source.teamIds.includes(item.team.id) &&
    (source.issueIds.includes(item.id) || (item.project !== null && source.projectIds.includes(item.project.id)))
  );
}
export function createLinearClient(token: Redacted.Redacted<string>, options: LinearClientOptions = {}) {
  const transport = createLinearTransport(token, options);
  async function collect<T extends {id: string}>(
    query: string,
    variables: Record<string, unknown>,
    select: (v: Record<string, unknown>) => unknown,
    parse: (v: unknown) => T,
  ): Promise<T[]> {
    const rows: T[] = [];
    const cursors = new Set<string>();
    const ids = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 64; page++) {
      const data = await transport.query(query, {...variables, after: cursor});
      const result = connection(select(data), parse);
      for (const row of result.nodes) {
        if (ids.has(row.id)) fail('contract-incomplete');
        ids.add(row.id);
        rows.push(row);
        if (rows.length > LINEAR_MAX_COLLECTION_ITEMS) fail('contract-incomplete');
      }
      if (!result.more) return rows;
      if (result.cursor === null || cursors.has(result.cursor)) fail('contract-incomplete');
      cursors.add(result.cursor);
      cursor = result.cursor;
    }
    return fail('contract-incomplete');
  }
  const issueDetail = async (id: string) => {
    linearUuid(id);
    const result = issue(
      (await transport.query(`query LinearIssue($id:String!){issue(id:$id){${ISSUE_FIELDS}}}`, {id})).issue,
    );
    if (result.id !== id) fail('contract-invalid');
    return result;
  };
  async function comments(id: string): Promise<LinearComment[]> {
    const hinted = (value: unknown) => {
      const parsed = comment(value);
      const children = connection(object(value).children, v => ({id: uuid(object(v).id)}));
      return {...parsed, hasChildren: children.nodes.length > 0};
    };
    const rows = await collect(
      `query LinearComments($id:String!,$after:String){issue(id:$id){id comments(first:50,after:$after,includeArchived:true){nodes{${COMMENT_NODE}} ${PAGE_INFO}}}}`,
      {id},
      data => {
        const value = object(data.issue);
        if (value.id !== id) fail('contract-invalid');
        return value.comments;
      },
      hinted,
    );
    const byId = new Map(rows.map(row => [row.id, row]));
    const pending = rows.filter(row => row.hasChildren);
    const expanded = new Set<string>();
    while (pending.length) {
      const parent = pending.shift()!;
      if (expanded.has(parent.id)) continue;
      expanded.add(parent.id);
      const children = await collect(
        `query LinearReplies($id:String!,$after:String){comment(id:$id){id children(first:50,after:$after,includeArchived:true){nodes{${COMMENT_NODE}} ${PAGE_INFO}}}}`,
        {id: parent.id},
        data => {
          const value = object(data.comment);
          if (value.id !== parent.id) fail('contract-invalid');
          return value.children;
        },
        hinted,
      );
      for (const child of children) {
        if (child.parentId !== parent.id) fail('contract-incomplete');
        const previous = byId.get(child.id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(child)) fail('revision-changed');
        byId.set(child.id, child);
        if (child.hasChildren) pending.push(child);
        if (byId.size > LINEAR_MAX_COLLECTION_ITEMS) fail('contract-incomplete');
      }
    }
    const all = [...byId.values()];
    for (const row of all) {
      const visited = new Set<string>();
      let current: typeof row | undefined = row;
      while (current?.parentId) {
        if (visited.has(current.id)) fail('contract-incomplete');
        visited.add(current.id);
        if (visited.size > 64) fail('contract-incomplete');
        current = byId.get(current.parentId);
        if (!current) fail('contract-incomplete');
      }
      if (row.resolvingCommentId && !byId.has(row.resolvingCommentId)) fail('contract-incomplete');
    }
    return all
      .filter(row => {
        let current: typeof row | undefined = row;
        while (current) {
          if (current.documentContentId !== null) return false;
          current = current.parentId ? byId.get(current.parentId) : undefined;
        }
        return true;
      })
      .map(({hasChildren: _, ...row}) => row)
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  const projectDetail = async (id: string) => {
    linearUuid(id);
    const result = project(
      (await transport.query(`query LinearProject($id:String!){project(id:$id){${PROJECT_FIELDS}}}`, {id})).project,
    );
    if (result.id !== id) fail('contract-invalid');
    return result;
  };
  return {
    query: transport.query,
    budget: transport.budget,
    close: transport.close,
    get requests() {
      return transport.requests;
    },
    get expired() {
      return transport.expired;
    },
    async identity() {
      const data = await transport.query('query LinearIdentity{organization{id} viewer{id}}');
      return {organizationId: uuid(object(data.organization).id), principalId: uuid(object(data.viewer).id)};
    },
    async team(id: string) {
      linearUuid(id);
      const result = object(
        (await transport.query('query LinearTeam($id:String!){team(id:$id){id name organization{id}}}', {id})).team,
      );
      if (result.id !== id) fail('contract-invalid');
      return {id: uuid(result.id), name: text(result.name, 1024), organizationId: uuid(object(result.organization).id)};
    },
    issueDetail,
    projectDetail,
    async listProjectIssues(source: LinearSourceConfig, id: string) {
      if (!source.projectIds.includes(id)) fail('scope-rejected');
      return collect(
        `query LinearProjectIssues($id:String!,$after:String,$teams:[ID!]!){project(id:$id){id issues(first:50,after:$after,includeArchived:true,filter:{team:{id:{in:$teams}}}){nodes{${ISSUE_FIELDS}} ${PAGE_INFO}}}}`,
        {id, teams: [...source.teamIds]},
        data => {
          const parent = object(data.project);
          if (parent.id !== id) fail('contract-invalid');
          return parent.issues;
        },
        value => {
          const item = issue(value);
          if (!linearIssueInScope(source, item) || item.project?.id !== id) fail('scope-rejected');
          return item;
        },
      );
    },
    async issueSnapshot(source: LinearSourceConfig, id: string) {
      const before = await issueDetail(id);
      if (!linearIssueInScope(source, before)) fail('scope-rejected');
      const discussion = await comments(id);
      const after = await issueDetail(id);
      if (!linearIssueInScope(source, after)) fail('scope-rejected');
      const confirmed = await comments(id);
      if (JSON.stringify(before) !== JSON.stringify(after) || JSON.stringify(discussion) !== JSON.stringify(confirmed))
        fail('revision-changed');
      return {issue: after, comments: confirmed};
    },
    async projectSnapshot(source: LinearSourceConfig, id: string) {
      if (!source.projectIds.includes(id)) fail('scope-rejected');
      const before = await projectDetail(id);
      const docs = () =>
        collect(
          `query LinearDocuments($id:String!,$after:String){project(id:$id){id documents(first:50,after:$after,includeArchived:true){nodes{${DOCUMENT_FIELDS}} ${PAGE_INFO}}}}`,
          {id},
          data => {
            const value = object(data.project);
            if (value.id !== id) fail('contract-invalid');
            return value.documents;
          },
          value => {
            const item = document(value);
            if (item.project.id !== id) fail('scope-rejected');
            return item;
          },
        );
      const updates = () =>
        collect(
          `query LinearUpdates($id:String!,$after:String){project(id:$id){id projectUpdates(first:50,after:$after,includeArchived:true){nodes{${UPDATE_FIELDS}} ${PAGE_INFO}}}}`,
          {id},
          data => {
            const value = object(data.project);
            if (value.id !== id) fail('contract-invalid');
            return value.projectUpdates;
          },
          value => {
            const item = update(value);
            if (item.project.id !== id) fail('scope-rejected');
            return item;
          },
        );
      const documents = await docs();
      const authoredUpdates = await updates();
      const after = await projectDetail(id);
      const confirmedDocs = await docs();
      const confirmedUpdates = await updates();
      if (
        JSON.stringify(before) !== JSON.stringify(after) ||
        JSON.stringify(documents) !== JSON.stringify(confirmedDocs) ||
        JSON.stringify(authoredUpdates) !== JSON.stringify(confirmedUpdates)
      )
        fail('revision-changed');
      return {project: after, documents, updates: authoredUpdates};
    },
  };
}
