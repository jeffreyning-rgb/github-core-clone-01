// REST v3 surface: repositories, branches, commits, contents, issues, comments,
// labels, pull requests, files and merges — the /api/v3 tree plus the API root.

import { Store, blobBase64, type IssueRec, type PullRec, type RepoRec } from './store.ts';

export interface HttpResult {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  raw?: Buffer;
}

const NOT_FOUND: HttpResult = { status: 404, body: { message: 'Not Found' } };

function json(status: number, body: unknown): HttpResult {
  return { status, body };
}

function unprocessable(message: string): HttpResult {
  return json(422, { message });
}

export function repoJson(repo: RepoRec): Record<string, unknown> {
  const owner = repo.ownerLogin ?? '';
  return {
    id: repo.dbId,
    node_id: `R_${repo.dbId}`,
    name: repo.name,
    full_name: owner ? `${owner}/${repo.name}` : repo.name,
    owner: { login: owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://forge.invalid/${owner}/${repo.name}`,
  };
}

function issueJson(issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    comments: issue.comments.length,
    created_at: new Date(1_700_000_000_000 + issue.seq * 1000).toISOString(),
    updated_at: new Date(1_700_000_000_000 + issue.seq * 1000).toISOString(),
  };
}

function pullJson(store: Store, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headSha = store.branchTip(repo, pull.headRef) ?? null;
  const baseSha = store.branchTip(repo, pull.baseRef) ?? null;
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: headSha },
    base: { ref: pull.baseRef, sha: baseSha },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: new Date(1_700_000_000_000 + pull.seq * 1000).toISOString(),
    updated_at: new Date(1_700_000_000_000 + pull.seq * 1000).toISOString(),
  };
}

function parseBody(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function paginate<T>(items: T[], query: URLSearchParams): { page: T[]; perPage: number; pageNum: number } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page')) || 30));
  const pageNum = Math.max(1, Number(query.get('page')) || 1);
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), perPage, pageNum };
}

