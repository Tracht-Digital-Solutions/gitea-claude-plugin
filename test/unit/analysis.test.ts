import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FEATURE_ENDPOINTS,
  endpointSet,
  featuresFromEndpoints,
  parseVersion,
} from '../../src/gitea/capabilities.js';
import { slimHook, slimPull, slimRepo } from '../../src/gitea/models.js';
import { analyzeLog } from '../../src/tools/modules/actions.js';
import { analyzeCommits, commitType, formatDiff, splitDiff } from '../../src/tools/modules/git.js';
import { priorityOf, summarizeIssues } from '../../src/tools/modules/issues.js';
import { buildReleaseNotes } from '../../src/tools/modules/releases.js';

const swagger: unknown = JSON.parse(readFileSync('test/fixtures/gitea-swagger.v1.json', 'utf8'));

describe('capabilities', () => {
  it('parses Gitea and Forgejo versions', () => {
    expect(parseVersion('28.2.0')).toEqual({ semver: [28, 2, 0], forgejo: false });
    expect(parseVersion('1.24.3')).toEqual({ semver: [1, 24, 3], forgejo: false });
    expect(parseVersion('11.0.1+gitea-1.22.0')).toEqual({ semver: [11, 0, 1], forgejo: true });
    expect(parseVersion('dev').semver).toBeUndefined();
  });

  it('every feature endpoint exists in the Gitea OpenAPI document', () => {
    const set = endpointSet(swagger);
    expect(set.size).toBeGreaterThan(400);
    for (const endpoint of Object.values(FEATURE_ENDPOINTS)) expect(set, endpoint).toContain(endpoint);
    expect(Object.values(featuresFromEndpoints(set)).every((v) => v === true)).toBe(true);
  });

  it('marks features unknown without an OpenAPI document and false when missing', () => {
    expect(featuresFromEndpoints(undefined).actions_runs).toBe('unknown');
    expect(featuresFromEndpoints(new Set(['GET /version'])).actions_runs).toBe(false);
  });
});

describe('issue analysis', () => {
  it('derives priorities from common label schemes', () => {
    expect(priorityOf(['priority/critical'])).toBe('critical');
    expect(priorityOf(['Priority: High'])).toBe('high');
    expect(priorityOf(['P1'])).toBe('high');
    expect(priorityOf(['prio/low', 'bug'])).toBe('low');
    expect(priorityOf(['bug', 'enhancement'])).toBeUndefined();
  });

  it('summarises issues by priority, label, assignee, milestone and age', () => {
    const now = Date.parse('2026-06-30T00:00:00Z');
    const mk = (n: number, labels: string[], created: string, assignee?: string) => ({
      number: n,
      title: `Issue ${n}`,
      state: 'open',
      labels: labels.map((name, i) => ({ id: i, name })),
      assignees: assignee ? [{ login: assignee }] : [],
      milestone: n === 1 ? { id: 1, title: 'v1' } : null,
      created_at: created,
      updated_at: created,
      comments: 0,
    });
    const s = summarizeIssues(
      [
        mk(1, ['priority/high', 'bug'], '2026-06-28T00:00:00Z', 'alice'),
        mk(2, ['bug'], '2026-01-01T00:00:00Z'),
        mk(3, ['priority/critical'], '2026-06-01T00:00:00Z', 'bob'),
      ],
      now,
    );
    expect(s.count).toBe(3);
    expect(s.by_priority).toEqual({ high: 1, '(none)': 1, critical: 1 });
    expect(s.by_label.bug).toBe(2);
    expect(s.by_assignee['(unassigned)']).toBe(1);
    expect(s.by_milestone).toEqual({ v1: 1, '(none)': 2 });
    expect(s.age).toEqual({ under_7_days: 1, under_30_days: 1, under_90_days: 0, older: 1 });
    expect(s.stale_count).toBe(1);
    expect(s.top_priority[0]).toMatchObject({ number: 3, priority: 'critical' });
  });
});

describe('commit analysis', () => {
  it('detects conventional commit types and breaking changes', () => {
    expect(commitType('feat(api): add x')).toEqual({ type: 'feat', breaking: false, scope: 'api' });
    expect(commitType('fix!: drop y')).toEqual({ type: 'fix', breaking: true });
    expect(commitType('chore: x\n\nBREAKING CHANGE: z').breaking).toBe(true);
    expect(commitType('Update README')).toEqual({ type: 'other', breaking: false });
  });

  it('aggregates authors and types', () => {
    const c = (msg: string, who: string, date: string) => ({
      sha: '1234567890',
      commit: { message: msg, author: { name: who, email: 'x', date } },
      author: { login: who },
    });
    const a = analyzeCommits([
      c('feat: a', 'alice', '2026-01-02T10:00:00Z'),
      c('fix: b', 'bob', '2026-01-01T10:00:00Z'),
      c('feat: c', 'alice', '2026-01-02T12:00:00Z'),
      c('wip', 'alice', '2026-01-03T12:00:00Z'),
    ]);
    expect(a.commit_count).toBe(4);
    expect(a.authors[0]).toEqual({ name: 'alice', commits: 3 });
    expect(a.conventional_types).toEqual({ feat: 2, fix: 1, other: 1 });
    expect(a.conventional_ratio).toBe(0.75);
    expect(a.first_commit_date).toBe('2026-01-01T10:00:00Z');
  });
});

