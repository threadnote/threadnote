import type {LinearSourceConfig} from '@threadnote/integration-linear/config';
import type {LinearComment, LinearIssue} from '@threadnote/integration-linear/schema';
export const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
export const time = '2026-10-08T12:00:00.000Z';
export const source: LinearSourceConfig = {
  type: 'linear',
  id: 'test-linear',
  enabled: true,
  organizationId: uuid(1),
  principalId: uuid(2),
  teamIds: [uuid(3)],
  projectIds: [],
  issueIds: [uuid(4)],
  project: 'threadnote',
  credentialEnv: 'THREADNOTE_LINEAR_TEST_KEY',
  refreshIntervalMinutes: 60,
  maxStaleHours: 24,
};
export const issue: LinearIssue = {
  id: uuid(4),
  identifier: 'TEST-1',
  title: 'Synthetic requirements',
  description: 'needle requirements',
  url: 'https://linear.app/synthetic/issue/TEST-1/requirements',
  createdAt: time,
  updatedAt: time,
  archivedAt: null,
  team: {id: uuid(3), name: 'Synthetic team'},
  project: null,
  state: {id: uuid(5), name: 'Started', type: 'started'},
};
interface FixtureConnection<T> {
  readonly nodes: readonly T[];
  readonly pageInfo: {readonly hasNextPage: boolean; readonly endCursor: string | null};
}
export const comment = (
  n: number,
  parentId: string | null = null,
): LinearComment & {readonly children: FixtureConnection<{readonly id: string}>} => ({
  id: uuid(n),
  body: `Synthetic reasoning ${n}`,
  url: `https://linear.app/synthetic/issue/TEST-1/requirements#comment-${uuid(n)}`,
  createdAt: time,
  updatedAt: time,
  editedAt: null,
  parentId,
  resolvedAt: null,
  resolvingCommentId: null,
  documentContentId: null,
  user: {id: uuid(2), name: 'Synthetic author'},
  children: {nodes: [], pageInfo: {hasNextPage: false, endCursor: null}},
});
export const connection = <T>(
  nodes: readonly T[],
  more = false,
  cursor: string | null = null,
): FixtureConnection<T> => ({
  nodes,
  pageInfo: {hasNextPage: more, endCursor: cursor},
});
export const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify({data}), {status, headers: {'content-type': 'application/json'}});
export type GraphRequest = {query: string; variables: Record<string, unknown>};
export const request = (init: RequestInit): GraphRequest => JSON.parse(String(init.body));
export const safeFetch = async (_url: URL, init: RequestInit): Promise<Response> => {
  const req = request(init);
  if (req.query.includes('LinearIdentity')) return response({organization: {id: uuid(1)}, viewer: {id: uuid(2)}});
  if (req.query.includes('LinearTeam'))
    return response({team: {id: uuid(3), name: 'Synthetic team', organization: {id: uuid(1)}}});
  if (req.query.includes('LinearIssue(')) return response({issue});
  if (req.query.includes('LinearComments'))
    return response({issue: {id: issue.id, comments: connection([comment(10)])}});
  throw new Error('Unrecognized synthetic GraphQL operation');
};
