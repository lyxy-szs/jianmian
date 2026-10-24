import { getEvaluations } from './evaluations.mjs';

const STATUS_LABELS = Object.freeze({ open: '进行中', evaluating: '评估中', completed: '已完成' });

function latestSeq(db, interviewId, scope) {
  const row = db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE interview_id = ? AND scope = ?')
    .get(interviewId, scope);
  return Number(row?.seq ?? 0);
}

function internalParticipantViews(db, interviewId, onlineRoles) {
  return db
    .prepare('SELECT * FROM participants WHERE interview_id = ?')
    .all(interviewId)
    .map((row) => ({
      id: row.id,
      role: row.role,
      name: row.name ?? '',
      claimed: Boolean(row.claimed_at),
      ready: Boolean(row.ready),
      readyAt: row.ready_at,
      online: onlineRoles ? onlineRoles.has(row.role) : false,
      generation: row.generation,
    }));
}

function noteViews(db, interviewId) {
  const groups = db
    .prepare('SELECT * FROM groups WHERE interview_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at')
    .all(interviewId)
    .map((row) => ({ ...row }));
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const notes = db
    .prepare(
      `SELECT * FROM notes WHERE interview_id = ? AND deleted_at IS NULL
       ORDER BY group_id, sort_order, created_at`,
    )
    .all(interviewId)
    .map((row) => ({
      id: row.id,
      round: row.round,
      body: row.body,
      groupId: row.group_id,
      groupName: groupById.get(row.group_id)?.name ?? '未分类',
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
    }));
  return { groups: groups.map((group) => ({
    id: group.id,
    name: group.name,
    sortOrder: group.sort_order,
    isSystem: Boolean(group.is_system),
  })), notes };
}

function messageViews(db, interviewId) {
  const deletedNoteIds = new Set(
    db
      .prepare('SELECT id FROM notes WHERE interview_id = ? AND deleted_at IS NOT NULL')
      .all(interviewId)
      .map((row) => row.id),
  );
  return db
    .prepare('SELECT * FROM messages WHERE interview_id = ? ORDER BY created_at, rowid')
    .all(interviewId)
    .map((row) => ({
      id: row.id,
      round: row.round,
      body: row.body,
      authorId: row.author_id,
      authorGeneration: row.author_generation,
      authorName: row.author_name,
      replyTo: row.reply_to,
      replyExcerpt: row.reply_excerpt,
      noteId: row.note_id,
      noteExcerpt: row.note_excerpt,
      noteDeleted: Boolean(row.note_id && deletedNoteIds.has(row.note_id)),
      createdAt: row.created_at,
    }));
}

function inviteViews(db, secrets, interviewId, now) {
  const rows = db
    .prepare(
      `SELECT * FROM invitations
       WHERE interview_id = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?
       ORDER BY created_at`,
    )
    .all(interviewId, now);
  return rows
    .map((row) => {
      const token = secrets.getInvitation(row.id);
      return token
        ? { id: row.id, role: row.role, url: `/join/${token}`, expiresAt: row.expires_at }
        : null;
    })
    .filter(Boolean);
}

/** 考官视角快照：包含内部资料、全部便签、讨论与双方评价。 */
export function buildInternalSnapshot({ db, auth, secrets, onlineRoles, now = new Date().toISOString() }) {
  const { interview, participant, role } = auth;
  const { groups, notes } = noteViews(db, interview.id);
  const evaluations = getEvaluations(db, interview.id, interview.round);
  const participantRows = internalParticipantViews(db, interview.id, onlineRoles);
  const roleById = new Map(participantRows.map((p) => [p.id, p]));
  const evaluationsByRole = { lead: null, co: null };
  for (const evaluation of evaluations) {
    const seatRole = roleById.get(evaluation.evaluatorId)?.role;
    if (seatRole) evaluationsByRole[seatRole] = evaluation;
  }
  const canEdit = interview.status !== 'completed';

  const snapshot = {
    viewer: {
      participantId: participant.id,
      role,
      name: participant.name ?? '',
      generation: participant.generation,
      sessionCreatedAt: auth.session.created_at,
    },
    interview: {
      id: interview.id,
      candidateName: interview.candidate_name,
      position: interview.position,
      internalBrief: interview.internal_brief,
      internalFocus: interview.internal_focus,
      publicBrief: interview.public_brief,
      status: interview.status,
      statusLabel: STATUS_LABELS[interview.status] ?? interview.status,
      round: interview.round,
      revision: interview.revision,
      createdAt: interview.created_at,
      completedAt: interview.completed_at,
    },
    participants: participantRows,
    groups,
    notes,
    messages: messageViews(db, interview.id),
    evaluations: {
      lead: evaluationsByRole.lead,
      co: evaluationsByRole.co,
    },
    decisions: db
      .prepare('SELECT * FROM decisions WHERE interview_id = ? ORDER BY round DESC')
      .all(interview.id)
      .map((row) => ({
        id: row.id,
        round: row.round,
        finalLevel: row.final_level,
        reason: row.reason,
        divergenceNote: row.divergence_note,
        decidedByName: row.decided_by_name,
        decidedAt: row.decided_at,
      })),
    joinRequests:
      role === 'lead'
        ? db
            .prepare('SELECT * FROM join_requests WHERE interview_id = ? ORDER BY created_at DESC LIMIT 50')
            .all(interview.id)
            .map((row) => ({
              id: row.id,
              name: row.name,
              status: row.status,
              createdAt: row.created_at,
              decidedAt: row.decided_at,
            }))
        : [],
    invites: role === 'lead' ? inviteViews(db, secrets, interview.id, now) : [],
    online: Object.fromEntries(participantRows.map((p) => [p.role, p.online])),
    permissions: {
      canEditNotes: canEdit,
      canMoveNotes: canEdit,
      canManageGroups: canEdit,
      canDiscuss: canEdit,
      canEvaluate: canEdit,
      canReviewRequests: role === 'lead' && canEdit,
      canManageInvites: role === 'lead',
      canConfirm: role === 'lead' && canEdit,
      canReopen: role === 'lead' && interview.status === 'completed',
      readOnly: !canEdit,
    },
    eventCursor: latestSeq(db, interview.id, 'internal'),
    serverTime: now,
  };
  return snapshot;
}

/** 面试人视角：仅公开字段与本人准备状态，绝不包含内部便签或评价。 */
export function buildCandidateSnapshot({ db, auth, onlineRoles, now = new Date().toISOString() }) {
  const { interview, participant } = auth;
  return {
    viewer: {
      participantId: participant.id,
      role: 'candidate',
      name: participant.name ?? '',
      generation: participant.generation,
    },
    interview: {
      id: interview.id,
      candidateName: interview.candidate_name,
      position: interview.position,
      publicBrief: interview.public_brief,
      status: interview.status,
      statusLabel: STATUS_LABELS[interview.status] ?? interview.status,
      round: interview.round,
    },
    ready: Boolean(participant.ready),
    readyAt: participant.ready_at,
    connected: onlineRoles ? onlineRoles.size > 0 : true,
    eventCursor: latestSeq(db, interview.id, 'candidate'),
    serverTime: now,
  };
}
