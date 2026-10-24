import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapInterview, createClient, opId, snapshot, startTestServer, submitEvaluation, tokenFromLink } from './helpers.mjs';

let server;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

async function readSse(response, timeoutMs, stopWhen = null) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ done: false, value: null }), Math.max(0, deadline - Date.now()))),
      ]);
      if (done) break;
      if (value) text += decoder.decode(value, { stream: true });
      if (stopWhen && stopWhen(text)) break;
    }
  } catch {
    /* abort */
  }
  try {
    await reader.cancel();
  } catch {
    /* ignore */
  }
  return text;
}

test('面试人快照、API 与 SSE 均不包含内部便签或评价', async () => {
  const { id, lead, candidate } = await bootstrapInterview(server);
  const leadSnap = await snapshot(lead, id);
  assert.equal(leadSnap.status, 200);
  const secret = '绝密便签内容-不可外泄';
  const created = await lead.post(`/api/interviews/${id}/operations`, {
    ops: [
      {
        opId: opId('note'),
        type: 'note.create',
        round: 1,
        payload: { noteId: crypto.randomUUID(), body: secret, groupId: leadSnap.snapshot.groups[0].id },
      },
    ],
  });
  assert.equal(created.data.results[0].status, 'ok');

  const candidateResponse = await candidate.get(`/api/interviews/${id}/snapshot`);
  assert.equal(candidateResponse.status, 200);
  const candidateSnapshot = candidateResponse.data.snapshot;
  assert.ok(candidateSnapshot.interview.publicBrief.includes('公开说明'));
  assert.equal(candidateSnapshot.interview.internalBrief, undefined);
  assert.equal(candidateSnapshot.interview.internalFocus, undefined);
  assert.equal(candidateSnapshot.notes, undefined);
  assert.equal(candidateSnapshot.evaluations, undefined);
  assert.equal(candidateSnapshot.messages, undefined);
  const raw = JSON.stringify(candidateSnapshot);
  assert.equal(raw.includes('绝密'), false);
  assert.equal(raw.includes('内部简介'), false);
  assert.equal(raw.includes('内部重点'), false);

  const candidateApi = await candidate.get(`/api/interviews/${id}/candidate`);
  assert.equal(candidateApi.status, 200);
  assert.equal(JSON.stringify(candidateApi.data).includes('绝密'), false);

  const sseUrl = `${server.baseUrl}/api/interviews/${id}/events?since=0`;
  const controller = new AbortController();
  const response = await fetch(sseUrl, { headers: { cookie: candidate.cookieHeader }, signal: controller.signal });
  assert.equal(response.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 120));
  await lead.post(`/api/interviews/${id}/operations`, {
    ops: [
      {
        opId: opId('note'),
        type: 'note.create',
        round: 1,
        payload: { noteId: crypto.randomUUID(), body: `${secret}-二`, groupId: leadSnap.snapshot.groups[0].id },
      },
    ],
  });
  const streamed = await readSse(response, 900, (text) => text.includes('绝密'));
  controller.abort();
  assert.equal(streamed.includes('绝密'), false);
  assert.equal(streamed.includes('note_created'), false);
  assert.equal(streamed.includes('evaluation_updated'), false);
});

test('未登录、跨站来源与错误面试身份不能提升权限', async () => {
  const { id, candidate } = await bootstrapInterview(server);
  const anon = createClient(server.baseUrl);
  assert.equal((await anon.get(`/api/interviews/${id}/snapshot`)).status, 401);
  assert.equal((await anon.get(`/api/interviews/${id}/report`)).status, 401);
  assert.equal((await anon.get(`/api/interviews/${id}/report.md`)).status, 401);
  assert.equal(
    (await anon.post(`/api/interviews/${id}/operations`, { ops: [] })).status,
    401,
  );
  assert.equal((await candidate.get(`/api/interviews/${id}/report`)).status, 403);
  assert.equal((await candidate.get(`/api/interviews/${id}/report.md`)).status, 403);
  assert.equal((await candidate.put(`/api/interviews/${id}/evaluations/me`, { level: 'yes', reason: 'x', submit: true })).status, 403);
  assert.equal((await candidate.post(`/api/interviews/${id}/reopen`, {})).status, 403);
  assert.equal((await candidate.get(`/api/interviews/${id}/candidate`)).status, 200);

  // 面试人会话访问另一场面试
  const other = await bootstrapInterview(server);
  assert.equal((await candidate.get(`/api/interviews/${other.id}/snapshot`)).status, 403);

  // 跨站来源被拒绝
  const crossSite = await fetch(`${server.baseUrl}/api/interviews`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
    body: JSON.stringify({ mode: 'demo' }),
  });
  assert.equal(crossSite.status, 403);

  // 伪造 JSON 角色字段没有任何作用
  const forged = await candidate.post(`/api/interviews/${id}/operations`, {
    ops: [],
    role: 'lead',
    participantId: 'forged',
  });
  assert.equal(forged.status, 403);
});

