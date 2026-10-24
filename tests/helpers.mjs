import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { openDatabase } from '../src/db/index.mjs';
import { SecretStore } from '../src/secrets.mjs';
import { createApp } from '../src/http/app.mjs';

const quietLogger = { info() {}, error() {}, warn() {} };

export async function startTestServer({ adminToken = `test-admin-${'a'.repeat(32)}` } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interview-partner-test-'));
  const config = loadConfig({ PORT: '0', DATA_DIR: dir }, process.cwd());
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(config.adminTokenPath, `${adminToken}\n`, { mode: 0o600 });
  const db = openDatabase(':memory:');
  const secrets = new SecretStore(config.secretsPath);
  const app = createApp({ config, db, secrets, adminToken, logger: quietLogger });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
  const port = app.server.address().port;
  config.baseUrl = `http://127.0.0.1:${port}`;
  config.port = port;

  const baseUrl = config.baseUrl;
  return {
    app,
    db,
    config,
    secrets,
    adminToken,
    baseUrl,
    port,
    dir,
    async close() {
      await app.close();
      try {
        db.close();
      } catch {
        /* ignore */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 极简 Cookie Jar 客户端，模拟一个独立浏览器环境。 */
export function createClient(baseUrl, { adminToken = null } = {}) {
  const cookies = new Map();

  function cookieHeader() {
    return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  function remember(response) {
    const setCookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);
    for (const raw of setCookies) {
      const [pair] = raw.split(';');
      const index = pair.indexOf('=');
      if (index === -1) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (value === '') cookies.delete(name);
      else cookies.set(name, value);
    }
  }

  async function request(method, urlPath, body, options = {}) {
    const headers = { ...(options.headers ?? {}) };
    if (cookieHeader()) headers.cookie = cookieHeader();
    if (adminToken) headers.authorization = `Bearer ${adminToken}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${baseUrl}${urlPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    remember(response);
    const type = response.headers.get('content-type') ?? '';
    let data = null;
    if (type.includes('application/json')) {
      data = await response.json();
    } else {
      data = await response.text();
    }
    return { status: response.status, data, headers: response.headers, response };
  }

  return {
    baseUrl,
    request,
    get: (urlPath, options) => request('GET', urlPath, undefined, options),
    post: (urlPath, body, options) => request('POST', urlPath, body, options),
    put: (urlPath, body, options) => request('PUT', urlPath, body, options),
    get cookieHeader() {
      return cookieHeader();
    },
    get cookies() {
      return cookies;
    },
    clearCookies() {
      cookies.clear();
    },
  };
}

/** 从绝对链接中取出一次性邀请令牌。 */
export function tokenFromLink(link) {
  const parts = new URL(link).pathname.split('/').filter(Boolean);
  return parts[parts.length - 1];
}

export function opId(prefix = 'op') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 创建一场面试，并让三个角色分别完成真实领取/申请/审批流程。 */
export async function bootstrapInterview(server, overrides = {}) {
  const creator = createClient(server.baseUrl);
  const created = await creator.post('/api/interviews', {
    mode: 'blank',
    candidateName: '候选人甲',
    position: '高级工程师',
    leadName: '主考官甲',
    internalBrief: '内部简介：需要保密的项目经历',
    internalFocus: '内部重点：验证系统设计深度',
    publicBrief: '公开说明：面试约 45 分钟',
    ...overrides,
  });
  if (created.status !== 201) throw new Error(`创建面试失败：${JSON.stringify(created.data)}`);
  const id = created.data.interviewId;
  const links = created.data.links;

  const lead = createClient(server.baseUrl);
  const leadClaim = await lead.post(`/api/invitations/${tokenFromLink(links.lead)}/claim`, {});
  if (leadClaim.status !== 200) throw new Error(`领取主考官失败：${JSON.stringify(leadClaim.data)}`);

  const co = createClient(server.baseUrl);
  const apply = await co.post(`/api/invitations/${tokenFromLink(links.co)}/apply`, { name: '副考官甲' });
  if (apply.status !== 200) throw new Error(`副考官申请失败：${JSON.stringify(apply.data)}`);
  const leadSnapshot = await lead.get(`/api/interviews/${id}/snapshot`);
  const pending = leadSnapshot.data.snapshot.joinRequests.find((request) => request.status === 'pending');
  const approve = await lead.post(`/api/interviews/${id}/join-requests/${pending.id}/approve`, {});
  if (approve.status !== 200) throw new Error(`审批失败：${JSON.stringify(approve.data)}`);
  const enter = await co.post('/api/join-requests/me/enter', {});
  if (enter.status !== 200) throw new Error(`副考官进入失败：${JSON.stringify(enter.data)}`);

  const candidate = createClient(server.baseUrl);
  const candidateClaim = await candidate.post(`/api/invitations/${tokenFromLink(links.candidate)}/claim`, {});
  if (candidateClaim.status !== 200) throw new Error(`领取面试人失败：${JSON.stringify(candidateClaim.data)}`);

  return { creator, created, id, links, lead, co, candidate };
}

export async function snapshot(client, interviewId) {
  const response = await client.get(`/api/interviews/${interviewId}/snapshot`);
  return { status: response.status, snapshot: response.data?.snapshot, body: response.data };
}

export async function submitEvaluation(client, interviewId, level, reason, { submit = true } = {}) {
  return client.put(`/api/interviews/${interviewId}/evaluations/me`, { level, reason, submit });
}

export function noteOp(overrides = {}) {
  return {
    opId: opId('note'),
    type: 'note.create',
    round: 1,
    payload: {
      noteId: crypto.randomUUID(),
      body: '一条用于测试的便签',
      ...overrides,
    },
  };
}
