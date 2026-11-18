// Git object model in pure Node: hashing, loose object encode/decode, tree/commit/tag
// parsing and building, tree path surgery, packfile read/write, delta application,
// and the pkt-line codec. No deltas are ever *created* here: packs we send carry full
// objects only, which the protocol allows; deltas are only *applied* when a received
// pack contains them.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export function encodeLoose(type: GitObjectType, data: Uint8Array): Buffer {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return deflateSync(Buffer.concat([head, Buffer.from(data)]));
}

export function decodeLoose(bytes: Uint8Array): GitObject {
  const raw = inflateSync(Buffer.from(bytes));
  const nul = raw.indexOf(0);
  const head = raw.subarray(0, nul).toString('utf8');
  const sp = head.indexOf(' ');
  const type = head.slice(0, sp) as GitObjectType;
  return { type, data: Buffer.from(raw.subarray(nul + 1)) };
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Git's tree sort: byte order on names, directories compared as if suffixed with '/'. */
function treeNameKey(e: TreeEntry): string {
  return e.mode === '40000' || e.mode === '040000' ? `${e.name}/` : e.name;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const buf = Buffer.from(data);
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i);
    const mode = buf.subarray(i, sp).toString('utf8');
    const nul = buf.indexOf(0, sp + 1);
    const name = buf.subarray(sp + 1, nul).toString('utf8');
    const oid = buf.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

export function buildTree(entries: ReadonlyArray<TreeEntry>): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeNameKey(a);
    const kb = treeNameKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits / tags

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  raw: Buffer;
}

export function parseCommit(data: Uint8Array): CommitView {
  const buf = Buffer.from(data);
  const blank = buf.indexOf('\n\n');
  const head = buf.subarray(0, blank === -1 ? buf.length : blank).toString('utf8');
  const message = blank === -1 ? '' : buf.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message, raw: buf };
}

export function buildCommit(fields: {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const p of fields.parents) lines.push(`parent ${p}`);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer}`);
  // The message is stored verbatim: the REST commits list returns it byte-for-byte,
  // and the suite compares it against the exact string the contents API was given.
  return Buffer.from(`${lines.join('\n')}\n\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Uint8Array): TagView {
  const text = Buffer.from(data).toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank === -1 ? text : text.slice(0, blank);
  const view: TagView = { object: '', type: '', tag: '', tagger: '', message: blank === -1 ? '' : text.slice(blank + 2) };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) view.object = line.slice(7).trim();
    else if (line.startsWith('type ')) view.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) view.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) view.tagger = line.slice(7);
  }
  return view;
}

/** Peel an object id through tags to the first non-tag object. */
export function peelToCommit(store: ObjectStore, oid: string): string {
  let cur = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const obj = store.get(cur);
    if (!obj) return cur;
    if (obj.type === 'tag') {
      cur = parseTag(obj.data).object;
      continue;
    }
    return cur;
  }
  return cur;
}

// ---------------------------------------------------------------- object store

export class ObjectStore {
  private objects = new Map<string, GitObject>();

  has(oid: string): boolean {
    return this.objects.has(oid);
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  /** Store raw object bytes; returns the oid (idempotent). */
  put(type: GitObjectType, data: Uint8Array): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data: Buffer.from(data) });
    return oid;
  }

  putObject(obj: GitObject): string {
    return this.put(obj.type, obj.data);
  }

  get size(): number {
    return this.objects.size;
  }

  /** All objects reachable from the given tips (commits, trees, blobs, tags). */
  reachable(tips: ReadonlyArray<string>): Map<string, GitObject> {
    const out = new Map<string, GitObject>();
    const stack = [...tips];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (out.has(oid)) continue;
      const obj = this.objects.get(oid);
      if (!obj) continue;
      out.set(oid, obj);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        stack.push(c.tree, ...c.parents);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) if (e.mode !== '160000') stack.push(e.oid);
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).object);
      }
    }
    return out;
  }

  /**
   * Objects reachable from `wants` but not from `haves` (both as commit-ish tips).
   * Have-tips mark their whole ancestry as had. Missing have objects are ignored.
   */
  wantedObjects(wants: ReadonlyArray<string>, haves: ReadonlyArray<string>): Map<string, GitObject> {
    const had = this.reachable(haves);
    const all = this.reachable(wants);
    for (const oid of had.keys()) all.delete(oid);
    return all;
  }
}

