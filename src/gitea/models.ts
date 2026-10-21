/**
 * Projections of Gitea API objects. Gitea responses embed full user and repository objects many
 * times over; tools return these compact shapes instead so results stay readable and small.
 */

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** Removes undefined, null and empty-string values to keep output compact. */
export function compact<T extends Obj>(o: T): T {
  const out: Obj = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out as T;
}

export function login(u: unknown): string | undefined {
  return isObj(u) ? (str(u.login) ?? str(u.username)) : undefined;
}

const logins = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.map(login).filter((x): x is string => Boolean(x)) : undefined;

export function slimUser(u: unknown): Obj {
  if (!isObj(u)) return {};
  return compact({
    id: u.id,
    login: u.login,
    full_name: u.full_name,
    email: u.email,
    is_admin: u.is_admin,
    html_url: u.html_url,
    description: u.description,
    visibility: u.visibility,
    created: u.created,
    last_login: u.last_login,
    restricted: u.restricted,
  });
}

export function slimOrg(o: unknown): Obj {
  if (!isObj(o)) return {};
  return compact({
    id: o.id,
    name: o.name ?? o.username,
    full_name: o.full_name,
    description: o.description,
    website: o.website,
    visibility: o.visibility,
    location: o.location,
  });
}

export function slimRepo(r: unknown): Obj {
  if (!isObj(r)) return {};
  return compact({
    id: r.id,
    full_name: r.full_name,
    description: r.description,
    private: r.private,
    fork: r.fork,
    parent: isObj(r.parent) ? r.parent.full_name : undefined,
    archived: r.archived,
    mirror: r.mirror,
    template: r.template,
    empty: r.empty,
    default_branch: r.default_branch,
    html_url: r.html_url,
    clone_url: r.clone_url,
    ssh_url: r.ssh_url,
    website: r.website,
    stars: r.stars_count,
    forks: r.forks_count,
    watchers: r.watchers_count,
    open_issues: r.open_issues_count,
    open_pulls: r.open_pr_counter,
    releases: r.release_counter,
    size_kb: r.size,
    language: r.language,
    topics: r.topics,
    has_issues: r.has_issues,
    has_wiki: r.has_wiki,
    has_pull_requests: r.has_pull_requests,
    has_actions: r.has_actions,
    has_releases: r.has_releases,
    permissions: r.permissions,
    created_at: r.created_at,
    updated_at: r.updated_at,
  });
}

export function slimLabel(l: unknown): Obj {
  if (!isObj(l)) return {};
  return compact({
    id: l.id,
    name: l.name,
    color: l.color,
    description: l.description,
    exclusive: l.exclusive || undefined,
    is_archived: l.is_archived || undefined,
  });
}

export function slimMilestone(m: unknown): Obj {
  if (!isObj(m)) return {};
  return compact({
    id: m.id,
    title: m.title,
    description: m.description,
    state: m.state,
    open_issues: m.open_issues,
    closed_issues: m.closed_issues,
    due_on: m.due_on,
    closed_at: m.closed_at,
  });
}

export function slimIssue(i: unknown, withBody = false): Obj {
  if (!isObj(i)) return {};
  const labels = Array.isArray(i.labels) ? i.labels.map((l) => (isObj(l) ? l.name : undefined)) : undefined;
  return compact({
    number: i.number,
    title: i.title,
    state: i.state,
    is_pull_request: isObj(i.pull_request) ? true : undefined,
    repository: isObj(i.repository) ? i.repository.full_name : undefined,
    author: login(i.user),
    assignees: logins(i.assignees),
    labels,
    milestone: isObj(i.milestone) ? i.milestone.title : undefined,
    comments: i.comments,
    created_at: i.created_at,
    updated_at: i.updated_at,
    closed_at: i.closed_at,
    due_date: i.due_date,
    html_url: i.html_url,
    body: withBody ? i.body : undefined,
  });
}

export function slimComment(c: unknown): Obj {
  if (!isObj(c)) return {};
  return compact({
    id: c.id,
    author: login(c.user),
    body: c.body,
    created_at: c.created_at,
    updated_at: c.updated_at !== c.created_at ? c.updated_at : undefined,
    html_url: c.html_url,
  });
}

