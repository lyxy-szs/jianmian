import { appendEvent, newId, nowIso, randomToken, sha256, tx } from '../db/index.mjs';
import { badRequest, forbidden, gone, unauthorized } from './errors.mjs';

export const ROLE_LABELS = Object.freeze({ lead: '主考官', co: '副考官', candidate: '面试人' });
export const EXAMINER_ROLES = Object.freeze(['lead', 'co']);

export const isExaminer = (role) => role === 'lead' || role === 'co';

export function invitationPath(role, token) {
  return role === 'candidate' ? `/candidate/join/${token}` : `/join/${token}`;
}

export function invitationUrl(baseUrl, role, token) {
  return `${baseUrl}${invitationPath(role, token)}`;
}

/** 创建会话并返回仅浏览器持有的原始令牌（数据库只存哈希）。 */
export function createSession(db, { participant, ttlMs, now = nowIso() }) {
  const raw = randomToken(32);
  const expiresAt = new Date(Date.parse(now) + ttlMs).toISOString();
  db.prepare(
    `INSERT INTO sessions (id, participant_id, interview_id, role, generation, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(sha256(raw), participant.id, participant.interview_id, participant.role, participant.generation, now, expiresAt);
  return { token: raw, expiresAt, generation: participant.generation };
}

export function revokeParticipantSessions(db, participantId, now = nowIso()) {
  return db
    .prepare('UPDATE sessions SET revoked_at = ? WHERE participant_id = ? AND revoked_at IS NULL')
    .run(now, participantId).changes;
}

export function getParticipantByRole(db, interviewId, role) {
  const row = db.prepare('SELECT * FROM participants WHERE interview_id = ? AND role = ?').get(interviewId, role);
  return row ? { ...row } : null;
}

/**
 * 校验原始会话令牌。返回 null 表示未登录或已失效，
 * 调用方不得据此读取任何面试数据。
 */
export function authenticate(db, rawToken, now = nowIso()) {
  if (!rawToken || typeof rawToken !== 'string' || rawToken.length < 20 || rawToken.length > 200) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sha256(rawToken));
  if (!session) return null;
  if (session.revoked_at) return null;
  if (session.expires_at <= now) return null;
  const participant = db.prepare('SELECT * FROM participants WHERE id = ?').get(session.participant_id);
  if (!participant) return null;
  if (participant.revoked_at) return null;
  if (!participant.claimed_at) return null;
  if (participant.generation !== session.generation) return null;
  const interview = db.prepare('SELECT * FROM interviews WHERE id = ?').get(session.interview_id);
  if (!interview) return null;
  return {
    session: { ...session },
    participant: { ...participant },
    interview: { ...interview },
    role: participant.role,
  };
}

export function requireExaminer(auth) {
  if (!auth) throw unauthorized();
  if (!isExaminer(auth.role)) throw forbidden('面试人身份不能访问内部面试板。');
  return auth;
}

export function requireLead(auth) {
  if (!auth) throw unauthorized();
  if (auth.role !== 'lead') throw forbidden('只有主考官可以执行该操作。');
  return auth;
}

export function requireCandidate(auth) {
  if (!auth) throw unauthorized();
  if (auth.role !== 'candidate') throw forbidden('该接口仅对面试人开放。');
  return auth;
}

export function assertNotCompleted(interview) {
  if (interview.status === 'completed') {
    throw forbidden('本次面试已完成并只读；如需继续请由主考官重新开启。', 'board_completed');
  }
}

/* ------------------------------------------------------------------ */
/* 邀请                                                                 */
/* ------------------------------------------------------------------ */

function revokeOpenInvitations(db, secrets, interviewId, role, now) {
  const rows = db
    .prepare(
      `SELECT id FROM invitations
       WHERE interview_id = ? AND role = ? AND consumed_at IS NULL AND revoked_at IS NULL`,
    )
    .all(interviewId, role);
  if (rows.length) {
    db.prepare(
      `UPDATE invitations SET revoked_at = ?
       WHERE interview_id = ? AND role = ? AND consumed_at IS NULL AND revoked_at IS NULL`,
    ).run(now, interviewId, role);
    for (const row of rows) secrets.removeInvitation(row.id);
  }
}

/** 生成一次性邀请；同一席位的旧邀请立即失效。 */
export function issueInvitation({ db, secrets, config, interviewId, role, now = nowIso() }) {
  const token = randomToken(32);
  const id = newId();
  revokeOpenInvitations(db, secrets, interviewId, role, now);
  const expiresAt = new Date(Date.parse(now) + config.inviteTtlMs).toISOString();
  db.prepare(
    `INSERT INTO invitations (id, interview_id, role, token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, interviewId, role, sha256(token), now, expiresAt);
  secrets.putInvitation(id, token);
  return { id, role, token, url: invitationUrl(config.baseUrl, role, token), expiresAt };
}

export function findInvitation(db, token) {
  if (!token || typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  const row = db.prepare('SELECT * FROM invitations WHERE token_hash = ?').get(sha256(token));
  return row ? { ...row } : null;
}

export function invitationState(invitation, now = nowIso()) {
  if (!invitation) return 'missing';
  if (invitation.consumed_at) return 'consumed';
  if (invitation.revoked_at) return 'revoked';
  if (invitation.expires_at <= now) return 'expired';
  return 'available';
}

export function inspectInvitation(db, token, now = nowIso()) {
  const invitation = findInvitation(db, token);
  const state = invitationState(invitation, now);
  if (!invitation) return { state };
  const interview = db.prepare('SELECT id, candidate_name, position, status FROM interviews WHERE id = ?').get(invitation.interview_id);
  if (!interview) return { state: 'missing' };
  const seat = getParticipantByRole(db, invitation.interview_id, invitation.role);
  return {
    state,
    role: invitation.role,
    expiresAt: invitation.expires_at,
    interview: {
      id: interview.id,
      candidateName: interview.candidate_name,
      position: interview.position,
      status: interview.status,
    },
    seatClaimed: Boolean(seat?.claimed_at),
  };
}

function assertInvitationAvailable(invitation, now) {
  const state = invitationState(invitation, now);
  if (state === 'missing') throw gone('链接无效，请向主考官索取新的邀请链接。', 'invite_missing');
  if (state === 'consumed') throw gone('该链接已被领取，无法再次使用。', 'invite_consumed');
  if (state === 'revoked') throw gone('该链接已被撤销，请使用最新邀请。', 'invite_revoked');
  if (state === 'expired') throw gone('该链接已过期，请让主考官重新邀请。', 'invite_expired');
}

function consumeInvitation(db, secrets, invitation, now) {
  db.prepare('UPDATE invitations SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL').run(now, invitation.id);
  secrets.removeInvitation(invitation.id);
}

/** 主考官 / 面试人：一次性领取固定席位并建立会话。 */
export function claimSeat({ db, secrets, config, token, expectedRole, now = nowIso() }) {
  const invitation = findInvitation(db, token);
  if (!invitation || (expectedRole && invitation.role !== expectedRole)) {
    throw gone('链接无效，请向主考官索取新的邀请链接。', 'invite_missing');
  }
  assertInvitationAvailable(invitation, now);
  return tx(db, () => {
    const fresh = db.prepare('SELECT * FROM invitations WHERE id = ?').get(invitation.id);
    assertInvitationAvailable(fresh, now);
    const participant = getParticipantByRole(db, fresh.interview_id, fresh.role);
    if (!participant) throw gone('席位不存在。', 'seat_missing');
    if (participant.claimed_at) {
      throw gone('该席位已被领取，请让主考官重新邀请。', 'seat_claimed');
    }
    const interview = db.prepare('SELECT * FROM interviews WHERE id = ?').get(fresh.interview_id);
    if (!interview) throw gone('面试不存在。', 'interview_missing');

    revokeParticipantSessions(db, participant.id, now);
    db.prepare('UPDATE participants SET claimed_at = ?, revoked_at = NULL, generation = generation + 1 WHERE id = ?').run(
      now,
      participant.id,
    );
    const updated = db.prepare('SELECT * FROM participants WHERE id = ?').get(participant.id);
    consumeInvitation(db, secrets, fresh, now);
    const session = createSession(db, { participant: updated, ttlMs: config.sessionTtlMs, now });
    const events = [
      appendEvent(db, {
        interviewId: interview.id,
        scope: 'internal',
        type: 'participant_joined',
        payload: { role: updated.role, name: updated.name },
        at: now,
      }),
    ];
    return {
      sessionToken: session.token,
      participant: { ...updated },
      interview: { ...interview },
      redirect: `/interviews/${interview.id}/${updated.role === 'candidate' ? 'candidate' : updated.role}`,
      events,
    };
  });
}

/* ------------------------------------------------------------------ */
/* 副考官申请                                                           */
/* ------------------------------------------------------------------ */

export function normalizeName(name) {
  const value = String(name ?? '').trim();
  if (!value) throw badRequest('请填写姓名。', 'name_required');
  if (value.length > 80) throw badRequest('姓名不能超过 80 个字符。', 'name_too_long');
  return value;
}

/** 副考官提交加入申请：不占用席位，等待主考官审批。 */
export function createJoinRequest({ db, secrets, config, token, name, now = nowIso() }) {
  const invitation = findInvitation(db, token);
  if (!invitation || invitation.role !== 'co') throw gone('链接无效，请向主考官索取新的邀请链接。', 'invite_missing');
  assertInvitationAvailable(invitation, now);
  const applicantName = normalizeName(name);
  return tx(db, () => {
    const fresh = db.prepare('SELECT * FROM invitations WHERE id = ?').get(invitation.id);
    assertInvitationAvailable(fresh, now);
    const seat = getParticipantByRole(db, fresh.interview_id, 'co');
    if (!seat) throw gone('席位不存在。', 'seat_missing');
    if (seat.claimed_at) throw gone('副考官席位已被领取，无法再申请。', 'seat_claimed');
    const interviewRow = db.prepare('SELECT status FROM interviews WHERE id = ?').get(fresh.interview_id);
    if (interviewRow?.status === 'completed') throw forbidden('本次面试已完成，不再接受新的加入申请。', 'board_completed');
    const requestToken = randomToken(32);
    const request = {
      id: newId(),
      interviewId: fresh.interview_id,
      invitationId: fresh.id,
      tokenHash: sha256(requestToken),
      name: applicantName,
      createdAt: now,
    };
    db.prepare(
      `INSERT INTO join_requests (id, interview_id, token_hash, name, invitation_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(request.id, request.interviewId, request.tokenHash, request.name, request.invitationId, now);
    const interview = db.prepare('SELECT id, candidate_name, position FROM interviews WHERE id = ?').get(fresh.interview_id);
    const events = [
      appendEvent(db, {
        interviewId: fresh.interview_id,
        scope: 'internal',
        type: 'join_request_created',
        payload: { requestId: request.id, name: applicantName },
        at: now,
      }),
    ];
    return {
      requestToken,
      status: 'pending',
      interview: { id: interview.id, candidateName: interview.candidate_name, position: interview.position },
      events,
    };
  });
}

export function findJoinRequestByToken(db, rawToken) {
  if (!rawToken || typeof rawToken !== 'string' || rawToken.length < 20 || rawToken.length > 200) return null;
  const row = db.prepare('SELECT * FROM join_requests WHERE token_hash = ?').get(sha256(rawToken));
  return row ? { ...row } : null;
}

export function getJoinRequestPublicView(db, request) {
  const interview = db.prepare('SELECT id, candidate_name, position, status FROM interviews WHERE id = ?').get(request.interview_id);
  return {
    status: request.status,
    canEnter: request.status === 'approved',
    requestId: request.id,
    interview: interview
      ? { id: interview.id, candidateName: interview.candidate_name, position: interview.position, status: interview.status }
      : null,
    createdAt: request.created_at,
    decidedAt: request.decided_at,
  };
}

/** 审批通过后，申请浏览器凭申请 Cookie 换取正式会话。 */
export function enterApprovedRequest({ db, config, requestToken, now = nowIso() }) {
  const request = findJoinRequestByToken(db, requestToken);
  if (!request) throw unauthorized('申请不存在，请重新通过邀请链接申请。', 'request_missing');
  if (request.status === 'rejected') throw forbidden('本次加入申请已被拒绝。', 'request_rejected');
  if (request.status !== 'approved') throw unauthorized('申请仍在等待主考官审批。', 'request_pending');
  return tx(db, () => {
    const fresh = db.prepare('SELECT * FROM join_requests WHERE id = ?').get(request.id);
    if (fresh.status !== 'approved') throw forbidden('本次加入申请状态已变更，请刷新查看。', 'request_changed');
    const participant = db.prepare('SELECT * FROM participants WHERE id = ?').get(fresh.participant_id);
    if (!participant || participant.revoked_at) throw unauthorized('席位已失效，请让主考官重新邀请。', 'seat_revoked');
    if (participant.generation !== fresh.generation) {
      throw unauthorized('席位已重新分配，请让主考官重新邀请。', 'seat_reassigned');
    }
    const session = createSession(db, { participant, ttlMs: config.sessionTtlMs, now });
    db.prepare('UPDATE join_requests SET session_issued_at = ? WHERE id = ?').run(now, fresh.id);
    return {
      sessionToken: session.token,
      interviewId: participant.interview_id,
      redirect: `/interviews/${participant.interview_id}/co`,
    };
  });
}

export function approveJoinRequest({ db, secrets, interviewId, requestId, now = nowIso() }) {
  return tx(db, () => {
    const request = db.prepare('SELECT * FROM join_requests WHERE id = ? AND interview_id = ?').get(requestId, interviewId);
    if (!request) throw gone('加入申请不存在。', 'request_missing');
    if (request.status !== 'pending') throw forbidden('该申请已被处理。', 'request_handled');
    const seat = getParticipantByRole(db, interviewId, 'co');
    if (!seat) throw gone('副考官席位不存在。');
    if (seat.claimed_at) throw forbidden('副考官席位已被占用，请先重新邀请。', 'seat_claimed');

    const invitation = db.prepare('SELECT * FROM invitations WHERE id = ?').get(request.invitation_id);
    if (invitation?.revoked_at) throw forbidden('该申请对应的邀请已被撤销。', 'invite_revoked');

    db.prepare(
      `UPDATE participants
       SET name = ?, claimed_at = ?, revoked_at = NULL, ready = 0, ready_at = NULL, generation = generation + 1
       WHERE id = ?`,
    ).run(request.name, now, seat.id);
    const updated = db.prepare('SELECT * FROM participants WHERE id = ?').get(seat.id);
    revokeParticipantSessions(db, seat.id, now);
    db.prepare(
      `UPDATE join_requests
       SET status = 'approved', participant_id = ?, generation = ?, decided_at = ?
       WHERE id = ?`,
    ).run(updated.id, updated.generation, now, request.id);
    const rejected = db
      .prepare(
        `UPDATE join_requests SET status = 'rejected', decided_at = ?
         WHERE interview_id = ? AND status = 'pending' AND id <> ?`,
      )
      .run(now, interviewId, request.id);
    if (invitation && !invitation.consumed_at) consumeInvitation(db, secrets, invitation, now);
    const events = [
      appendEvent(db, {
        interviewId,
        scope: 'internal',
        type: 'join_request_decided',
        payload: { requestId: request.id, status: 'approved', name: updated.name, rejectedOthers: rejected.changes },
        at: now,
      }),
    ];
    return { participant: { ...updated }, events };
  });
}

export function rejectJoinRequest({ db, interviewId, requestId, now = nowIso() }) {
  return tx(db, () => {
    const request = db.prepare('SELECT * FROM join_requests WHERE id = ? AND interview_id = ?').get(requestId, interviewId);
    if (!request) throw gone('加入申请不存在。', 'request_missing');
    if (request.status !== 'pending') throw forbidden('该申请已被处理。', 'request_handled');
    db.prepare(`UPDATE join_requests SET status = 'rejected', decided_at = ? WHERE id = ?`).run(now, request.id);
    const events = [
      appendEvent(db, {
        interviewId,
        scope: 'internal',
        type: 'join_request_decided',
        payload: { requestId: request.id, status: 'rejected', name: request.name },
        at: now,
      }),
    ];
    return { events };
  });
}

/* ------------------------------------------------------------------ */
/* 重新邀请 / 恢复主考官                                                */
/* ------------------------------------------------------------------ */

/**
 * 重新邀请固定席位：撤销旧会话、递增代次、清空领取状态并签发新链接。
 * 历史便签/消息使用作者名快照，作者标识不会被覆盖。
 */
export function reinviteSeat({ db, secrets, config, interviewId, role, now = nowIso() }) {
  if (!EXAMINER_ROLES.includes(role) && role !== 'candidate') {
    throw badRequest('席位角色无效。', 'invalid_role');
  }
  return tx(db, () => {
    const seat = getParticipantByRole(db, interviewId, role);
    if (!seat) throw gone('席位不存在。', 'seat_missing');
    revokeParticipantSessions(db, seat.id, now);
    db.prepare(
      `UPDATE participants
       SET claimed_at = NULL, revoked_at = NULL, ready = 0, ready_at = NULL, generation = generation + 1
       WHERE id = ?`,
    ).run(seat.id);
    // 副考官被替换时，新的人不能继承旧副考官在当前轮的评价。
    if (role === 'co') {
      const interview = db.prepare('SELECT round FROM interviews WHERE id = ?').get(interviewId);
      db.prepare(
        'DELETE FROM evaluations WHERE interview_id = ? AND round = ? AND evaluator_id = ?',
      ).run(interviewId, interview?.round ?? 1, seat.id);
    }
    // 旧申请全部作废
    db.prepare(
      `UPDATE join_requests SET status = 'rejected', decided_at = ?
       WHERE interview_id = ? AND status = 'pending'`,
    ).run(now, interviewId);
    const invitation = issueInvitation({ db, secrets, config, interviewId, role, now });
    const events = [
      appendEvent(db, {
        interviewId,
        scope: 'internal',
        type: 'seat_reinvited',
        payload: { role, participantId: seat.id },
        at: now,
      }),
    ];
    return { invitation, participantId: seat.id, events };
  });
}

/** 主考官恢复入口（CLI 专用）：与重新邀请相同，但保留姓名并额外提示会撤销旧身份。 */
export function recoverLeadSeat({ db, secrets, config, interviewId, now = nowIso() }) {
  const result = reinviteSeat({ db, secrets, config, interviewId, role: 'lead', now });
  return { ...result, role: 'lead' };
}

/** 席位被撤销后，旧队列不得继续写入：校验代次。 */
export function assertSessionGeneration(auth, expectedGeneration) {
  if (expectedGeneration == null) return;
  if (Number(expectedGeneration) !== auth.participant.generation) {
    throw unauthorized('身份已更新，请刷新页面后重新操作。', 'stale_generation');
  }
}
