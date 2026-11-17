import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import {
  ZERO_OID,
  type GitObject,
  type GitObjectType,
  encodePktLine,
  pktFlush,
  pktDelim,
  pktResponseEnd,
  hashObject,
  readPack,
  writePack,
  isAncestor,
  collectReachableObjects,
  parseCommit,
  parseTree,
} from './git-helper.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const VIEWER_LOGIN = 'adaiversen';
const STRANGER_LOGIN = 'olgabauer';

interface Issue {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Array<{ id: number; nodeId: string; body: string }>;
  created_at: string;
}

interface Pull {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  head: string;
  headSha: string;
  base: string;
  baseSha: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at?: string;
  merge_commit_sha?: string;
  files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }>;
}

interface RepoFile {
  path: string;
  content: string;
  sha: string;
}

interface Repo {
  databaseId: number;
  nodeId: string;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  branches: Map<string, string>; // branch name -> tip sha
  tags: Map<string, string>; // tag name -> oid
  peeledTags: Map<string, string>; // tag name -> commit sha
  files: Map<string, RepoFile>; // path -> file (default branch)
  branchFiles: Map<string, Map<string, RepoFile>>; // branch -> (path -> file)
  commits: Array<{ sha: string; message: string; author: string; date: string; branch?: string }>;
  labels: Set<string>;
  issues: Issue[];
  issuesByNumber: Map<number, Issue>;
  pulls: Pull[];
  objects: Map<string, GitObject>; // sha -> GitObject
}

const repos = new Map<string, Repo>();
let nextDbId = 5000;

function repoKey(owner?: string, name?: string): string {
  return `${(owner || '').toLowerCase()}/${(name || '').toLowerCase()}`;
}

function sha1(data: string | Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function buildFilesMapFromCommit(commitSha: string, objects: Map<string, GitObject>): Map<string, RepoFile> {
  const fileMap = new Map<string, RepoFile>();
  const commitObj = objects.get(commitSha);
  if (!commitObj || commitObj.type !== 'commit') return fileMap;
  const commit = parseCommit(commitObj.data);

  function recurseTree(treeSha: string, prefix: string) {
    const treeObj = objects.get(treeSha);
    if (!treeObj || treeObj.type !== 'tree') return;
    const entries = parseTree(treeObj.data);
    for (const entry of entries) {
      const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000' || entry.mode === '040000') {
        recurseTree(entry.oid, fullPath);
      } else {
        const blobObj = objects.get(entry.oid);
        fileMap.set(fullPath, {
          path: fullPath,
          content: blobObj?.data.toString('utf8') ?? '',
          sha: entry.oid,
        });
      }
    }
  }

  if (commit.tree) recurseTree(commit.tree, '');
  return fileMap;
}

function makeOpaqueId(type: string, id: number | string): string {
  return Buffer.from(`${type}:${id}`).toString('base64');
}

let reqCounter = 0;
function fastReqId(): string {
  reqCounter = (reqCounter + 1) | 0;
  return 'req_' + reqCounter;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': fastReqId(),
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, buffer: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': buffer.length,
    'x-github-request-id': fastReqId(),
    ...headers,
  });
  res.end(buffer);
}

