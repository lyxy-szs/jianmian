import { appendEvent, newId, nowIso, tx } from '../db/index.mjs';
import { LIMITS } from '../config.mjs';
import { badRequest, conflict, forbidden } from './errors.mjs';
import { LEVELS, LEVEL_KEYS, levelLabel, mapEvaluationRow } from './levels.mjs';
import { buildReport } from './report.mjs';

export { LEVELS, LEVEL_KEYS, levelLabel, mapEvaluationRow };

export function getEvaluations(db, interviewId, round) {
  const rows = db
    .prepare('SELECT * FROM evaluations WHERE interview_id = ? AND round = ? ORDER BY evaluator_id')
    .all(interviewId, round);
  return rows.map(mapEvaluationRow);
}

export function evaluationsByRole(db, interviewId, round) {
  const lead = db.prepare('SELECT * FROM participants WHERE interview_id = ? AND role = ?').get(interviewId, 'lead');
  const co = db.prepare('SELECT * FROM participants WHERE interview_id = ? AND role = ?').get(interviewId, 'co');
  const byId = new Map(getEvaluations(db, interviewId, round).map((row) => [row.evaluatorId, row]));
  return {
    lead: { participantId: lead?.id, evaluation: lead ? byId.get(lead.id) ?? null : null },
    co: { participantId: co?.id, evaluation: co ? byId.get(co.id) ?? null : null },
  };
}

function validateLevel(level, required) {
  if (level == null || level === '') {
    if (required) throw badRequest('提交评价前请选择推荐等级。', 'level_required');
    return null;
  }
  if (!Object.hasOwn(LEVELS, level)) throw badRequest('推荐等级只能取四个合法值之一。', 'invalid_level');
  return level;
}

function cleanReason(reason, required) {
  const text = String(reason ?? '').trim();
  if (text.length > LIMITS.evaluationReason) {
    throw badRequest(`评价理由不能超过 ${LIMITS.evaluationReason} 个字符。`, 'reason_too_long');
  }
  if (required && !text) throw badRequest('提交评价前请填写理由。', 'reason_required');
  return text;
}

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

/**
 * 保存或提交自己的评价。服务端实时共享草稿内容与提交状态；
 * 内容修订（等级或理由变化）会把状态从 submitted 退回 draft。
 */
