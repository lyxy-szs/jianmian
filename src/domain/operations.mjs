import { appendEvent, newId, nowIso, tx } from '../db/index.mjs';
import { LIMITS } from '../config.mjs';
import { forbidden } from './errors.mjs';
import { uncategorizedGroup } from './interviews.mjs';

const STATUS = Object.freeze({
  OK: 'ok',
  DUPLICATE: 'duplicate',
  CONFLICT: 'conflict',
  FORBIDDEN: 'forbidden',
  INVALID: 'invalid',
});

function fail(status, reason, message, extra = {}) {
  return { status, reason, message, ...extra };
}

function conflictResult(reason, message, current) {
  return { status: STATUS.CONFLICT, reason, message, current };
}

function invalidResult(message, reason = 'invalid_input') {
  return { status: STATUS.INVALID, reason, message };
}

function cleanText(value, max, label) {
  const text = String(value ?? '').trim();
  if (!text) return { error: invalidResult(`${label}不能为空。`, 'empty_body') };
  if (text.length > max) return { error: invalidResult(`${label}不能超过 ${max} 个字符。`, 'body_too_long') };
  return { text };
}

function touch(db, interviewId, now) {
  db.prepare('UPDATE interviews SET revision = revision + 1, updated_at = ? WHERE id = ?').run(now, interviewId);
}

/** 首次写入把面试板从 open 推进到 evaluating，并向面试人推送公开状态。 */
function ensureEvaluating(db, interview, now) {
  if (interview.status !== 'open') return [];
  db.prepare(`UPDATE interviews SET status = 'evaluating', revision = revision + 1, updated_at = ? WHERE id = ?`).run(
    now,
    interview.id,
  );
  interview.status = 'evaluating';
  return [
    appendEvent(db, {
      interviewId: interview.id,
      scope: 'internal',
      type: 'status_changed',
      payload: { status: 'evaluating', round: interview.round },
      at: now,
    }),
    appendEvent(db, {
      interviewId: interview.id,
      scope: 'candidate',
      type: 'status_changed',
      payload: { status: 'evaluating' },
      at: now,
    }),
  ];
}

function noteView(row, groupsById) {
  const group = groupsById.get(row.group_id);
  return {
    id: row.id,
    round: row.round,
    body: row.body,
    groupId: row.group_id,
    groupName: group?.name ?? '未分类',
    authorId: row.author_id,
    authorGeneration: row.author_generation,
    authorName: row.author_name,
    important: Boolean(row.important),
    needsDiscussion: Boolean(row.needs_discussion),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMovedBy: row.last_moved_by,
    lastMovedAt: row.last_moved_at,
  };
}

function loadGroups(db, interviewId) {
  return new Map(
    db
      .prepare('SELECT * FROM groups WHERE interview_id = ?')
      .all(interviewId)
      .map((row) => [row.id, { ...row }]),
  );
}

function activeGroup(db, interviewId, groupId) {
  if (!groupId || typeof groupId !== 'string') return null;
  const row = db
    .prepare('SELECT * FROM groups WHERE id = ? AND interview_id = ? AND deleted_at IS NULL')
    .get(groupId, interviewId);
  return row ? { ...row } : null;
}