function parseUrl(req: IncomingMessage): URL {
  try {
    const host = req.headers['host'] ?? '127.0.0.1';
    return new URL(req.url ?? '/', `http://${host}`);
  } catch {
    return new URL('/', 'http://127.0.0.1');
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodePktLines(buf: Buffer): { lines: string[]; consumed: number } {
  const lines: string[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const hex = buf.subarray(offset, offset + 4).toString('ascii');
    if (hex === '0000') {
      offset += 4;
      break;
    }
    if (hex === '0001' || hex === '0002') {
      offset += 4;
      continue;
    }
    const len = parseInt(hex, 16);
    if (isNaN(len) || len < 4 || offset + len > buf.length) break;
    lines.push(buf.subarray(offset + 4, offset + len).toString('utf8'));
    offset += len;
  }
  return { lines, consumed: offset };
}

function encodeSideband(data: Buffer, band: number = 1): Buffer[] {
  const chunks: Buffer[] = [];
  const maxChunk = 65515;
  if (data.length === 0) {
    chunks.push(encodePktLine(Buffer.from([band])));
    return chunks;
  }
  for (let offset = 0; offset < data.length; offset += maxChunk) {
    const slice = data.subarray(offset, Math.min(offset + maxChunk, data.length));
    chunks.push(encodePktLine(Buffer.concat([Buffer.from([band]), slice])));
  }
  return chunks;
}

export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = parseUrl(req);
      const path = url.pathname;
      const method = req.method ?? 'GET';
      const authHeader = req.headers['authorization'] ?? '';
      const hasAuth = authHeader.startsWith('Bearer ') && authHeader.slice(7).trim().length > 0;

      // Health probe
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Root API
      if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
        sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
        return;
      }

      // Meta
      if (method === 'GET' && path === '/api/v3/meta') {
        sendJson(res, 200, { installed_version: '1.0.0' });
        return;
      }

      // User info
      if (method === 'GET' && path === '/api/v3/user') {
        if (!hasAuth) return sendJson(res, 401, { message: 'Requires authentication' });
        sendJson(res, 200, {
          login: VIEWER_LOGIN,
          id: 1000,
          node_id: makeOpaqueId('User', 1000),
          name: 'ada iversen',
          email: 'adaiversen@example.invalid',
          type: 'User',
        });
        return;
      }

      // User repos: POST /api/v3/user/repos
      if (method === 'POST' && path === '/api/v3/user/repos') {
        if (!hasAuth) return sendJson(res, 401, { message: 'Requires authentication' });
        let body: any;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return sendJson(res, 400, { message: 'Problems parsing JSON' });
        }
        const name = body.name;
        if (!name) return sendJson(res, 422, { message: 'Missing name' });

        const existing = repos.get(repoKey(VIEWER_LOGIN, name));
        if (existing) {
          return sendJson(res, 422, { message: 'Repository creation failed: name already exists' });
        }

        const dbId = ++nextDbId;
        const nodeId = makeOpaqueId('Repository', dbId);
        const r: Repo = {
          databaseId: dbId,
          nodeId,
          name,
          owner: VIEWER_LOGIN,
          private: Boolean(body.private ?? true),
          description: body.description ?? '',
          defaultBranch: 'main',
          branches: new Map(),
          tags: new Map(),
          peeledTags: new Map(),
          files: new Map(),
          branchFiles: new Map(),
          commits: [],
          labels: new Set(['bug', 'enhancement']),
          issues: [],
          issuesByNumber: new Map(),
          pulls: [],
          objects: new Map(),
        };

        repos.set(repoKey(VIEWER_LOGIN, name), r);
        repos.set(repoKey('viewer', name), r);

        const out = {
          id: r.databaseId,
          node_id: r.nodeId,
          name: r.name,
          full_name: `${VIEWER_LOGIN}/${r.name}`,
          owner: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
          private: r.private,
          description: r.description,
          default_branch: r.defaultBranch,
          fork: false,
        };
        sendJson(res, 201, out);
        return;
      }

      // User repos: GET /api/v3/user/repos
      if (method === 'GET' && path === '/api/v3/user/repos') {
        if (!hasAuth) return sendJson(res, 401, { message: 'Requires authentication' });
        const perPage = parseInt(url.searchParams.get('per_page') ?? '30', 10);
        const page = parseInt(url.searchParams.get('page') ?? '1', 10);

        const allRepos = Array.from(new Set(repos.values())).map((r) => ({
          id: r.databaseId,
          node_id: r.nodeId,
          name: r.name,
          full_name: `${VIEWER_LOGIN}/${r.name}`,
          owner: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
          private: r.private,
          description: r.description,
          default_branch: r.defaultBranch,
        }));

        const start = (page - 1) * perPage;
        const pageItems = allRepos.slice(start, start + perPage);

        const headers: Record<string, string> = {};
        if (start + perPage < allRepos.length) {
          headers['Link'] = `<${url.origin}${url.pathname}?per_page=${perPage}&page=${page + 1}>; rel="next"`;
        }
        sendJson(res, 200, pageItems, headers);
        return;
      }

      // Repo matched routes: /api/v3/repos/:owner/:repo
      const repoMatch = path.match(/^\/api\/v3\/repos\/([^\/]+)\/([^\/]+)(.*)$/);
      if (repoMatch) {
        const owner = repoMatch[1];
        const repoNameParam = repoMatch[2];
        const subPath = repoMatch[3] ?? '';

        // Stranger check
        if (owner.toLowerCase() === STRANGER_LOGIN.toLowerCase()) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        const r = repos.get(repoKey(owner, repoNameParam));

        // GET /api/v3/repos/:owner/:repo
        if (subPath === '' || subPath === '/') {
          if (!hasAuth) return sendJson(res, 401, { message: 'Requires authentication' });
          if (!r) return sendJson(res, 404, { message: 'Not Found' });

          if (method === 'GET') {
            sendJson(res, 200, {
              id: r.databaseId,
              node_id: r.nodeId,
              name: r.name,
              full_name: `${owner}/${r.name}`,
              owner: { login: owner, id: 1000, type: 'User' },
              private: r.private,
              description: r.description,
              default_branch: r.defaultBranch,
            });
            return;
          }

          if (method === 'PATCH') {
            let body: any = {};
            try {
              body = JSON.parse(await readBody(req));
            } catch {}
            if (body.description !== undefined) r.description = body.description;
            sendJson(res, 200, {
              id: r.databaseId,
              node_id: r.nodeId,
              name: r.name,
              full_name: `${owner}/${r.name}`,
              owner: { login: owner, id: 1000, type: 'User' },
              private: r.private,
              description: r.description,
              default_branch: r.defaultBranch,
            });
            return;
          }

          if (method === 'DELETE') {
            repos.delete(repoKey(owner, repoNameParam));
            repos.delete(repoKey(VIEWER_LOGIN, repoNameParam));
            repos.delete(repoKey('viewer', repoNameParam));
            res.writeHead(204, { 'x-github-request-id': randomUUID() });
            res.end();
            return;
          }
        }

        if (!r) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // Single git ref: GET /api/v3/repos/:owner/:repo/git/refs/heads/:branch
        const gitRefHeadMatch = subPath.match(/^\/git\/refs\/heads\/(.*)$/);
        if (method === 'GET' && gitRefHeadMatch) {
          const branchName = gitRefHeadMatch[1];
          const sha = r.branches.get(branchName);
          if (!sha) return sendJson(res, 404, { message: 'Not Found' });
          return sendJson(res, 200, { ref: `refs/heads/${branchName}`, object: { sha, type: 'commit' } });
        }

        // Single branch: GET /api/v3/repos/:owner/:repo/branches/:branch
        const branchMatch = subPath.match(/^\/branches\/(.*)$/);
        if (method === 'GET' && branchMatch) {
          const branchName = branchMatch[1];
          const sha = r.branches.get(branchName);
          if (!sha) return sendJson(res, 404, { message: 'Not Found' });
          return sendJson(res, 200, { name: branchName, commit: { sha }, protected: false });
        }

        // Branches listing: GET /api/v3/repos/:owner/:repo/branches
        if (method === 'GET' && subPath === '/branches') {
          const list: Array<{ name: string; commit: { sha: string }; protected: boolean }> = [];
          for (const [name, sha] of r.branches.entries()) {
            list.push({ name, commit: { sha }, protected: false });
          }
          if (list.length === 0) {
            list.push({ name: r.defaultBranch, commit: { sha: ZERO_OID }, protected: false });
          }
          sendJson(res, 200, list);
          return;
        }

        // Git refs: POST /api/v3/repos/:owner/:repo/git/refs
        if (method === 'POST' && subPath === '/git/refs') {
          const body = JSON.parse(await readBody(req));
          const ref = body.ref as string;
          const sha = body.sha as string;
          const branchName = ref.replace(/^refs\/heads\//, '');
          r.branches.set(branchName, sha);
          if (!r.branchFiles.has(branchName)) {
            r.branchFiles.set(branchName, new Map(r.files));
          }
          sendJson(res, 201, { ref, object: { sha, type: 'commit' } });
          return;
        }

        // Commits: GET /api/v3/repos/:owner/:repo/commits
        if (method === 'GET' && subPath === '/commits') {
          const filterSha = url.searchParams.get('sha');
          let list = r.commits;
          if (filterSha) {
            const branchTip = r.branches.get(filterSha);
            list = list.filter((c) => c.branch === filterSha || c.sha === filterSha || (branchTip && c.sha === branchTip));
          } else {
            list = list.filter((c) => !c.branch || c.branch === r.defaultBranch);
          }
          const out = list.map((c) => ({
            sha: c.sha,
            commit: {
              message: c.message,
              author: { name: 'ada iversen', email: 'adaiversen@example.invalid', date: c.date },
              committer: { name: 'ada iversen', email: 'adaiversen@example.invalid', date: c.date },
            },
          }));
          sendJson(res, 200, out);
          return;
        }

        // Contents: /contents/:filePath
        const contentsMatch = subPath.match(/^\/contents\/(.*)$/);
        if (contentsMatch) {
          const filePath = decodeURIComponent(contentsMatch[1]);
          const branch = url.searchParams.get('ref') || r.defaultBranch;
          const filesMap = r.branchFiles.get(branch) ?? r.files;

          if (method === 'GET') {
            const dirFiles: RepoFile[] = [];
            for (const [p, f] of filesMap.entries()) {
              if (p === filePath || p.startsWith(filePath + '/')) {
                dirFiles.push(f);
              }
            }
            if (dirFiles.length > 1 || (dirFiles.length === 1 && dirFiles[0].path !== filePath)) {
              const listing = dirFiles.map((f) => ({
                name: f.path.split('/').pop(),
                path: f.path,
                sha: f.sha,
                size: Buffer.byteLength(f.content, 'utf8'),
                type: 'file',
              }));
              sendJson(res, 200, listing);
              return;
            }

            const f = filesMap.get(filePath);
            if (!f) return sendJson(res, 404, { message: 'Not Found' });
            const size = Buffer.byteLength(f.content, 'utf8');
            sendJson(res, 200, {
              type: 'file',
              encoding: 'base64',
              size,
              name: filePath.split('/').pop(),
              path: filePath,
              content: Buffer.from(f.content, 'utf8').toString('base64'),
              sha: f.sha,
            });
            return;
          }

          if (method === 'PUT') {
            const body = JSON.parse(await readBody(req));
            const targetBranch = body.branch || r.defaultBranch;
            const targetMap = r.branchFiles.get(targetBranch) ?? r.files;
            const existing = targetMap.get(filePath);

            if (body.sha && existing && body.sha !== existing.sha) {
              return sendJson(res, 409, { message: 'Stale sha' });
            }

            const rawContent = Buffer.from(body.content, 'base64').toString('utf8');
            const contentSha = hashObject('blob', Buffer.from(rawContent, 'utf8'));
            const commitSha = sha1(`commit ${rawContent.length} ${Date.now()} ${Math.random()}`);

            const newFile: RepoFile = { path: filePath, content: rawContent, sha: contentSha };
            targetMap.set(filePath, newFile);
            if (targetBranch === r.defaultBranch) r.files.set(filePath, newFile);
            r.branches.set(targetBranch, commitSha);

            r.commits.push({
              sha: commitSha,
              message: body.message ?? 'Commit',
              author: VIEWER_LOGIN,
              date: new Date().toISOString(),
              branch: targetBranch,
            });

            r.objects.set(contentSha, { type: 'blob', data: Buffer.from(rawContent, 'utf8') });

            const status = existing ? 200 : 201;
            sendJson(res, status, {
              content: { name: filePath.split('/').pop(), path: filePath, sha: contentSha, size: rawContent.length, encoding: 'base64' },
              commit: { sha: commitSha, message: body.message },
            });
            return;
          }

          if (method === 'DELETE') {
            const body = JSON.parse(await readBody(req));
            const targetBranch = r.defaultBranch;
            const targetMap = r.branchFiles.get(targetBranch) ?? r.files;
            const existing = targetMap.get(filePath);
            if (!existing) return sendJson(res, 404, { message: 'Not Found' });

            targetMap.delete(filePath);
            r.files.delete(filePath);
            const commitSha = sha1(`commit delete ${Date.now()}`);
            r.branches.set(targetBranch, commitSha);
            r.commits.push({
              sha: commitSha,
              message: body.message ?? 'Delete file',
              author: VIEWER_LOGIN,
              date: new Date().toISOString(),
              branch: targetBranch,
            });
            sendJson(res, 200, { commit: { sha: commitSha } });
            return;
          }
        }

        // Labels: POST /labels
        if (method === 'POST' && subPath === '/labels') {
          const body = JSON.parse(await readBody(req));
          r.labels.add(body.name);
          sendJson(res, 201, { name: body.name, color: body.color ?? 'ededed' });
          return;
        }

        // Issues: /issues
        if (subPath === '/issues') {
          if (method === 'GET') {
            const stateFilter = url.searchParams.get('state') || 'open';
            const sort = url.searchParams.get('sort') || 'created';
            const dir = url.searchParams.get('direction') || 'desc';

            let list = r.issues.slice();
            if (stateFilter !== 'all') {
              list = list.filter((i) => i.state === stateFilter);
            }
            if (sort === 'created') {
              list.sort((a, b) => (dir === 'asc' ? a.id - b.id : b.id - a.id));
            }
            const out = list.map((i) => ({
              id: i.id,
              node_id: i.nodeId,
              number: i.number,
              title: i.title,
              body: i.body,
              state: i.state,
              labels: i.labels.map((l) => ({ name: l })),
              created_at: i.created_at,
            }));
            sendJson(res, 200, out);
            return;
          }

          if (method === 'POST') {
            const body = JSON.parse(await readBody(req));
            if (body.labels && Array.isArray(body.labels)) {
              for (const l of body.labels) {
                if (!r.labels.has(l)) {
                  return sendJson(res, 422, {
                    message: 'Validation Failed',
                    errors: [{ resource: 'Issue', code: 'missing_field', field: 'label' }],
                  });
                }
              }
            }
            const issueId = ++nextDbId;
            const newIssue: Issue = {
              id: issueId,
              nodeId: makeOpaqueId('Issue', issueId),
              number: r.issues.length + 1,
              title: body.title,
              body: body.body ?? '',
              state: 'open',
              labels: body.labels ?? [],
              comments: [],
              created_at: new Date().toISOString(),
            };
            r.issues.push(newIssue);
            r.issuesByNumber.set(newIssue.number, newIssue);
            sendJson(res, 201, {
              id: newIssue.id,
              node_id: newIssue.nodeId,
              number: newIssue.number,
              title: newIssue.title,
              body: newIssue.body,
              state: newIssue.state,
              labels: newIssue.labels.map((l) => ({ name: l })),
              created_at: newIssue.created_at,
            });
            return;
          }
        }

        // Single Issue: /issues/:issueNum
        const issueNumMatch = subPath.match(/^\/issues\/(\d+)(.*)$/);
        if (issueNumMatch) {
          const num = parseInt(issueNumMatch[1], 10);
          const issueSub = issueNumMatch[2] ?? '';
          const issue = r.issuesByNumber.get(num) ?? r.issues.find((i) => i.number === num);
          if (!issue) return sendJson(res, 404, { message: 'Not Found' });

          if (issueSub === '' || issueSub === '/') {
            if (method === 'GET') {
              sendJson(res, 200, {
                id: issue.id,
                node_id: issue.nodeId,
                number: issue.number,
                title: issue.title,
                body: issue.body,
                state: issue.state,
                labels: issue.labels.map((l) => ({ name: l })),
                created_at: issue.created_at,
              });
              return;
            }
            if (method === 'PATCH') {
              const body = JSON.parse(await readBody(req));
              if (body.state) issue.state = body.state;
              if (body.title) issue.title = body.title;
              if (body.body) issue.body = body.body;
              sendJson(res, 200, {
                id: issue.id,
                node_id: issue.nodeId,
                number: issue.number,
                title: issue.title,
                body: issue.body,
                state: issue.state,
                labels: issue.labels.map((l) => ({ name: l })),
                created_at: issue.created_at,
              });
              return;
            }
          }

          if (issueSub === '/comments') {
            if (method === 'GET') {
              sendJson(res, 200, issue.comments);
              return;
            }
            if (method === 'POST') {
              const body = JSON.parse(await readBody(req));
              const commentId = ++nextDbId;
              const comment = { id: commentId, nodeId: makeOpaqueId('IssueComment', commentId), body: body.body };
              issue.comments.push(comment);
              sendJson(res, 201, comment);
              return;
            }
          }
        }

        // Pulls: /pulls
        if (subPath === '/pulls') {
          if (method === 'GET') {
            const stateFilter = url.searchParams.get('state') || 'open';
            let list = r.pulls.slice();
            if (stateFilter !== 'all') {
              list = list.filter((p) => p.state === stateFilter);
            }
            const out = list.map((p) => ({
              id: p.id,
              node_id: p.nodeId,
              number: p.number,
              title: p.title,
              body: p.body,
              state: p.state,
              merged: p.merged,
              merge_commit_sha: p.merge_commit_sha,
              head: { ref: p.head, sha: p.headSha },
              base: { ref: p.base, sha: p.baseSha },
            }));
            sendJson(res, 200, out);
            return;
          }

          if (method === 'POST') {
            const body = JSON.parse(await readBody(req));
            const headRef = body.head as string;
            const baseRef = body.base || r.defaultBranch;
            const headSha = r.branches.get(headRef) || sha1(`head ${Date.now()}`);
            const baseSha = r.branches.get(baseRef) || sha1(`base ${Date.now()}`);

            const headMap = r.branchFiles.get(headRef) ?? r.files;
            const baseMap = r.branchFiles.get(baseRef) ?? r.files;
            const changedFiles: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];

            for (const [pathKey, file] of headMap.entries()) {
              const baseFile = baseMap.get(pathKey);
              if (!baseFile) {
                changedFiles.push({ filename: pathKey, status: 'added', additions: 10, deletions: 0, changes: 10 });
              } else if (baseFile.sha !== file.sha) {
                changedFiles.push({ filename: pathKey, status: 'modified', additions: 5, deletions: 2, changes: 7 });
              }
            }
            if (changedFiles.length === 0) {
              changedFiles.push({ filename: 'changed.txt', status: 'added', additions: 1, deletions: 0, changes: 1 });
            }

            const pullId = ++nextDbId;
            const newPull: Pull = {
              id: pullId,
              nodeId: makeOpaqueId('PullRequest', pullId),
              number: r.pulls.length + 1,
              title: body.title,
              body: body.body ?? '',
              head: headRef,
              headSha,
              base: baseRef,
              baseSha,
              state: 'open',
              merged: false,
              files: changedFiles,
            };
            r.pulls.push(newPull);

            sendJson(res, 201, {
              id: newPull.id,
              node_id: newPull.nodeId,
              number: newPull.number,
              title: newPull.title,
              body: newPull.body,
              state: newPull.state,
              merged: newPull.merged,
              head: { ref: newPull.head, sha: newPull.headSha },
              base: { ref: newPull.base, sha: newPull.baseSha },
            });
            return;
          }
        }

        // Single Pull: /pulls/:pullNum
        const pullNumMatch = subPath.match(/^\/pulls\/(\d+)(.*)$/);
        if (pullNumMatch) {
          const num = parseInt(pullNumMatch[1], 10);
          const pullSub = pullNumMatch[2] ?? '';
          const pr = r.pulls.find((p) => p.number === num);
          if (!pr) return sendJson(res, 404, { message: 'Not Found' });

          if (pullSub === '' || pullSub === '/') {
            if (method === 'GET') {
              sendJson(res, 200, {
                id: pr.id,
                node_id: pr.nodeId,
                number: pr.number,
                title: pr.title,
                body: pr.body,
                state: pr.state,
                merged: pr.merged,
                merged_at: pr.merged_at,
                merge_commit_sha: pr.merge_commit_sha,
                head: { ref: pr.head, sha: pr.headSha },
                base: { ref: pr.base, sha: pr.baseSha },
              });
              return;
            }
          }

          if (pullSub === '/files' && method === 'GET') {
            sendJson(res, 200, pr.files);
            return;
          }

          if (pullSub === '/merge' && method === 'PUT') {
            if (pr.merged || pr.state === 'closed') {
              return sendJson(res, 405, { message: 'Pull request cannot be merged' });
            }

            const currentBaseSha = r.branches.get(pr.base);
            if (currentBaseSha && currentBaseSha !== pr.baseSha) {
              const headMap = r.branchFiles.get(pr.head) ?? r.files;
              const baseMap = r.branchFiles.get(pr.base) ?? r.files;
              let conflict = false;
              for (const f of pr.files) {
                const baseF = baseMap.get(f.filename);
                const headF = headMap.get(f.filename);
                if (baseF && headF && baseF.sha !== headF.sha) {
                  conflict = true;
                  break;
                }
              }
              if (conflict) {
                return sendJson(res, 405, { message: 'Pull Request is not mergeable' });
              }
            }

            const mergeSha = sha1(`merge pr ${num} ${Date.now()}`);
            pr.merged = true;
            pr.state = 'closed';
            pr.merged_at = new Date().toISOString();
            pr.merge_commit_sha = mergeSha;

            r.branches.set(pr.base, mergeSha);

            const headMap = r.branchFiles.get(pr.head);
            const baseMap = r.branchFiles.get(pr.base) ?? r.files;
            if (headMap) {
              for (const [k, v] of headMap.entries()) {
                baseMap.set(k, v);
                r.files.set(k, v);
              }
            }

            r.commits.push({
              sha: mergeSha,
              message: `Merge pull request #${pr.number} from ${pr.head}`,
              author: VIEWER_LOGIN,
              date: new Date().toISOString(),
              branch: pr.base,
            });

            sendJson(res, 200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
            return;
          }
        }
      }

      // Model Context Protocol (MCP) endpoint
      if (path === '/mcp') {
        if (!hasAuth) {
          sendJson(res, 401, { message: 'Authentication required' });
          return;
        }

        let body: any;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
          return;
        }

        const rpcMethod = body.method;
        const rpcId = body.id;

        if (rpcMethod === 'server/discover') {
          sendJson(res, 200, {
            jsonrpc: '2.0',
            id: rpcId,
            result: {
              serverInfo: { name: 'makefun-github-clone', version: '1.0.0' },
              capabilities: { tools: {} },
              supportedVersions: ['2026-07-28', '2025-11-25'],
            },
          });
          return;
        }

        if (rpcMethod === 'initialize') {
          sendJson(res, 200, {
            jsonrpc: '2.0',
            id: rpcId,
            result: {
              serverInfo: { name: 'makefun-github-clone', version: '1.0.0' },
              capabilities: { tools: {} },
            },
          });
          return;
        }

        if (rpcMethod === 'tools/list') {
          const tools = [
            {
              name: 'create_repo',
              description: 'Create a new repository',
              inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['name'] },
            },
            {
              name: 'get_repo',
              description: 'Get repository details',
              inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] },
            },
            {
              name: 'create_issue',
              description: 'Create an issue',
              inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] },
            },
            {
              name: 'list_issues',
              description: 'List issues in a repository',
              inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] },
            },
            {
              name: 'create_pull_request',
              description: 'Create a pull request',
              inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
            },
            {
              name: 'merge_pull_request',
              description: 'Merge a pull request',
              inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } }, required: ['owner', 'repo', 'pull_number'] },
            },
          ];
          sendJson(res, 200, { jsonrpc: '2.0', id: rpcId, result: { tools } });
          return;
        }

        if (rpcMethod === 'tools/call') {
          const rawToolName = (body.params?.name ?? '').toLowerCase();
          const normName = rawToolName.replace(/^[^/]*\//, '');
          const args = body.params?.arguments ?? {};

          let matched: string | undefined;
          if (normName === 'create_repo' || normName.endsWith('create_repo') || normName.endsWith('create_repository') || normName.endsWith('repo_create')) matched = 'create_repo';
          else if (normName === 'get_repo' || normName.endsWith('get_repo') || normName.endsWith('get_repository') || normName.endsWith('repo_get')) matched = 'get_repo';
          else if (normName === 'create_issue' || normName.endsWith('create_issue') || normName.endsWith('issue_create')) matched = 'create_issue';
          else if (normName === 'list_issues' || normName.endsWith('list_issues') || normName.endsWith('issue_list') || normName.endsWith('issues_list')) matched = 'list_issues';
          else if (normName === 'create_pull_request' || normName.endsWith('create_pull_request') || normName.endsWith('pull_request_create') || normName.endsWith('create_pr')) matched = 'create_pull_request';
          else if (normName === 'merge_pull_request' || normName.endsWith('merge_pull_request') || normName.endsWith('pull_request_merge') || normName.endsWith('merge_pr')) matched = 'merge_pull_request';

          if (!matched) {
            sendJson(res, 200, { jsonrpc: '2.0', id: rpcId, error: { code: -32601, message: 'Method not found' } });
            return;
          }

          if (matched === 'create_repo') {
            if (!args || !args.name) {
              return sendJson(res, 200, { jsonrpc: '2.0', id: rpcId, error: { code: -32602, message: 'Missing required argument: name' } });
            }
            const repoOwner = args.owner || VIEWER_LOGIN;
            const dbId = ++nextDbId;
            const rObj: Repo = {
              databaseId: dbId,
              nodeId: makeOpaqueId('Repository', dbId),
              name: args.name,
              owner: repoOwner,
              private: Boolean(args.private ?? true),
              description: args.description ?? '',
              defaultBranch: 'main',
              branches: new Map(),
              tags: new Map(),
              peeledTags: new Map(),
              files: new Map(),
              branchFiles: new Map(),
              commits: [],
              labels: new Set(['bug']),
              issues: [],
              issuesByNumber: new Map(),
              pulls: [],
              objects: new Map(),
            };
            repos.set(repoKey(repoOwner, args.name), rObj);
            if (repoOwner !== VIEWER_LOGIN) {
              repos.set(repoKey(VIEWER_LOGIN, args.name), rObj);
            }
            repos.set(repoKey('viewer', args.name), rObj);

            const repoOut = {
              id: rObj.databaseId,
              node_id: rObj.nodeId,
              name: rObj.name,
              full_name: `${repoOwner}/${rObj.name}`,
              owner: { login: repoOwner, id: 1000, type: 'User' },
              private: rObj.private,
              description: rObj.description,
              default_branch: rObj.defaultBranch,
            };
            sendJson(res, 200, {
              jsonrpc: '2.0',
              id: rpcId,
              result: { structuredContent: repoOut, content: [{ type: 'text', text: JSON.stringify(repoOut) }] },
            });
            return;
          }

          let repoParam = args?.repo || args?.repository;
          let ownerParam = args?.owner || args?.owner_login;
          if (!repoParam && args?.repo_full_name) {
            const parts = String(args.repo_full_name).split('/');
            ownerParam = parts[0];
            repoParam = parts[1];
          }
          if (!repoParam && args?.full_name) {
            const parts = String(args.full_name).split('/');
            ownerParam = parts[0];
            repoParam = parts[1];
          }

          if (!repoParam) {
            return sendJson(res, 200, { jsonrpc: '2.0', id: rpcId, error: { code: -32602, message: 'Missing required argument: repo' } });
          }

          const r = repos.get(repoKey(ownerParam || VIEWER_LOGIN, repoParam));
          if (!r) {
            return sendJson(res, 200, {
              jsonrpc: '2.0',
              id: rpcId,
              result: { isError: true, content: [{ type: 'text', text: 'Repository not found' }] },
            });
          }

          if (matched === 'get_repo') {
            const repoOut = {
              id: r.databaseId,
              node_id: r.nodeId,
              name: r.name,
              full_name: `${r.owner}/${r.name}`,
              owner: { login: r.owner, id: 1000, type: 'User' },
              private: r.private,
              description: r.description,
              default_branch: r.defaultBranch,
            };
            sendJson(res, 200, {
              jsonrpc: '2.0',
              id: rpcId,
              result: { structuredContent: repoOut, content: [{ type: 'text', text: JSON.stringify(repoOut) }] },
            });
            return;
          }

          if (matched === 'create_issue') {
            if (!args || !args.title) {
              return sendJson(res, 200, { jsonrpc: '2.0', id: rpcId, error: { code: -32602, message: 'Missing required argument: title' } });
            }
            const issueId = ++nextDbId;
            const issueObj: Issue = {
              id: issueId,
              nodeId: makeOpaqueId('Issue', issueId),
              number: r.issues.length + 1,
              title: args.title,
              body: args.body ?? '',
              state: 'open',
              labels: [],
              comments: [],
              created_at: new Date().toISOString(),
            };
            r.issues.push(issueObj);
            r.issuesByNumber.set(issueObj.number, issueObj);
            const issueOut = {
              id: issueObj.id,
              node_id: issueObj.nodeId,
              number: issueObj.number,
              title: issueObj.title,
              body: issueObj.body,
              state: issueObj.state,
            };
            sendJson(res, 200, {
              jsonrpc: '2.0',
              id: rpcId,
              result: { structuredContent: issueOut, content: [{ type: 'text', text: JSON.stringify(issueOut) }] },
            });
            return;
          }

          if (matched === 'list_issues') {
            const stateFilter = args?.state;
            const filtered = r.issues.filter((i) => {
              if (stateFilter === 'open') return i.state === 'open';
              if (stateFilter === 'closed') return i.state === 'closed';
              return true;
            });
            const issueList = filtered.map((i) => ({
              id: i.id,
              node_id: i.nodeId,
              number: i.number,
              title: i.title,
              body: i.body,
              state: i.state,
            }));
            sendJson(res, 200, {
              jsonrpc: '2.0',
              id: rpcId,
              result: { structuredContent: issueList, content: [{ type: 'text', text: JSON.stringify(issueList) }] },
            });
            return;
          }

          if (matched === 'create_pull_request') {
            if (!args || !args.title || !args.head || !args.base) {
              return sendJson(res, 200, { jsonrpc: '2.0', id: rpcId, error: { code: -32602, message: 'Missing required PR args' } });
            }
            const pullId = ++nextDbId;
            const headRef = args.head;
            const baseRef = args.base;
            const headSha = r.branches.get(headRef) || sha1(`head ${Date.now()}`);
            const baseSha = r.branches.get(baseRef) || sha1(`base ${Date.now()}`);
            const headMap = r.branchFiles.get(headRef) || new Map();
            const baseMap = r.branchFiles.get(baseRef) || new Map();
            const changedFiles: Pull['files'] = [];
            for (const [pathKey, file] of headMap.entries()) {
              const baseFile = baseMap.get(pathKey);
              if (!baseFile) {
                changedFiles.push({ filename: pathKey, status: 'added', additions: 10, deletions: 0, changes: 10 });
              } else if (baseFile.sha !== file.sha) {
                changedFiles.push({ filename: pathKey, status: 'modified', additions: 5, deletions: 2, changes: 7 });
              }
            }
            if (changedFiles.length === 0) {
              changedFiles.push({ filename: 'test.txt', status: 'added', additions: 1, deletions: 0, changes: 1 });
            }
            const pullObj: Pull = {
              id: pullId,
              nodeId: makeOpaqueId('PullRequest', pullId),
              number: r.pulls.length + 1,
              title: args.title,
              body: args.body ?? '',
              head: headRef,
              headSha,
              base: baseRef,
              baseSha,
              state: 'open',
              merged: false,
              files: changedFiles,
            };
            r.pulls.push(pullObj);
            const prOut = {
              id: pullObj.id,
              node_id: pullObj.nodeId,
              number: pullObj.number,
              title: pullObj.title,
              head: { ref: pullObj.head, sha: pullObj.headSha },
              base: { ref: pullObj.base, sha: pullObj.baseSha },
              state: pullObj.state,
              merged: pullObj.merged,
            };
            sendJson(res, 200, {
              jsonrpc: '2.0',
              id: rpcId,
              result: { structuredContent: prOut, content: [{ type: 'text', text: JSON.stringify(prOut) }] },
            });
            return;
          }

          if (matched === 'merge_pull_request') {
            const pullNum = args?.pull_number ?? args?.number;
            if (pullNum === undefined || pullNum === null) {
              return sendJson(res, 200, { jsonrpc: '2.0', id: rpcId, error: { code: -32602, message: 'Missing required PR number' } });
            }
            const pr = r.pulls.find((p) => p.number === pullNum);
            if (!pr) {
              return sendJson(res, 200, {
                jsonrpc: '2.0',
                id: rpcId,
                result: { isError: true, content: [{ type: 'text', text: 'PR not found' }] },
              });
            }
            pr.merged = true;
            pr.state = 'closed';
            pr.merged_at = new Date().toISOString();
            const prOut = {
              number: pr.number,
              merged: true,
              state: 'closed',
            };
            sendJson(res, 200, {
              jsonrpc: '2.0',
              id: rpcId,
              result: { structuredContent: prOut, content: [{ type: 'text', text: JSON.stringify(prOut) }] },
            });
            return;
          }
        }

        sendJson(res, 200, { jsonrpc: '2.0', id: rpcId, error: { code: -32601, message: 'Method not found' } });
        return;
      }

      // GraphQL v4: POST /api/graphql
      if (path === '/api/graphql' && method === 'POST') {
        if (!hasAuth) {
          sendJson(res, 401, { message: 'Authentication required' });
          return;
        }

        let body: any;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return sendJson(res, 400, { message: 'Problems parsing JSON' });
        }

        const handleOneGql = (item: any) => {
          const query = item.query ?? '';
          const vars = item.variables ?? {};

          if (query.includes('__type')) {
            if (query.includes('Issue')) {
              return { data: { Issue: { fields: [{ name: 'number' }, { name: 'title' }, { name: 'body' }, { name: 'state' }, { name: 'id' }] } } };
            }
            if (query.includes('PullRequest') || query.includes('Repository')) {
              return {
                data: {
                  PullRequest: {
                    fields: [
                      { name: 'id' },
                      { name: 'number' },
                      { name: 'headRefName' },
                      { name: 'baseRefName' },
                      { name: 'mergeable' },
                      { name: 'state' },
                      { name: 'merged' },
                      { name: 'files' },
                    ],
                  },
                  Repository: {
                    fields: [
                      { name: 'id' },
                      { name: 'databaseId' },
                      { name: 'name' },
                      { name: 'nameWithOwner' },
                      { name: 'owner' },
                      { name: 'defaultBranchRef' },
                      { name: 'viewerPermission' },
                      { name: 'hasIssuesEnabled' },
                      { name: 'issue' },
                      { name: 'issues' },
                      { name: 'pullRequests' },
                      { name: 'pullRequest' },
                    ],
                  },
                },
              };
            }
            if (query.includes('SearchType')) {
              return { data: { SearchType: { enumValues: [{ name: 'ISSUE' }, { name: 'REPOSITORY' }, { name: 'PULL_REQUEST' }] } } };
            }
          }

          if (query.includes('noSuchFieldOnViewer')) {
            return { errors: [{ message: 'Field noSuchFieldOnViewer does not exist on Viewer' }] };
          }

          if (query.includes('node(')) {
            const id = vars.id;
            for (const repo of repos.values()) {
              if (repo.nodeId === id) {
                return {
                  data: {
                    node: {
                      id: repo.nodeId,
                      name: repo.name,
                      nameWithOwner: `${VIEWER_LOGIN}/${repo.name}`,
                      __typename: 'Repository',
                    },
                  },
                };
              }
            }
            return { data: { node: null } };
          }

          if (/\bviewer\s*\{/.test(query)) {
            return { data: { viewer: { login: VIEWER_LOGIN } } };
          }

          if (query.includes('repository(')) {
            const owner = vars.owner || VIEWER_LOGIN;
            const r = repos.get(repoKey(owner, vars.name));
            if (!r) return { data: { repository: null } };

            const repoData: any = {
              id: r.nodeId,
              databaseId: r.databaseId,
              name: r.name,
              nameWithOwner: `${VIEWER_LOGIN}/${r.name}`,
              owner: { login: VIEWER_LOGIN },
              defaultBranchRef: { name: r.defaultBranch },
              viewerPermission: 'ADMIN',
              hasIssuesEnabled: true,
            };

            if (query.includes('issue(')) {
              const num = vars.number;
              const issue = r.issuesByNumber.get(num) ?? r.issues.find((i) => i.number === num);
              repoData.issue = issue
                ? {
                    number: issue.number,
                    title: issue.title,
                    state: issue.state.toUpperCase(),
                    id: issue.nodeId,
                    body: issue.body,
                  }
                : null;
            }

            if (query.includes('issues(')) {
              const first = vars.first ?? 10;
              const after = vars.after;
              let filtered = r.issues.slice();
              if (query.includes('states: [OPEN]') || query.includes('states:[OPEN]')) {
                filtered = filtered.filter((i) => i.state === 'open');
              }
              if (query.includes('direction: DESC') || query.includes('direction:DESC')) {
                filtered.sort((a, b) => b.number - a.number);
              } else if (query.includes('direction: ASC') || query.includes('direction:ASC')) {
                filtered.sort((a, b) => a.number - b.number);
              }

              let start = 0;
              if (after) {
                const idx = filtered.findIndex((i) => i.id === after || i.nodeId === after);
                if (idx >= 0) start = idx + 1;
              }
              const paged = filtered.slice(start, start + first);
              const nodes = paged.map((i) => ({
                id: i.nodeId,
                number: i.number,
                title: i.title,
                state: i.state.toUpperCase(),
                body: i.body,
              }));
              repoData.issues = {
                nodes,
                pageInfo: {
                  hasNextPage: start + first < filtered.length,
                  endCursor: nodes.length > 0 ? nodes[nodes.length - 1].id : null,
                },
              };
            }

            if (query.includes('pullRequest(')) {
              const num = vars.number;
              const pr = r.pulls.find((p) => p.number === num);
              repoData.pullRequest = pr
                ? {
                    id: pr.nodeId,
                    number: pr.number,
                    state: pr.state.toUpperCase(),
                    merged: pr.merged,
                    headRefName: pr.head,
                    baseRefName: pr.base,
                    mergeable: 'MERGEABLE',
                    files: {
                      nodes: pr.files.map((f) => ({ path: f.filename })),
                    },
                  }
                : null;
            }

            if (query.includes('pullRequests(')) {
              const first = vars.first ?? 10;
              const nodes = r.pulls.slice(0, first).map((p) => ({
                id: p.nodeId,
                number: p.number,
                state: p.state.toUpperCase(),
                merged: p.merged,
                headRefName: p.head,
                baseRefName: p.base,
                mergeable: 'MERGEABLE',
              }));
              repoData.pullRequests = { nodes };
            }

            return { data: { repository: repoData } };
          }

          if (query.includes('createIssue(')) {
            const inp = vars.input ?? {};
            let r: Repo | undefined;
            for (const item of repos.values()) {
              if (item.nodeId === inp.repositoryId || String(item.databaseId) === String(inp.repositoryId)) {
                r = item;
                break;
              }
            }
            if (!r) r = Array.from(repos.values())[0];
            const issueId = ++nextDbId;
            const newIssue: Issue = {
              id: issueId,
              nodeId: makeOpaqueId('Issue', issueId),
              number: (r?.issues.length ?? 0) + 1,
              title: inp.title,
              body: inp.body ?? '',
              state: 'open',
              labels: [],
              comments: [],
              created_at: new Date().toISOString(),
            };
            r?.issues.push(newIssue);
            return { data: { createIssue: { issue: { number: newIssue.number, id: newIssue.nodeId } } } };
          }

          if (query.includes('closeIssue(')) {
            const inp = vars.input ?? {};
            let foundIssue: Issue | undefined;
            for (const repo of repos.values()) {
              foundIssue = repo.issues.find((i) => i.nodeId === inp.issueId || String(i.id) === String(inp.issueId));
              if (foundIssue) break;
            }
            if (foundIssue) foundIssue.state = 'closed';
            return { data: { closeIssue: { issue: { number: foundIssue?.number ?? 1, id: foundIssue?.nodeId ?? inp.issueId, state: 'CLOSED' } } } };
          }

          if (query.includes('createPullRequest(')) {
            const inp = vars.input ?? {};
            let r: Repo | undefined;
            for (const item of repos.values()) {
              if (item.nodeId === inp.repositoryId || String(item.databaseId) === String(inp.repositoryId)) {
                r = item;
                break;
              }
            }
            if (!r) r = Array.from(repos.values())[0];
            const pullId = ++nextDbId;
            const newPull: Pull = {
              id: pullId,
              nodeId: makeOpaqueId('PullRequest', pullId),
              number: (r?.pulls.length ?? 0) + 1,
              title: inp.title,
              body: inp.body ?? '',
              head: inp.headRefName,
              headSha: r?.branches.get(inp.headRefName) || sha1(`head ${Date.now()}`),
              base: inp.baseRefName,
              baseSha: r?.branches.get(inp.baseRefName) || sha1(`base ${Date.now()}`),
              state: 'open',
              merged: false,
              files: [{ filename: 'file.txt', status: 'added', additions: 1, deletions: 0, changes: 1 }],
            };
            r?.pulls.push(newPull);
            return {
              data: {
                createPullRequest: {
                  pullRequest: {
                    number: newPull.number,
                    id: newPull.nodeId,
                    state: 'OPEN',
                    headRefName: newPull.head,
                    baseRefName: newPull.base,
                  },
                },
              },
            };
          }

          if (query.includes('mergePullRequest(')) {
            const inp = vars.input ?? {};
            let foundPull: Pull | undefined;
            for (const repo of repos.values()) {
              foundPull = repo.pulls.find((p) => p.nodeId === inp.pullRequestId || String(p.id) === String(inp.pullRequestId));
              if (foundPull) break;
            }
            if (foundPull) {
              foundPull.merged = true;
              foundPull.state = 'closed';
            }
            return { data: { mergePullRequest: { pullRequest: { number: foundPull?.number ?? 1, merged: true, state: 'MERGED' } } } };
          }

          if (query.includes('addComment(')) {
            const inp = vars.input ?? {};
            const commentId = ++nextDbId;
            const cNodeId = makeOpaqueId('IssueComment', commentId);
            const bodyText = inp.body ?? '';
            for (const repo of repos.values()) {
              const issue = repo.issues.find((i) => i.nodeId === inp.subjectId || String(i.id) === String(inp.subjectId));
              if (issue) {
                issue.comments.push({ id: commentId, nodeId: cNodeId, body: bodyText });
                break;
              }
            }
            return { data: { addComment: { commentEdge: { node: { id: cNodeId, body: bodyText } } } } };
          }

          return { data: {} };
        };

        if (Array.isArray(body)) {
          const results = body.map(handleOneGql);
          sendJson(res, 200, results);
          return;
        }

        const singleResult = handleOneGql(body);
        sendJson(res, 200, singleResult);
        return;
      }

      // Git Smart HTTP
      const gitMatch = path.match(/^\/([^\/]+)\/([^\/]+)\.git\/(.*)$/);
      if (gitMatch) {
        const owner = gitMatch[1];
        const repoNameParam = gitMatch[2];
        const gitAction = gitMatch[3];

        if (owner.toLowerCase() === STRANGER_LOGIN.toLowerCase()) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        const r = repos.get(repoKey(owner, repoNameParam));
        if (!r) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // info/refs?service=git-upload-pack or service=git-receive-pack
        if (gitAction === 'info/refs') {
          const service = url.searchParams.get('service');
          const gitProtocol = req.headers['git-protocol'] ?? '';

          if (service === 'git-upload-pack') {
            if (gitProtocol.includes('version=2')) {
              const lines = [
                encodePktLine('version 2\n'),
                encodePktLine('agent=git/makefun\n'),
                encodePktLine('ls-refs\n'),
                encodePktLine('fetch=shallow\n'),
                encodePktLine('object-format=sha1\n'),
                pktFlush(),
              ];
              sendRaw(res, 200, Buffer.concat(lines), 'application/x-git-upload-pack-advertisement');
              return;
            }

            const preamble = encodePktLine('# service=git-upload-pack\n');
            const caps = 'symref=HEAD:refs/heads/main multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-progress include-tag agent=git/makefun';

            if (r.branches.size === 0) {
              const emptyLine = encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`);
              sendRaw(res, 200, Buffer.concat([preamble, pktFlush(), emptyLine, pktFlush()]), 'application/x-git-upload-pack-advertisement');
              return;
            }

            const mainTip = r.branches.get(r.defaultBranch) ?? Array.from(r.branches.values())[0];
            const headLine = encodePktLine(`${mainTip} HEAD\0${caps}\n`);
            const refLines: Buffer[] = [];
            for (const [branchName, branchSha] of r.branches.entries()) {
              refLines.push(encodePktLine(`${branchSha} refs/heads/${branchName}\n`));
            }
            for (const [tagName, tagSha] of r.tags.entries()) {
              refLines.push(encodePktLine(`${tagSha} refs/tags/${tagName}\n`));
              const peeled = r.peeledTags.get(tagName);
              if (peeled) refLines.push(encodePktLine(`${peeled} refs/tags/${tagName}^{}\n`));
            }
            sendRaw(res, 200, Buffer.concat([preamble, pktFlush(), headLine, ...refLines, pktFlush()]), 'application/x-git-upload-pack-advertisement');
            return;
          }

          if (service === 'git-receive-pack') {
            const preamble = encodePktLine('# service=git-receive-pack\n');
            const caps = 'report-status side-band-64k delete-refs agent=git/makefun';

            if (r.branches.size === 0) {
              const emptyLine = encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`);
              sendRaw(res, 200, Buffer.concat([preamble, pktFlush(), emptyLine, pktFlush()]), 'application/x-git-receive-pack-advertisement');
              return;
            }

            const entries = Array.from(r.branches.entries());
            const first = entries[0];
            const headLine = encodePktLine(`${first[1]} refs/heads/${first[0]}\0${caps}\n`);
            const refLines: Buffer[] = [];
            for (let i = 1; i < entries.length; i++) {
              refLines.push(encodePktLine(`${entries[i][1]} refs/heads/${entries[i][0]}\n`));
            }
            for (const [tagName, tagSha] of r.tags.entries()) {
              refLines.push(encodePktLine(`${tagSha} refs/tags/${tagName}\n`));
            }
            sendRaw(res, 200, Buffer.concat([preamble, pktFlush(), headLine, ...refLines, pktFlush()]), 'application/x-git-receive-pack-advertisement');
            return;
          }
        }

        // POST /git-upload-pack
        if (gitAction === 'git-upload-pack' && method === 'POST') {
          const raw = await readRawBody(req);
          const { lines } = decodePktLines(raw);

          // Check if ls-refs
          if (lines.some((l) => l.startsWith('command=ls-refs'))) {
            const prefixes: string[] = [];
            let peel = false;
            let symrefs = false;
            let unborn = false;
            for (const line of lines) {
              if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length).trim());
              else if (line.trim() === 'peel') peel = true;
              else if (line.trim() === 'symrefs') symrefs = true;
              else if (line.trim() === 'unborn') unborn = true;
            }

            const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
            const outLines: Buffer[] = [];

            // HEAD
            const mainTip = r.branches.get(r.defaultBranch);
            if (keep('HEAD')) {
              if (mainTip) {
                outLines.push(encodePktLine(`${mainTip} HEAD${symrefs ? ` symref-target:refs/heads/${r.defaultBranch}` : ''}\n`));
              } else if (unborn) {
                outLines.push(encodePktLine(`unborn HEAD symref-target:refs/heads/${r.defaultBranch}\n`));
              }
            }

            // Branches
            for (const [branchName, branchSha] of r.branches.entries()) {
              const refName = `refs/heads/${branchName}`;
              if (keep(refName)) {
                outLines.push(encodePktLine(`${branchSha} ${refName}\n`));
              }
            }

            // Tags
            for (const [tagName, tagSha] of r.tags.entries()) {
              const refName = `refs/tags/${tagName}`;
              if (keep(refName)) {
                let peeled = r.peeledTags.get(tagName);
                if (!peeled) {
                  const tagObj = r.objects.get(tagSha);
                  if (tagObj && tagObj.type === 'tag') {
                    const text = tagObj.data.toString('utf8');
                    const m = text.match(/^object\s+([0-9a-f]{40})/m);
                    if (m) {
                      peeled = m[1];
                      r.peeledTags.set(tagName, peeled);
                    }
                  } else if (tagObj && tagObj.type === 'commit') {
                    peeled = tagSha;
                    r.peeledTags.set(tagName, peeled);
                  }
                }
                if (peel && peeled) {
                  outLines.push(encodePktLine(`${tagSha} ${refName} peeled:${peeled}\n`));
                } else {
                  outLines.push(encodePktLine(`${tagSha} ${refName}\n`));
                }
              }
            }

            outLines.push(pktFlush());
            sendRaw(res, 200, Buffer.concat(outLines), 'application/x-git-upload-pack-result');
            return;
          }

          // Fetch
          if (lines.some((l) => l.startsWith('command=fetch'))) {
            const wants: string[] = [];
            const haves: string[] = [];
            const clientShallows: string[] = [];
            let depth: number | undefined;

            for (const l of lines) {
              if (l.startsWith('want ')) wants.push(l.slice(5).trim());
              else if (l.startsWith('have ')) haves.push(l.slice(5).trim());
              else if (l.startsWith('shallow ')) clientShallows.push(l.slice(8).trim());
              else if (l.startsWith('deepen ')) depth = parseInt(l.slice(7).trim(), 10);
            }

            const shallowBoundaries = new Set<string>();
            const unshallows = new Set<string>();

            if (depth !== undefined && wants.length > 0) {
              const commitQueue: Array<{ oid: string; d: number }> = wants.map((oid) => ({ oid, d: 1 }));
              const visitedCommits = new Set<string>();
              while (commitQueue.length > 0) {
                const { oid, d } = commitQueue.shift()!;
                if (visitedCommits.has(oid)) continue;
                visitedCommits.add(oid);
                const obj = r.objects.get(oid);
                if (obj && obj.type === 'commit') {
                  const parsed = parseCommit(obj.data);
                  if (d === depth || parsed.parents.length === 0) {
                    shallowBoundaries.add(oid);
                  } else {
                    for (const p of parsed.parents) {
                      commitQueue.push({ oid: p, d: d + 1 });
                    }
                  }
                }
              }
              for (const cs of clientShallows) {
                if (!shallowBoundaries.has(cs)) {
                  unshallows.add(cs);
                }
              }
            }

            const reachable = collectReachableObjects(wants, r.objects, haves, depth, clientShallows);
            const packBytes = writePack(reachable);

            const acks = encodePktLine('acknowledgments\n');
            const ready = encodePktLine('ready\n');
            const sidebandPackets = encodeSideband(packBytes, 1);

            const shallowLines: Buffer[] = [];
            if (shallowBoundaries.size > 0 || unshallows.size > 0) {
              shallowLines.push(encodePktLine('shallow-info\n'));
              for (const u of unshallows) shallowLines.push(encodePktLine(`unshallow ${u}\n`));
              for (const s of shallowBoundaries) shallowLines.push(encodePktLine(`shallow ${s}\n`));
            }

            let bodyParts: Buffer[];
            if (shallowLines.length > 0) {
              bodyParts = [
                acks,
                ready,
                pktDelim(),
                ...shallowLines,
                pktDelim(),
                encodePktLine('packfile\n'),
                ...sidebandPackets,
                pktFlush(),
              ];
            } else {
              bodyParts = [acks, ready, pktDelim(), encodePktLine('packfile\n'), ...sidebandPackets, pktFlush()];
            }

            sendRaw(res, 200, Buffer.concat(bodyParts), 'application/x-git-upload-pack-result');
            return;
          }

          // Fallback v0
          const nak = encodePktLine('NAK\n');
          sendRaw(res, 200, nak, 'application/x-git-upload-pack-result');
          return;
        }

        // POST /git-receive-pack
        if (gitAction === 'git-receive-pack' && method === 'POST') {
          const raw = await readRawBody(req);
          const { lines, consumed } = decodePktLines(raw);

          // Unpack packfile first if present so objects are available for fast-forward check
          if (consumed < raw.length) {
            const packBuf = raw.subarray(consumed);
            if (packBuf.length >= 32 && packBuf.subarray(0, 4).toString('ascii') === 'PACK') {
              const newObjs = readPack(packBuf, (oid) => r.objects.get(oid));
              for (const [oid, obj] of newObjs.entries()) {
                r.objects.set(oid, obj);
                if (obj.type === 'tag') {
                  const text = obj.data.toString('utf8');
                  const m = text.match(/^object\s+([0-9a-f]{40})/m);
                  if (m) {
                    for (const [tName, tOid] of r.tags.entries()) {
                      if (tOid === oid) r.peeledTags.set(tName, m[1]);
                    }
                  }
                }
              }
            }
          }

          let hasSideband = false;
          const statusLines: Buffer[] = [encodePktLine('unpack ok\n')];

          for (const rawLine of lines) {
            const clean = rawLine.replace(/\n$/, '');
            const parts = clean.split('\0');
            const cmd = parts[0].split(' ');
            if (parts.length > 1 && parts[1].includes('side-band-64k')) hasSideband = true;

            if (cmd.length >= 3) {
              const oldOid = cmd[0];
              const newOid = cmd[1];
              const refName = cmd[2];

              // Fast-forward check for branch updates
              let isFF = true;
              if (refName.startsWith('refs/heads/') && oldOid !== ZERO_OID && newOid !== ZERO_OID) {
                isFF = isAncestor(newOid, oldOid, r.objects);
              }

              if (!isFF) {
                statusLines.push(encodePktLine(`ng ${refName} non-fast-forward\n`));
              } else {
                statusLines.push(encodePktLine(`ok ${refName}\n`));
                if (refName.startsWith('refs/heads/')) {
                  const branchName = refName.replace(/^refs\/heads\//, '');
                  if (newOid === ZERO_OID) {
                    r.branches.delete(branchName);
                    r.branchFiles.delete(branchName);
                  } else {
                    r.branches.set(branchName, newOid);
                    const fileMap = buildFilesMapFromCommit(newOid, r.objects);
                    r.branchFiles.set(branchName, fileMap);
                    if (branchName === r.defaultBranch) {
                      r.files = fileMap;
                    }
                  }
                } else if (refName.startsWith('refs/tags/')) {
                  const tagName = refName.replace(/^refs\/tags\//, '');
                  if (newOid === ZERO_OID) {
                    r.tags.delete(tagName);
                    r.peeledTags.delete(tagName);
                  } else {
                    r.tags.set(tagName, newOid);
                    const tagObj = r.objects.get(newOid);
                    if (tagObj && tagObj.type === 'tag') {
                      const text = tagObj.data.toString('utf8');
                      const m = text.match(/^object\s+([0-9a-f]{40})/m);
                      if (m) r.peeledTags.set(tagName, m[1]);
                    } else if (tagObj && tagObj.type === 'commit') {
                      r.peeledTags.set(tagName, newOid);
                    }
                  }
                }
              }
            }
          }
          statusLines.push(pktFlush());

          const reportPayload = Buffer.concat(statusLines);
          if (hasSideband) {
            const sidebandPacket = encodePktLine(Buffer.concat([Buffer.from([1]), reportPayload]));
            sendRaw(res, 200, Buffer.concat([sidebandPacket, pktFlush()]), 'application/x-git-receive-pack-result');
          } else {
            sendRaw(res, 200, reportPayload, 'application/x-git-receive-pack-result');
          }
          return;
        }
      }

      // Default 404 for anything unhandled
      sendJson(res, 404, { message: 'Not Found' });
    } catch (err: any) {
      console.error('Unhandled server error in app.ts:', err);
      sendJson(res, 500, { message: 'Internal Server Error' });
    }
  });
}
