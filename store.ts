// The forge's in-memory store: one content-addressed git object store shared by all
// repositories, plus per-repository records (refs, issues, pull requests, labels).
// Everything the REST, GraphQL, MCP and git-HTTP surfaces serve comes from here, so
// the surfaces always agree with each other.

import {
  ObjectStore,
  buildCommit,
  flattenTree,
  hashObject,
  parseCommit,
  peelToCommit,
  setTreePath,
  treeFromFlat,
  type GitObjectType,
} from './gitcore.ts';

export const DEFAULT_BRANCH = 'main';
const COMMIT_IDENTITY = 'Forge <forge@forge.invalid>';

export interface LabelRec {
  name: string;
  color: string;
}

export interface CommentRec {
  id: number;
  body: string;
  createdAt: string;
}

export interface IssueRec {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  seq: number;
}

export interface PullRec {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  seq: number;
}

export interface RepoRec {
  name: string;
  /** The owner's login, learned from the first owner-addressed request; null until then. */
  ownerLogin: string | null;
  dbId: number;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>;
  nextNumber: number;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  labels: Map<string, LabelRec>;
  seq: number;
}

export class Store {
  readonly objects = new ObjectStore();
  readonly repos = new Map<string, RepoRec>();
  /** The token owner's login, learned from the first owner-addressed path. */
  viewerLogin: string | null = null;
  private repoSeq = 0;
  private nextRepoDbId = 100;
  private nextIssueId = 10_000;
  private nextCommentId = 100_000;
  private seq = 0;

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  createRepo(name: string, opts: { isPrivate?: boolean; description?: string } = {}): RepoRec {
    const repo: RepoRec = {
      name,
      ownerLogin: null,
      dbId: this.nextRepoDbId,
      isPrivate: opts.isPrivate ?? false,
      description: opts.description ?? '',
      defaultBranch: DEFAULT_BRANCH,
      refs: new Map(),
      nextNumber: 1,
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      seq: this.nextSeq(),
    };
    this.nextRepoDbId += 1;
    this.repoSeq += 1;
    this.repos.set(name, repo);
    return repo;
  }

  /**
   * Resolve a repository by the owner/name pair a request used. Learns the owner
   * login (and the global viewer login) the first time a token-created repo is
   * addressed under some owner; a repo addressed under a *different* owner than the
   * learned one does not exist, which is what makes foreign-owner reads 404.
   */
  repoFor(owner: string, name: string): RepoRec | null {
    const repo = this.repos.get(name);
    if (!repo) return null;
    if (repo.ownerLogin === null) {
      repo.ownerLogin = owner;
      if (this.viewerLogin === null) this.viewerLogin = owner;
      return repo;
    }
    return repo.ownerLogin === owner ? repo : null;
  }