test('副考官权限：不能审批/确认/重开/编辑他人便签，但可以移动任意便签', async () => {
  const { id, lead, co } = await bootstrapInterview(server);
  const leadSnap = await snapshot(lead, id);
  const groups = leadSnap.snapshot.groups;
  const created = await lead.post(`/api/interviews/${id}/operations`, {
    ops: [
      {
        opId: opId('note'),
        type: 'note.create',
        round: 1,
        payload: { noteId: crypto.randomUUID(), body: '主考官创建的便签', groupId: groups[0].id },
      },
    ],
  });
  const noteId = created.data.results[0].data.id;

  const forbiddenOperations = await co.post(`/api/interviews/${id}/operations`, {
    ops: [
      { opId: opId('note'), type: 'note.update', round: 1, payload: { noteId, body: '篡改', version: 1 } },
      { opId: opId('note'), type: 'note.delete', round: 1, payload: { noteId, version: 1 } },
      { opId: opId('note'), type: 'note.flags', round: 1, payload: { noteId, important: true, version: 1 } },
    ],
  });
  assert.equal(forbiddenOperations.status, 200);
  for (const result of forbiddenOperations.data.results) {
    assert.equal(result.status, 'forbidden');
    assert.equal(result.reason, 'not_author');
  }
  const moved = await co.post(`/api/interviews/${id}/operations`, {
    ops: [{ opId: opId('note'), type: 'note.move', round: 1, payload: { noteId, groupId: groups[1].id } }],
  });
  assert.equal(moved.data.results[0].status, 'ok');
  assert.equal(moved.data.results[0].data.groupId, groups[1].id);

  // 副考官不能审批加入申请、确认结论或重新开启
  const leadSnapshot = await snapshot(lead, id);
  assert.ok(Array.isArray(leadSnapshot.snapshot.joinRequests));
  assert.equal((await co.post(`/api/interviews/${id}/join-requests/not-a-request/approve`, {})).status, 403);
  assert.equal((await co.post(`/api/interviews/${id}/complete`, { finalLevel: 'yes', reason: 'x' })).status, 403);
  assert.equal((await co.post(`/api/interviews/${id}/reopen`, {})).status, 403);
  assert.equal((await co.get(`/api/interviews/${id}/report`)).status, 200);
});

test('未审批或被拒绝的副考官不能读取内部数据', async () => {
  const { id, lead } = await bootstrapInterview(server);
  // 重新邀请出一个新的副考官邀请
  const reinvited = await lead.post(`/api/interviews/${id}/reinvite`, { role: 'co' });
  assert.equal(reinvited.status, 200);
  const applicant = createClient(server.baseUrl);
  const apply = await applicant.post(`/api/invitations/${tokenFromLink(reinvited.data.url)}/apply`, { name: '待审批者' });
  assert.equal(apply.status, 200);
  assert.equal((await applicant.get(`/api/interviews/${id}/snapshot`)).status, 401);
  const enterPending = await applicant.post('/api/join-requests/me/enter', {});
  assert.equal(enterPending.status, 401);
  assert.equal(enterPending.data.error.code, 'request_pending');

  const leadSnap = await snapshot(lead, id);
  const pending = leadSnap.snapshot.joinRequests.find((request) => request.status === 'pending');
  const reject = await lead.post(`/api/interviews/${id}/join-requests/${pending.id}/reject`, {});
  assert.equal(reject.status, 200);
  const enterRejected = await applicant.post('/api/join-requests/me/enter', {});
  assert.equal(enterRejected.status, 403);
  assert.equal(enterRejected.data.error.code, 'request_rejected');
  assert.equal((await applicant.get(`/api/interviews/${id}/snapshot`)).status, 401);
});

