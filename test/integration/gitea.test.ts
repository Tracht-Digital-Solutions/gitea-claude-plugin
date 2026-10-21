import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_TOOLS } from '../../src/tools/registry.js';
import {
  api,
  calledTools,
  harness,
  loadItEnv,
  recorded,
  waitUntil,
  type Harness,
  type ItEnv,
} from './harness.js';

const env = loadItEnv();
if (!env && process.env.GITEA_IT_REQUIRED === '1') {
  throw new Error('GITEA_IT_REQUIRED=1 but no test instance: run `npm run gitea:up` first.');
}

const run = Date.now().toString(36);
const REPO = `it-repo-${run}`;
const ORG = `it-org-${run}`;
const REVIEWER = `it-reviewer-${run}`;
const REVIEWER_PASSWORD = `Rv-${run}-Passw0rd!`;

type Obj = Record<string, any>;

describe.skipIf(!env)('Gitea integration', () => {
  const e = env as ItEnv;
  let h: Harness;
  let owner: string;
  let cwd: string;
  const state: Obj = {};

  beforeAll(async () => {
    cwd = mkdtempSync(join(tmpdir(), 'gitea-it-cwd-'));
    h = await harness(e, { cwd });
    owner = e.username;
    await api(e, 'POST', '/admin/users', {
      username: REVIEWER,
      email: `${REVIEWER}@example.com`,
      password: REVIEWER_PASSWORD,
      must_change_password: false,
    });
  });

  afterAll(async () => {
    await h.close();
  });

  describe('connection', () => {
    it('connection_test reports version, user, scopes and features', async () => {
      const r = await h.call('connection_test');
      expect(r.ok).toBe(true);
      expect(r.gitea_version).toBe(e.version);
      expect(r.authenticated_as.login).toBe(owner);
      expect(r.feature_detection).toBe('swagger');
      expect(r.features.actions_runs).toBe(true);
      expect(Object.values(r.read_scopes)).toEqual(expect.arrayContaining(['granted']));
      expect(r.enabled_operations).toEqual({ read: true, write: true, destructive: true, admin: true });
    });

    it('profiles_list shows the profile without the token', async () => {
      const r = await h.call('profiles_list');
      expect(r.profiles[0].token_configured).toBe(true);
      expect(JSON.stringify(r)).not.toContain(e.token);
    });

    it('reports an invalid token clearly', async () => {
      const bad = await harness(e, { token: 'invalid-token-0000000000000000000000000000' });
      const r = await bad.call('connection_test');
      expect(r.ok).toBe(false);
      expect(r.authentication_error.code).toBe('UNAUTHORIZED');
      expect(JSON.stringify(r)).not.toContain('invalid-token-0000');
      await bad.close();
    });

    it('reports missing write scopes of a restricted token', async () => {
      const t = await api<{ sha1: string }>(
        e,
        'POST',
        `/users/${owner}/tokens`,
        { name: `ro-${run}`, scopes: ['read:repository', 'read:user'] },
        true,
      );
      const ro = await harness(e, { token: t.sha1 });
      const status = await ro.call('connection_test');
      expect(status.read_scopes['read:repository']).toBe('granted');
      expect(status.read_scopes['read:issue']).toBe('missing');
      const err = await ro.fail('repo_create', { name: `ro-${run}` });
      expect(err.code).toBe('FORBIDDEN');
      expect(err.hint).toMatch(/scope/);
      await ro.close();
    });

    it('needs write:user (not only write:repository) to create a repository', async () => {
      // Documented in docs/CONFIGURATION.md: Gitea assigns POST /user/repos to the user scope.
      const scoped = async (name: string, scopes: string[]) =>
        (await api<{ sha1: string }>(e, 'POST', `/users/${owner}/tokens`, { name, scopes }, true)).sha1;
      const repoOnly = await harness(e, {
        token: await scoped(`wr-${run}`, ['write:repository', 'write:issue', 'read:user']),
      });
      const err = await repoOnly.fail('repo_create', { name: `wr-${run}` });
      expect(err.code).toBe('FORBIDDEN');
      expect(err.message).toContain('write:user');
      await repoOnly.close();
      const recommended = await harness(e, {
        token: await scoped(`rec-${run}`, [
          'write:repository',
          'write:issue',
          'write:user',
          'read:organization',
          'write:notification',
        ]),
      });
      const created = await recommended.call('repo_create', { name: `rec-${run}` });
      expect(created.repository.private).toBe(true);
      await recommended.call('repo_delete', { owner, repo: `rec-${run}` });
      await recommended.close();
    });
  });

  describe('repositories and contents', () => {
    it('creates, reads, lists and searches a repository', async () => {
      const created = await h.call('repo_create', {
        name: REPO,
        description: 'integration',
        auto_init: true,
        private: true,
      });
      expect(created.repository.full_name).toBe(`${owner}/${REPO}`);
      expect(created.repository.private).toBe(true);
      const conflict = await h.fail('repo_create', { name: REPO });
      expect(conflict.code).toBe('CONFLICT');
      const got = await h.call('repo_get', { owner, repo: REPO });
      expect(got.default_branch).toBe('main');
      const list = await h.call('repo_list', { limit: 50 });
      expect(list.repositories.map((r: Obj) => r.full_name)).toContain(`${owner}/${REPO}`);
      const listOwner = await h.call('repo_list', { owner });
      expect(listOwner.repositories.length).toBeGreaterThan(0);
      const search = await h.call('repo_search', { query: REPO });
      expect(search.repositories[0].full_name).toBe(`${owner}/${REPO}`);
      const missing = await h.fail('repo_get', { owner, repo: 'does-not-exist' });
      expect(missing.code).toBe('NOT_FOUND');
    });

    it('updates settings, topics, visibility and archive state', async () => {
      const up = await h.call('repo_update', { owner, repo: REPO, description: 'updated', has_wiki: false });
      expect(up.repository.description).toBe('updated');
      await h.call('repo_topics_set', { owner, repo: REPO, topics: ['mcp', 'integration'] });
      const vis = await h.call('repo_set_visibility', { owner, repo: REPO, private: false });
      expect(vis.repository.private).toBe(false);
      await h.call('repo_set_visibility', { owner, repo: REPO, private: true });
      const arch = await h.call('repo_archive', { owner, repo: REPO, archived: true });
      expect(arch.repository.archived).toBe(true);
      await h.call('repo_archive', { owner, repo: REPO, archived: false });
    });

    it('creates, reads, updates, lists and searches files', async () => {
      await h.call('file_create', {
        owner,
        repo: REPO,
        path: 'src/hello.ts',
        content: 'export const hello = "world";\n',
      });
      const f = await h.call('file_get', { owner, repo: REPO, path: 'src/hello.ts' });
      expect(f.content).toContain('hello');
      state.helloSha = f.sha;
      await h.call('file_update', {
        owner,
        repo: REPO,
        path: 'src/hello.ts',
        content: 'export const hello = "gitea";\n',
        message: 'feat: greet gitea',
      });
      const commit = await h.call('files_commit', {
        owner,
        repo: REPO,
        message: 'chore: add docs and config',
        files: [
          { operation: 'create', path: 'docs/guide.md', content: '# Guide\nSearch me: NEEDLE-42\n' },
          { operation: 'create', path: 'config/app.json', content: '{"a":1}\n' },
          { operation: 'update', path: 'README.md', content: `# ${REPO}\n` },
        ],
      });
      expect(commit.commit).toMatch(/^[0-9a-f]{40}$/);
      const dir = await h.call('dir_list', { owner, repo: REPO });
      expect(dir.entries.map((x: Obj) => x.name)).toEqual(
        expect.arrayContaining(['src', 'docs', 'README.md']),
      );
      const tree = await h.call('tree_get', { owner, repo: REPO });
      expect(tree.entries).toEqual(expect.arrayContaining(['src/hello.ts (30 B)']));
      const found = await h.call('files_find', { owner, repo: REPO, pattern: '**/*.md' });
      expect(found.files).toEqual(expect.arrayContaining(['docs/guide.md', 'README.md']));
      const grep = await h.call('code_search', { owner, repo: REPO, query: 'needle-42' });
      expect(grep.matches).toEqual([{ path: 'docs/guide.md', line: 2, text: 'Search me: NEEDLE-42' }]);
      const asDir = await h.call('file_get', { owner, repo: REPO, path: 'docs' });
      expect(asDir.type).toBe('dir');
      const traversal = await h.fail('file_get', { owner, repo: REPO, path: '../../etc/passwd' });
      expect(traversal.code).toBe('INVALID_INPUT');
    });

    it('deletes a file with confirmation', async () => {
      await h.call('file_create', { owner, repo: REPO, path: 'tmp.txt', content: 'x' });
      const r = await h.call('file_delete', { owner, repo: REPO, path: 'tmp.txt' });
      expect(r.deleted).toBe('tmp.txt');
    });
  });

  describe('branches, commits and tags', () => {
    it('manages branches and compares them', async () => {
      const b = await h.call('branch_create', { owner, repo: REPO, branch: 'feature/a' });
      expect(b.branch.name).toBe('feature/a');
      await h.call('file_update', {
        owner,
        repo: REPO,
        path: 'src/hello.ts',
        branch: 'feature/a',
        content: 'export const hello = "feature";\n',
        message: 'feat(hello): feature greeting',
      });
      const list = await h.call('branch_list', { owner, repo: REPO });
      expect(list.branches.map((x: Obj) => x.name)).toEqual(expect.arrayContaining(['main', 'feature/a']));
      const one = await h.call('branch_get', { owner, repo: REPO, branch: 'feature/a' });
      expect(one.commit_message).toMatch(/feature greeting/);
      const cmp = await h.call('compare', {
        owner,
        repo: REPO,
        base: 'main',
        head: 'feature/a',
        include_diff: true,
      });
      expect(cmp.total_commits).toBe(1);
      expect(cmp.changed_files).toEqual([{ filename: 'src/hello.ts', status: 'modified' }]);
      expect(cmp.diff).toContain('+export const hello = "feature";');
      const fc = await h.call('file_compare', {
        owner,
        repo: REPO,
        path: 'src/hello.ts',
        base: 'main',
        head: 'feature/a',
      });
      expect(fc.status).toBe('modified');
      expect(fc.diff).toContain('-export const hello = "gitea";');
    });

    it('lists, inspects and analyses commits', async () => {
      const list = await h.call('commit_list', { owner, repo: REPO, with_files: true });
      expect(list.commits.length).toBeGreaterThanOrEqual(3);
      state.headSha = list.commits[0].sha;
      const c = await h.call('commit_get', { owner, repo: REPO, sha: state.headSha, include_diff: true });
      expect(c.files.length).toBeGreaterThan(0);
      expect(c.diff.files.length).toBeGreaterThan(0);
      const byPath = await h.call('commit_list', { owner, repo: REPO, path: 'src/hello.ts' });
      expect(byPath.commits.length).toBe(2);
      const a = await h.call('commit_history_analyze', { owner, repo: REPO });
      expect(a.commit_count).toBeGreaterThanOrEqual(3);
      expect(a.authors[0].name).toBeTruthy();
      const status = await h.call('commit_status_get', { owner, repo: REPO, ref: 'main' });
      expect(status.sha).toMatch(/^[0-9a-f]{40}$/);
    });

    it('creates, lists, reads and deletes tags', async () => {
      await h.call('tag_create', { owner, repo: REPO, tag: 'v0.0.1', message: 'first' });
      const tags = await h.call('tag_list', { owner, repo: REPO });
      expect(tags.tags.map((t: Obj) => t.name)).toContain('v0.0.1');
      const t = await h.call('tag_get', { owner, repo: REPO, tag: 'v0.0.1' });
      expect(t.message).toBe('first');
      await h.call('tag_create', { owner, repo: REPO, tag: 'tmp-tag' });
      expect((await h.call('tag_delete', { owner, repo: REPO, tag: 'tmp-tag' })).deleted).toBe('tmp-tag');
    });

    it('manages branch and tag protection', async () => {
      const created = await h.call('branch_protection_set', {
        owner,
        repo: REPO,
        rule_name: 'main',
        required_approvals: 1,
      });
      expect(created.action).toBe('created');
      const updated = await h.call('branch_protection_set', {
        owner,
        repo: REPO,
        rule_name: 'main',
        required_approvals: 0,
      });
      expect(updated.action).toBe('updated');
      const list = await h.call('branch_protection_list', { owner, repo: REPO });
      expect(list.rules[0].rule_name).toBe('main');
      const tp = await h.call('tag_protection_create', {
        owner,
        repo: REPO,
        name_pattern: 'v*',
        whitelist_usernames: [owner],
      });
      const tpl = await h.call('tag_protection_list', { owner, repo: REPO });
      expect(tpl.rules.length).toBe(1);
      await h.call('tag_protection_delete', { owner, repo: REPO, id: tp.rule.id });
      await h.call('branch_protection_delete', { owner, repo: REPO, rule_name: 'main' });
      expect((await h.call('branch_protection_list', { owner, repo: REPO })).rules).toEqual([]);
    });
  });

  describe('issues, labels and milestones', () => {
    it('manages labels and milestones', async () => {
      state.bug = (await h.call('label_create', { owner, repo: REPO, name: 'bug', color: 'ee0701' })).label;
      state.high = (
        await h.call('label_create', { owner, repo: REPO, name: 'priority/high', color: '#ff9900' })
      ).label;
      const tmp = (await h.call('label_create', { owner, repo: REPO, name: 'tmp', color: '000000' })).label;
      const up = await h.call('label_update', { owner, repo: REPO, id: tmp.id, description: 'temporary' });
      expect(up.label.description).toBe('temporary');
      await h.call('label_delete', { owner, repo: REPO, id: tmp.id });
      const labels = await h.call('label_list', { owner, repo: REPO });
      expect(labels.labels.map((l: Obj) => l.name).sort()).toEqual(['bug', 'priority/high']);
      state.ms = (
        await h.call('milestone_create', { owner, repo: REPO, title: 'v1.0', due_on: '2030-01-01T00:00:00Z' })
      ).milestone;
      const ms2 = (await h.call('milestone_create', { owner, repo: REPO, title: 'later' })).milestone;
      const closed = await h.call('milestone_update', { owner, repo: REPO, id: ms2.id, state: 'closed' });
      expect(closed.milestone.state).toBe('closed');
      await h.call('milestone_delete', { owner, repo: REPO, id: ms2.id });
      const mss = await h.call('milestone_list', { owner, repo: REPO, state: 'all' });
      expect(mss.milestones.map((m: Obj) => m.title)).toEqual(['v1.0']);
    });

    it('creates, edits, assigns, labels and comments issues', async () => {
      const i1 = await h.call('issue_create', {
        owner,
        repo: REPO,
        title: 'Crash on start',
        body: 'Steps…',
        labels: ['bug', 'priority/high'],
        milestone: 'v1.0',
        assignees: [owner],
      });
      expect(i1.issue).toMatchObject({
        number: 1,
        labels: ['bug', 'priority/high'],
        milestone: 'v1.0',
        assignees: [owner],
      });
      await h.call('issue_create', { owner, repo: REPO, title: 'Docs typo' });
      const badLabel = await h.fail('issue_create', { owner, repo: REPO, title: 'x', labels: ['nope'] });
      expect(badLabel.hint).toMatch(/Existing labels/);
      const upd = await h.call('issue_update', {
        owner,
        repo: REPO,
        number: 2,
        title: 'Docs typo in README',
        body: 'line 3',
      });
      expect(upd.issue.title).toBe('Docs typo in README');
      await h.call('issue_labels', { owner, repo: REPO, number: 2, add: ['bug'] });
      const lbl = await h.call('issue_labels', {
        owner,
        repo: REPO,
        number: 2,
        replace: ['priority/high'],
        remove: [],
      });
      expect(lbl.labels.map((l: Obj) => l.name)).toEqual(['priority/high']);
      const asg = await h.call('issue_assign', { owner, repo: REPO, number: 2, add: [owner] });
      expect(asg.issue.assignees).toEqual([owner]);
      const c = await h.call('issue_comment_create', {
        owner,
        repo: REPO,
        number: 1,
        body: 'Investigating.',
      });
      await h.call('issue_comment_update', {
        owner,
        repo: REPO,
        comment_id: c.comment.id,
        body: 'Investigating (updated).',
      });
      const extra = await h.call('issue_comment_create', { owner, repo: REPO, number: 1, body: 'to delete' });
      await h.call('issue_comment_delete', { owner, repo: REPO, comment_id: extra.comment.id });
      const comments = await h.call('issue_comment_list', { owner, repo: REPO, number: 1 });
      expect(comments.comments.map((x: Obj) => x.body)).toEqual(['Investigating (updated).']);
      const got = await h.call('issue_get', { owner, repo: REPO, number: 1 });
      expect(got.comment_list).toHaveLength(1);
    });

    it('filters, searches, summarises and closes issues', async () => {
      const byLabel = await h.call('issue_list', { owner, repo: REPO, labels: ['bug'] });
      expect(byLabel.issues.map((i: Obj) => i.number)).toEqual([1]);
      const byPrio = await h.call('issue_list', { owner, repo: REPO, priority: 'high' });
      expect(byPrio.issues.map((i: Obj) => i.number).sort()).toEqual([1, 2]);
      const byAssignee = await h.call('issue_list', { owner, repo: REPO, assigned_to: owner });
      expect(byAssignee.issues.length).toBe(2);
      const search = await h.call('issue_search', { query: 'Crash', owner });
      expect(search.issues.map((i: Obj) => i.title)).toContain('Crash on start');
      const sum = await h.call('issues_summary', { owner, repo: REPO });
      expect(sum.count).toBe(2);
      expect(sum.by_priority.high).toBe(2);
      expect(sum.by_milestone['v1.0']).toBe(1);
      const closed = await h.call('issue_set_state', {
        owner,
        repo: REPO,
        number: 2,
        state: 'closed',
        comment: 'Fixed.',
      });
      expect(closed.issue.state).toBe('closed');
      const reopened = await h.call('issue_set_state', { owner, repo: REPO, number: 2, state: 'open' });
      expect(reopened.issue.state).toBe('open');
    });
  });

  describe('projects', () => {
    it('manages a repository kanban board with issues', async () => {
      const created = await h.call('project_create', {
        owner,
        repo: REPO,
        title: 'Sprint 1',
        description: 'Integration board',
        template: 'basic_kanban',
      });
      const id = created.project.id;
      const titles = created.columns.map((c: Obj) => c.title);
      expect(titles.length).toBeGreaterThanOrEqual(3);
      const list = await h.call('project_list', { owner, repo: REPO });
      expect(list.projects.map((p: Obj) => p.title)).toContain('Sprint 1');
      // basic_kanban creates every column with sorting 0; a new column still gets a defined place.
      const added = await h.call('project_column_create', {
        owner,
        repo: REPO,
        id,
        title: 'Review',
        color: '00aabb',
      });
      expect(added.order.at(-1)).toBe('Review');
      const reordered = await h.call('project_column_move', {
        owner,
        repo: REPO,
        id,
        column: 'Review',
        position: titles.length,
      });
      expect(reordered.order).toEqual([...titles.slice(0, -1), 'Review', titles.at(-1)]);
      const blocked = await h.call('project_column_create', {
        owner,
        repo: REPO,
        id,
        title: 'Blocked',
        position: 1,
      });
      expect(blocked.order[0]).toBe('Blocked');
      expect(
        (await h.call('project_get', { owner, repo: REPO, id })).columns.map((c: Obj) => c.title),
      ).toEqual(blocked.order);
      await h.call('project_column_delete', { owner, repo: REPO, id, column: 'Blocked' });
      await h.call('project_column_update', {
        owner,
        repo: REPO,
        id,
        column: 'Review',
        title: 'Code Review',
      });
      await h.call('project_column_update', { owner, repo: REPO, id, column: titles[0], make_default: true });
      await h.call('project_issue_add', { owner, repo: REPO, id, numbers: [1, 2] });
      const moved = await h.call('project_issue_move', {
        owner,
        repo: REPO,
        id,
        numbers: [1],
        column: 'Code Review',
      });
      expect(moved.moved).toEqual([1]);
      const board = await h.call('project_get', { owner, repo: REPO, id });
      const byCol = Object.fromEntries(
        board.columns.map((c: Obj) => [c.title, c.issues.map((i: Obj) => i.number)]),
      );
      expect(byCol['Code Review']).toEqual([1]);
      expect(byCol[titles[0]]).toEqual([2]);
      const bad = await h.fail('project_issue_move', { owner, repo: REPO, id, numbers: [2], column: 'Nope' });
      expect(bad.hint).toMatch(/Code Review/);
      await h.call('project_issue_remove', { owner, repo: REPO, id, numbers: [2], column: titles[0] });
      await h.call('project_column_delete', { owner, repo: REPO, id, column: 'Code Review' });
      const after = await h.call('project_get', { owner, repo: REPO, id });
      expect(after.columns.map((c: Obj) => c.title)).not.toContain('Code Review');
      const closed = await h.call('project_update', { owner, repo: REPO, id, state: 'closed' });
      expect(closed.project.state).toBe('closed');
      expect((await h.call('project_delete', { owner, repo: REPO, id })).deleted).toBe(id);
    });

    it('creates user projects with custom columns', async () => {
      const created = await h.call('project_create', {
        scope: 'user',
        title: `Personal ${run}`,
        columns: ['Backlog', 'Doing', 'Done'],
      });
      expect(created.columns.map((c: Obj) => c.title)).toEqual(['Backlog', 'Doing', 'Done']);
      const list = await h.call('project_list', { scope: 'user' });
      expect(list.projects.map((p: Obj) => p.id)).toContain(created.project.id);
      await h.call('project_issue_add', {
        scope: 'user',
        owner,
        repo: REPO,
        id: created.project.id,
        numbers: [2],
        column: 'Doing',
      });
      const board = await h.call('project_get', { scope: 'user', id: created.project.id });
      expect(board.columns.find((c: Obj) => c.title === 'Doing').issues[0].number).toBe(2);
      await h.call('project_delete', { scope: 'user', id: created.project.id });
      const missingOrg = await h.fail('project_list', { scope: 'org' });
      expect(missingOrg.code).toBe('INVALID_INPUT');
    });
  });

  describe('time tracking', () => {
    it('books, lists and deletes tracked time with all parameters', async () => {
      const a = await h.call('time_add', { owner, repo: REPO, number: 1, duration: '1h30m' });
      expect(a.added).toMatchObject({ seconds: 5400, duration: '1h30m', user: owner });
      const b = await h.call('time_add', {
        owner,
        repo: REPO,
        number: 1,
        duration: 900,
        created: '2026-01-15T09:00:00Z',
        user_name: REVIEWER,
      });
      expect(b.added).toMatchObject({ seconds: 900, user: REVIEWER });
      // Gitea 28.2 ignores `created` and stores the current time; the tool reports that honestly.
      expect(b.warning).toMatch(/ignored the requested date/);
      const issueTimes = await h.call('time_list', { owner, repo: REPO, number: 1 });
      expect(issueTimes.total_seconds).toBe(6300);
      expect(issueTimes.by_user).toEqual({ [owner]: '1h30m', [REVIEWER]: '15m' });
      const byUser = await h.call('time_list', { owner, repo: REPO, user: REVIEWER });
      expect(byUser.entries.map((e: Obj) => e.user)).toEqual([REVIEWER]);
      const today = new Date(Date.now() - 86_400_000).toISOString().replace(/.d+Z$/, 'Z');
      const range = await h.call('time_list', { owner, repo: REPO, since: today });
      expect(range.total_seconds).toBe(6300);
      const before = await h.call('time_list', { owner, repo: REPO, before: '2026-02-01T00:00:00Z' });
      expect(before.total_seconds).toBe(0);
      const mine = await h.call('time_list', { mine: true });
      expect(mine.total_seconds).toBeGreaterThanOrEqual(5400);
      const bad = await h.fail('time_add', { owner, repo: REPO, number: 1, duration: 'later' });
      expect(bad.code).toBe('INVALID_INPUT');
      await h.call('time_delete', { owner, repo: REPO, number: 1, id: b.added.id });
      await h.call('stopwatch', { owner, repo: REPO, number: 2, action: 'start' });
      const running = await h.call('stopwatch_list');
      expect(running.stopwatches.map((w: Obj) => w.issue)).toContain(2);
      await h.call('stopwatch', { owner, repo: REPO, number: 2, action: 'cancel' });
      expect((await h.call('stopwatch_list')).stopwatches).toEqual([]);
      await h.call('stopwatch', { owner, repo: REPO, number: 2, action: 'start' });
      await h.call('stopwatch', { owner, repo: REPO, number: 2, action: 'stop' });
      await h.call('time_delete', { owner, repo: REPO, number: 1, all: true });
      expect((await h.call('time_list', { owner, repo: REPO, number: 1, user: owner })).total_seconds).toBe(
        0,
      );
    });
  });

  describe('wiki', () => {
    it('creates, reads, edits, renames and deletes wiki pages', async () => {
      const disabled = await h.fail('wiki_page_create', { owner, repo: REPO, title: 'x', content: 'x' });
      expect(disabled).toMatchObject({ code: 'UNSUPPORTED' });
      expect(disabled.hint).toMatch(/has_wiki/);
      await h.call('repo_update', { owner, repo: REPO, has_wiki: true });
      const c = await h.call('wiki_page_create', {
        owner,
        repo: REPO,
        title: 'Getting Started',
        content: '# Start\nHello',
        message: 'docs: add start page',
      });
      expect(c.page.title).toBe('Getting Started');
      const list = await h.call('wiki_page_list', { owner, repo: REPO });
      expect(list.pages.map((p: Obj) => p.title)).toContain('Getting Started');
      const got = await h.call('wiki_page_get', { owner, repo: REPO, page: 'Getting Started' });
      expect(got.content).toBe('# Start\nHello');
      await h.call('wiki_page_update', {
        owner,
        repo: REPO,
        page: 'Getting Started',
        content: '# Start\nUpdated',
      });
      const before = await h.call('wiki_page_get', {
        owner,
        repo: REPO,
        page: 'Getting Started',
        include_history: true,
      });
      expect(before.history.map((c: Obj) => c.message)).toContain('docs: add start page');
      expect(before.history.length).toBeGreaterThanOrEqual(2);
      const renamed = await h.call('wiki_page_update', {
        owner,
        repo: REPO,
        page: 'Getting Started',
        new_title: 'Quickstart',
      });
      expect(renamed.page.title).toBe('Quickstart');
      const hist = await h.call('wiki_page_get', {
        owner,
        repo: REPO,
        page: 'Quickstart',
        include_history: true,
      });
      expect(hist.content).toBe('# Start\nUpdated');
      expect(hist.history.length).toBeGreaterThanOrEqual(1);
      const missing = await h.fail('wiki_page_get', { owner, repo: REPO, page: 'Nope' });
      expect(missing.hint).toMatch(/Quickstart/);
      await h.call('wiki_page_delete', { owner, repo: REPO, page: 'Quickstart' });
      expect((await h.call('wiki_page_list', { owner, repo: REPO })).pages).toEqual([]);
    });
  });

  describe('packages', () => {
    it('uploads, lists, inspects, links and deletes generic packages', async () => {
      writeFileSync(join(cwd, 'tool-1.0.0.tar.gz'), 'package-bytes');
      const up = await h.call('package_upload_generic', {
        owner,
        name: 'it-tool',
        version: '1.0.0',
        file: 'tool-1.0.0.tar.gz',
      });
      expect(up).toMatchObject({ uploaded: true, bytes: 13 });
      await h.call('package_upload_generic', {
        owner,
        name: 'it-tool',
        version: '1.1.0',
        file: 'tool-1.0.0.tar.gz',
        file_name: 'tool.tar.gz',
      });
      const list = await h.call('package_list', { owner, type: 'generic' });
      expect(list.packages.map((p: Obj) => p.version).sort()).toEqual(['1.0.0', '1.1.0']);
      const versions = await h.call('package_get', { owner, type: 'generic', name: 'it-tool' });
      expect(versions.versions).toHaveLength(2);
      const v = await h.call('package_get', { owner, type: 'generic', name: 'it-tool', version: '1.0.0' });
      expect(v.files).toEqual([
        { name: 'tool-1.0.0.tar.gz', size: 13, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      ]);
      const latest = await h.call('package_get', {
        owner,
        type: 'generic',
        name: 'it-tool',
        version: 'latest',
      });
      expect(latest.files[0].name).toBe('tool.tar.gz');
      await h.call('package_link', { owner, type: 'generic', name: 'it-tool', repo: REPO });
      const linked = await h.call('package_get', {
        owner,
        type: 'generic',
        name: 'it-tool',
        version: '1.0.0',
      });
      expect(linked.repository).toBe(`${owner}/${REPO}`);
      await h.call('package_link', { owner, type: 'generic', name: 'it-tool', action: 'unlink' });
      const outside = await h.fail('package_upload_generic', {
        owner,
        name: 'x',
        version: '1',
        file: '../../etc/hosts',
      });
      expect(outside.code).toBe('INVALID_INPUT');
      await h.call('package_delete', { owner, type: 'generic', name: 'it-tool', version: '1.0.0' });
      await h.call('package_delete', { owner, type: 'generic', name: 'it-tool' });
      expect((await h.call('package_list', { owner, type: 'generic' })).packages).toEqual([]);
    });
  });

  describe('pull requests', () => {
    it('creates a pull request from local changes', async () => {
      const auth = new URL(e.url);
      auth.username = e.username;
      auth.password = encodeURIComponent(e.password);
      const clone = join(cwd, 'clone');
      execFileSync('git', ['clone', '-q', `${auth.href}${owner}/${REPO}.git`, clone], { stdio: 'pipe' });
      const git = (...args: string[]) => execFileSync('git', args, { cwd: clone, stdio: 'pipe' });
      git('config', 'user.email', 'it@example.com');
      git('config', 'user.name', 'IT');
      git('checkout', '-q', '-b', 'feature/local');
      writeFileSync(join(clone, 'CHANGELOG.md'), '# Changelog\n');
      git('add', '.');
      git('commit', '-q', '-m', 'docs: add changelog');
      const local = await harness(e, { cwd: clone });
      const ctx = await local.call('local_repo_context');
      expect(ctx.branch).toBe('feature/local');
      expect(ctx.remotes[0].giteaRepo).toEqual({ owner, repo: REPO });
      const pushed = await local.call('local_branch_push');
      expect(pushed.pushed).toBe('feature/local');
      expect(JSON.stringify(pushed)).not.toContain(e.password);
      // owner/repo are inferred from the clone's remote
      const detected = await local.call('repo_get');
      expect(detected.full_name).toBe(`${owner}/${REPO}`);
      const pr = await local.call('pr_create', {
        head: 'feature/local',
        title: 'Add changelog',
        body: 'Adds a changelog.',
      });
      expect(pr.pull).toMatchObject({ head: 'feature/local', base: 'main', state: 'open' });
      state.localPr = pr.pull.number;
      await local.close();
    });

    it('creates, lists and inspects pull requests', async () => {
      await api(e, 'PUT', `/repos/${owner}/${REPO}/collaborators/${REVIEWER}`, { permission: 'write' });
      const pr = await h.call('pr_create', {
        owner,
        repo: REPO,
        head: 'feature/a',
        title: 'feat: feature greeting',
        body: 'Implements the feature.',
        labels: ['bug'],
        reviewers: [REVIEWER],
        assignees: [owner],
      });
      state.pr = pr.pull.number;
      expect(pr.pull.requested_reviewers).toEqual([REVIEWER]);
      const list = await h.call('pr_list', { owner, repo: REPO });
      expect(list.pulls.length).toBe(2);
      const latest = await h.call('pr_get', { owner, repo: REPO });
      expect([state.pr, state.localPr]).toContain(latest.number);
      const files = await h.call('pr_files', { owner, repo: REPO, number: state.pr });
      expect(files.files).toEqual([
        { filename: 'src/hello.ts', status: 'changed', additions: 1, deletions: 1 },
      ]);
      const diff = await h.call('pr_diff', { owner, repo: REPO, number: state.pr });
      expect(diff.files).toEqual([{ file: 'src/hello.ts', additions: 1, deletions: 1 }]);
      const commits = await h.call('pr_commits', { owner, repo: REPO, number: state.pr });
      expect(commits.commits).toHaveLength(1);
      const upd = await h.call('pr_update', {
        owner,
        repo: REPO,
        number: state.pr,
        body: 'Implements the feature (edited).',
      });
      expect(upd.updated).toEqual(['body']);
      await h.call('pr_request_reviewers', {
        owner,
        repo: REPO,
        number: state.pr,
        reviewers: [REVIEWER],
        remove: true,
      });
      await h.call('pr_request_reviewers', { owner, repo: REPO, number: state.pr, reviewers: [REVIEWER] });
    });

    it('reviews and comments pull requests', async () => {
      await h.call('issue_comment_create', {
        owner,
        repo: REPO,
        number: state.pr,
        body: 'Looks good overall.',
      });
      const r = await h.call('pr_review_create', {
        owner,
        repo: REPO,
        number: state.pr,
        event: 'COMMENT',
        body: 'Inline notes',
        comments: [{ path: 'src/hello.ts', line: 1, body: 'Consider a constant.' }],
      });
      expect(r.review.state).toBe('COMMENT');
      const pending = await h.call('pr_review_create', {
        owner,
        repo: REPO,
        number: state.pr,
        event: 'PENDING',
        body: 'draft',
      });
      const submitted = await h.call('pr_review_submit', {
        owner,
        repo: REPO,
        number: state.pr,
        review_id: pending.review.id,
        event: 'COMMENT',
        body: 'final',
      });
      expect(submitted.review.state).toBe('COMMENT');
      const reviews = await h.call('pr_reviews', { owner, repo: REPO, number: state.pr });
      const inline = reviews.reviews.flatMap((x: Obj) => x.comments ?? []);
      expect(inline[0]).toMatchObject({ path: 'src/hello.ts', body: 'Consider a constant.' });
      expect(reviews.conversation.map((c: Obj) => c.body)).toContain('Looks good overall.');
    });

    it('checks merge readiness against branch protection and merges', async () => {
      await h.call('branch_protection_set', {
        owner,
        repo: REPO,
        rule_name: 'main',
        required_approvals: 1,
        enable_push: true,
      });
      await waitUntil(
        async () =>
          (await h.call('pr_get', { owner, repo: REPO, number: state.pr })).mergeable ? true : undefined,
        60_000,
      );
      const blocked = await h.call('pr_merge_check', { owner, repo: REPO, number: state.pr });
      expect(blocked.ready_to_merge).toBe(false);
      expect(blocked.blockers.join()).toMatch(/Needs 1 approval/);
      const refused = await h.fail('pr_merge', { owner, repo: REPO, number: state.pr, style: 'squash' });
      expect(refused.code).toBe('CONFLICT');
      await h.call('branch_protection_delete', { owner, repo: REPO, rule_name: 'main' });
      const ready = await h.call('pr_merge_check', { owner, repo: REPO, number: state.pr });
      expect(ready.ready_to_merge).toBe(true);
      const merged = await h.call('pr_merge', {
        owner,
        repo: REPO,
        number: state.pr,
        style: 'squash',
        delete_branch_after_merge: true,
      });
      expect(merged.merged).toBe(true);
      const branches = await h.call('branch_list', { owner, repo: REPO });
      expect(branches.branches.map((b: Obj) => b.name)).not.toContain('feature/a');
    });

    it('updates and closes pull requests and deletes branches', async () => {
      await waitUntil(
        async () =>
          (await h.call('pr_get', { owner, repo: REPO, number: state.localPr })).mergeable !== undefined
            ? true
            : undefined,
        60_000,
      );
      const upd = await h.call('pr_update_branch', { owner, repo: REPO, number: state.localPr });
      expect(upd.updated).toBe(true);
      const closed = await h.call('pr_close', {
        owner,
        repo: REPO,
        number: state.localPr,
        comment: 'Superseded.',
      });
      expect(closed.pull.state).toBe('closed');
      const del = await h.call('branch_delete', { owner, repo: REPO, branch: 'feature/local' });
      expect(del.deleted).toBe('feature/local');
    });
  });

  describe('organisations, teams and access', () => {
    it('manages organisations and teams', async () => {
      await h.call('org_create', { name: ORG, description: 'IT org' });
      await h.call('org_update', { org: ORG, description: 'Integration org', visibility: 'private' });
      const org = await h.call('org_get', { org: ORG });
      expect(org).toMatchObject({ name: ORG, description: 'Integration org', visibility: 'private' });
      expect((await h.call('org_list')).organizations.map((o: Obj) => o.name)).toContain(ORG);
      expect((await h.call('org_members_list', { org: ORG })).members[0].login).toBe(owner);
      await h.call('repo_create', { name: 'org-repo', organization: ORG });
      const team = await h.call('team_create', { org: ORG, name: 'devs', permission: 'write' });
      expect(team.team.name).toBe('devs');
      await h.call('team_member_set', { org: ORG, team: 'devs', username: REVIEWER, action: 'add' });
      await h.call('team_repo_set', { org: ORG, team: 'devs', repo: 'org-repo', action: 'add' });
      const t = await h.call('team_get', { org: ORG, team: 'devs' });
      expect(t.members).toEqual([REVIEWER]);
      expect(t.repositories).toEqual([`${ORG}/org-repo`]);
      await h.call('team_update', { org: ORG, team: 'devs', description: 'Developers' });
      const teams = await h.call('team_list', { org: ORG });
      expect(teams.teams.map((x: Obj) => x.name)).toEqual(expect.arrayContaining(['Owners', 'devs']));
      const access = await h.call('repo_permissions_analyze', { owner: ORG, repo: 'org-repo' });
      expect(access.teams_with_access.map((x: Obj) => x.name)).toContain('devs');
      await h.call('team_repo_set', { org: ORG, team: 'devs', repo: 'org-repo', action: 'remove' });
      await h.call('team_member_set', { org: ORG, team: 'devs', username: REVIEWER, action: 'remove' });
      await h.call('team_delete', { org: ORG, team: 'devs' });
    });

    it('manages collaborators and analyses permissions', async () => {
      await h.call('collaborator_set', {
        owner,
        repo: REPO,
        username: REVIEWER,
        action: 'add',
        permission: 'read',
      });
      const collab = await h.call('collaborator_list', { owner, repo: REPO });
      expect(collab.collaborators).toEqual([{ login: REVIEWER, permission: 'read', role: 'read' }]);
      const access = await h.call('repo_permissions_analyze', { owner, repo: REPO });
      expect(access.visibility).toBe('private');
      expect(access.observations.join()).toMatch(/No branch protection/);
      await h.call('collaborator_set', { owner, repo: REPO, username: REVIEWER, action: 'remove' });
    });

    it('reads users', async () => {
      expect((await h.call('user_get')).login).toBe(owner);
      expect((await h.call('user_get', { username: REVIEWER })).login).toBe(REVIEWER);
      const found = await h.call('user_search', { query: 'it-reviewer' });
      expect(found.users.map((u: Obj) => u.login)).toContain(REVIEWER);
    });

    it('forks repositories', async () => {
      const fork = await h.call('repo_fork', { owner, repo: REPO, organization: ORG });
      expect(fork.repository).toMatchObject({ full_name: `${ORG}/${REPO}`, fork: true });
      const forks = await waitUntil(async () => {
        const f = await h.call('repo_forks_list', { owner, repo: REPO });
        return f.forks.length ? f : undefined;
      });
      expect(forks.forks[0].full_name).toBe(`${ORG}/${REPO}`);
    });
  });

  describe.skipIf(!env?.runner)('Gitea Actions', () => {
    it('lists workflows and analyses a failed run with logs', async () => {
      const workflow = [
        'name: it-ci',
        'on:',
        '  push:',
        '  workflow_dispatch:',
        'jobs:',
        '  build:',
        '    runs-on: it-host',
        '    steps:',
        '      - name: greet',
        '        shell: sh',
        '        run: echo "hello from integration"',
        '      - name: break',
        '        shell: sh',
        '        run: |',
        '          echo "about to fail"',
        '          echo "error: intentional failure for the test"',
        '          exit 3',
        '',
      ].join('\n');
      await h.call('file_create', {
        owner,
        repo: REPO,
        path: '.gitea/workflows/ci.yml',
        content: workflow,
        message: 'ci: add workflow',
      });
      const wf = await waitUntil(async () => {
        const r = await h.call('actions_workflow_list', { owner, repo: REPO });
        return r.workflows.length ? r : undefined;
      });
      expect(wf.workflows[0]).toMatchObject({ path: '.gitea/workflows/ci.yml' });
      state.workflowId = wf.workflows[0].id;
      const cfg = await h.call('actions_workflow_get', { owner, repo: REPO, workflow: 'ci.yml' });
      expect(cfg.content).toContain('intentional failure');
      const done = await waitUntil(
        async () => {
          const r = await h.call('actions_run_list', { owner, repo: REPO, limit: 5 });
          const first = r.runs[0];
          return first && first.status === 'completed' ? first : undefined;
        },
        240_000,
        3000,
      );
      expect(done.conclusion).toBe('failure');
      state.runId = done.id;
      const failedOnly = await h.call('actions_run_list', { owner, repo: REPO, status: 'failure' });
      expect(failedOnly.runs.map((r: Obj) => r.id)).toContain(done.id);
      const runInfo = await h.call('actions_run_get', { owner, repo: REPO, run_id: done.id });
      expect(runInfo.jobs[0]).toMatchObject({ name: 'build', conclusion: 'failure' });
      state.jobId = runInfo.jobs[0].id;
      const logs = await h.call('actions_job_logs', { owner, repo: REPO, job_id: state.jobId });
      expect(logs.error_lines.map((l: Obj) => l.text).join('\n')).toContain('intentional failure');
      const analysis = await h.call('actions_failures_analyze', { owner, repo: REPO });
      expect(analysis.runs[0].failed_jobs[0].log.error_lines.length).toBeGreaterThan(0);
      expect(analysis.runs[0].failed_jobs[0].failed_steps).toEqual(['break']);
      const full = await h.call('actions_job_logs', { owner, repo: REPO, job_id: state.jobId, full: true });
      expect(full.log).toContain('hello from integration');
    });

    it('lists runners for repository, user and organisation', async () => {
      // The test runner is registered for the whole instance: the repository has no runner of its
      // own, yet jobs run. The tool must report the inherited runner instead of "stays queued".
      const r = await h.call('actions_runner_list', { owner, repo: REPO });
      expect(r.online).toBeGreaterThanOrEqual(1);
      expect(r.runners.map((x: Obj) => x.level)).toContain('instance');
      expect(r.note).toBeUndefined();
      expect((await h.call('actions_runner_list', { scope: 'user' })).scope).toBe('user');
      expect((await h.call('actions_runner_list', { scope: 'org', org: ORG })).scope).toBe('org');
    });

    it('re-runs, dispatches and cancels runs and lists artifacts', async () => {
      const rerun = await h.call('actions_run_rerun', {
        owner,
        repo: REPO,
        run_id: state.runId,
        mode: 'failed',
      });
      expect(rerun.rerun).toBe('failed');
      const dispatched = await h.call('actions_workflow_dispatch', {
        owner,
        repo: REPO,
        workflow: 'ci.yml',
        ref: 'main',
      });
      expect(dispatched.dispatched).toBe(true);
      const latest = await h.call('actions_run_list', {
        owner,
        repo: REPO,
        event: 'workflow_dispatch',
        limit: 1,
      });
      const id = latest.runs[0].id;
      const cancel = await h
        .call('actions_run_cancel', { owner, repo: REPO, run_id: id })
        .catch((err: Error) => err);
      // A run that finished before the cancel request arrives cannot be cancelled any more.
      if (cancel instanceof Error) expect(cancel.message).toMatch(/CONFLICT|INVALID_INPUT|VALIDATION_FAILED/);
      else expect(cancel.cancelled).toBe(id);
      const artifacts = await h.call('actions_artifact_list', { owner, repo: REPO, run_id: state.runId });
      expect(artifacts.artifacts).toEqual([]);
      const missing = await h.fail('actions_artifact_download', { owner, repo: REPO, artifact_id: 999_999 });
      expect(missing.code).toBe('NOT_FOUND');
    });
  });

  describe('releases', () => {
    it('creates releases with generated notes and manages assets', async () => {
      const r1 = await h.call('release_create', { owner, repo: REPO, tag: 'v0.1.0', generate_notes: true });
      expect(r1.release).toMatchObject({ tag_name: 'v0.1.0', prerelease: false });
      expect(r1.release.body).toContain('## v0.1.0');
      expect(r1.release.body).toContain('### Features');
      await h.call('file_create', {
        owner,
        repo: REPO,
        path: 'NEWS.md',
        content: 'news',
        message: 'fix: add news',
      });
      const notes = await h.call('release_notes_generate', {
        owner,
        repo: REPO,
        tag: 'v0.2.0-rc.1',
        target: 'main',
      });
      expect(notes.previous_tag).toBe('v0.1.0');
      expect(notes.notes).toContain('### Bug fixes\n\n- add news');
      const r2 = await h.call('release_create', {
        owner,
        repo: REPO,
        tag: 'v0.2.0-rc.1',
        generate_notes: true,
        draft: false,
      });
      expect(r2.release.prerelease).toBe(true);
      const upd = await h.call('release_update', { owner, repo: REPO, release: 'v0.2.0-rc.1', name: 'RC 1' });
      expect(upd.release.name).toBe('RC 1');
      const latest = await h.call('release_get', { owner, repo: REPO });
      expect(latest.tag_name).toBe('v0.1.0');
      const list = await h.call('release_list', { owner, repo: REPO });
      expect(list.releases.map((x: Obj) => x.tag_name)).toEqual(['v0.2.0-rc.1', 'v0.1.0']);
      writeFileSync(join(cwd, 'artifact.txt'), 'binary-ish content');
      const up = await h.call('release_asset_upload', {
        owner,
        repo: REPO,
        release: 'v0.1.0',
        file: 'artifact.txt',
      });
      expect(up.asset).toMatchObject({ name: 'artifact.txt', size: 18 });
      const outside = await h.fail('release_asset_upload', {
        owner,
        repo: REPO,
        release: 'v0.1.0',
        file: join(tmpdir(), '..', 'x'),
      });
      expect(outside.code).toBe('INVALID_INPUT');
      const assets = await h.call('release_asset_list', { owner, repo: REPO, release: 'v0.1.0' });
      expect(assets.assets).toHaveLength(1);
      await h.call('release_asset_delete', { owner, repo: REPO, release: 'v0.1.0', asset_id: up.asset.id });
      const cmp = await h.call('release_compare', { owner, repo: REPO });
      expect(cmp).toMatchObject({ base: { tag_name: 'v0.1.0' }, head: { tag_name: 'v0.2.0-rc.1' } });
      expect(cmp.commits_by_type.fix).toBe(1);
      const del = await h.call('release_delete', {
        owner,
        repo: REPO,
        release: 'v0.2.0-rc.1',
        delete_tag: true,
      });
      expect(del).toEqual({ deleted: 'v0.2.0-rc.1', tag_deleted: true });
    });
  });

  describe('webhooks, notifications and analysis', () => {
    it('manages webhooks without exposing secrets', async () => {
      const hook = await h.call('webhook_create', {
        owner,
        repo: REPO,
        url: 'https://hooks.example.com/gitea',
        secret: 'hook-secret-123456',
        events: ['push', 'pull_request'],
      });
      expect(JSON.stringify(hook)).not.toContain('hook-secret-123456');
      await h.call('webhook_update', { owner, repo: REPO, id: hook.webhook.id, active: false });
      const list = await h.call('webhook_list', { owner, repo: REPO });
      expect(list.webhooks[0]).toMatchObject({ id: hook.webhook.id, active: false });
      await h.call('webhook_test', { owner, repo: REPO, id: hook.webhook.id });
      await h.call('webhook_delete', { owner, repo: REPO, id: hook.webhook.id });
      const orgHook = await h.call('webhook_create', {
        org: ORG,
        url: 'https://hooks.example.com/org',
        events: ['repository'],
      });
      expect((await h.call('webhook_list', { org: ORG })).webhooks).toHaveLength(1);
      await h.call('webhook_delete', { org: ORG, id: orgHook.webhook.id });
    });

    it('lists and marks notifications', async () => {
      // The reviewer was asked for a review earlier, so the reviewer has notifications.
      const t = await api<{ sha1: string }>(
        e,
        'POST',
        `/users/${REVIEWER}/tokens`,
        { name: `n-${run}`, scopes: ['write:notification', 'read:user', 'read:repository'] },
        { username: REVIEWER, password: REVIEWER_PASSWORD },
      );
      const rv = await harness(e, { token: t.sha1 });
      // Gitea hides the subject of threads in repositories the user can no longer read.
      await h.call('collaborator_set', {
        owner,
        repo: REPO,
        username: REVIEWER,
        action: 'add',
        permission: 'read',
      });
      const list = await rv.call('notification_list', { all: true });
      expect(list.notifications.length).toBeGreaterThan(0);
      expect(list.notifications[0]).toHaveProperty('title');
      const one = await rv.call('notification_mark_read', { thread_id: list.notifications[0].id });
      expect(one.marked_read).toBe(list.notifications[0].id);
      const all = await rv.call('notification_mark_read', {});
      expect(all.marked_read).toBe('all');
      expect((await rv.call('notification_list')).notifications).toEqual([]);
      await h.call('collaborator_set', { owner, repo: REPO, username: REVIEWER, action: 'remove' });
      await rv.close();
    });

    it('analyses repository health', async () => {
      const a = await h.call('repo_analyze', { owner, repo: REPO });
      expect(a.repository.full_name).toBe(`${owner}/${REPO}`);
      expect(a.community_files.readme).toBe(true);
      expect(a.community_files.license).toBe(false);
      expect(a.suggestions.join('\n')).toMatch(/LICENSE/);
      expect(a.latest_release.tag_name).toBe('v0.1.0');
    });
  });

  describe('cleanup', () => {
    it('deletes repositories with confirmation', async () => {
      const noElicit = await harness(e, { elicitation: false });
      const refused = await noElicit.fail('repo_delete', { owner: ORG, repo: REPO });
      expect(refused.code).toBe('CONFIRMATION_REQUIRED');
      const ok = await noElicit.call('repo_delete', { owner: ORG, repo: REPO, confirm: `${ORG}/${REPO}` });
      expect(ok.deleted).toBe(`${ORG}/${REPO}`);
      await noElicit.close();
      await h.call('repo_delete', { owner: ORG, repo: 'org-repo' });
      await h.call('repo_delete', { owner, repo: REPO });
      expect((await h.fail('repo_get', { owner, repo: REPO })).code).toBe('NOT_FOUND');
    });
  });

  describe('API compatibility', () => {
    interface Op {
      method: string;
      template: string;
      re: RegExp;
      query: Set<string>;
    }
    const swagger = JSON.parse(readFileSync('test/fixtures/gitea-swagger.v1.json', 'utf8')) as {
      paths: Record<string, Record<string, { parameters?: { in: string; name: string }[] }>>;
    };
    const ops: Op[] = [];
    for (const [template, methods] of Object.entries(swagger.paths)) {
      const source = template
        .split(/(\{[^}]+\})/)
        .map((part) => {
          if (!part.startsWith('{')) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          return part === '{filepath}' ? '.+' : '[^/]+';
        })
        .join('');
      for (const [method, op] of Object.entries(methods)) {
        if (method === 'parameters') continue;
        ops.push({
          method: method.toUpperCase(),
          template,
          re: new RegExp(`^${source}$`),
          query: new Set((op.parameters ?? []).filter((x) => x.in === 'query').map((x) => x.name)),
        });
      }
    }

    it('every request the tools sent uses a documented endpoint and documented query parameters', () => {
      // The generic package registry lives outside /api/v1 and is documented separately
      // (https://docs.gitea.com/usage/packages/generic): only PUT uploads of that exact form are allowed.
      const registry = recorded.filter((r) => r.url.pathname.startsWith('/api/packages/'));
      expect(registry.length).toBeGreaterThan(0);
      for (const r of registry) {
        expect(`${r.method} ${r.url.pathname}`).toMatch(
          /^PUT \/api\/packages\/[^/]+\/generic\/[^/]+\/[^/]+\/[^/]+$/,
        );
      }
      const unexpected = recorded.filter(
        (r) =>
          !r.url.pathname.startsWith('/api/v1/') &&
          !r.url.pathname.startsWith('/api/packages/') &&
          r.url.pathname !== '/swagger.v1.json',
      );
      expect(unexpected.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([]);
      const apiRequests = recorded.filter((r) => r.url.pathname.startsWith('/api/v1/'));
      expect(apiRequests.length).toBeGreaterThan(300);
      const problems = new Set<string>();
      for (const r of apiRequests) {
        const path = r.url.pathname.slice('/api/v1'.length);
        const matches = ops.filter((o) => o.method === r.method && o.re.test(path));
        if (matches.length === 0) {
          problems.add(`undocumented endpoint: ${r.method} ${path}`);
          continue;
        }
        const allowed = new Set(matches.flatMap((m) => [...m.query]));
        for (const key of r.url.searchParams.keys()) {
          if (!allowed.has(key))
            problems.add(`undocumented query parameter "${key}" for ${r.method} ${matches[0]!.template}`);
        }
      }
      expect([...problems]).toEqual([]);
    });

    it('every tool was exercised against the real server', () => {
      const missing = ALL_TOOLS.map((t) => t.name).filter((n) => !calledTools.has(n));
      expect(missing).toEqual([]);
    });
  });
});