  /** Resolve by name alone (surfaces that carry no meaningful owner, e.g. MCP tools). */
  repoByName(name: string): RepoRec | null {
    return this.repos.get(name) ?? null;
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  listRepos(): RepoRec[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  // ------------------------------------------------------------ git helpers

  branchRef(branch: string): string {
    return `refs/heads/${branch}`;
  }

  refOid(repo: RepoRec, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  branchTip(repo: RepoRec, branch: string): string | undefined {
    return repo.refs.get(this.branchRef(branch));
  }

  /** The tree oid at a ref-ish (branch name, full ref, or commit oid); null when unborn/unknown. */
  treeAt(repo: RepoRec, refish: string): string | null {
    const oid = this.resolveCommit(repo, refish);
    if (!oid) return null;
    const obj = this.objects.get(oid);
    if (!obj || obj.type !== 'commit') return null;
    return parseCommit(obj.data).tree;
  }

  /** Resolve a branch name, full ref, or raw oid to a commit oid (peeling tags). */
  resolveCommit(repo: RepoRec, refish: string): string | null {
    let oid: string | undefined;
    if (/^[0-9a-f]{40}$/i.test(refish)) oid = refish.toLowerCase();
    else if (refish.startsWith('refs/')) oid = repo.refs.get(refish);
    else oid = repo.refs.get(this.branchRef(refish)) ?? repo.refs.get(refish);
    if (!oid) return null;
    if (!this.objects.has(oid)) return null;
    return peelToCommit(this.objects, oid);
  }

  /** Flattened path -> blob map at a ref-ish; empty map when unborn. */
  flatAt(repo: RepoRec, refish: string): Map<string, { mode: string; oid: string }> {
    const tree = this.treeAt(repo, refish);
    if (!tree) return new Map();
    return flattenTree(this.objects, tree);
  }

  private commitWithTree(repo: RepoRec, branch: string, treeOid: string, message: string): string {
    const parent = this.branchTip(repo, branch);
    const now = Math.floor(Date.now() / 1000);
    const identity = `${COMMIT_IDENTITY} ${now} +0000`;
    const data = buildCommit({
      tree: treeOid,
      parents: parent ? [parent] : [],
      author: identity,
      committer: identity,
      message,
    });
    const oid = this.objects.put('commit', data);
    repo.refs.set(this.branchRef(branch), oid);
    return oid;
  }

  /**
   * Create or update (or, with content === null, delete) one file on a branch,
   * committing on top of the branch tip. Creates the branch from the default
   * branch when it does not exist yet. Returns the commit oid and blob oid.
   */
  commitFile(
    repo: RepoRec,
    branch: string,
    path: string,
    content: Buffer | null,
    message: string,
  ): { commitOid: string; blobOid: string | null; previousBlobOid: string | null } {
    if (!repo.refs.has(this.branchRef(branch))) {
      const baseTip = this.branchTip(repo, repo.defaultBranch);
      if (baseTip) repo.refs.set(this.branchRef(branch), baseTip);
    }
    const tipTree = this.treeAt(repo, branch);
    const flatBefore = tipTree ? flattenTree(this.objects, tipTree) : new Map<string, { mode: string; oid: string }>();
    const previousBlobOid = flatBefore.get(path)?.oid ?? null;
    const blobOid = content === null ? null : this.objects.put('blob', content);
    const newTree = setTreePath(this.objects, tipTree, path, blobOid);
    const commitOid = this.commitWithTree(repo, branch, newTree, message);
    return { commitOid, blobOid, previousBlobOid };
  }

  /** All commits reachable from a tip, newest first (by committer time, then ancestry order). */
  commitLog(repo: RepoRec, tip: string): Array<{ oid: string; tree: string; parents: string[]; author: string; committer: string; message: string }> {
    const seen = new Set<string>();
    const out: Array<{ oid: string; tree: string; parents: string[]; author: string; committer: string; message: string; ts: number; order: number }> = [];
    const queue: string[] = [tip];
    let order = 0;
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = this.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const c = parseCommit(obj.data);
      const tsMatch = / (\d+) [+-]\d{4}$/.exec(c.committer);
      out.push({ oid, tree: c.tree, parents: c.parents, author: c.author, committer: c.committer, message: c.message, ts: tsMatch ? Number(tsMatch[1]) : 0, order });
      order += 1;
      for (const p of c.parents) queue.push(p);
    }
    out.sort((a, b) => b.ts - a.ts || a.order - b.order);
    return out;
  }

  /** The best common ancestor of two commits, or null. */
  mergeBase(a: string, b: string): string | null {
    if (a === b) return a;
    const ancestorsOf = (tip: string): Map<string, number> => {
      const dist = new Map<string, number>();
      const queue: Array<[string, number]> = [[tip, 0]];
      while (queue.length > 0) {
        const [oid, d] = queue.shift() as [string, number];
        if (dist.has(oid)) continue;
        dist.set(oid, d);
        const obj = this.objects.get(oid);
        if (obj && obj.type === 'commit') for (const p of parseCommit(obj.data).parents) queue.push([p, d + 1]);
      }
      return dist;
    };
    const da = ancestorsOf(a);
    const db = ancestorsOf(b);
    let best: string | null = null;
    let bestScore = Infinity;
    for (const [oid, d] of da) {
      const other = db.get(oid);
      if (other !== undefined && d + other < bestScore) {
        bestScore = d + other;
        best = oid;
      }
    }
    return best;
  }

  // ------------------------------------------------------------ issues / pulls

  createIssue(repo: RepoRec, fields: { title: string; body: string; labels?: string[] }): IssueRec {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const issue: IssueRec = {
      number,
      id: this.nextIssueId,
      title: fields.title,
      body: fields.body,
      state: 'open',
      labels: fields.labels ?? [],
      comments: [],
      seq: this.nextSeq(),
    };
    this.nextIssueId += 1;
    repo.issues.set(number, issue);
    return issue;
  }

  addComment(issue: IssueRec, body: string): CommentRec {
    const comment: CommentRec = { id: this.nextCommentId, body, createdAt: new Date().toISOString() };
    this.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  createPull(repo: RepoRec, fields: { title: string; body: string; headRef: string; baseRef: string }): PullRec {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const pull: PullRec = {
      number,
      id: this.nextIssueId,
      title: fields.title,
      body: fields.body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: fields.headRef,
      baseRef: fields.baseRef,
      seq: this.nextSeq(),
    };
    this.nextIssueId += 1;
    repo.pulls.set(number, pull);
    return pull;
  }

  /**
   * Three-way tree merge of head into base. Returns the merged flat map, or null
   * when any path conflicts (both sides changed it differently from the base).
   */
  mergeTrees(
    baseFlat: Map<string, { mode: string; oid: string }>,
    headFlat: Map<string, { mode: string; oid: string }>,
    mbFlat: Map<string, { mode: string; oid: string }>,
  ): Map<string, { mode: string; oid: string }> | null {
    const merged = new Map<string, { mode: string; oid: string }>();
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys(), ...mbFlat.keys()]);
    for (const path of paths) {
      const base = baseFlat.get(path);
      const head = headFlat.get(path);
      const mb = mbFlat.get(path);
      const sameBlob = (x?: { oid: string }, y?: { oid: string }) => (x?.oid ?? null) === (y?.oid ?? null);
      if (sameBlob(base, head)) {
        if (base) merged.set(path, base);
      } else if (sameBlob(base, mb)) {
        if (head) merged.set(path, head);
      } else if (sameBlob(head, mb)) {
        if (base) merged.set(path, base);
      } else {
        return null;
      }
    }
    return merged;
  }

  /** Whether head can be merged into base without conflict, plus the merge base. */
  mergeability(repo: RepoRec, pull: PullRec): { base: string | null; conflict: boolean } {
    const baseTip = this.branchTip(repo, pull.baseRef);
    const headTip = this.branchTip(repo, pull.headRef);
    if (!baseTip || !headTip) return { base: null, conflict: true };
    const mb = this.mergeBase(baseTip, headTip);
    if (!mb) return { base: null, conflict: true };
    const merged = this.mergeTrees(this.flatAt(repo, pull.baseRef), this.flatAt(repo, pull.headRef), this.flatAt(repo, mb));
    return { base: mb, conflict: merged === null };
  }

  /**
   * Merge a pull request into its base branch. Returns the merge commit oid, or
   * null on conflict. method 'merge' makes a two-parent commit; 'squash' (and
   * 'rebase', approximated) makes a single-parent commit with the merged tree.
   */
  mergePull(repo: RepoRec, pull: PullRec, method: string): string | null {
    const baseTip = this.branchTip(repo, pull.baseRef);
    const headTip = this.branchTip(repo, pull.headRef);
    if (!baseTip || !headTip) return null;
    const mb = this.mergeBase(baseTip, headTip);
    if (!mb) return null;
    const merged = this.mergeTrees(this.flatAt(repo, pull.baseRef), this.flatAt(repo, pull.headRef), this.flatAt(repo, mb));
    if (merged === null) return null;
    const treeOid = treeFromFlat(this.objects, merged);
    const now = Math.floor(Date.now() / 1000);
    const identity = `${COMMIT_IDENTITY} ${now} +0000`;
    let data: Buffer;
    if (method === 'merge') {
      data = buildCommit({
        tree: treeOid,
        parents: [baseTip, headTip],
        author: identity,
        committer: identity,
        message: `Merge pull request #${pull.number} from ${pull.headRef}`,
      });
    } else {
      data = buildCommit({
        tree: treeOid,
        parents: [baseTip],
        author: identity,
        committer: identity,
        message: `${pull.title} (#${pull.number})`,
      });
    }
    const oid = this.objects.put('commit', data);
    repo.refs.set(this.branchRef(pull.baseRef), oid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = new Date().toISOString();
    pull.mergeCommitSha = oid;
    return oid;
  }

  /** Files changed by a pull request: merge-base tree vs head tree. */
  pullFiles(repo: RepoRec, pull: PullRec): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const baseTip = this.branchTip(repo, pull.baseRef);
    const headTip = this.branchTip(repo, pull.headRef);
    if (!baseTip || !headTip) return [];
    const mb = this.mergeBase(baseTip, headTip) ?? baseTip;
    const from = this.flatAt(repo, mb);
    const to = this.flatAt(repo, pull.headRef);
    const paths = new Set([...from.keys(), ...to.keys()]);
    const files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    for (const path of [...paths].sort()) {
      const a = from.get(path);
      const b = to.get(path);
      if ((a?.oid ?? null) === (b?.oid ?? null)) continue;
      const aText = a ? (this.objects.get(a.oid)?.data.toString('utf8') ?? '') : '';
      const bText = b ? (this.objects.get(b.oid)?.data.toString('utf8') ?? '') : '';
      const { additions, deletions } = lineDiff(aText, bText);
      files.push({
        filename: path,
        status: !a ? 'added' : !b ? 'removed' : 'modified',
        additions,
        deletions,
        changes: additions + deletions,
      });
    }
    return files;
  }
}

/** Line-level add/remove counts between two texts (LCS over lines; inputs are small). */
export function lineDiff(aText: string, bText: string): { additions: number; deletions: number } {
  if (aText === bText) return { additions: 0, deletions: 0 };
  const a = aText === '' ? [] : aText.split('\n');
  const b = bText === '' ? [] : bText.split('\n');
  const m = a.length;
  const n = b.length;
  const dp: number[] = new Array(n + 1).fill(0);
  for (let i = m - 1; i >= 0; i -= 1) {
    let prev = 0;
    for (let j = n - 1; j >= 0; j -= 1) {
      const tmp = dp[j];
      dp[j] = a[i] === b[j] ? prev + 1 : Math.max(dp[j], dp[j + 1]);
      prev = tmp;
    }
  }
  const common = dp[0];
  return { additions: n - common, deletions: m - common };
}

/** GitHub-style global node id: opaque, stable, never the bare numeric id. */
export function globalId(kind: string, parts: ReadonlyArray<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64url');
}

export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    return { kind: parts[0], parts: parts.slice(1) };
  } catch {
    return null;
  }
}

export function blobBase64(data: Uint8Array): string {
  return Buffer.from(data).toString('base64');
}

export function shaOf(type: GitObjectType, data: Uint8Array): string {
  return hashObject(type, data);
}