export function slimPull(p: unknown, withBody = false): Obj {
  if (!isObj(p)) return {};
  const head = isObj(p.head) ? p.head : {};
  const base = isObj(p.base) ? p.base : {};
  const headRepo = isObj(head.repo) ? head.repo.full_name : undefined;
  const baseRepo = isObj(base.repo) ? base.repo.full_name : undefined;
  return compact({
    number: p.number,
    title: p.title,
    state: p.state,
    draft: p.draft || undefined,
    author: login(p.user),
    head: head.ref ?? head.label,
    head_sha: head.sha,
    head_repo: headRepo !== baseRepo ? headRepo : undefined,
    base: base.ref ?? base.label,
    mergeable: p.mergeable,
    merged: p.merged,
    merged_by: login(p.merged_by),
    merged_at: p.merged_at,
    merge_commit_sha: p.merge_commit_sha,
    assignees: logins(p.assignees),
    requested_reviewers: logins(p.requested_reviewers),
    labels: Array.isArray(p.labels) ? p.labels.map((l) => (isObj(l) ? l.name : undefined)) : undefined,
    milestone: isObj(p.milestone) ? p.milestone.title : undefined,
    comments: p.comments,
    review_comments: p.review_comments,
    additions: p.additions,
    deletions: p.deletions,
    changed_files: p.changed_files,
    created_at: p.created_at,
    updated_at: p.updated_at,
    closed_at: p.closed_at,
    html_url: p.html_url,
    body: withBody ? p.body : undefined,
  });
}

export function slimReview(r: unknown): Obj {
  if (!isObj(r)) return {};
  return compact({
    id: r.id,
    reviewer: login(r.user),
    state: r.state,
    body: r.body,
    comments_count: r.comments_count,
    commit_id: r.commit_id,
    stale: r.stale || undefined,
    official: r.official,
    dismissed: r.dismissed || undefined,
    submitted_at: r.submitted_at,
    html_url: r.html_url,
  });
}

export function slimReviewComment(c: unknown): Obj {
  if (!isObj(c)) return {};
  return compact({
    id: c.id,
    author: login(c.user),
    path: c.path,
    line: c.position || c.original_position,
    commit_id: c.commit_id,
    body: c.body,
    diff_hunk: c.diff_hunk,
    resolver: login(c.resolver),
    created_at: c.created_at,
  });
}

export function slimBranch(b: unknown): Obj {
  if (!isObj(b)) return {};
  const commit = isObj(b.commit) ? b.commit : {};
  return compact({
    name: b.name,
    protected: b.protected,
    commit_sha: commit.id,
    commit_message: typeof commit.message === 'string' ? commit.message.split('\n')[0] : undefined,
    commit_author: isObj(commit.author) ? commit.author.name : undefined,
    commit_date: commit.timestamp,
    user_can_push: b.user_can_push,
    user_can_merge: b.user_can_merge,
  });
}

export function slimCommit(c: unknown, withFiles = false): Obj {
  if (!isObj(c)) return {};
  const commit = isObj(c.commit) ? c.commit : {};
  const author = isObj(commit.author) ? commit.author : {};
  const stats = isObj(c.stats) ? c.stats : undefined;
  return compact({
    sha: c.sha,
    message: commit.message,
    author: author.name,
    author_email: author.email,
    author_login: login(c.author),
    date: author.date,
    committer: isObj(commit.committer) ? commit.committer.name : undefined,
    parents: Array.isArray(c.parents) ? c.parents.map((p) => (isObj(p) ? p.sha : undefined)) : undefined,
    stats: stats ? { additions: stats.additions, deletions: stats.deletions, total: stats.total } : undefined,
    files:
      withFiles && Array.isArray(c.files)
        ? c.files.map((f: unknown) => (isObj(f) ? compact({ filename: f.filename, status: f.status }) : f))
        : undefined,
    html_url: c.html_url,
  });
}