describe('diff handling', () => {
  const diff = [
    'diff --git a/a.txt b/a.txt',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1 +1,2 @@',
    '-old',
    '+new',
    '+more',
    'diff --git a/b.txt b/b.txt',
    '--- a/b.txt',
    '+++ b/b.txt',
    '@@ -1 +1 @@',
    '-x',
    '+y',
    '',
  ].join('\n');

  it('splits diffs per file with counts', () => {
    expect(splitDiff(diff).map(({ file, additions, deletions }) => ({ file, additions, deletions }))).toEqual(
      [
        { file: 'a.txt', additions: 2, deletions: 1 },
        { file: 'b.txt', additions: 1, deletions: 1 },
      ],
    );
  });

  it('filters files and truncates', () => {
    const out = formatDiff(diff, { files: ['b.txt'], maxChars: 10_000 });
    expect(out.diff).toContain('b.txt');
    expect(out.diff).not.toContain('a/a.txt');
    expect(formatDiff(diff, { maxChars: 20 }).truncated).toBe(true);
  });
});

describe('release notes', () => {
  it('groups commits by type and skips merges', () => {
    const c = (sha: string, message: string, login?: string) => ({
      sha,
      commit: { message, author: { name: 'x', date: '2026-01-01T00:00:00Z' } },
      author: login ? { login } : null,
    });
    const notes = buildReleaseNotes(
      [
        c('aaaaaaaaaa', 'feat(ui): dark mode', 'alice'),
        c('bbbbbbbbbb', 'fix: crash on start'),
        c('cccccccccc', 'feat!: new config format'),
        c('dddddddddd', "Merge branch 'x'"),
        c('eeeeeeeeee', 'tweak things'),
      ],
      { tag: 'v1.0.0', previousTag: 'v0.9.0', compareUrl: 'https://g/x/y/compare/v0.9.0...v1.0.0' },
    );
    expect(notes).toContain('## v1.0.0');
    expect(notes).toContain('### ⚠ Breaking changes\n\n- new config format (ccccccc)');
    expect(notes).toContain('### Features\n\n- **ui:** dark mode (aaaaaaa) (@alice)');
    expect(notes).toContain('### Bug fixes\n\n- crash on start (bbbbbbb)');
    expect(notes).toContain('### Other changes\n\n- tweak things (eeeeeee)');
    expect(notes).not.toContain('Merge branch');
    expect(notes).toContain('**Full changelog:** https://g/x/y/compare/v0.9.0...v1.0.0');
  });
});

describe('log analysis', () => {
  it('extracts error lines and the tail', () => {
    const log = [
      '2026-01-01T00:00:00.000Z step 1',
      'npm ERR! code 1',
      'all good',
      '##[error]Process completed with exit code 1.',
      'done',
    ].join('\n');
    const a = analyzeLog(log, 2);
    expect(a.total_lines).toBe(5);
    expect(a.error_lines.map((l) => l.line)).toEqual([2, 4]);
    expect(a.tail).toBe('##[error]Process completed with exit code 1.\ndone');
  });
});

describe('models', () => {
  it('hides webhook secrets and auth headers', () => {
    const h = slimHook({
      id: 1,
      config: { url: 'https://x', secret: 's3cret' },
      authorization_header: 'Bearer abc',
    });
    expect(JSON.stringify(h)).not.toMatch(/s3cret|abc/);
  });

  it('compacts repositories and pull requests', () => {
    expect(
      slimRepo({ id: 1, full_name: 'a/b', description: '', private: true, owner: { login: 'a' } }),
    ).toEqual({
      id: 1,
      full_name: 'a/b',
      private: true,
    });
    const pr = slimPull({
      number: 3,
      head: { ref: 'f', sha: 'abc', repo: { full_name: 'x/y' } },
      base: { ref: 'main', repo: { full_name: 'a/b' } },
      user: { login: 'u' },
    });
    expect(pr).toMatchObject({ number: 3, head: 'f', base: 'main', head_repo: 'x/y', author: 'u' });
  });
});
