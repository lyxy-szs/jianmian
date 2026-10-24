import { appendEvent, newId, nowIso, plain, tx } from '../db/index.mjs';
import { DEFAULT_GROUPS } from '../db/schema.mjs';
import { LIMITS } from '../config.mjs';
import { badRequest } from './errors.mjs';
import { issueInvitation } from './auth.mjs';
import { LEVELS } from './levels.mjs';

export { LEVELS };

function requiredText(value, label, max) {
  const text = String(value ?? '').trim();
  if (!text) throw badRequest(`${label}不能为空。`, 'field_required');
  if (text.length > max) throw badRequest(`${label}不能超过 ${max} 个字符。`, 'field_too_long');
  return text;
}

function optionalText(value, label, max) {
  const text = String(value ?? '').trim();
  if (text.length > max) throw badRequest(`${label}不能超过 ${max} 个字符。`, 'field_too_long');
  return text;
}

export function normalizeInterviewFields(input = {}) {
  return {
    candidateName: requiredText(input.candidateName, '候选人姓名', LIMITS.name),
    position: requiredText(input.position, '应聘岗位', LIMITS.position),
    leadName: requiredText(input.leadName, '主考官姓名', LIMITS.name),
    internalBrief: optionalText(input.internalBrief, '候选人简介', LIMITS.brief),
    internalFocus: optionalText(input.internalFocus, '面试重点', LIMITS.brief),
    publicBrief: optionalText(input.publicBrief, '公开面试说明', LIMITS.brief),
  };
}

export const DEMO_FIELDS = Object.freeze({
  candidateName: '林悦',
  position: '高级前端工程师',
  leadName: '陈明',
  internalBrief:
    '7 年 Web 前端经验，近三年负责企业协作产品的编辑器与实时协同模块；简历自述主导过一次协同内核重构。',
  internalFocus:
    '重点验证实时协同与冲突处理的真实深度、复杂问题的拆解方式，以及离开上一家公司的主要原因。',
  publicBrief: '本次面试约 45 分钟，包含项目经历交流与场景设计讨论；请提前 5 分钟确认设备与环境。',
});