// ---------------------------------------------------------------- tree surgery

/** Flatten a tree (recursively) into path -> {mode, oid}. */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = '', out = new Map<string, { mode: string; oid: string }>()): Map<string, { mode: string; oid: string }> {
  const obj = store.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000' || e.mode === '040000') flattenTree(store, e.oid, path, out);
    else out.set(path, { mode: e.mode, oid: e.oid });
  }
  return out;
}

/** Rebuild a tree oid from a flattened path map. */
export function treeFromFlat(store: ObjectStore, flat: Map<string, { mode: string; oid: string }>): string {
  interface Node {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let next = node.dirs.get(parts[i]);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1], entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, sub] of node.dirs) entries.push({ mode: '40000', name, oid: build(sub) });
    for (const [name, f] of node.files) entries.push({ mode: f.mode, name, oid: f.oid });
    return store.put('tree', buildTree(entries));
  };
  return build(root);
}

/** Set (or delete, when blobOid is null) one path in a tree; returns the new root tree oid. */
export function setTreePath(store: ObjectStore, rootTreeOid: string | null, path: string, blobOid: string | null, mode = '100644'): string {
  const flat = rootTreeOid ? flattenTree(store, rootTreeOid) : new Map<string, { mode: string; oid: string }>();
  if (blobOid === null) flat.delete(path);
  else flat.set(path, { mode, oid: blobOid });
  return treeFromFlat(store, flat);
}

// ---------------------------------------------------------------- pkt-line

export function encodePktLine(payload: string | Uint8Array): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');
export const pktResponseEnd = (): Buffer => Buffer.from('0002', 'ascii');