function nextSortOrder(db, table, whereSql, params) {
  const row = db.prepare(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM ${table} WHERE ${whereSql}`).get(...params);
  return Number(row?.next ?? 1);
}

/**
 * 副考官席位可能被重新邀请给新的人，因此作者校验包含会话代次；
 * 主考官只有“恢复入口”（同一人找回身份），不改变其对历史便签的作者关系。
 */
function isNoteAuthor(note, participant) {
  if (note.author_id !== participant.id) return false;
  if (participant.role === 'lead') return true;
  return Number(note.author_generation ?? 0) === Number(participant.generation);
}

function getNoteRow(db, interviewId, noteId) {
  if (!noteId || typeof noteId !== 'string' || noteId.length > 100) return null;
  const row = db.prepare('SELECT * FROM notes WHERE id = ? AND interview_id = ?').get(noteId, interviewId);
  return row ? { ...row } : null;
}

function noteIdFrom(payload, warnings, prefix = 'note') {
  if (payload.noteId != null) {
    if (typeof payload.noteId !== 'string' || payload.noteId.length < 8 || payload.noteId.length > 100) {
      return { error: invalidResult('便签 ID 格式无效。', 'invalid_note_id') };
    }
    return { id: payload.noteId };
  }
  warnings.push({ code: 'client_id_missing', message: '客户端未提供便签 ID，已由服务端生成。' });
  return { id: `${prefix}-${newId()}` };
}

/**
 * 单条操作的核心处理；调用方负责事务、幂等记录和事件推送。
 * 返回 { result, events }，result.status 为 ok/conflict/forbidden/invalid。
 */
export function applyOperation({ db, interview, participant, role, op, now = nowIso() }) {
  const warnings = [];
  const events = [];
  const payload = op.payload && typeof op.payload === 'object' && !Array.isArray(op.payload) ? op.payload : {};

  if (interview.status === 'completed') {
    return {
      result: fail(STATUS.FORBIDDEN, 'board_completed', '本次面试已完成并只读，未同步的操作已保留为本地草稿。'),
      events,
    };
  }

  if (op.round != null && Number(op.round) !== interview.round) {
    return {
      result: fail(
        STATUS.CONFLICT,
        'stale_round',
        `该操作属于第 ${op.round} 轮，当前为第 ${interview.round} 轮，未写入并保留为草稿。`,
      ),
      events,
    };
  }

  const type = op.type;
  const revision = Number.isFinite(op.baseRevision) ? Number(op.baseRevision) : null;
  if (revision != null && revision < 1) {
    return { result: invalidResult('基准版本无效。', 'invalid_revision'), events };
  }

  switch (type) {
    case 'note.create': {
      const createdId = noteIdFrom(payload, warnings);
      if (createdId.error) return { result: createdId.error, events };
      const noteId = createdId.id;
      const text = cleanText(payload.body, LIMITS.noteBody, '便签正文');
      if (text.error) return { result: text.error, events };
      if (getNoteRow(db, interview.id, noteId)) {
        return {
          result: conflictResult('note_exists', '便签 ID 已存在，未重复创建。', null),
          events,
        };
      }
      events.push(...ensureEvaluating(db, interview, now));
      let group = activeGroup(db, interview.id, payload.groupId);
      let warning;
      if (!group) {
        group = uncategorizedGroup(db, interview.id);
        if (payload.groupId) {
          warning = {
            code: 'group_missing',
            message: '目标分组不存在或已删除，便签已放入“未分类”。',
          };
          warnings.push(warning);
        }
      }
      const sortOrder = nextSortOrder(db, 'notes', 'interview_id = ? AND group_id = ? AND deleted_at IS NULL', [
        interview.id,
        group.id,
      ]);
      db.prepare(
        `INSERT INTO notes (id, interview_id, round, author_id, author_generation, author_name, body, group_id, sort_order,
          important, needs_discussion, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(
        noteId,
        interview.id,
        interview.round,
        participant.id,
        participant.generation,
        participant.name ?? '',
        text.text,
        group.id,
        sortOrder,
        payload.important ? 1 : 0,
        payload.needsDiscussion ? 1 : 0,
        now,
        now,
      );
      const row = getNoteRow(db, interview.id, noteId);
      touch(db, interview.id, now);
      events.push(
        appendEvent(db, {
          interviewId: interview.id,
          scope: 'internal',
          type: 'note_created',
          payload: { noteId, groupId: group.id, authorId: participant.id },
          at: now,
        }),
      );
      return {
        result: {
          status: STATUS.OK,
          data: noteView(row, loadGroups(db, interview.id)),
          warnings,
        },
        events,
      };
    }

    case 'note.update': {
      const note = getNoteRow(db, interview.id, payload.noteId);
      const groups = loadGroups(db, interview.id);
      if (!note || note.deleted_at) {
        return {
          result: conflictResult('note_deleted', '便签已被删除，正文已保留为本地草稿。', null),
          events,
        };
      }
      if (!isNoteAuthor(note, participant)) {
        return {
          result: fail(STATUS.FORBIDDEN, 'not_author', '只能修改自己创建的便签。'),
          events,
        };
      }
      if (payload.version != null && Number(payload.version) !== note.version) {
        return {
          result: conflictResult('version_conflict', '便签已被其他窗口修改，本地正文已保留为草稿。', {
            ...noteView(note, groups),
          }),
          events,
        };
      }
      const text = cleanText(payload.body, LIMITS.noteBody, '便签正文');
      if (text.error) return { result: text.error, events };
      events.push(...ensureEvaluating(db, interview, now));
      db.prepare('UPDATE notes SET body = ?, version = version + 1, updated_at = ? WHERE id = ?').run(
        text.text,
        now,
        note.id,
      );
      const updated = getNoteRow(db, interview.id, note.id);
      touch(db, interview.id, now);
      events.push(
        appendEvent(db, {
          interviewId: interview.id,
          scope: 'internal',
          type: 'note_updated',
          payload: { noteId: note.id, authorId: participant.id, version: updated.version },
          at: now,
        }),
      );
      return { result: { status: STATUS.OK, data: noteView(updated, groups), warnings }, events };
    }

    case 'note.delete': {
      const note = getNoteRow(db, interview.id, payload.noteId);
      const groups = loadGroups(db, interview.id);
      if (!note || note.deleted_at) {
        return { result: conflictResult('note_deleted', '便签已被删除。', null), events };
      }
      if (!isNoteAuthor(note, participant)) {
        return { result: fail(STATUS.FORBIDDEN, 'not_author', '只能删除自己创建的便签。'), events };
      }
      if (payload.version != null && Number(payload.version) !== note.version) {
        return {
          result: conflictResult('version_conflict', '便签已被修改，请刷新后再删除。', noteView(note, groups)),
          events,
        };
      }
      events.push(...ensureEvaluating(db, interview, now));
      db.prepare('UPDATE notes SET deleted_at = ?, deleted_by = ?, version = version + 1 WHERE id = ?').run(
        now,
        participant.id,
        note.id,
      );
      touch(db, interview.id, now);
      events.push(
        appendEvent(db, {
          interviewId: interview.id,
          scope: 'internal',
          type: 'note_deleted',
          payload: { noteId: note.id, authorId: participant.id },
          at: now,
        }),
      );
      return { result: { status: STATUS.OK, data: { id: note.id, deleted: true }, warnings }, events };
    }

    case 'note.move': {
      const note = getNoteRow(db, interview.id, payload.noteId);
      const groups = loadGroups(db, interview.id);
      if (!note || note.deleted_at) {
        return {
          result: conflictResult('note_deleted', '便签已被删除，未执行移动，操作说明已保留为本地草稿。', null),
          events,
        };
      }
      let group = activeGroup(db, interview.id, payload.groupId);
      if (!group) {
        group = uncategorizedGroup(db, interview.id);
        warnings.push({
          code: 'group_missing',
          message: '目标分组不存在或已删除，便签已放入“未分类”。',
        });
      }
      events.push(...ensureEvaluating(db, interview, now));
      const sortOrder = nextSortOrder(db, 'notes', 'interview_id = ? AND group_id = ? AND deleted_at IS NULL', [
        interview.id,
        group.id,
      ]);
      db.prepare(
        `UPDATE notes SET group_id = ?, sort_order = ?, last_moved_by = ?, last_moved_at = ?,
           version = version + 1, updated_at = ? WHERE id = ?`,
      ).run(group.id, sortOrder, participant.name ?? '', now, now, note.id);
      const updated = getNoteRow(db, interview.id, note.id);
      touch(db, interview.id, now);
      events.push(
        appendEvent(db, {
          interviewId: interview.id,
          scope: 'internal',
          type: 'note_moved',
          payload: { noteId: note.id, groupId: group.id, movedBy: participant.name ?? '' },
          at: now,
        }),
      );
      return { result: { status: STATUS.OK, data: noteView(updated, groups), warnings }, events };
    }

    case 'note.flags': {
      const note = getNoteRow(db, interview.id, payload.noteId);
      const groups = loadGroups(db, interview.id);
      if (!note || note.deleted_at) {
        return { result: conflictResult('note_deleted', '便签已被删除。', null), events };
      }
      if (!isNoteAuthor(note, participant)) {
        return { result: fail(STATUS.FORBIDDEN, 'not_author', '标记也属于作者编辑权限。'), events };
      }
      if (payload.version != null && Number(payload.version) !== note.version) {
        return {
          result: conflictResult('version_conflict', '便签已被修改，标记未写入。', noteView(note, groups)),
          events,
        };
      }
      const important = payload.important == null ? Boolean(note.important) : Boolean(payload.important);
      const needsDiscussion =
        payload.needsDiscussion == null ? Boolean(note.needs_discussion) : Boolean(payload.needsDiscussion);
      events.push(...ensureEvaluating(db, interview, now));
      db.prepare(
        'UPDATE notes SET important = ?, needs_discussion = ?, version = version + 1, updated_at = ? WHERE id = ?',
      ).run(important ? 1 : 0, needsDiscussion ? 1 : 0, now, note.id);
      const updated = getNoteRow(db, interview.id, note.id);
      touch(db, interview.id, now);
      events.push(
        appendEvent(db, {
          interviewId: interview.id,
          scope: 'internal',
          type: 'note_flags_changed',
          payload: { noteId: note.id, important, needsDiscussion },
          at: now,
        }),
      );
      return { result: { status: STATUS.OK, data: noteView(updated, groups), warnings }, events };
    }

    case 'group.create': {
      const name = String(payload.name ?? '').trim();
      if (!name) return { result: invalidResult('分组名称不能为空。', 'empty_group_name'), events };
      if (name.length > LIMITS.groupName) {
        return { result: invalidResult(`分组名称不能超过 ${LIMITS.groupName} 个字符。`, 'group_name_too_long'), events };
      }
      let id = newId();
      if (payload.groupId != null) {
        if (typeof payload.groupId !== 'string' || payload.groupId.length < 8 || payload.groupId.length > 100) {
          return { result: invalidResult('分组 ID 格式无效。', 'invalid_group_id'), events };
        }
        id = payload.groupId;
      }
      const existing = db
        .prepare('SELECT * FROM groups WHERE interview_id = ? AND deleted_at IS NULL AND name = ?')
        .get(interview.id, name);
      if (existing) {
        return { result: conflictResult('group_exists', '已存在同名分组。', { id: existing.id, name: existing.name }), events };
      }
      events.push(...ensureEvaluating(db, interview, now));
      const sortOrder = nextSortOrder(db, 'groups', 'interview_id = ? AND deleted_at IS NULL', [interview.id]);
      db.prepare(
        'INSERT INTO groups (id, interview_id, name, sort_order, is_system, created_at) VALUES (?, ?, ?, ?, 0, ?)',
      ).run(id, interview.id, name, sortOrder, now);
      touch(db, interview.id, now);
      events.push(
        appendEvent(db, {
          interviewId: interview.id,
          scope: 'internal',
          type: 'group_created',
          payload: { groupId: id, name },
          at: now,
        }),
      );
      return {
        result: { status: STATUS.OK, data: { id, name, sortOrder, isSystem: false }, warnings },
        events,
      };
    }

    case 'group.rename': {
      const groupId = payload.groupId;
      const group = groupId ? db.prepare('SELECT * FROM groups WHERE id = ? AND interview_id = ?').get(groupId, interview.id) : null;
      if (!group || group.deleted_at) {
        return { result: conflictResult('group_deleted', '分组已被删除。', null), events };
      }
      if (group.is_system) return { result: fail(STATUS.FORBIDDEN, 'system_group', '“未分类”系统分组不可改名。'), events };
      const name = String(payload.name ?? '').trim();
      if (!name) return { result: invalidResult('分组名称不能为空。', 'empty_group_name'), events };
      if (name.length > LIMITS.groupName) {
        return { result: invalidResult(`分组名称不能超过 ${LIMITS.groupName} 个字符。`, 'group_name_too_long'), events };
      }
      const duplicate = db
        .prepare('SELECT id FROM groups WHERE interview_id = ? AND deleted_at IS NULL AND name = ? AND id <> ?')
        .get(interview.id, name, group.id);
      if (duplicate) {
        return { result: conflictResult('group_exists', '已存在同名分组。', { id: duplicate.id }), events };
      }
      events.push(...ensureEvaluating(db, interview, now));
      db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(name, group.id);
      touch(db, interview.id, now);
      events.push(
        appendEvent(db, {
          interviewId: interview.id,
          scope: 'internal',
          type: 'group_renamed',
          payload: { groupId: group.id, name },
          at: now,
        }),
      );
      return { result: { status: STATUS.OK, data: { id: group.id, name }, warnings }, events };
    }

    case 'group.delete': {
      const group = payload.groupId
        ? db.prepare('SELECT * FROM groups WHERE id = ? AND interview_id = ?').get(payload.groupId, interview.id)
        : null;
      if (!group || group.deleted_at) {
        return { result: conflictResult('group_deleted', '分组已被删除。', null), events };
      }
      if (group.is_system) return { result: fail(STATUS.FORBIDDEN, 'system_group', '“未分类”系统分组不可删除。'), events };
      const fallback = uncategorizedGroup(db, interview.id);
      events.push(...ensureEvaluating(db, interview, now));
      db.prepare('UPDATE groups SET deleted_at = ? WHERE id = ?').run(now, group.id);
      const moved = db
        .prepare(
          `UPDATE notes SET group_id = ?, version = version + 1, updated_at = ?, last_moved_by = ?, last_moved_at = ?
           WHERE interview_id = ? AND group_id = ? AND deleted_at IS NULL`,
        )
        .run(fallback.id, now, participant.name ?? '', now, interview.id, group.id);
      touch(db, interview.id, now);
      events.push(
        appendEvent(db, {
          interviewId: interview.id,
          scope: 'internal',
          type: 'group_deleted',
          payload: { groupId: group.id, name: group.name, movedTo: fallback.id, movedCount: moved.changes },
          at: now,
        }),
      );
      return {
        result: {
          status: STATUS.OK,
          data: { id: group.id, deleted: true, movedTo: fallback.id, movedCount: moved.changes },
          warnings,
        },
        events,
      };
    }

    case 'message.create': {
      let messageId = payload.messageId;
      if (messageId == null) {
        messageId = `msg-${newId()}`;
        warnings.push({ code: 'client_id_missing', message: '客户端未提供消息 ID，已由服务端生成。' });
      } else if (typeof messageId !== 'string' || messageId.length < 8 || messageId.length > 100) {
        return { result: invalidResult('消息 ID 格式无效。', 'invalid_message_id'), events };
      }
      const text = cleanText(payload.body, LIMITS.messageBody, '讨论消息');
      if (text.error) return { result: text.error, events };
      if (db.prepare('SELECT id FROM messages WHERE id = ?').get(messageId)) {
        return { result: conflictResult('message_exists', '消息 ID 已存在，未重复发送。', null), events };
      }
      let replyTo = null;
      let replyExcerpt = null;
      if (payload.replyTo) {
        const parent = db
          .prepare('SELECT * FROM messages WHERE id = ? AND interview_id = ?')
          .get(payload.replyTo, interview.id);
        if (!parent) {
          return {
            result: conflictResult('reply_missing', '被回复的消息不存在，消息未发送，正文已保留为本地草稿。', null),
            events,
          };
        }
        replyTo = parent.id;
        replyExcerpt = parent.body.length > 120 ? `${parent.body.slice(0, 120)}…` : parent.body;
      }
      let noteId = null;
      let noteExcerpt = null;
      if (payload.noteId) {
        const note = getNoteRow(db, interview.id, payload.noteId);
        if (note && !note.deleted_at) {
          noteId = note.id;
          noteExcerpt = note.body.length > 120 ? `${note.body.slice(0, 120)}…` : note.body;
        } else {
          noteExcerpt = '原便签已删除';
          warnings.push({ code: 'quote_missing', message: '引用的便签已删除，消息已保留正文并标注引用失效。' });
        }
      }
      events.push(...ensureEvaluating(db, interview, now));
      db.prepare(
        `INSERT INTO messages (id, interview_id, round, author_id, author_generation, author_name, body, reply_to, reply_excerpt,
          note_id, note_excerpt, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        messageId,
        interview.id,
        interview.round,
        participant.id,
        participant.generation,
        participant.name ?? '',
        text.text,
        replyTo,
        replyExcerpt,
        noteId,
        noteExcerpt,
        now,
      );
      touch(db, interview.id, now);
      events.push(
        appendEvent(db, {
          interviewId: interview.id,
          scope: 'internal',
          type: 'message_created',
          payload: { messageId, authorId: participant.id },
          at: now,
        }),
      );
      return {
        result: {
          status: STATUS.OK,
          data: {
            id: messageId,
            body: text.text,
            authorId: participant.id,
            authorName: participant.name ?? '',
            replyTo,
            replyExcerpt,
            noteId,
            noteExcerpt,
            createdAt: now,
            round: interview.round,
          },
          warnings,
        },
        events,
      };
    }

    default:
      return { result: invalidResult(`未知操作类型：${String(type).slice(0, 40)}`, 'unknown_operation'), events };
  }
}

/** 幂等执行：同一席位重复提交同一 opId 只返回第一次的结果。 */
export function runOperation({ db, interview, participant, role, op, now = nowIso() }) {
  return tx(db, () => {
    const existing = db
      .prepare('SELECT result FROM applied_operations WHERE participant_id = ? AND op_id = ?')
      .get(participant.id, op.opId);
    if (existing) {
      return {
        result: { ...JSON.parse(existing.result), status: STATUS.DUPLICATE },
        events: [],
      };
    }
    const { result, events } = applyOperation({ db, interview, participant, role, op, now });
    const stored = { ...result, opId: op.opId, type: op.type };
    db.prepare(
      'INSERT INTO applied_operations (participant_id, op_id, result, created_at) VALUES (?, ?, ?, ?)',
    ).run(participant.id, op.opId, JSON.stringify(stored), now);
    return { result: { ...stored }, events };
  });
}

export { STATUS as OPERATION_STATUS };
