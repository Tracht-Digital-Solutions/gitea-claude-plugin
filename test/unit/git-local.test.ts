import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertBranchName,
  assertRemoteName,
  localContext,
  parseRemoteUrl,
  repoFromRemote,
} from '../../src/git/local.js';

describe('remote parsing', () => {
  it('parses https, ssh and scp-like remotes', () => {
    expect(parseRemoteUrl('https://git.example.com/acme/tool.git')).toEqual({
      host: 'git.example.com',
      path: 'acme/tool',
    });
    expect(parseRemoteUrl('ssh://git@git.example.com:2222/acme/tool.git')).toEqual({
      host: 'git.example.com',
      path: 'acme/tool',
    });
    expect(parseRemoteUrl('git@git.example.com:acme/tool.git')).toEqual({
      host: 'git.example.com',
      path: 'acme/tool',
    });
    expect(parseRemoteUrl('/local/path')).toBeUndefined();
  });

  it('maps remotes to owner/repo only for the configured host', () => {
    const base = new URL('https://git.example.com/');
    expect(repoFromRemote('git@git.example.com:acme/tool.git', base)).toEqual({
      owner: 'acme',
      repo: 'tool',
    });
    expect(repoFromRemote('https://github.com/acme/tool.git', base)).toBeUndefined();
    expect(repoFromRemote('https://git.example.com/a/b/c.git', base)).toBeUndefined();
  });

  it('handles instances under a sub path', () => {
    const base = new URL('https://example.com/gitea/');
    expect(repoFromRemote('https://example.com/gitea/acme/tool.git', base)).toEqual({
      owner: 'acme',
      repo: 'tool',
    });
    expect(repoFromRemote('git@example.com:acme/tool.git', base)).toEqual({ owner: 'acme', repo: 'tool' });
  });
});

describe('argument validation (command injection guard)', () => {
  it.each(['main', 'feature/login', 'release-1.2', 'user/x_y'])('accepts branch %s', (b) => {
    expect(() => {
      assertBranchName(b);
    }).not.toThrow();
  });

  it.each([
    '--upload-pack=evil',
    '-f',
    'a..b',
    'a b',
    'a;rm -rf',
    'a$(id)',
    'a`id`',
    'x~1',
    'x^',
    'x:y',
    'x.lock',
    '.hidden',
    'a//b',
    '',
    '@',
    'a@{1}',
  ])('rejects branch %j', (b) => {
    expect(() => {
      assertBranchName(b);
    }).toThrow();
  });

  it('validates remote names', () => {
    expect(() => {
      assertRemoteName('origin');
    }).not.toThrow();
    expect(() => {
      assertRemoteName('--exec=x');
    }).toThrow();
    expect(() => {
      assertRemoteName('a b');
    }).toThrow();
  });
});

describe('localContext', () => {
  it('reads branch, changes and Gitea remotes of a real repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitea-local-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    writeFileSync(join(dir, 'a.txt'), 'a');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    git('remote', 'add', 'origin', 'git@git.example.com:acme/tool.git');
    writeFileSync(join(dir, 'b.txt'), 'b');
    const lc = await localContext(dir, new URL('https://git.example.com/'));
    expect(lc.branch).toBe('main');
    expect(lc.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(lc.changedFiles).toEqual([{ status: '??', path: 'b.txt' }]);
    expect(lc.remotes).toEqual([
      {
        name: 'origin',
        url: 'git@git.example.com:acme/tool.git',
        giteaRepo: { owner: 'acme', repo: 'tool' },
      },
    ]);
  });
});