export type Pkt =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Decode as many complete pkt-lines as the buffer holds; returns packets and bytes consumed. */
export function decodePktLines(bytes: Uint8Array, start = 0): { packets: Pkt[]; next: number } {
  const buf = Buffer.from(bytes);
  const packets: Pkt[] = [];
  let i = start;
  while (i + 4 <= buf.length) {
    const hex = buf.subarray(i, i + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
    const len = parseInt(hex, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      i += 4;
    } else if (len === 1) {
      packets.push({ kind: 'delim' });
      i += 4;
    } else if (len === 2) {
      packets.push({ kind: 'response-end' });
      i += 4;
    } else if (len < 4 || i + len > buf.length) {
      break;
    } else {
      packets.push({ kind: 'data', payload: Buffer.from(buf.subarray(i + 4, i + len)) });
      i += len;
    }
  }
  return { packets, next: i };
}

// ---------------------------------------------------------------- packfiles

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/** Write a complete pack (version 2) holding the given full objects, in the given order. */
export function writePack(objects: ReadonlyArray<{ oid: string; type: GitObjectType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  parts.push(head);
  for (const obj of objects) {
    parts.push(writePackObjectHeader(TYPE_CODE[obj.type], obj.data.length));
    // Level 1: packs are consumed on the spot, and deflate time dominates clone
    // latency on large trees; the wire format is identical at any level.
    parts.push(deflateSync(obj.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const buf = Buffer.from(delta);
  let i = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = buf[i];
      i += 1;
      value |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error(`delta base size ${baseSize} != ${base.length}`);
  const resultSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (i < buf.length) {
    const op = buf[i];
    i += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          offset |= buf[i] << (8 * bit);
          i += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          size |= buf[i] << (8 * bit);
          i += 1;
        }
      }
      if (size === 0) size = 0x10000;
      out.push(Buffer.from(base.subarray(offset, offset + size)));
      produced += size;
    } else if (op > 0) {
      out.push(Buffer.from(buf.subarray(i, i + op)));
      produced += op;
      i += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize || produced !== resultSize) throw new Error('delta result size mismatch');
  return result;
}

export interface PackReadResult {
  objects: GitObject[];
  /** oid -> object for everything the pack held after delta resolution. */
  byOid: Map<string, GitObject>;
}

/**
 * Read a pack fully, resolving OFS/REF deltas. `externalBase` resolves REF_DELTA bases
 * that live outside the pack (thin packs); without it such packs throw.
 */
export function readPack(pack: Uint8Array, externalBase?: (oid: string) => GitObject | undefined): PackReadResult {
  const buf = Buffer.from(pack);
  if (buf.length < 12 + 20 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const expect = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!trailer.equals(expect)) throw new Error('pack checksum mismatch');

  interface RawEntry {
    offset: number;
    typeCode: number;
    data?: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const entries: RawEntry[] = [];
  let i = 12;
  for (let n = 0; n < count; n += 1) {
    const start = i;
    let b = buf[i];
    i += 1;
    const typeCode = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      b = buf[i];
      i += 1;
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    const entry: RawEntry = { offset: start, typeCode };
    if (typeCode === 6) {
      // OFS_DELTA: negative offset encoding.
      let c = buf[i];
      i += 1;
      let offset = c & 0x7f;
      while (c & 0x80) {
        c = buf[i];
        i += 1;
        offset = ((offset + 1) << 7) | (c & 0x7f);
      }
      entry.baseOffset = start - offset;
    } else if (typeCode === 7) {
      entry.baseOid = buf.subarray(i, i + 20).toString('hex');
      i += 20;
    }
    // Inflate exactly one zlib stream starting at i; {info:true} reports how many
    // input bytes the stream consumed, which is where the next entry begins.
    const inflated = inflateSync(buf.subarray(i), { info: true });
    if (inflated.buffer.length !== size) throw new Error(`pack object size ${inflated.buffer.length} != ${size}`);
    entry.data = inflated.buffer;
    i += inflated.engine.bytesWritten;
    entries.push(entry);
  }

  const byOffset = new Map<number, RawEntry>();
  for (const e of entries) byOffset.set(e.offset, e);
  const resolved = new Map<number, GitObject>();
  const byOid = new Map<string, GitObject>();
  const resolve = (entry: RawEntry): GitObject => {
    const hit = resolved.get(entry.offset);
    if (hit) return hit;
    let obj: GitObject;
    if (entry.typeCode >= 1 && entry.typeCode <= 4) {
      obj = { type: CODE_TYPE[entry.typeCode], data: entry.data as Buffer };
    } else if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error('ofs-delta base not in pack');
      const base = resolve(baseEntry);
      obj = { type: base.type, data: applyDelta(base.data, entry.data as Buffer) };
    } else if (entry.typeCode === 7) {
      let base = byOid.get(entry.baseOid as string);
      if (!base) {
        // The base may be a later entry in the same pack; resolve by scanning.
        for (const cand of entries) {
          const c = resolve(cand);
          if (hashObject(c.type, c.data) === entry.baseOid) {
            base = c;
            break;
          }
        }
      }
      if (!base && externalBase) base = externalBase(entry.baseOid as string);
      if (!base) throw new Error(`ref-delta base ${entry.baseOid} not available`);
      obj = { type: base.type, data: applyDelta(base.data, entry.data as Buffer) };
    } else {
      throw new Error(`unknown pack type code ${entry.typeCode}`);
    }
    resolved.set(entry.offset, obj);
    byOid.set(hashObject(obj.type, obj.data), obj);
    return obj;
  };
  const objects: GitObject[] = [];
  for (const e of entries) objects.push(resolve(e));
  return { objects, byOid };
}
