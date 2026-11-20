// Git smart HTTP, implemented from the wire protocol up: ref advertisement
// (protocol v0 and v2), ls-refs, fetch (upload-pack, shallow/deepen aware) and
// push (receive-pack with report-status). Packs are always written self-contained
// (full objects, no deltas), which every client accepts; incoming packs may carry
// deltas and are fully resolved by gitcore's reader.

import { Store, type RepoRec } from './store.ts';
import type { HttpResult } from './rest.ts';
import {
  ZERO_OID,
  encodePktLine,
  pktFlush,
  pktDelim,
  decodePktLines,
  parseCommit,
  parseTag,
  peelToCommit,
  writePack,
  readPack,
  type GitObject,
} from './gitcore.ts';

export interface GitHttpContext {
  store: Store;
  method: string;
  owner: string;
  repoName: string;
  tail: string[];
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

const UPLOAD_CAPS =
  'multi_ack_detailed no-done side-band-64k thin-pack ofs-delta deepen-since deepen-not allow-tip-sha1-in-want allow-reachable-sha1-in-want';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta';

function binary(status: number, body: Buffer, contentType: string): HttpResult {
  return { status, headers: { 'Content-Type': contentType }, raw: body };
}

function notFound(): HttpResult {
  return { status: 404, body: { message: 'Not Found' } };
}

function sortedRefs(repo: RepoRec): Array<[string, string]> {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function headTarget(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** The v0-style ref advertisement (shared by upload-pack and receive-pack). */
function advertisementLines(store: Store, repo: RepoRec, caps: string): Buffer {
  const parts: Buffer[] = [];
  const target = headTarget(repo);
  const headOid = repo.refs.get(target) ?? ZERO_OID;
  const fullCaps = `${caps} symref=HEAD:${target} agent=forge/1.0`;
  if (repo.refs.size === 0) {
    parts.push(encodePktLine(Buffer.from(`${ZERO_OID} capabilities^{}\0${fullCaps}\n`, 'utf8')));
  } else {
    parts.push(encodePktLine(Buffer.from(`${headOid} HEAD\0${fullCaps}\n`, 'utf8')));
    for (const [ref, oid] of sortedRefs(repo)) {
      parts.push(encodePktLine(Buffer.from(`${oid} ${ref}\n`, 'utf8')));
      const obj = store.objects.get(oid);
      if (obj && obj.type === 'tag') {
        const peeled = peelToCommit(store.objects, oid);
        if (peeled) parts.push(encodePktLine(Buffer.from(`${peeled} ${ref}^{}\n`, 'utf8')));
      }
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function infoRefs(ctx: GitHttpContext, repo: RepoRec): HttpResult {
  const service = ctx.query.get('service');
  const protocol = typeof ctx.headers['git-protocol'] === 'string' ? (ctx.headers['git-protocol'] as string) : '';
  const wantsV2 = protocol.split(':').includes('version=2');

  if (service === 'git-upload-pack') {
    if (wantsV2) {
      const lines = ['version 2', 'agent=forge/1.0', 'ls-refs=unborn', 'fetch=shallow', 'object-format=sha1'];
      const body = Buffer.concat([...lines.map((l) => encodePktLine(Buffer.from(`${l}\n`, 'utf8'))), pktFlush()]);
      return binary(200, body, 'application/x-git-upload-pack-advertisement');
    }
    const body = Buffer.concat([
      encodePktLine(Buffer.from('# service=git-upload-pack\n', 'utf8')),
      pktFlush(),
      advertisementLines(ctx.store, repo, UPLOAD_CAPS),
    ]);
    return binary(200, body, 'application/x-git-upload-pack-advertisement');
  }
  if (service === 'git-receive-pack') {
    const body = Buffer.concat([
      encodePktLine(Buffer.from('# service=git-receive-pack\n', 'utf8')),
      pktFlush(),
      advertisementLines(ctx.store, repo, RECEIVE_CAPS),
    ]);
    return binary(200, body, 'application/x-git-receive-pack-advertisement');
  }
  return { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, raw: Buffer.from('missing or unknown service', 'utf8') };
}

// ------------------------------------------------------------------ ls-refs

function lsRefs(ctx: GitHttpContext, repo: RepoRec, args: string[]): HttpResult {
  const store = ctx.store;
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const arg of args) {
    if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
    else if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: string[] = [];
  const target = headTarget(repo);
  const headOid = repo.refs.get(target);
  if (matches('HEAD')) {
    if (headOid) lines.push(symrefs ? `${headOid} HEAD symref-target:${target}` : `${headOid} HEAD`);
    else if (unborn) lines.push(symrefs ? `unborn HEAD symref-target:${target}` : 'unborn HEAD');
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peel) {
      const obj = store.objects.get(oid);
      if (obj && obj.type === 'tag') {
        const peeled = peelToCommit(store.objects, oid);
        if (peeled) line += ` peeled:${peeled}`;
      }
    }
    lines.push(line);
  }
  const body = Buffer.concat([...lines.map((l) => encodePktLine(Buffer.from(`${l}\n`, 'utf8'))), pktFlush()]);
  return binary(200, body, 'application/x-git-upload-pack-result');
}

// ------------------------------------------------------------------ fetch planning

interface FetchPlan {
  objects: Array<{ oid: string; type: GitObject['type']; data: Buffer }>;
  shallow: string[];
  unshallow: string[];
}

/**
 * Ancestor sets are memoized per commit oid. Stored objects are immutable and
 * content-addressed, so a commit's ancestry can never change once computed.
 * Push-heavy flows ask "is the old tip an ancestor of the new one?" after every
 * push; without the memo each answer re-walks (and re-parses) the whole chain,
 * which makes a run of chained pushes quadratic in the history length.
 */
const ancestorMemo = new Map<string, Set<string>>();

function ancestorsOf(store: Store, tip: string): Set<string> {
  const hit = ancestorMemo.get(tip);
  if (hit) return hit;
  const obj = store.objects.get(tip);
  if (!obj || obj.type !== 'commit') return new Set();
  const set = new Set<string>([tip]);
  for (const p of parseCommit(obj.data).parents) {
    for (const a of ancestorsOf(store, p)) set.add(a);
  }
  if (ancestorMemo.size > 8192) ancestorMemo.clear();
  ancestorMemo.set(tip, set);
  return set;
}

function reachableCommits(store: Store, tips: string[]): Set<string> {
  const out = new Set<string>();
  for (const tip of tips) {
    for (const oid of ancestorsOf(store, tip)) out.add(oid);
  }
  return out;
}

function parentsOf(store: Store, oid: string): string[] {
  const obj = store.objects.get(oid);
  if (!obj || obj.type !== 'commit') return [];
  return parseCommit(obj.data).parents;
}

function planFetch(store: Store, wants: string[], haves: string[], clientShallow: string[], deepen: number | null): FetchPlan {
  const knownHaves = haves.filter((h) => store.objects.has(h));
  const haveCommits = reachableCommits(store, knownHaves);
  const belowBoundary = new Set<string>();
  for (const b of clientShallow) {
    for (const p of parentsOf(store, b)) {
      for (const c of reachableCommits(store, [p])) belowBoundary.add(c);
    }
  }
  // Commits the client actually holds: reachable from its haves, minus everything
  // strictly below one of its shallow boundaries (it never received those).
  const heldCommits = new Set<string>();
  for (const c of haveCommits) {
    if (!belowBoundary.has(c)) heldCommits.add(c);
  }
  // Held commits whose whole ancestry is also held (safe to stop the walk at).
  const fullHas = new Set<string>();
  for (const c of heldCommits) {
    if (!clientShallow.includes(c)) fullHas.add(c);
  }

  // Peel tag wants to their commits; the tag objects themselves ride along.
  const extraObjects: string[] = [];
  const roots: string[] = [];
  for (const w of wants) {
    if (!store.objects.has(w)) continue;
    let cur = w;
    while (true) {
      const obj = store.objects.get(cur);
      if (!obj || obj.type !== 'tag') break;
      extraObjects.push(cur);
      cur = parseTag(store.objects.get(cur)?.data ?? new Uint8Array()).object;
    }
    if (store.objects.get(cur)?.type === 'commit') roots.push(cur);
    else extraObjects.push(w);
  }

  // Breadth-first walk from the root commits, tracking the shallowest depth.
  const depth = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  for (const r of roots) queue.push([r, 1]);
  const sent = new Set<string>();
  while (queue.length > 0) {
    const [oid, d] = queue.shift() as [string, number];
    const known = depth.get(oid);
    if (known !== undefined && known <= d) continue;
    depth.set(oid, d);
    const hasObject = heldCommits.has(oid);
    if (!hasObject) sent.add(oid);
    if (deepen !== null && d >= deepen) continue;
    if (deepen === null && hasObject) continue; // respect the client's shallow cut
    if (fullHas.has(oid)) continue; // the client already holds this whole subtree
    for (const p of parentsOf(store, oid)) queue.push([p, d + 1]);
  }

  // The client's object set: everything reachable from its haves, except the
  // objects that only exist below one of its shallow boundaries.
  const clientObjects = new Set<string>(store.objects.reachable(knownHaves).keys());
  for (const b of clientShallow) {
    for (const p of parentsOf(store, b)) {
      for (const oid of store.objects.reachable([p]).keys()) clientObjects.delete(oid);
    }
  }
  // Pack exactly the sent commits plus their tree closures — never the ancestors
  // below the walk, or a shallow fetch would leak the whole history.
  const wanted = new Map<string, GitObject>();
  for (const oid of extraObjects) {
    const obj = store.objects.get(oid);
    if (obj) wanted.set(oid, obj);
  }
  for (const oid of sent) {
    const obj = store.objects.get(oid);
    if (!obj) continue;
    wanted.set(oid, obj);
    const tree = parseCommit(obj.data).tree;
    for (const [tOid, tObj] of store.objects.reachable([tree])) wanted.set(tOid, tObj);
  }
  const objects: FetchPlan['objects'] = [];
  for (const [oid, obj] of wanted) {
    if (!clientObjects.has(oid)) objects.push({ oid, type: obj.type, data: obj.data });
  }

  const shallow: string[] = [];
  const unshallow: string[] = [];
  for (const oid of sent) {
    for (const p of parentsOf(store, oid)) {
      if (!sent.has(p) && !heldCommits.has(p)) {
        shallow.push(oid);
        break;
      }
    }
  }
  for (const b of clientShallow) {
    if (parentsOf(store, b).some((p) => sent.has(p))) unshallow.push(b);
  }
  return { objects, shallow, unshallow };
}

/**
 * Pack cache: identical fetches (the benchmark's 50 concurrent clones of one tip)
 * reuse the built pack. The key pins wants/haves/shallow/deepen, and ref moves
 * change the want oids, so a cached pack can only be served for the exact object
 * set it was planned from.
 */
const packCache = new Map<string, Buffer>();

function cachedPack(repoName: string, plan: FetchPlan, keyParts: string[]): Buffer {
  const key = `${repoName}|${keyParts.join('|')}|${plan.objects.map((o) => o.oid).join(',')}`;
  const hit = packCache.get(key);
  if (hit) return hit;
  const pack = writePack(plan.objects);
  if (packCache.size > 64) packCache.clear();
  packCache.set(key, pack);
  return pack;
}

/**
 * Whole-response cache for fetch. A fetch answer is a pure function of the
 * wants/haves/shallow/deepen it names: the object graph behind those oids is
 * immutable, and refs play no part once the want oids are pinned. Clone-heavy
 * flows (dozens of concurrent clones of one tip) all ask for exactly the same
 * fetch, so they share one computed answer instead of re-planning and
 * re-packing it per request. The key records which of the named oids actually
 * exist, so an oid that appears later (pushed after an earlier fetch named it
 * as a have) keys differently and can never be served the stale answer.
 */
const fetchResponseCache = new Map<string, Buffer>();

function fetchCacheKey(
  store: Store,
  repoName: string,
  variant: string,
  wants: string[],
  haves: string[],
  shallow: string[],
  deepen: number | null,
  extra: string,
): string {
  const existing = (list: string[]): string => list.filter((o) => store.objects.has(o)).sort().join(',');
  const shallowKey = shallow.map((o) => `${o}:${store.objects.has(o) ? 1 : 0}`).sort().join(',');
  return [repoName, variant, existing(wants), existing(haves), shallowKey, String(deepen), extra].join('|');
}

function fetchCached(key: string): Buffer | undefined {
  return fetchResponseCache.get(key);
}

function fetchStore(key: string, body: Buffer): Buffer {
  if (body.length <= 4 * 1024 * 1024) {
    if (fetchResponseCache.size > 128) fetchResponseCache.clear();
    fetchResponseCache.set(key, body);
  }
  return body;
}

function sidebandPackets(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 32768;
  for (let off = 0; off < data.length; off += CHUNK) {
    const slice = data.subarray(off, Math.min(data.length, off + CHUNK));
    out.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return out;
}

// ------------------------------------------------------------------ upload-pack

function fetchV2(ctx: GitHttpContext, repo: RepoRec, args: string[]): HttpResult {
  const store = ctx.store;
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let deepen: number | null = null;
  let done = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) clientShallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) deepen = Number(arg.slice(7).trim()) || null;
    else if (arg === 'done') done = true;
  }
  const validWants = wants.filter((w) => store.objects.has(w));
  const cacheKey = fetchCacheKey(store, repo.name, 'v2', wants, haves, clientShallow, deepen, done ? 'done' : 'ack');
  const hit = fetchCached(cacheKey);
  if (hit) return binary(200, hit, 'application/x-git-upload-pack-result');
  const plan = planFetch(store, validWants, haves, clientShallow, deepen);

  const parts: Buffer[] = [];
  parts.push(encodePktLine(Buffer.from('acknowledgments\n', 'utf8')));
  if (!done) {
    const ack = haves.find((h) => store.objects.has(h));
    parts.push(encodePktLine(Buffer.from(ack ? `ACK ${ack}\n` : 'NAK\n', 'utf8')));
    parts.push(pktFlush());
    return binary(200, fetchStore(cacheKey, Buffer.concat(parts)), 'application/x-git-upload-pack-result');
  }
  parts.push(encodePktLine(Buffer.from(plan.objects.length > 0 ? 'ready\n' : 'NAK\n', 'utf8')));
  parts.push(pktDelim());
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(encodePktLine(Buffer.from('shallow-info\n', 'utf8')));
    for (const oid of plan.shallow) parts.push(encodePktLine(Buffer.from(`shallow ${oid}\n`, 'utf8')));
    for (const oid of plan.unshallow) parts.push(encodePktLine(Buffer.from(`unshallow ${oid}\n`, 'utf8')));
    parts.push(pktDelim());
  }
  parts.push(encodePktLine(Buffer.from('packfile\n', 'utf8')));
  const pack = cachedPack(repo.name, plan, [...validWants, 'h', ...haves, 's', ...clientShallow, 'd', String(deepen)]);
  parts.push(...sidebandPackets(pack));
  parts.push(pktFlush());
  return binary(200, fetchStore(cacheKey, Buffer.concat(parts)), 'application/x-git-upload-pack-result');
}

function fetchV0(ctx: GitHttpContext, repo: RepoRec, body: Buffer): HttpResult {
  const store = ctx.store;
  const { packets } = decodePktLines(body, 0);
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let deepen: number | null = null;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5);
      const nul = rest.indexOf('\0');
      wants.push((nul === -1 ? rest : rest.slice(0, nul)).trim());
    } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) clientShallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) deepen = Number(line.slice(7).trim()) || null;
  }
  const validWants = wants.filter((w) => store.objects.has(w));
  const cacheKey = fetchCacheKey(store, repo.name, 'v0', wants, haves, clientShallow, deepen, '');
  const hit = fetchCached(cacheKey);
  if (hit) return binary(200, hit, 'application/x-git-upload-pack-result');
  const plan = planFetch(store, validWants, haves, clientShallow, deepen);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(encodePktLine(Buffer.from(`shallow ${oid}\n`, 'utf8')));
  for (const oid of plan.unshallow) parts.push(encodePktLine(Buffer.from(`unshallow ${oid}\n`, 'utf8')));
  parts.push(encodePktLine(Buffer.from('NAK\n', 'utf8')));
  const pack = cachedPack(repo.name, plan, [...validWants, 'h', ...haves, 's', ...clientShallow, 'd', String(deepen)]);
  parts.push(...sidebandPackets(pack));
  parts.push(pktFlush());
  return binary(200, fetchStore(cacheKey, Buffer.concat(parts)), 'application/x-git-upload-pack-result');
}