export function slimTag(t: unknown): Obj {
  if (!isObj(t)) return {};
  return compact({
    name: t.name,
    message: typeof t.message === 'string' ? t.message.trim() : undefined,
    commit_sha: isObj(t.commit) ? t.commit.sha : undefined,
    tag_sha: t.id,
  });
}

export function slimRelease(r: unknown, withBody = true): Obj {
  if (!isObj(r)) return {};
  return compact({
    id: r.id,
    tag_name: r.tag_name,
    target: r.target_commitish,
    name: r.name,
    draft: r.draft,
    prerelease: r.prerelease,
    author: login(r.author),
    created_at: r.created_at,
    published_at: r.published_at,
    html_url: r.html_url,
    body: withBody ? r.body : undefined,
    assets: Array.isArray(r.assets) ? r.assets.map(slimAsset) : undefined,
  });
}

export function slimAsset(a: unknown): Obj {
  if (!isObj(a)) return {};
  return compact({
    id: a.id,
    name: a.name,
    size: a.size,
    download_count: a.download_count,
    created_at: a.created_at,
    browser_download_url: a.browser_download_url,
  });
}

export function slimTeam(t: unknown): Obj {
  if (!isObj(t)) return {};
  return compact({
    id: t.id,
    name: t.name,
    description: t.description,
    permission: t.permission,
    includes_all_repositories: t.includes_all_repositories,
    can_create_org_repo: t.can_create_org_repo,
    units: t.units,
    units_map: t.units_map,
    organization: isObj(t.organization) ? (t.organization.name ?? t.organization.username) : undefined,
  });
}

export function slimHook(h: unknown): Obj {
  if (!isObj(h)) return {};
  const config = isObj(h.config) ? { ...h.config } : undefined;
  if (config && 'secret' in config) config.secret = '[hidden]';
  return compact({
    id: h.id,
    type: h.type,
    active: h.active,
    events: h.events,
    branch_filter: h.branch_filter,
    authorization_header: h.authorization_header ? '[hidden]' : undefined,
    config,
    created_at: h.created_at,
    updated_at: h.updated_at,
  });
}

export function slimRun(r: unknown): Obj {
  if (!isObj(r)) return {};
  return compact({
    id: r.id,
    run_number: r.run_number,
    title: r.display_title ?? r.title,
    workflow: r.path ?? r.workflow_id,
    event: r.event,
    status: r.status,
    conclusion: r.conclusion,
    branch: r.head_branch,
    head_sha: r.head_sha,
    actor: login(r.actor) ?? login(r.trigger_actor),
    run_attempt: r.run_attempt,
    started_at: r.started_at ?? r.run_started_at,
    completed_at: r.completed_at,
    html_url: r.html_url,
  });
}

export function slimJob(j: unknown): Obj {
  if (!isObj(j)) return {};
  return compact({
    id: j.id,
    run_id: j.run_id,
    name: j.name,
    status: j.status,
    conclusion: j.conclusion,
    runner_name: j.runner_name,
    labels: j.labels,
    started_at: j.started_at,
    completed_at: j.completed_at,
    steps: Array.isArray(j.steps)
      ? j.steps.map((s: unknown) =>
          isObj(s)
            ? compact({ number: s.number, name: s.name, status: s.status, conclusion: s.conclusion })
            : s,
        )
      : undefined,
    html_url: j.html_url,
  });
}

export function slimNotification(n: unknown): Obj {
  if (!isObj(n)) return {};
  const subject = isObj(n.subject) ? n.subject : {};
  return compact({
    id: n.id,
    unread: n.unread,
    pinned: n.pinned || undefined,
    repository: isObj(n.repository) ? n.repository.full_name : undefined,
    type: subject.type,
    title: subject.title,
    state: subject.state,
    url: subject.html_url,
    updated_at: n.updated_at,
  });
}

export function slimBranchProtection(b: unknown): Obj {
  if (!isObj(b)) return {};
  const out: Obj = {};
  for (const [k, v] of Object.entries(b)) {
    if (v === null || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  return out;
}
