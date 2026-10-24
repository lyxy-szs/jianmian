import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  bootstrapInterview,
  createClient,
  opId,
  snapshot,
  startTestServer,
  submitEvaluation,
  tokenFromLink,
} from './helpers.mjs';

let server;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

async function createNote(client, interviewId, body, overrides = {}) {
  const snap = await snapshot(client, interviewId);
  const groupId = overrides.groupId ?? snap.snapshot.groups.find((group) => group.isSystem)?.id ?? snap.snapshot.groups[0].id;
  const response = await client.post(`/api/interviews/${interviewId}/operations`, {
    ops: [
      {
        opId: opId('note'),
        type: 'note.create',
        round: snap.snapshot.interview.round,
        payload: { noteId: crypto.randomUUID(), body, groupId, ...overrides },
      },
    ],
  });
  return response.data.results[0];
}

test('评价提交与最终结论事务：缺理由、等级不一致、版本变化均被拒绝', async () => {
  const { id, lead, co, candidate } = await bootstrapInterview(server);

  const early = await lead.post(`/api/interviews/${id}/complete`, { finalLevel: 'yes', reason: '过早确认' });
  assert.equal(early.status, 403);
  assert.equal(early.data.error.code, 'evaluations_pending');

  const leadEval = await submitEvaluation(lead, id, 'yes', '主考官认可项目深度');
  assert.equal(leadEval.status, 200);
  assert.equal(leadEval.data.evaluation.status, 'submitted');

  const onlyOne = await lead.post(`/api/interviews/${id}/complete`, { finalLevel: 'yes', reason: '只有一人提交' });
  assert.equal(onlyOne.status, 403);
  assert.equal(onlyOne.data.error.code, 'evaluations_pending');

  const blankReason = await submitEvaluation(co, id, 'hold', '   ');
  assert.equal(blankReason.status, 400);
  assert.equal(blankReason.data.error.code, 'reason_required');

  const invalidLevel = await submitEvaluation(co, id, 'maybe', '等级非法');
  assert.equal(invalidLevel.status, 400);
  assert.equal(invalidLevel.data.error.code, 'invalid_level');

  const draft = await submitEvaluation(co, id, 'hold', '需要再确认技术深度', { submit: false });
  assert.equal(draft.status, 200);
  assert.equal(draft.data.evaluation.status, 'draft');
  const stillDraft = await lead.post(`/api/interviews/${id}/complete`, { finalLevel: 'yes', reason: '仍为草稿' });
  assert.equal(stillDraft.status, 403);

  const coEval = await submitEvaluation(co, id, 'hold', '需要再确认技术深度');
  assert.equal(coEval.status, 200);

  const noDivergence = await lead.post(`/api/interviews/${id}/complete`, { finalLevel: 'yes', reason: '综合推荐' });
  assert.equal(noDivergence.status, 400);
  assert.equal(noDivergence.data.error.code, 'divergence_required');

  const staleVersion = await lead.post(`/api/interviews/${id}/complete`, {
    finalLevel: 'yes',
    reason: '综合推荐',
    divergenceNote: '对深度有分歧',
    expectedVersions: { lead: 999, co: 999 },
  });
  assert.equal(staleVersion.status, 409);
  assert.equal(staleVersion.data.error.code, 'evaluation_changed');

  const final = await lead.post(`/api/interviews/${id}/complete`, {
    finalLevel: 'yes',
    reason: '综合推荐，技术深度可继续培养',
    divergenceNote: '副考官对系统设计深度保留意见，建议入职后重点跟进',
    expectedVersions: { lead: leadEval.data.evaluation.version, co: coEval.data.evaluation.version },
  });
  assert.equal(final.status, 200);
  assert.equal(final.data.decision.finalLevel, 'yes');
  assert.equal(final.data.decision.finalLevelLabel, '推荐');
  assert.equal(final.data.report.reportVersion, 'round-1-final');
  assert.equal(final.data.report.decision.finalLevel, 'yes');

  const done = await snapshot(lead, id);
  assert.equal(done.snapshot.interview.status, 'completed');
  assert.equal(done.snapshot.permissions.readOnly, true);
  assert.equal(done.snapshot.permissions.canReopen, true);
  assert.equal(done.snapshot.permissions.canConfirm, false);

  const candidateSnap = await snapshot(candidate, id);
  assert.equal(candidateSnap.snapshot.interview.status, 'completed');
  assert.equal(candidateSnap.snapshot.interview.statusLabel, '已完成');
  assert.equal(JSON.stringify(candidateSnap.snapshot).includes('综合推荐'), false);

  const afterComplete = await lead.post(`/api/interviews/${id}/operations`, {
    ops: [
      {
        opId: opId('note'),
        type: 'note.create',
        round: 1,
        payload: { noteId: crypto.randomUUID(), body: '完成后不应写入' },
      },
    ],
  });
  assert.equal(afterComplete.data.results[0].status, 'forbidden');
  assert.equal(afterComplete.data.results[0].reason, 'board_completed');
  const evalAfter = await submitEvaluation(lead, id, 'yes', '完成后修改评价');
  assert.equal(evalAfter.status, 403);
  const readyAfter = await candidate.post(`/api/interviews/${id}/ready`, { ready: true });
  assert.equal(readyAfter.status, 409);
  assert.equal((await co.post(`/api/interviews/${id}/reopen`, {})).status, 403);

  const md = await lead.get(`/api/interviews/${id}/report.md`);
  assert.equal(md.status, 200);
  assert.match(md.data, /推荐/);
  assert.match(md.data, /round-1-final/);
  assert.match(md.data, /副考官对系统设计深度保留意见/);
  assert.match(md.data, /面试人不可访问/);

  const reopen = await lead.post(`/api/interviews/${id}/reopen`, {});
  assert.equal(reopen.status, 200);
  assert.equal(reopen.data.round, 2);
  const reopened = await snapshot(lead, id);
  assert.equal(reopened.snapshot.interview.status, 'evaluating');
  assert.equal(reopened.snapshot.interview.round, 2);
  assert.equal(reopened.snapshot.evaluations.lead.status, 'draft');
  assert.equal(reopened.snapshot.evaluations.co.status, 'draft');
  assert.equal(reopened.snapshot.evaluations.lead.reason, '主考官认可项目深度');
  assert.equal(reopened.snapshot.evaluations.co.reason, '需要再确认技术深度');
  assert.equal(reopened.snapshot.decisions.length, 1);
  assert.equal(reopened.snapshot.decisions[0].round, 1);

  const completeBeforeResubmit = await lead.post(`/api/interviews/${id}/complete`, {
    finalLevel: 'yes',
    reason: '未重新提交',
  });
  assert.equal(completeBeforeResubmit.status, 403);

  const rel = await submitEvaluation(lead, id, 'strong_yes', '第二轮确认强烈推荐');
  const rec = await submitEvaluation(co, id, 'strong_yes', '第二轮一致同意');
  assert.equal(rel.status, 200);
  assert.equal(rec.status, 200);
  const final2 = await lead.post(`/api/interviews/${id}/complete`, {
    finalLevel: 'strong_yes',
    reason: '两轮一致，建议进入下一流程',
  });
  assert.equal(final2.status, 200);
  assert.equal(final2.data.report.reportVersion, 'round-2-final');
  assert.equal(final2.data.report.history.length, 1);
  assert.equal(final2.data.report.history[0].round, 1);
  const md2 = await lead.get(`/api/interviews/${id}/report.md`);
  assert.match(md2.data, /round-2-final/);
  assert.match(md2.data, /第 1 轮/);
  const reportJson = await lead.get(`/api/interviews/${id}/report`);
  assert.equal(reportJson.data.report.decision.finalLevel, 'strong_yes');
  assert.equal(reportJson.data.report.history[0].finalLevel, 'yes');
});

