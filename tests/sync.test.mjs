import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapInterview, opId, snapshot, startTestServer, submitEvaluation } from './helpers.mjs';

let server;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

async function sendOps(client, interviewId, ops) {
  return client.post(`/api/interviews/${interviewId}/operations`, { ops });
}

test('opId 幂等：重复提交只返回第一次结果，不重复写入', async () => {
  const { id, lead } = await bootstrapInterview(server);
  const snap = await snapshot(lead, id);
  const noteId = crypto.randomUUID();
  const operation = {
    opId: opId('note'),
    type: 'note.create',
    round: 1,
    payload: { noteId, body: '幂等测试便签', groupId: snap.snapshot.groups[0].id },
  };
  const first = await sendOps(lead, id, [operation]);
  assert.equal(first.data.results[0].status, 'ok');
  assert.equal(first.data.results[0].data.id, noteId);

  const retry = await sendOps(lead, id, [{ ...operation, payload: { ...operation.payload, body: '不应生效的第二次正文' } }]);
  assert.equal(retry.data.results[0].status, 'duplicate');
  assert.equal(retry.data.results[0].data.id, noteId);
  const after = await snapshot(lead, id);
  assert.equal(after.snapshot.notes.filter((note) => note.id === noteId).length, 1);
  assert.equal(after.snapshot.notes.find((note) => note.id === noteId).body, '幂等测试便签');

  const duplicateId = await sendOps(lead, id, [
    {
      opId: opId('note'),
      type: 'note.create',
      round: 1,
      payload: { noteId, body: '同一 ID 的另一条操作', groupId: snap.snapshot.groups[0].id },
    },
  ]);
  assert.equal(duplicateId.data.results[0].status, 'conflict');
  assert.equal(duplicateId.data.results[0].reason, 'note_exists');
});

test('版本冲突返回服务端当前便签；单条冲突不阻塞同批其他操作', async () => {
  const { id, lead, co } = await bootstrapInterview(server);
  const created = await sendOps(lead, id, [
    {
      opId: opId('note'),
      type: 'note.create',
      round: 1,
      payload: { noteId: crypto.randomUUID(), body: '初始正文', groupId: (await snapshot(lead, id)).snapshot.groups[0].id },
    },
  ]);
  const note = created.data.results[0].data;

  const update = await sendOps(lead, id, [
    { opId: opId('note'), type: 'note.update', round: 1, payload: { noteId: note.id, body: '服务端最新正文', version: note.version } },
  ]);
  assert.equal(update.data.results[0].status, 'ok');
  assert.equal(update.data.results[0].data.version, 2);

  const batch = await sendOps(lead, id, [
    { opId: opId('note'), type: 'note.update', round: 1, payload: { noteId: note.id, body: '旧窗口正文', version: 1 } },
    {
      opId: opId('msg'),
      type: 'message.create',
      round: 1,
      payload: { messageId: crypto.randomUUID(), body: '同批另一条消息应成功' },
    },
    {
      opId: opId('msg'),
      type: 'message.create',
      round: 1,
      payload: { messageId: crypto.randomUUID(), body: '回复不存在的消息', replyTo: 'missing-message-id' },
    },
  ]);
  assert.equal(batch.status, 200);
  assert.equal(batch.data.results[0].status, 'conflict');
  assert.equal(batch.data.results[0].reason, 'version_conflict');
  assert.equal(batch.data.results[0].current.version, 2);
  assert.equal(batch.data.results[0].current.body, '服务端最新正文');
  assert.equal(batch.data.results[1].status, 'ok');
  assert.equal(batch.data.results[2].status, 'conflict');
  assert.equal(batch.data.results[2].reason, 'reply_missing');

  const snap = await snapshot(co, id);
  assert.equal(snap.snapshot.notes.find((item) => item.id === note.id).body, '服务端最新正文');
  assert.equal(snap.snapshot.messages.some((message) => message.body === '同批另一条消息应成功'), true);
});

test('同时移动按服务端最后有效提交处理并记录最近移动人', async () => {
  const { id, lead, co } = await bootstrapInterview(server);
  const snap = await snapshot(lead, id);
  const groups = snap.snapshot.groups;
  const created = await sendOps(lead, id, [
    {
      opId: opId('note'),
      type: 'note.create',
      round: 1,
      payload: { noteId: crypto.randomUUID(), body: '移动竞争测试', groupId: groups[0].id },
    },
  ]);
  const noteId = created.data.results[0].data.id;
  await sendOps(lead, id, [{ opId: opId('note'), type: 'note.move', round: 1, payload: { noteId, groupId: groups[1].id } }]);
  await sendOps(co, id, [{ opId: opId('note'), type: 'note.move', round: 1, payload: { noteId, groupId: groups[2].id } }]);
  const finalMove = await sendOps(lead, id, [
    { opId: opId('note'), type: 'note.move', round: 1, payload: { noteId, groupId: groups[0].id } },
  ]);
  assert.equal(finalMove.data.results[0].status, 'ok');
  assert.equal(finalMove.data.results[0].data.groupId, groups[0].id);
  const after = await snapshot(co, id);
  const note = after.snapshot.notes.find((item) => item.id === noteId);
  assert.equal(note.groupId, groups[0].id);
  assert.equal(note.lastMovedBy, '主考官甲');
});