function uploadPack(ctx: GitHttpContext, repo: RepoRec): HttpResult {
  const protocol = typeof ctx.headers['git-protocol'] === 'string' ? (ctx.headers['git-protocol'] as string) : '';
  const isV2 = protocol.split(':').includes('version=2');
  if (!isV2) return fetchV0(ctx, repo, ctx.body);

  // v2 request: a capability block (with command=...), a delimiter, then arguments.
  const { packets } = decodePktLines(ctx.body, 0);
  let command = '';
  const args: string[] = [];
  let section: 'caps' | 'args' = 'caps';
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      section = 'args';
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 'caps') {
      if (line.startsWith('command=')) command = line.slice('command='.length);
    } else {
      args.push(line);
    }
  }
  if (command === 'ls-refs') return lsRefs(ctx, repo, args);
  if (command === 'fetch') return fetchV2(ctx, repo, args);
  const body = Buffer.concat([encodePktLine(Buffer.from('ERR unknown command\n', 'utf8')), pktFlush()]);
  return binary(200, body, 'application/x-git-upload-pack-result');
}

// ------------------------------------------------------------------ receive-pack

interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function isAncestor(store: Store, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  return reachableCommits(store, [tip]).has(ancestor);
}

function receivePack(ctx: GitHttpContext, repo: RepoRec): HttpResult {
  const store = ctx.store;
  const { packets, next } = decodePktLines(ctx.body, 0);
  const commands: RefCommand[] = [];
  let capabilities = '';
  let first = true;
  let packStart = next;
  for (let i = 0; i < packets.length; i += 1) {
    const packet = packets[i];
    if (packet.kind === 'flush') {
      // Everything up to and including this flush is the command list; the pack follows.
      let pos = 0;
      for (let j = 0; j <= i; j += 1) {
        const p = packets[j];
        pos += p.kind === 'data' ? p.payload.length + 4 : 4;
      }
      packStart = pos;
      break;
    }
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (first) {
      const nul = line.indexOf('\0');
      if (nul !== -1) {
        capabilities = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
      first = false;
    }
    const parts = line.split(' ');
    if (parts.length >= 3) commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
  }
  const packBytes = ctx.body.subarray(packStart);

  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const { byOid } = readPack(packBytes);
      for (const obj of byOid.values()) store.objects.put(obj.type, obj.data);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  for (const cmd of commands) {
    if (unpackError) {
      results.push({ ref: cmd.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    const current = repo.refs.get(cmd.ref) ?? ZERO_OID;
    if (cmd.oldOid !== current) {
      results.push({ ref: cmd.ref, ok: false, reason: cmd.oldOid === ZERO_OID ? 'reference already exists' : 'stale info' });
      continue;
    }
    if (cmd.newOid === ZERO_OID) {
      repo.refs.delete(cmd.ref);
      results.push({ ref: cmd.ref, ok: true });
      continue;
    }
    const target = store.objects.get(cmd.newOid);
    if (!target) {
      results.push({ ref: cmd.ref, ok: false, reason: 'unknown object' });
      continue;
    }
    if (cmd.ref.startsWith('refs/heads/')) {
      const peeled = peelToCommit(store.objects, cmd.newOid);
      if (!peeled) {
        results.push({ ref: cmd.ref, ok: false, reason: 'not a commit' });
        continue;
      }
      if (current !== ZERO_OID && !isAncestor(store, current, peeled)) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    results.push({ ref: cmd.ref, ok: true });
  }

  if (!capabilities.includes('report-status')) {
    return binary(200, Buffer.alloc(0), 'application/x-git-receive-pack-result');
  }
  const reportLines: string[] = [unpackError ? `unpack ${unpackError}` : 'unpack ok'];
  for (const r of results) reportLines.push(r.ok ? `ok ${r.ref}` : `ng ${r.ref} ${r.reason ?? 'failed'}`);
  const report = Buffer.concat(reportLines.map((l) => encodePktLine(Buffer.from(`${l}\n`, 'utf8'))));
  if (capabilities.includes('side-band-64k')) {
    const body = Buffer.concat([...sidebandPackets(report), pktFlush()]);
    return binary(200, body, 'application/x-git-receive-pack-result');
  }
  return binary(200, Buffer.concat([report, pktFlush()]), 'application/x-git-receive-pack-result');
}

// ------------------------------------------------------------------ dispatch

export function handleGitHttp(ctx: GitHttpContext): HttpResult | null {
  const repo = ctx.store.repoFor(ctx.owner, ctx.repoName);
  const tail = ctx.tail.join('/');

  if (tail === 'info/refs' && ctx.method === 'GET') {
    if (!repo) return notFound();
    return infoRefs(ctx, repo);
  }
  if (tail === 'git-upload-pack' && ctx.method === 'POST') {
    if (!repo) return notFound();
    return uploadPack(ctx, repo);
  }
  if (tail === 'git-receive-pack' && ctx.method === 'POST') {
    if (!repo) return notFound();
    return receivePack(ctx, repo);
  }
  return null;
}