test('重新邀请撤销旧会话与旧 SSE，历史便签作者快照保留且新身份不能编辑', async () => {
  const { id, lead, co } = await bootstrapInterview(server);
  const coSnap = await snapshot(co, id);
  const created = await co.post(`/api/interviews/${id}/operations`, {
    ops: [
      {
        opId: opId('note'),
        type: 'note.create',
        round: 1,
        payload: { noteId: crypto.randomUUID(), body: '副考官甲的便签', groupId: coSnap.snapshot.groups[0].id },
      },
    ],
  });
  const noteId = created.data.results[0].data.id;

  const sseController = new AbortController();
  const coSse = await fetch(`${server.baseUrl}/api/interviews/${id}/events?since=0`, {
    headers: { cookie: co.cookieHeader },
    signal: sseController.signal,
  });
  assert.equal(coSse.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 120));

  const reinvite = await lead.post(`/api/interviews/${id}/reinvite`, { role: 'co' });
  assert.equal(reinvite.status, 200);
  const streamed = await readSse(coSse, 1500, (text) => text.includes('revoked'));
  sseController.abort();
  assert.ok(streamed.includes('revoked'));

  assert.equal((await co.get(`/api/interviews/${id}/snapshot`)).status, 401);
  assert.equal(
    (await co.post(`/api/interviews/${id}/operations`, {
      ops: [{ opId: opId('note'), type: 'note.create', round: 1, payload: { noteId: crypto.randomUUID(), body: '旧队列' } }],
    })).status,
    401,
  );

  // 新副考官通过新链接申请、审批、进入
  const newCo = createClient(server.baseUrl);
  const apply = await newCo.post(`/api/invitations/${tokenFromLink(reinvite.data.url)}/apply`, { name: '副考官乙' });
  assert.equal(apply.status, 200);
  const leadSnap = await snapshot(lead, id);
  const pending = leadSnap.snapshot.joinRequests.find((request) => request.status === 'pending');
  assert.equal((await lead.post(`/api/interviews/${id}/join-requests/${pending.id}/approve`, {})).status, 200);
  assert.equal((await newCo.post('/api/join-requests/me/enter', {})).status, 200);
  const newSnap = await snapshot(newCo, id);
  assert.equal(newSnap.status, 200);
  const historical = newSnap.snapshot.notes.find((note) => note.id === noteId);
  assert.ok(historical);
  assert.equal(historical.authorName, '副考官甲');
  assert.equal(historical.authorGeneration, 1);
  const edit = await newCo.post(`/api/interviews/${id}/operations`, {
    ops: [{ opId: opId('note'), type: 'note.update', round: 1, payload: { noteId, body: '新副考官篡改', version: historical.version } }],
  });
  assert.equal(edit.data.results[0].status, 'forbidden');
  assert.equal(edit.data.results[0].reason, 'not_author');
});

test('恢复主考官入口后同一人仍可编辑自己创建的历史便签', async () => {
  const { id, lead } = await bootstrapInterview(server);
  const snap = await snapshot(lead, id);
  const created = await lead.post(`/api/interviews/${id}/operations`, {
    ops: [
      {
        opId: opId('note'),
        type: 'note.create',
        round: 1,
        payload: { noteId: crypto.randomUUID(), body: '主考官恢复前创建的便签', groupId: snap.snapshot.groups[0].id },
      },
    ],
  });
  const note = created.data.results[0].data;

  const admin = createClient(server.baseUrl, { adminToken: server.adminToken });
  const recover = await admin.post(`/api/admin/interviews/${id}/recover-lead`, { confirm: true });
  assert.equal(recover.status, 200);
  assert.equal((await lead.get(`/api/interviews/${id}/snapshot`)).status, 401);

  const recoveredLead = createClient(server.baseUrl);
  assert.equal((await recoveredLead.post(`/api/invitations/${tokenFromLink(recover.data.url)}/claim`, {})).status, 200);
  const after = await snapshot(recoveredLead, id);
  assert.ok(after.snapshot.viewer.generation > 1);
  const edit = await recoveredLead.post(`/api/interviews/${id}/operations`, {
    ops: [
      {
        opId: opId('note'),
        type: 'note.update',
        round: 1,
        payload: { noteId: note.id, body: '恢复身份后继续编辑自己的便签', version: note.version },
      },
    ],
  });
  assert.equal(edit.data.results[0].status, 'ok');
  assert.equal(edit.data.results[0].data.body, '恢复身份后继续编辑自己的便签');
});

test('副考官被替换后不继承旧副考官在当前轮的评价', async () => {
  const { id, lead, co } = await bootstrapInterview(server);
  const submitted = await submitEvaluation(co, id, 'yes', '旧副考官的评价');
  assert.equal(submitted.status, 200);
  const before = await snapshot(lead, id);
  assert.equal(before.snapshot.evaluations.co.status, 'submitted');

  const reinvite = await lead.post(`/api/interviews/${id}/reinvite`, { role: 'co' });
  assert.equal(reinvite.status, 200);
  const replacement = createClient(server.baseUrl);
  assert.equal((await replacement.post(`/api/invitations/${tokenFromLink(reinvite.data.url)}/apply`, { name: '新副考官' })).status, 200);
  const leadSnap = await snapshot(lead, id);
  const pending = leadSnap.snapshot.joinRequests.find((request) => request.status === 'pending');
  assert.equal((await lead.post(`/api/interviews/${id}/join-requests/${pending.id}/approve`, {})).status, 200);
  assert.equal((await replacement.post('/api/join-requests/me/enter', {})).status, 200);
  const after = await snapshot(replacement, id);
  assert.equal(after.snapshot.evaluations.co, null);
  const complete = await lead.post(`/api/interviews/${id}/complete`, { finalLevel: 'yes', reason: '缺少新副考官评价' });
  assert.equal(complete.status, 403);
  void co;
});