test('示例面试写入真实数据库并需要真实审批流程', async () => {
  const creator = createClient(server.baseUrl);
  const created = await creator.post('/api/interviews', { mode: 'demo' });
  assert.equal(created.status, 201);
  const id = created.data.interviewId;
  const lead = createClient(server.baseUrl);
  assert.equal((await lead.post(`/api/invitations/${tokenFromLink(created.data.links.lead)}/claim`, {})).status, 200);
  const leadSnap = await snapshot(lead, id);
  assert.equal(leadSnap.snapshot.interview.status, 'evaluating');
  assert.ok(leadSnap.snapshot.notes.length >= 4);
  assert.ok(leadSnap.snapshot.messages.length >= 2);

  const co = createClient(server.baseUrl);
  assert.equal((await co.get(`/api/interviews/${id}/snapshot`)).status, 401);
  assert.equal((await co.post(`/api/invitations/${tokenFromLink(created.data.links.co)}/apply`, { name: '示例副考官' })).status, 200);
  assert.equal((await co.get(`/api/interviews/${id}/snapshot`)).status, 401);
  const pending = leadSnap.snapshot.joinRequests.find((request) => request.status === 'pending');
  assert.equal(pending, undefined); // 示例不会预生成已登录的副考官
  const refreshed = await snapshot(lead, id);
  const request = refreshed.snapshot.joinRequests.find((item) => item.status === 'pending');
  assert.ok(request);
  assert.equal((await lead.post(`/api/interviews/${id}/join-requests/${request.id}/approve`, {})).status, 200);
  assert.equal((await co.post('/api/join-requests/me/enter', {})).status, 200);
  assert.equal((await snapshot(co, id)).snapshot.viewer.name, '示例副考官');
  const md = await lead.get(`/api/interviews/${id}/report.md`);
  assert.match(md.data, /评估中/);
});