function linkHeader(origin: string, path: string, total: number, perPage: number, pageNum: number): string | undefined {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const parts: string[] = [];
  const url = (p: number) => `<${origin}${path}?per_page=${perPage}&page=${p}>`;
  if (pageNum < lastPage) parts.push(`${url(pageNum + 1)}; rel="next"`, `${url(lastPage)}; rel="last"`);
  if (pageNum > 1) parts.push(`${url(pageNum - 1)}; rel="prev"`, `${url(1)}; rel="first"`);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

export interface RestContext {
  store: Store;
  method: string;
  /** Path segments after /api/v3 (or ['__root__'] for the root itself). */
  segments: string[];
  query: URLSearchParams;
  body: string;
  origin: string;
  /** True when a non-empty body failed JSON parsing: writes answer 400. */
  malformedBody?: boolean;
}

/** Handle one /api/v3 request. Returns null when the path is not a REST route. */
export function handleRest(ctx: RestContext): HttpResult | null {
  const { store, method, segments, query, origin } = ctx;
  if (ctx.malformedBody && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
    return json(400, { message: 'Problems parsing JSON' });
  }
  const body = parseBody(ctx.body);
  const seg = segments;

  // GET /api/v3/ root
  if (seg.length === 0) {
    if (method !== 'GET') return NOT_FOUND;
    return {
      status: 200,
      headers: { 'X-OAuth-Scopes': '' },
      body: {
        current_user_url: `${origin}/api/v3/user`,
        repository_url: `${origin}/api/v3/repos/{owner}/{repo}`,
        issue_search_url: `${origin}/api/v3/search/issues?q={query}`,
      },
    };
  }

  // GET /api/v3/meta
  if (seg.length === 1 && seg[0] === 'meta' && method === 'GET') {
    return json(200, { installed_version: '1.0.0-forge' });
  }

  // /user and /user/repos
  if (seg[0] === 'user') {
    if (seg.length === 1 && method === 'GET') {
      if (!store.viewerLogin) return NOT_FOUND;
      return json(200, { login: store.viewerLogin, id: 1, type: 'User' });
    }
    if (seg.length === 2 && seg[1] === 'repos') {
      if (method === 'GET') {
        const all = store.listRepos().map(repoJson);
        const { page, perPage, pageNum } = paginate(all, query);
        const link = linkHeader(origin, '/api/v3/user/repos', all.length, perPage, pageNum);
        return { status: 200, headers: link ? { Link: link } : {}, body: page };
      }
      if (method === 'POST') {
        const name = str(body.name);
        if (!name) return unprocessable('name is required');
        if (store.repoByName(name)) return unprocessable('name already exists on this account');
        const repo = store.createRepo(name, {
          isPrivate: body.private === true,
          description: str(body.description),
        });
        return json(201, repoJson(repo));
      }
    }
    return NOT_FOUND;
  }

  // /repos/{owner}/{repo}/...
  if (seg[0] === 'repos' && seg.length >= 3) {
    const owner = decodeURIComponent(seg[1]);
    const name = decodeURIComponent(seg[2]);
    const rest = seg.slice(3);
    const repo = store.repoFor(owner, name);

    if (rest.length === 0) {
      if (method === 'GET') return repo ? json(200, repoJson(repo)) : NOT_FOUND;
      if (method === 'PATCH') {
        if (!repo) return NOT_FOUND;
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        if (typeof body.default_branch === 'string' && body.default_branch) repo.defaultBranch = body.default_branch;
        if (typeof body.name === 'string' && body.name && body.name !== repo.name) {
          store.repos.delete(repo.name);
          repo.name = body.name;
          store.repos.set(repo.name, repo);
        }
        return json(200, repoJson(repo));
      }
      if (method === 'DELETE') {
        if (!repo) return NOT_FOUND;
        store.deleteRepo(name);
        return { status: 204 };
      }
      return NOT_FOUND;
    }
    if (!repo) return NOT_FOUND;

    return handleRepoSubroutes(ctx, repo, rest, body);
  }

  return NOT_FOUND;
}

function handleRepoSubroutes(ctx: RestContext, repo: RepoRec, rest: string[], body: Record<string, unknown>): HttpResult {
  const { store, method, query, origin } = ctx;
  const head = rest[0];

  // ---- branches
  if (head === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: oid } }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return json(200, branches);
    }
    if (rest.length >= 2 && method === 'GET') {
      const branch = rest.slice(1).map(decodeURIComponent).join('/');
      const tip = store.branchTip(repo, branch);
      if (!tip) return NOT_FOUND;
      return json(200, { name: branch, commit: { sha: tip } });
    }
    return NOT_FOUND;
  }

  // ---- git refs
  if (head === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'POST') {
      const ref = str(body.ref);
      const sha = str(body.sha);
      if (!ref || !sha) return unprocessable('ref and sha are required');
      const commit = store.resolveCommit(repo, sha);
      if (!commit) return unprocessable('sha is not a known object');
      if (repo.refs.has(ref)) return unprocessable('Reference already exists');
      repo.refs.set(ref, commit);
      return json(201, { ref, object: { sha: commit, type: 'commit' } });
    }
    if (rest.length >= 3 && method === 'GET') {
      const ref = rest.slice(2).map(decodeURIComponent).join('/');
      const oid = repo.refs.get(ref);
      if (!oid) return NOT_FOUND;
      const obj = store.objects.get(oid);
      return json(200, { ref, object: { sha: oid, type: obj?.type ?? 'commit' } });
    }
    return NOT_FOUND;
  }

  // ---- commits list
  if (head === 'commits' && rest.length === 1 && method === 'GET') {
    const refish = query.get('sha') ?? repo.defaultBranch;
    const tip = store.resolveCommit(repo, refish);
    if (!tip) return json(200, []);
    const log = store.commitLog(repo, tip).map((c) => ({
      sha: c.oid,
      commit: {
        message: c.message,
        author: identityJson(c.author),
        committer: identityJson(c.committer),
        tree: { sha: c.tree },
      },
      parents: c.parents.map((sha) => ({ sha })),
    }));
    const { page } = paginate(log, query);
    return json(200, page);
  }

  // ---- contents
  if (head === 'contents') {
    const path = rest.slice(1).map(decodeURIComponent).join('/');
    return handleContents(ctx, repo, path, body);
  }

  // ---- labels
  if (head === 'labels') {
    if (rest.length === 1 && method === 'GET') {
      return json(200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color })));
    }
    if (rest.length === 1 && method === 'POST') {
      const name = str(body.name);
      if (!name) return unprocessable('name is required');
      if (repo.labels.has(name)) return unprocessable('name already exists');
      const label = { name, color: str(body.color) || 'ededed' };
      repo.labels.set(name, label);
      return json(201, { name: label.name, color: label.color });
    }
    return NOT_FOUND;
  }

  // ---- issues
  if (head === 'issues') {
    return handleIssues(ctx, repo, rest.slice(1), body);
  }

  // ---- pulls
  if (head === 'pulls') {
    return handlePulls(ctx, repo, rest.slice(1), body);
  }

  return NOT_FOUND;
}