test('目标分组已删除时移动归入“未分类”并给出警告', async () => {
  const { id, lead } = await bootstrapInterview(server);
  const snap = await snapshot(lead, id);
  const groupResponse = await sendOps(lead, id, [
    { opId: opId('group'), type: 'group.create', round: 1, payload: { groupId: crypto.randomUUID(), name: '将被删除的分组' } },
  ]);
  const groupId = groupResponse.data.results[0].data.id;
  const created = await sendOps(lead, id, [
    {
      opId: opId('note'),
      type: 'note.create',
      round: 1,
      payload: { noteId: crypto.randomUUID(), body: '组内便签', groupId },
    },
  ]);
  const noteId = created.data.results[0].data.id;
  await sendOps(lead, id, [{ opId: opId('group'), type: 'group.delete', round: 1, payload: { groupId } }]);

  const move = await sendOps(lead, id, [
    { opId: opId('note'), type: 'note.move', round: 1, payload: { noteId, groupId } },
  ]);
  assert.equal(move.data.results[0].status, 'ok');
  assert.equal(move.data.results[0].warnings[0].code, 'group_missing');
  assert.equal(move.data.results[0].data.groupName, '未分类');
  const systemGroup = snap.snapshot.groups.find((group) => group.isSystem);
  assert.equal(move.data.results[0].data.groupId, systemGroup.id);

  const createInDeleted = await sendOps(lead, id, [
    {
      opId: opId('note'),
      type: 'note.create',
      round: 1,
      payload: { noteId: crypto.randomUUID(), body: '离线时目标分组已被删除', groupId },
    },
  ]);
  assert.equal(createInDeleted.data.results[0].status, 'ok');
  assert.equal(createInDeleted.data.results[0].warnings[0].code, 'group_missing');
  assert.equal(createInDeleted.data.results[0].data.groupId, systemGroup.id);
});

test('完后只读、重新开启后旧轮次在线/离线操作均被拒绝', async () => {
  const { id, lead, co } = await bootstrapInterview(server);
  await submitEvaluation(lead, id, 'yes', '推荐');
  await submitEvaluation(co, id, 'yes', '推荐');
  const complete = await lead.post(`/api/interviews/${id}/complete`, { finalLevel: 'yes', reason: '一致推荐' });
  assert.equal(complete.status, 200);

  const rejected = await sendOps(co, id, [
    {
      opId: opId('note'),
      type: 'note.create',
      round: 1,
      payload: { noteId: crypto.randomUUID(), body: '完成后离线补写' },
    },
    {
      opId: opId('msg'),
      type: 'message.create',
      round: 1,
      payload: { messageId: crypto.randomUUID(), body: '完成后离线消息' },
    },
  ]);
  assert.equal(rejected.data.results[0].status, 'forbidden');
  assert.equal(rejected.data.results[0].reason, 'board_completed');
  assert.equal(rejected.data.results[1].status, 'forbidden');

  await lead.post(`/api/interviews/${id}/reopen`, {});
  const stale = await sendOps(co, id, [
    {
      opId: opId('note'),
      type: 'note.create',
      round: 1,
      payload: { noteId: crypto.randomUUID(), body: '旧轮次队列内容' },
    },
  ]);
  assert.equal(stale.data.results[0].status, 'conflict');
  assert.equal(stale.data.results[0].reason, 'stale_round');

  const current = await sendOps(co, id, [
    {
      opId: opId('note'),
      type: 'note.create',
      round: 2,
      payload: { noteId: crypto.randomUUID(), body: '新轮次正常写入' },
    },
  ]);
  assert.equal(current.data.results[0].status, 'ok');
  const snap = await snapshot(lead, id);
  assert.equal(snap.snapshot.interview.round, 2);
  assert.equal(snap.snapshot.notes.some((note) => note.body === '旧轮次队列内容'), false);
  assert.equal(snap.snapshot.notes.some((note) => note.body === '新轮次正常写入'), true);
});

test('输入上限、批大小与请求体上限返回明确错误', async () => {
  const { id, lead } = await bootstrapInterview(server);
  const snap = await snapshot(lead, id);
  const tooLong = await sendOps(lead, id, [
    {
      opId: opId('note'),
      type: 'note.create',
      round: 1,
      payload: { noteId: crypto.randomUUID(), body: '长'.repeat(4001), groupId: snap.snapshot.groups[0].id },
    },
  ]);
  assert.equal(tooLong.data.results[0].status, 'invalid');
  assert.equal(tooLong.data.results[0].reason, 'body_too_long');

  const tooMany = await sendOps(
    lead,
    id,
    Array.from({ length: 51 }, () => ({ opId: opId('note'), type: 'note.create', round: 1, payload: { body: 'x' } })),
  );
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.data.error.code, 'too_many_operations');

  const huge = 'x'.repeat(129 * 1024);
  const response = await fetch(`${server.baseUrl}/api/interviews/${id}/operations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: lead.cookieHeader },
    body: JSON.stringify({ ops: [], padding: huge }),
  });
  assert.equal(response.status, 413);
});

test('未知操作与无权限操作返回独立结果，不中断整批', async () => {
  const { id, lead } = await bootstrapInterview(server);
  const response = await sendOps(lead, id, [
    { opId: opId('unknown'), type: 'note.explode', round: 1, payload: {} },
    { opId: 'short', type: 'note.create', round: 1, payload: { body: 'x' } },
    { opId: opId('note'), type: 'note.create', round: 1, payload: { body: '   ' } },
    { opId: opId('msg'), type: 'message.create', round: 1, payload: { messageId: crypto.randomUUID(), body: '有效消息' } },
  ]);
  assert.equal(response.status, 200);
  assert.equal(response.data.results.length, 4);
  assert.equal(response.data.results[0].status, 'invalid');
  assert.equal(response.data.results[0].reason, 'unknown_operation');
  assert.equal(response.data.results[1].status, 'invalid');
  assert.equal(response.data.results[1].reason, 'invalid_op_id');
  assert.equal(response.data.results[2].status, 'invalid');
  assert.equal(response.data.results[2].reason, 'empty_body');
  assert.equal(response.data.results[3].status, 'ok');
});