test('便签、讨论引用与删除后的历史摘要保持稳定', async () => {
  const { id, lead, co } = await bootstrapInterview(server);
  const noteResult = await createNote(lead, id, '被引用的重要便签', { important: true, needsDiscussion: true });
  assert.equal(noteResult.status, 'ok');
  const noteId = noteResult.data.id;

  const coSnap = await snapshot(co, id);
  const movedGroup = coSnap.snapshot.groups[1].id;
  const moved = await co.post(`/api/interviews/${id}/operations`, {
    ops: [{ opId: opId('note'), type: 'note.move', round: 1, payload: { noteId, groupId: movedGroup } }],
  });
  assert.equal(moved.data.results[0].status, 'ok');

  const message = await co.post(`/api/interviews/${id}/operations`, {
    ops: [
      {
        opId: opId('msg'),
        type: 'message.create',
        round: 1,
        payload: { messageId: crypto.randomUUID(), body: '引用这条便签展开讨论', noteId },
      },
    ],
  });
  assert.equal(message.data.results[0].status, 'ok');
  const messageId = message.data.results[0].data.id;

  const reply = await lead.post(`/api/interviews/${id}/operations`, {
    ops: [
      {
        opId: opId('msg'),
        type: 'message.create',
        round: 1,
        payload: { messageId: crypto.randomUUID(), body: '收到，我补充一个追问', replyTo: messageId },
      },
    ],
  });
  assert.equal(reply.data.results[0].status, 'ok');
  assert.ok(reply.data.results[0].data.replyExcerpt.includes('引用这条便签'));

  const beforeDelete = await snapshot(co, id);
  const note = beforeDelete.snapshot.notes.find((item) => item.id === noteId);
  const deleted = await lead.post(`/api/interviews/${id}/operations`, {
    ops: [{ opId: opId('note'), type: 'note.delete', round: 1, payload: { noteId, version: note.version } }],
  });
  assert.equal(deleted.data.results[0].status, 'ok');

  const afterDelete = await snapshot(co, id);
  assert.equal(afterDelete.snapshot.notes.some((item) => item.id === noteId), false);
  const historicalMessage = afterDelete.snapshot.messages.find((item) => item.id === messageId);
  assert.ok(historicalMessage);
  assert.equal(historicalMessage.noteDeleted, true);
  assert.ok(historicalMessage.noteExcerpt.includes('被引用的重要便签'));

  const quoteDeleted = await co.post(`/api/interviews/${id}/operations`, {
    ops: [
      {
        opId: opId('msg'),
        type: 'message.create',
        round: 1,
        payload: { messageId: crypto.randomUUID(), body: '引用已删除便签的待发消息', noteId },
      },
    ],
  });
  assert.equal(quoteDeleted.data.results[0].status, 'ok');
  assert.equal(quoteDeleted.data.results[0].data.noteId, null);
  assert.equal(quoteDeleted.data.results[0].data.noteExcerpt, '原便签已删除');
  assert.equal(quoteDeleted.data.results[0].warnings[0].code, 'quote_missing');
});

