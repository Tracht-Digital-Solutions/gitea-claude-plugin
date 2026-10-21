import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GiteaError, ifFound, isGiteaError } from '../../src/gitea/errors.js';
import { readWorkdirFile, resolveInWorkdir } from '../../src/security/workdir.js';
import { listResult } from '../../src/tools/common.js';
import { mapLimit } from '../../src/util/concurrency.js';
import { globMatch, globToRegExp, isGlob } from '../../src/util/glob.js';

describe('glob', () => {
  it('matches within and across path segments', () => {
    expect(globMatch('release/*', 'release/1.0')).toBe(true);
    expect(globMatch('release/*', 'release/1.0/hotfix')).toBe(false);
    expect(globMatch('release/**', 'release/1.0/hotfix')).toBe(true);
    expect(globMatch('src/**/*.ts', 'src/a.ts')).toBe(true);
    expect(globMatch('src/**/*.ts', 'src/a/b/c.ts')).toBe(true);
    expect(globMatch('ci/?', 'ci/a')).toBe(true);
    expect(globMatch('v1.0', 'v1x0')).toBe(false);
  });

  it('is case-sensitive unless requested', () => {
    expect(globMatch('*.MD', 'readme.md')).toBe(false);
    expect(globToRegExp('*.MD', { caseInsensitive: true }).test('readme.md')).toBe(true);
  });

  it('detects glob syntax', () => {
    expect(isGlob('*.ts')).toBe(true);
    expect(isGlob('README.md')).toBe(false);
  });
});

describe('error helpers', () => {
  it('maps NOT_FOUND to undefined and re-throws other errors', async () => {
    await expect(ifFound(Promise.resolve(1))).resolves.toBe(1);
    await expect(ifFound(Promise.reject(new GiteaError('NOT_FOUND', 'x')))).resolves.toBeUndefined();
    await expect(ifFound(Promise.reject(new GiteaError('FORBIDDEN', 'x')))).rejects.toThrow('x');
  });

  it('checks error codes', () => {
    const err = new GiteaError('CONFLICT', 'x');
    expect(isGiteaError(err)).toBe(true);
    expect(isGiteaError(err, 'NOT_FOUND', 'CONFLICT')).toBe(true);
    expect(isGiteaError(err, 'NOT_FOUND')).toBe(false);
    expect(isGiteaError(new Error('x'))).toBe(false);
  });
});

describe('listResult', () => {
  it('builds the uniform list shape and omits an unknown total', () => {
    expect(listResult({ items: [1, 2], totalCount: 5, hasMore: true }, 'n', (x) => x * 10)).toEqual({
      total: 5,
      has_more: true,
      n: [10, 20],
    });
    expect(listResult({ items: [], totalCount: undefined, hasMore: false }, 'n', (x) => x)).toEqual({
      has_more: false,
      n: [],
    });
  });
});

describe('mapLimit', () => {
  it('keeps the order and respects the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 3, 2], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, n));
      active--;
      return n * 2;
    });
    expect(out).toEqual([10, 2, 6, 4]);
    expect(peak).toBe(2);
  });
});

describe('workdir confinement', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gitea-workdir-'));
  writeFileSync(join(dir, 'a.txt'), 'hello');
  mkdirSync(join(dir, 'sub'));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts paths inside and rejects paths outside the working directory', () => {
    expect(resolveInWorkdir(dir, 'sub/x.zip', 'write')).toBe(join(dir, 'sub', 'x.zip'));
    expect(() => resolveInWorkdir(dir, '../x', 'write')).toThrow(/inside the working directory/);
    expect(() => resolveInWorkdir(dir, join(tmpdir(), 'x'), 'read')).toThrow(/can be uploaded/);
  });

  it('reads regular files and enforces type and size', async () => {
    const file = await readWorkdirFile(dir, 'a.txt', 100);
    expect(file.name).toBe('a.txt');
    expect(file.data.toString()).toBe('hello');
    await expect(readWorkdirFile(dir, 'sub', 100)).rejects.toThrow(/not a file/);
    await expect(readWorkdirFile(dir, 'missing.txt', 100)).rejects.toThrow(/not a readable file/);
    await expect(readWorkdirFile(dir, 'a.txt', 2)).rejects.toThrow(/larger than/);
  });
});
