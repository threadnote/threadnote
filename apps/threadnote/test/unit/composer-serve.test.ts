import {describe, expect, it} from 'vitest';
import {resolveComposerServeShareId} from '@threadnote/threadnote/mcp/composer_attach';
import {remoteMemoryConfigFromEnvironment} from '@threadnote/remote-memory/config';
import {
  composerServeEnvironment,
  parseComposerListenAddress,
  releaseFailedComposerStart,
} from '@threadnote/threadnote/remote_memory/composer_serve';
import {LOCAL_COMPOSER_DEFAULT_LISTEN} from '@threadnote/threadnote/remote_memory/local_idp';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const listenAddress = {hostname: '127.0.0.1' as const, port: 18788};

describe('composer serve', () => {
  it('parses loopback listen addresses and refuses Cursor OAuth callback port 8787', () => {
    expect(parseComposerListenAddress(LOCAL_COMPOSER_DEFAULT_LISTEN)).toEqual(listenAddress);
    expect(parseComposerListenAddress('localhost:18788')).toEqual({hostname: '127.0.0.1', port: 18788});
    expect(() => parseComposerListenAddress('127.0.0.1:8787')).toThrow('8787');
    expect(() => parseComposerListenAddress('0.0.0.0:18788')).toThrow('loopback');
    expect(() => parseComposerListenAddress('example.test:18788')).toThrow('loopback');
  });

  it('forces git canonical bodies and a loopback OAuth issuer', () => {
    const environment = composerServeEnvironment({
      databaseUrl: 'postgres://threadnote@127.0.0.1/threadnote',
      gitCloneUrl: 'git@github.com:Kashkovsky/threadnote-share.git',
      gitWorktree: '/tmp/threadnote-share-default',
      listenAddress,
      shareId: 'default',
      subject: 'local:tester',
    });
    expect(environment.THREADNOTE_REMOTE_CANONICAL_STORE).toBe('git');
    expect(environment.THREADNOTE_REMOTE_OAUTH_ISSUER).toBe('http://127.0.0.1:18788');
    expect(Effect.pipe(environment.THREADNOTE_REMOTE_ALLOWED_HOSTS, EffectString.split(','))).toEqual(
      expect.arrayContaining(['127.0.0.1:18788', 'localhost:18788']),
    );
    const config = remoteMemoryConfigFromEnvironment(environment);
    expect(config.canonicalStore).toBe('git');
    expect(config.gitWorktree).toBe('/tmp/threadnote-share-default');
    expect(config.accessTokenIssuer).toBe('http://127.0.0.1:18788');
    expect(config.accessTokenAudience).toBe('http://127.0.0.1:18788/mcp');
    expect(config.allowedOrigins).toEqual(
      expect.arrayContaining(['https://cursor.com', 'http://127.0.0.1:8787', 'http://localhost:8787']),
    );
    expect(config.gitPush).toBe(false);
    expect(
      remoteMemoryConfigFromEnvironment(
        composerServeEnvironment({
          databaseUrl: 'postgres://threadnote@127.0.0.1/threadnote',
          gitCloneUrl: 'git@github.com:Kashkovsky/threadnote-share.git',
          gitPush: true,
          gitWorktree: '/tmp/threadnote-share-default',
          listenAddress,
          shareId: 'default',
          subject: 'local:tester',
        }),
      ).gitPush,
    ).toBe(true);
  });

  it('stops a started composer listener when startup fails after listen', async () => {
    const workers = new AbortController();
    let stopped = false;
    let closed = false;
    await releaseFailedComposerStart({
      closeControlPlane: async () => {
        closed = true;
      },
      server: {
        stop: async () => {
          stopped = true;
        },
      },
      workerTasks: [],
      workers,
    });
    expect(workers.signal.aborted).toBe(true);
    expect(stopped).toBe(true);
    expect(closed).toBe(true);
  });

  it('binds the provisioned control-plane share id to the existing Git team name', () => {
    expect(resolveComposerServeShareId('default')).toBe('default');
    expect(resolveComposerServeShareId('default', ' share-engineering ')).toBe('share-engineering');
    expect(() => resolveComposerServeShareId('default', 'share:other')).toThrow('opaque identifier');
  });
});