test('分组新增、改名、删除与“未分类”保护', async () => {
  const { id, lead, co } = await bootstrapInterview(server);
  const added = await lead.post(`/api/interviews/${id}/operations`, {
    ops: [
      {
        opId: opId('group'),
        type: 'group.create',
        round: 1,
        payload: { groupId: crypto.randomUUID(), name: '临时分组' },
      },
    ],
  });
  assert.equal(added.data.results[0].status, 'ok');
  const groupId = added.data.results[0].data.id;
  const note = await createNote(co, id, '放入临时分组的便签', { groupId });
  assert.equal(note.status, 'ok');
  assert.equal(note.data.groupId, groupId);

  const duplicate = await co.post(`/api/interviews/${id}/operations`, {
    ops: [{ opId: opId('group'), type: 'group.create', round: 1, payload: { groupId: crypto.randomUUID(), name: '临时分组' } }],
  });
  assert.equal(duplicate.data.results[0].status, 'conflict');
  assert.equal(duplicate.data.results[0].reason, 'group_exists');

  const renamed = await co.post(`/api/interviews/${id}/operations`, {
    ops: [{ opId: opId('group'), type: 'group.rename', round: 1, payload: { groupId, name: '追问清单' } }],
  });
  assert.equal(renamed.data.results[0].status, 'ok');
  const snapAfterRename = await snapshot(lead, id);
  assert.equal(snapAfterRename.snapshot.notes.find((item) => item.id === note.data.id).groupName, '追问清单');

  const removed = await co.post(`/api/interviews/${id}/operations`, {
    ops: [{ opId: opId('group'), type: 'group.delete', round: 1, payload: { groupId } }],
  });
  assert.equal(removed.data.results[0].status, 'ok');
  assert.ok(removed.data.results[0].data.movedCount >= 1);
  const snapAfterDelete = await snapshot(lead, id);
  const systemGroup = snapAfterDelete.snapshot.groups.find((group) => group.isSystem);
  assert.equal(snapAfterDelete.snapshot.notes.find((item) => item.id === note.data.id).groupId, systemGroup.id);
  assert.equal(snapAfterDelete.snapshot.notes.find((item) => item.id === note.data.id).groupName, '未分类');

  const deleteSystem = await lead.post(`/api/interviews/${id}/operations`, {
    ops: [{ opId: opId('group'), type: 'group.delete', round: 1, payload: { groupId: systemGroup.id } }],
  });
  assert.equal(deleteSystem.data.results[0].status, 'forbidden');
  assert.equal(deleteSystem.data.results[0].reason, 'system_group');

  const renameSystem = await lead.post(`/api/interviews/${id}/operations`, {
    ops: [{ opId: opId('group'), type: 'group.rename', round: 1, payload: { groupId: systemGroup.id, name: '改名失败' } }],
  });
  assert.equal(renameSystem.data.results[0].status, 'forbidden');
});

test('面试人准备状态同步到考官端且不披露结论', async () => {
  const { id, lead, co, candidate } = await bootstrapInterview(server);
  assert.equal((await candidate.post(`/api/interviews/${id}/ready`, { ready: true })).status, 200);
  const leadSnap = await snapshot(lead, id);
  const candidateRow = leadSnap.snapshot.participants.find((participant) => participant.role === 'candidate');
  assert.equal(candidateRow.ready, true);
  assert.ok(candidateRow.readyAt);
  const candidateSnap = await snapshot(candidate, id);
  assert.equal(candidateSnap.snapshot.ready, true);

  await submitEvaluation(lead, id, 'yes', '推荐');
  await submitEvaluation(co, id, 'yes', '推荐');
  const completed = await lead.post(`/api/interviews/${id}/complete`, { finalLevel: 'yes', reason: '一致推荐' });
  assert.equal(completed.status, 200);
  const finalCandidateSnap = await snapshot(candidate, id);
  assert.equal(finalCandidateSnap.snapshot.interview.status, 'completed');
  const raw = JSON.stringify(finalCandidateSnap.snapshot);
  assert.equal(raw.includes('一致推荐'), false);
  assert.equal(raw.includes('finalLevel'), false);
  assert.equal(raw.includes('decisions'), false);
});