function identityJson(line: string): { name: string; email: string; date: string } {
  const m = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
  if (!m) return { name: line, email: '', date: new Date(0).toISOString() };
  return { name: m[1], email: m[2], date: new Date(Number(m[3]) * 1000).toISOString() };
}

function handleContents(ctx: RestContext, repo: RepoRec, path: string, body: Record<string, unknown>): HttpResult {
  const { store, method, query } = ctx;

  if (method === 'GET') {
    const refish = query.get('ref') ?? repo.defaultBranch;
    const tree = store.treeAt(repo, refish);
    if (!tree) return NOT_FOUND;
    const flat = store.flatAt(repo, refish);
    if (path === '') {
      return json(200, dirListing(store, repo, refish, ''));
    }
    const entry = flat.get(path);
    if (entry) {
      const obj = store.objects.get(entry.oid);
      const data = obj?.data ?? new Uint8Array();
      return json(200, {
        type: 'file',
        encoding: 'base64',
        content: blobBase64(data),
        name: path.split('/').pop(),
        path,
        sha: entry.oid,
        size: data.length,
      });
    }
    // directory?
    const prefix = `${path}/`;
    if ([...flat.keys()].some((k) => k.startsWith(prefix))) {
      return json(200, dirListing(store, repo, refish, path));
    }
    return NOT_FOUND;
  }

  if (method === 'PUT') {
    const branch = str(body.branch) || repo.defaultBranch;
    const message = str(body.message) || `Update ${path}`;
    const contentB64 = str(body.content);
    let content: Buffer;
    try {
      content = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
    } catch {
      return unprocessable('content is not valid base64');
    }
    const flatBefore = store.flatAt(repo, branch);
    const existing = flatBefore.get(path);
    const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
    if (existing) {
      if (givenSha === undefined) return unprocessable('sha is required when updating an existing file');
      if (givenSha !== existing.oid) return json(409, { message: 'sha does not match the current blob' });
    }
    const { commitOid, blobOid } = store.commitFile(repo, branch, path, content, message);
    return json(existing ? 200 : 201, {
      content: {
        type: 'file',
        name: path.split('/').pop(),
        path,
        sha: blobOid,
        size: content.length,
        encoding: 'base64',
        content: blobBase64(content),
      },
      commit: { sha: commitOid },
    });
  }

  if (method === 'DELETE') {
    const branch = str(body.branch) || repo.defaultBranch;
    const message = str(body.message) || `Delete ${path}`;
    const flatBefore = store.flatAt(repo, branch);
    const existing = flatBefore.get(path);
    if (!existing) return NOT_FOUND;
    const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
    if (givenSha !== undefined && givenSha !== existing.oid) return json(409, { message: 'sha does not match the current blob' });
    const { commitOid } = store.commitFile(repo, branch, path, null, message);
    return json(200, { content: null, commit: { sha: commitOid } });
  }

  return NOT_FOUND;
}