function insertDefaultGroups(db, interviewId, now) {
  const insert = db.prepare(
    'INSERT INTO groups (id, interview_id, name, sort_order, is_system, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const groups = {};
  DEFAULT_GROUPS.forEach((group, index) => {
    const id = newId();
    insert.run(id, interviewId, group.name, index, group.isSystem, now);
    groups[group.key] = id;
  });
  return groups;
}

function seedDemoContent(db, interviewId, groups, leadId, now) {
  const noteInsert = db.prepare(
    `INSERT INTO notes (id, interview_id, round, author_id, author_name, body, group_id, sort_order,
      important, needs_discussion, version, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  );
  const seedNotes = [
    {
      group: 'highlight',
      body: '项目经历里负责过实时协作编辑，能清楚解释为什么选择操作变换而不是简单加锁。',
      important: 1,
      discuss: 0,
    },
    {
      group: 'concern',
      body: '离职原因回答得比较笼统，只说“想换环境”，需要继续追问具体触发点。',
      important: 0,
      discuss: 1,
    },
    {
      group: 'verify',
      body: '断线重连后本地队列如何与服务端版本合并？请举一个真实线上问题说明。',
      important: 1,
      discuss: 1,
    },
    {
      group: 'uncategorized',
      body: '表达节奏偏快，后半段回到项目细节后明显更稳。',
      important: 0,
      discuss: 0,
    },
  ];
  const noteIds = [];
  let order = 0;
  for (const note of seedNotes) {
    const id = newId();
    noteInsert.run(
      id,
      interviewId,
      leadId,
      DEMO_FIELDS.leadName,
      note.body,
      groups[note.group],
      order++,
      note.important,
      note.discuss,
      now,
      now,
    );
    noteIds.push(id);
  }

  const messageInsert = db.prepare(
    `INSERT INTO messages (id, interview_id, round, author_id, author_name, body, note_id, note_excerpt, created_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`,
  );
  messageInsert.run(
    newId(),
    interviewId,
    leadId,
    DEMO_FIELDS.leadName,
    '先按简历里的实时协作项目展开，重点追问冲突合并和断线恢复。',
    null,
    null,
    now,
  );
  messageInsert.run(
    newId(),
    interviewId,
    leadId,
    DEMO_FIELDS.leadName,
    '测试覆盖这块问得比较具体，可以顺带确认他平时怎么做回归。',
    noteIds[0],
    seedNotes[0].body,
    now,
  );
}

/**
 * 创建面试。先落库（含席位与默认分组），成功后签发三个角色的邀请链接。
 * 示例数据同样写入 SQLite，走真实读取与后续协作流程，不绕过审核。
 */
export function createInterview({ db, secrets, config, fields, mode = 'blank', now = nowIso() }) {
  const normalized = normalizeInterviewFields(mode === 'demo' ? { ...DEMO_FIELDS, ...fields } : fields);
  const interviewId = newId();

  const created = tx(db, () => {
    db.prepare(
      `INSERT INTO interviews (id, candidate_name, position, internal_brief, internal_focus, public_brief,
        status, revision, round, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
    ).run(
      interviewId,
      normalized.candidateName,
      normalized.position,
      normalized.internalBrief,
      normalized.internalFocus,
      normalized.publicBrief,
      mode === 'demo' ? 'evaluating' : 'open',
      now,
      now,
    );

    const insertParticipant = db.prepare(
      'INSERT INTO participants (id, interview_id, role, name, generation) VALUES (?, ?, ?, ?, 0)',
    );
    const leadId = newId();
    insertParticipant.run(leadId, interviewId, 'lead', normalized.leadName);
    insertParticipant.run(newId(), interviewId, 'co', null);
    insertParticipant.run(newId(), interviewId, 'candidate', normalized.candidateName);

    const groups = insertDefaultGroups(db, interviewId, now);
    if (mode === 'demo') seedDemoContent(db, interviewId, groups, leadId, now);

    appendEvent(db, {
      interviewId,
      scope: 'internal',
      type: 'interview_created',
      payload: { mode, candidateName: normalized.candidateName, position: normalized.position },
      at: now,
    });
    if (mode === 'demo') {
      appendEvent(db, {
        interviewId,
        scope: 'candidate',
        type: 'status_changed',
        payload: { status: 'evaluating', round: 1 },
        at: now,
      });
    }
    return db.prepare('SELECT * FROM interviews WHERE id = ?').get(interviewId);
  });

  const lead = issueInvitation({ db, secrets, config, interviewId, role: 'lead', now });
  const co = issueInvitation({ db, secrets, config, interviewId, role: 'co', now });
  const candidate = issueInvitation({ db, secrets, config, interviewId, role: 'candidate', now });

  return {
    interview: plain(created),
    invitations: { lead, co, candidate },
  };
}

export function getInterview(db, interviewId) {
  const row = db.prepare('SELECT * FROM interviews WHERE id = ?').get(interviewId);
  return row ? { ...row } : null;
}

export function listInterviews(db) {
  return db
    .prepare('SELECT id, candidate_name, position, status, round, created_at, updated_at FROM interviews ORDER BY created_at DESC')
    .all()
    .map((row) => ({
      id: row.id,
      candidateName: row.candidate_name,
      position: row.position,
      status: row.status,
      round: row.round,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
}

export function resolveGroups(db, interviewId) {
  return db
    .prepare('SELECT * FROM groups WHERE interview_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at')
    .all()
    .map((row) => ({ ...row }));
}

export function uncategorizedGroup(db, interviewId) {
  return db
    .prepare('SELECT * FROM groups WHERE interview_id = ? AND is_system = 1 AND deleted_at IS NULL LIMIT 1')
    .get(interviewId);
}