export function saveEvaluation({ db, interview, participant, input = {}, now = nowIso() }) {
  if (interview.status === 'completed') {
    throw forbidden('面试已完成并只读，无法修改评价。', 'board_completed');
  }
  const submit = input.submit === true;
  const level = validateLevel(input.level, submit);
  const reason = cleanReason(input.reason, submit);

  return tx(db, () => {
    const current = db
      .prepare('SELECT * FROM evaluations WHERE interview_id = ? AND round = ? AND evaluator_id = ?')
      .get(interview.id, interview.round, participant.id);
    if (input.version != null && current && Number(input.version) !== current.version) {
      throw conflict('评价已在其他窗口更新，请刷新后重试。', 'version_conflict', {
        current: mapEvaluationRow(current),
      });
    }
    const changed =
      !current || current.level !== level || current.reason !== reason || (submit && current.status !== 'submitted');
    let status;
    if (submit) status = 'submitted';
    else if (!changed) status = current?.status ?? 'draft';
    else status = 'draft';

    const events = ensureEvaluating(db, interview, now);
    const version = current ? (changed || current.status !== status ? current.version + 1 : current.version) : 1;
    const submittedAt =
      status === 'submitted' ? (current?.status === 'submitted' && !changed ? current.submitted_at : now) : null;
    if (current) {
      db.prepare(
        `UPDATE evaluations SET evaluator_name = ?, level = ?, reason = ?, status = ?, version = ?,
           updated_at = ?, submitted_at = ? WHERE id = ?`,
      ).run(participant.name ?? '', level, reason, status, version, now, submittedAt, current.id);
    } else {
      db.prepare(
        `INSERT INTO evaluations (id, interview_id, round, evaluator_id, evaluator_name, level, reason,
           status, version, updated_at, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(
        newId(),
        interview.id,
        interview.round,
        participant.id,
        participant.name ?? '',
        level,
        reason,
        status,
        now,
        submittedAt,
      );
    }
    db.prepare('UPDATE interviews SET revision = revision + 1, updated_at = ? WHERE id = ?').run(now, interview.id);
    events.push(
      appendEvent(db, {
        interviewId: interview.id,
        scope: 'internal',
        type: 'evaluation_updated',
        payload: {
          evaluatorId: participant.id,
          role: participant.role,
          status,
          level,
          round: interview.round,
        },
        at: now,
      }),
    );
    const saved = db
      .prepare('SELECT * FROM evaluations WHERE interview_id = ? AND round = ? AND evaluator_id = ?')
      .get(interview.id, interview.round, participant.id);
    return { evaluation: mapEvaluationRow(saved), events };
  });
}

/**
 * 主考官确认最终结论。所有校验在单一事务内完成：
 * 两份评价均已提交、最终理由与分歧说明、评价版本未被并发修改。
 */
export function completeInterview({ db, interview, participant, input = {}, now = nowIso() }) {
  if (interview.status === 'completed') {
    throw conflict('本次面试已经完成。', 'already_completed');
  }
  const finalLevel = validateLevel(input.finalLevel, true);
  const reason = cleanReason(input.reason, true);
  if (reason.length > LIMITS.decisionReason) {
    throw badRequest(`最终理由不能超过 ${LIMITS.decisionReason} 个字符。`, 'reason_too_long');
  }

  return tx(db, () => {
    const fresh = db.prepare('SELECT * FROM interviews WHERE id = ?').get(interview.id);
    if (!fresh || fresh.status === 'completed') throw conflict('本次面试已经完成。', 'already_completed');
    const round = fresh.round;
    const lead = db.prepare('SELECT * FROM participants WHERE interview_id = ? AND role = ?').get(interview.id, 'lead');
    const co = db.prepare('SELECT * FROM participants WHERE interview_id = ? AND role = ?').get(interview.id, 'co');
    const leadEval = db
      .prepare('SELECT * FROM evaluations WHERE interview_id = ? AND round = ? AND evaluator_id = ?')
      .get(interview.id, round, lead?.id);
    const coEval = db
      .prepare('SELECT * FROM evaluations WHERE interview_id = ? AND round = ? AND evaluator_id = ?')
      .get(interview.id, round, co?.id);
    if (!leadEval || !coEval) {
      throw forbidden('两位考官都提交评价后，主考官才能确认最终结论。', 'evaluations_pending', {
        missing: [!leadEval ? 'lead' : null, !coEval ? 'co' : null].filter(Boolean),
      });
    }
    if (leadEval.status !== 'submitted' || coEval.status !== 'submitted') {
      throw forbidden('仍有考官的评价未提交，无法确认最终结论。', 'evaluations_pending', {
        pending: [
          leadEval.status !== 'submitted' ? { role: 'lead', status: leadEval.status } : null,
          coEval.status !== 'submitted' ? { role: 'co', status: coEval.status } : null,
        ].filter(Boolean),
      });
    }
    const expected = input.expectedVersions;
    if (expected && typeof expected === 'object') {
      if (
        (expected.lead != null && Number(expected.lead) !== leadEval.version) ||
        (expected.co != null && Number(expected.co) !== coEval.version)
      ) {
        throw conflict('确认期间评价已被修改，请重新查看后再确认。', 'evaluation_changed', {
          lead: mapEvaluationRow(leadEval),
          co: mapEvaluationRow(coEval),
        });
      }
    }
    const diverged = leadEval.level !== coEval.level;
    const divergenceNote = String(input.divergenceNote ?? '').trim();
    if (divergenceNote.length > LIMITS.divergenceNote) {
      throw badRequest(`分歧说明不能超过 ${LIMITS.divergenceNote} 个字符。`, 'divergence_too_long');
    }
    if (diverged && !divergenceNote) {
      throw badRequest('两位考官推荐等级不同时必须填写分歧说明。', 'divergence_required');
    }

    const decisionId = newId();
    db.prepare(
      `INSERT INTO decisions (id, interview_id, round, final_level, reason, divergence_note,
         decided_by, decided_by_name, decided_at, report_snapshot, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 1)`,
    ).run(
      decisionId,
      interview.id,
      round,
      finalLevel,
      reason,
      divergenceNote,
      participant.id,
      participant.name ?? '',
      now,
    );
    db.prepare(
      `UPDATE interviews SET status = 'completed', completed_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
    ).run(now, now, interview.id);
    interview.status = 'completed';
    const snapshot = buildReport(db, interview.id, { round, includeHistory: true, includeCurrentDecision: true });
    snapshot.generatedAt = now;
    db.prepare('UPDATE decisions SET report_snapshot = ? WHERE id = ?').run(JSON.stringify(snapshot), decisionId);
    const events = [
      appendEvent(db, {
        interviewId: interview.id,
        scope: 'internal',
        type: 'decision_confirmed',
        payload: { round, finalLevel, diverged },
        at: now,
      }),
      appendEvent(db, {
        interviewId: interview.id,
        scope: 'candidate',
        type: 'interview_completed',
        payload: { status: 'completed' },
        at: now,
      }),
    ];
    const decision = db.prepare('SELECT * FROM decisions WHERE id = ?').get(decisionId);
    return {
      decision: {
        id: decision.id,
        round: decision.round,
        finalLevel: decision.final_level,
        finalLevelLabel: levelLabel(decision.final_level),
        reason: decision.reason,
        divergenceNote: decision.divergence_note,
        decidedByName: decision.decided_by_name,
        decidedAt: decision.decided_at,
      },
      report: snapshot,
      events,
    };
  });
}

/**
 * 重新开启：回到下一轮评估，保留上一轮结论作为历史；
 * 两份评价正文保留但状态恢复为草稿，必须重新提交。
 */
export function reopenInterview({ db, interview, participant, now = nowIso() }) {
  return tx(db, () => {
    const fresh = db.prepare('SELECT * FROM interviews WHERE id = ?').get(interview.id);
    if (!fresh) throw conflict('面试不存在。', 'missing');
    if (fresh.status !== 'completed') throw conflict('只有已完成的面试才能重新开启。', 'not_completed');
    const fromRound = fresh.round;
    const toRound = fresh.round + 1;
    db.prepare(
      `UPDATE interviews SET status = 'evaluating', round = ?, completed_at = NULL,
         revision = revision + 1, updated_at = ? WHERE id = ?`,
    ).run(toRound, now, interview.id);
    const previous = db
      .prepare('SELECT * FROM evaluations WHERE interview_id = ? AND round = ?')
      .all(interview.id, fromRound);
    const insertEvaluation = db.prepare(
      `INSERT INTO evaluations (id, interview_id, round, evaluator_id, evaluator_name, level, reason,
         status, version, updated_at, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, NULL)`,
    );
    for (const row of previous) {
      insertEvaluation.run(
        newId(),
        interview.id,
        toRound,
        row.evaluator_id,
        row.evaluator_name,
        row.level,
        row.reason,
        now,
      );
    }
    interview.status = 'evaluating';
    interview.round = toRound;
    const events = [
      appendEvent(db, {
        interviewId: interview.id,
        scope: 'internal',
        type: 'interview_reopened',
        payload: { fromRound, toRound, by: participant.name ?? '' },
        at: now,
      }),
      appendEvent(db, {
        interviewId: interview.id,
        scope: 'candidate',
        type: 'status_changed',
        payload: { status: 'evaluating', reopened: true },
        at: now,
      }),
    ];
    return { fromRound, round: toRound, events };
  });
}