function dirListing(store: Store, repo: RepoRec, refish: string, dirPath: string): Array<Record<string, unknown>> {
  const tree = store.treeAt(repo, refish);
  if (!tree) return [];
  const flat = store.flatAt(repo, refish);
  const prefix = dirPath === '' ? '' : `${dirPath}/`;
  const entries = new Map<string, { type: string; sha: string }>();
  for (const [path, entry] of flat) {
    if (!path.startsWith(prefix)) continue;
    const restPath = path.slice(prefix.length);
    const slash = restPath.indexOf('/');
    if (slash === -1) {
      entries.set(restPath, { type: 'file', sha: entry.oid });
    } else {
      const dirName = restPath.slice(0, slash);
      if (!entries.has(dirName)) entries.set(dirName, { type: 'dir', sha: entry.oid });
    }
  }
  return [...entries.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, e]) => ({ type: e.type, name, path: prefix + name, sha: e.sha }));
}

function handleIssues(ctx: RestContext, repo: RepoRec, rest: string[], body: Record<string, unknown>): HttpResult {
  const { store, method, query } = ctx;

  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((i) => i.state === state);
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const { page } = paginate(issues.map(issueJson), query);
      return json(200, page);
    }
    if (method === 'POST') {
      const labels = Array.isArray(body.labels) ? body.labels.map((l) => str(typeof l === 'object' && l !== null ? (l as Record<string, unknown>).name : l)).filter(Boolean) : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return unprocessable(`unknown label: ${label}`);
      }
      const issue = store.createIssue(repo, { title: str(body.title), body: str(body.body), labels });
      return json(201, issueJson(issue));
    }
    return NOT_FOUND;
  }

  const number = Number(rest[0]);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;

  if (rest.length === 1) {
    if (method === 'GET') return issue ? json(200, issueJson(issue)) : NOT_FOUND;
    if (method === 'PATCH') {
      if (!issue) return NOT_FOUND;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (Array.isArray(body.labels)) {
        const labels = body.labels.map((l) => str(typeof l === 'object' && l !== null ? (l as Record<string, unknown>).name : l)).filter(Boolean);
        for (const label of labels) if (!repo.labels.has(label)) return unprocessable(`unknown label: ${label}`);
        issue.labels = labels;
      }
      return json(200, issueJson(issue));
    }
    return NOT_FOUND;
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (!issue) return NOT_FOUND;
    if (method === 'GET') {
      return json(200, issue.comments.map((c) => ({ id: c.id, body: c.body, created_at: c.createdAt })));
    }
    if (method === 'POST') {
      const comment = store.addComment(issue, str(body.body));
      return json(201, { id: comment.id, body: comment.body, created_at: comment.createdAt });
    }
    return NOT_FOUND;
  }

  return NOT_FOUND;
}

function handlePulls(ctx: RestContext, repo: RepoRec, rest: string[], body: Record<string, unknown>): HttpResult {
  const { store, method, query } = ctx;

  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
      pulls.sort((a, b) => a.number - b.number);
      const { page } = paginate(pulls.map((p) => pullJson(store, repo, p)), query);
      return json(200, page);
    }
    if (method === 'POST') {
      const headRef = str(body.head).split(':').pop() as string;
      const baseRef = str(body.base).split(':').pop() as string;
      if (!headRef || !baseRef) return unprocessable('head and base are required');
      if (!store.branchTip(repo, headRef) || !store.branchTip(repo, baseRef)) {
        return unprocessable('head or base branch does not exist');
      }
      const pull = store.createPull(repo, { title: str(body.title), body: str(body.body), headRef, baseRef });
      return json(201, pullJson(store, repo, pull));
    }
    return NOT_FOUND;
  }

  const number = Number(rest[0]);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;

  if (rest.length === 1 && method === 'GET') {
    return pull ? json(200, pullJson(store, repo, pull)) : NOT_FOUND;
  }

  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    if (!pull) return NOT_FOUND;
    return json(200, store.pullFiles(repo, pull));
  }

  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (!pull) return NOT_FOUND;
    if (pull.merged) return json(405, { message: 'Pull Request is not mergeable' });
    const mergeMethod = str(body.merge_method) || 'merge';
    const sha = store.mergePull(repo, pull, mergeMethod);
    if (!sha) return json(405, { message: 'Pull Request is not mergeable' });
    return json(200, { merged: true, sha, message: 'Pull Request successfully merged' });
  }

  return NOT_FOUND;
}
