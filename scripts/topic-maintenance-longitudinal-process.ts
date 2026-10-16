/** Bound child output while reading, before it can exhaust the evaluation process. */
export async function readBoundedChildOutput(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  terminate: () => void,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        terminate();
        throw new Error('Child output exceeded bounded capture.');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/** Caller Git controls are never allowed to redirect fixture operations or load hooks/config. */
export function topicStudyEnvironment(input: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input))
    if (
      value !== undefined &&
      !key.toUpperCase().startsWith('GIT_') &&
      ![
        'NODE_OPTIONS',
        'NODE_PATH',
        'BUN_OPTIONS',
        'LD_PRELOAD',
        'DYLD_INSERT_LIBRARIES',
        'DYLD_LIBRARY_PATH',
      ].includes(key.toUpperCase())
    )
      env[key] = value;
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/dev/null',
    GIT_CONFIG_KEY_1: 'init.templateDir',
    GIT_CONFIG_VALUE_1: '',
  };
}

/** The authored final transition runs on success, refusal, exception, and process failure. */
export async function withTopicStudyTimeline<T>(
  before: () => Promise<void>,
  after: () => Promise<void>,
  action: (postReview: () => Promise<void>) => Promise<T>,
): Promise<T> {
  let completed = false;
  const postReview = async () => {
    if (!completed) {
      await after();
      completed = true;
    }
  };
  try {
    await before();
    return await action(postReview);
  } finally {
    await postReview();
  }
}

/** Identical authored source history in every isolated arm, including commit metadata. */
export function topicStudyCommitEnvironment(
  env: Readonly<Record<string, string>>,
  eventIndex: number,
  postReview = false,
) {
  const date = new Date(Date.UTC(2020, 0, 1) + (eventIndex * 2 + (postReview ? 1 : 0)) * 1000).toISOString();
  return {...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date};
}
