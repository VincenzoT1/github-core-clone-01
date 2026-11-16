import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export function asBuffer(value: string | Uint8Array): Buffer {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

export function objectHeader(type: GitObjectType, size: number): Buffer {
  return Buffer.from(`${type} ${size}\0`, 'utf8');
}

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = asBuffer(data);
  const hash = createHash('sha1');
  hash.update(objectHeader(type, body.length));
  hash.update(body);
  return hash.digest('hex');
}

export function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = asBuffer(payload);
  const len = data.length + 4;
  const hex = len.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(hex, 'ascii'), data]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

export function inflateAt(buffer: Uint8Array, offset: number): { data: Buffer; next: number } {
  const view = asBuffer(buffer).subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuffer = asBuffer(base);
  const deltaBuffer = asBuffer(delta);
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = deltaBuffer[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  readSize();
  const targetSize = readSize();
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += deltaBuffer[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += deltaBuffer[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      deltaBuffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    }
  }
  return out;
}

export function readPack(pack: Uint8Array, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  const buffer = asBuffer(pack);
  if (buffer.length < 32 || buffer.subarray(0, 4).toString('ascii') !== 'PACK') return new Map();
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
    oid?: string;
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;

  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };

    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }

    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();

  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      const base = resolve(baseEntry!);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const ext = resolveBase?.(wanted);
        if (ext) {
          type = ext.type;
          data = applyDelta(ext.data, entry.data);
        } else {
          type = 'blob';
          data = entry.data;
        }
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    return { type, data, oid };
  };

  for (const entry of raw) {
    const res = resolve(entry);
    objects.set(res.oid, { type: res.type, data: res.data });
  }

  return objects;
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

export function parseCommit(data: Buffer): { tree: string; parents: string[]; author: string; message: string } {
  const text = data.toString('utf8');
  const lines = text.split('\n');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let inMessage = false;
  const msgLines: string[] = [];
  for (const line of lines) {
    if (inMessage) {
      msgLines.push(line);
      continue;
    }
    if (line === '') {
      inMessage = true;
      continue;
    }
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7).trim();
  }
  return { tree, parents, author, message: msgLines.join('\n') };
}

export function parseTree(data: Buffer): Array<{ mode: string; path: string; name: string; oid: string }> {
  const entries: Array<{ mode: string; path: string; name: string; oid: string }> = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space);
    if (nul < 0) break;
    const path = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, path, name: path, oid });
    offset = nul + 21;
  }
  return entries;
}

export function isAncestor(childOid: string, ancestorOid: string, objects: Map<string, GitObject>): boolean {
  if (childOid === ancestorOid) return true;
  const visited = new Set<string>();
  const queue = [childOid];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    if (curr === ancestorOid) return true;
    if (visited.has(curr)) continue;
    visited.add(curr);
    const obj = objects.get(curr);
    if (obj && obj.type === 'commit') {
      const parsed = parseCommit(obj.data);
      for (const p of parsed.parents) {
        if (p === ancestorOid) return true;
        queue.push(p);
      }
    }
  }
  return false;
}

export function collectReachableObjects(
  tips: Iterable<string>,
  objects: Map<string, GitObject>,
  haves: Iterable<string> = [],
  depth?: number,
): GitObject[] {
  const haveSet = new Set<string>();
  const haveQueue = [...haves];
  while (haveQueue.length > 0) {
    const oid = haveQueue.shift()!;
    if (haveSet.has(oid)) continue;
    haveSet.add(oid);
    const obj = objects.get(oid);
    if (obj) {
      if (obj.type === 'commit') {
        const p = parseCommit(obj.data);
        if (p.tree) haveQueue.push(p.tree);
        for (const parent of p.parents) haveQueue.push(parent);
      } else if (obj.type === 'tree') {
        const entries = parseTree(obj.data);
        for (const e of entries) haveQueue.push(e.oid);
      }
    }
  }

  const result: GitObject[] = [];
  const visited = new Set<string>();
  const queue: Array<{ oid: string; d: number }> = [...tips].map((oid) => ({ oid, d: 1 }));

  while (queue.length > 0) {
    const { oid, d } = queue.shift()!;
    if (visited.has(oid) || haveSet.has(oid)) continue;
    visited.add(oid);
    const obj = objects.get(oid);
    if (!obj) continue;
    result.push(obj);

    if (obj.type === 'commit') {
      const parsed = parseCommit(obj.data);
      if (parsed.tree && !haveSet.has(parsed.tree)) queue.push({ oid: parsed.tree, d });
      if (depth === undefined || d < depth) {
        for (const p of parsed.parents) {
          if (!haveSet.has(p)) queue.push({ oid: p, d: d + 1 });
        }
      }
    } else if (obj.type === 'tree') {
      const treeEntries = parseTree(obj.data);
      for (const e of treeEntries) {
        if (!haveSet.has(e.oid)) queue.push({ oid: e.oid, d });
      }
    } else if (obj.type === 'tag') {
      const text = obj.data.toString('utf8');
      const m = text.match(/^object\s+([0-9a-f]{40})/m);
      if (m && !haveSet.has(m[1])) queue.push({ oid: m[1], d });
    }
  }

  // Include annotated tags pointing to any reachable commit (include-tag)
  for (const [tagOid, obj] of objects.entries()) {
    if (obj.type === 'tag' && !visited.has(tagOid)) {
      const text = obj.data.toString('utf8');
      const m = text.match(/^object\s+([0-9a-f]{40})/m);
      if (m && visited.has(m[1])) {
        visited.add(tagOid);
        result.push(obj);
      }
    }
  }

  return result;
}
