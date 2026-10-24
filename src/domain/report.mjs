import { LEVELS, levelLabel, mapEvaluationRow } from './levels.mjs';

const STATUS_LABELS = Object.freeze({ open: '进行中', evaluating: '评估中', completed: '已完成' });

function decisionView(row) {
  if (!row) return null;
  return {
    id: row.id,
    round: row.round,
    finalLevel: row.final_level,
    finalLevelLabel: levelLabel(row.final_level),
    reason: row.reason,
    divergenceNote: row.divergence_note,
    decidedByName: row.decided_by_name,
    decidedAt: row.decided_at,
  };
}

function safeJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 组装某轮的在线总结。完成结论时会把该对象快照进 decisions.report_snapshot，
 * 因此页面与 Markdown 导出对应同一个报告版本。
 */
export function buildReport(db, interviewId, options = {}) {
  const interview = db.prepare('SELECT * FROM interviews WHERE id = ?').get(interviewId);
  if (!interview) return null;
  const round = options.round ?? interview.round;
  const includeCurrentDecision = options.includeCurrentDecision !== false;
  const groups = db
    .prepare('SELECT * FROM groups WHERE interview_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at')
    .all(interviewId)
    .map((row) => ({ ...row }));
  const allNotes = db
    .prepare('SELECT * FROM notes WHERE interview_id = ? ORDER BY sort_order, created_at')
    .all(interviewId)
    .map((row) => ({ ...row }));
  const activeNotes = allNotes.filter((note) => !note.deleted_at);
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const deletedCount = allNotes.length - activeNotes.length;

  const participants = {};
  for (const row of db.prepare('SELECT * FROM participants WHERE interview_id = ?').all(interviewId)) {
    participants[row.role] = {
      id: row.id,
      role: row.role,
      name: row.name ?? '',
      claimed: Boolean(row.claimed_at),
      ready: Boolean(row.ready),
    };
  }

  const roleById = new Map(Object.values(participants).map((p) => [p.id, p]));
  const notes = activeNotes.map((note) => ({
    id: note.id,
    round: note.round,
    body: note.body,
    groupId: note.group_id,
    groupName: groupById.get(note.group_id)?.name ?? '未分类',
    authorId: note.author_id,
    authorName: note.author_name,
    authorRole: roleById.get(note.author_id)?.role ?? null,
    important: Boolean(note.important),
    needsDiscussion: Boolean(note.needs_discussion),
    createdAt: note.created_at,
    updatedAt: note.updated_at,
  }));

  const grouped = groups
    .map((group) => ({
      id: group.id,
      name: group.name,
      isSystem: Boolean(group.is_system),
      notes: notes.filter((note) => note.groupId === group.id),
    }))
    .filter((group) => group.notes.length > 0 || !group.isSystem);
  const knownGroupIds = new Set(groups.map((group) => group.id));
  const orphanNotes = notes.filter((note) => !knownGroupIds.has(note.groupId));
  if (orphanNotes.length) {
    grouped.push({ id: 'orphan', name: '未分类', isSystem: true, notes: orphanNotes });
  }

  const evaluations = {};
  for (const row of db
    .prepare('SELECT * FROM evaluations WHERE interview_id = ? AND round = ?')
    .all(interviewId, round)) {
    const role = roleById.get(row.evaluator_id)?.role ?? row.evaluator_id;
    evaluations[role] = mapEvaluationRow(row);
  }
  for (const role of ['lead', 'co']) {
    if (!evaluations[role]) evaluations[role] = null;
  }

  const decisionRows = db
    .prepare('SELECT * FROM decisions WHERE interview_id = ? ORDER BY round DESC')
    .all(interviewId)
    .map((row) => ({ ...row }));
  const currentDecisionRow = includeCurrentDecision ? decisionRows.find((row) => row.round === round) ?? null : null;

  const bothSubmitted = Boolean(evaluations.lead?.status === 'submitted' && evaluations.co?.status === 'submitted');
  const diverged = bothSubmitted && evaluations.lead.level !== evaluations.co.level;

  const report = {
    reportVersion: currentDecisionRow ? `round-${round}-final` : `round-${round}-preview`,
    generatedAt: new Date().toISOString(),
    round,
    interview: {
      id: interview.id,
      candidateName: interview.candidate_name,
      position: interview.position,
      status: interview.status,
      statusLabel: STATUS_LABELS[interview.status] ?? interview.status,
      internalBrief: interview.internal_brief,
      internalFocus: interview.internal_focus,
      publicBrief: interview.public_brief,
      createdAt: interview.created_at,
      completedAt: interview.completed_at,
    },
    participants,
    groups: grouped,
    notes,
    stats: {
      noteCount: notes.length,
      deletedNoteCount: deletedCount,
      messageCount: Number(
        db.prepare('SELECT COUNT(*) AS count FROM messages WHERE interview_id = ?').get(interviewId)?.count ?? 0,
      ),
      importantCount: notes.filter((note) => note.important).length,
      needsDiscussionCount: notes.filter((note) => note.needsDiscussion).length,
    },
    evaluations,
    decision: decisionView(currentDecisionRow),
    history: decisionRows.filter((row) => !currentDecisionRow || row.id !== currentDecisionRow.id).map(decisionView),
    divergence: {
      bothSubmitted,
      diverged,
      note: currentDecisionRow?.divergence_note ?? '',
    },
    openQuestions: notes
      .filter((note) => note.needsDiscussion || note.groupName === '待验证')
      .map((note) => ({ id: note.id, body: note.body, groupName: note.groupName })),
    levelLabels: LEVELS,
  };
  return report;
}

/** 报告页面使用的投影：附带历史报告可用的版本信息。 */
export function buildReportForPage(db, interviewId) {
  const interview = db.prepare('SELECT * FROM interviews WHERE id = ?').get(interviewId);
  if (!interview) return null;
  const report = buildReport(db, interviewId, { round: interview.round, includeCurrentDecision: true });
  return report;
}

function mdInline(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function mdBlock(text, indent = '') {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => `${indent}${line}`)
    .join('\n');
}

function evalSection(report, role) {
  const label = role === 'lead' ? '主考官' : '副考官';
  const person = report.participants[role];
  const evaluation = report.evaluations[role];
  if (!evaluation) {
    return `### ${label}：${person?.name || '未加入'}\n\n- 状态：尚未填写\n`;
  }
  const status = evaluation.status === 'submitted' ? '已提交' : '草稿（未提交）';
  return [
    `### ${label}：${evaluation.evaluatorName || person?.name || '未命名'}`,
    '',
    `- 推荐等级：${evaluation.level ? levelLabel(evaluation.level) : '未选择'}`,
    `- 状态：${status}`,
    `- 理由：`,
    '',
    mdBlock(evaluation.reason || '（未填写）', '  '),
    '',
  ].join('\n');
}

/** Markdown 导出：与页面使用同一份报告对象/快照。 */
export function renderMarkdown(report) {
  if (!report) return '# 面试总结\n\n未找到该面试。\n';
  const lines = [];
  lines.push(`# 面试总结：${mdInline(report.interview.candidateName)} — ${mdInline(report.interview.position)}`);
  lines.push('');
  lines.push(`- 面试状态：${report.interview.statusLabel}（第 ${report.round} 轮）`);
  lines.push(`- 报告版本：${report.reportVersion}`);
  lines.push(`- 生成时间：${report.generatedAt}`);
  lines.push(
    `- 考官：主考官 ${mdInline(report.participants.lead?.name || '未加入')} / 副考官 ${mdInline(report.participants.co?.name || '未加入')}`,
  );
  lines.push(`- 面试人：${mdInline(report.participants.candidate?.name || report.interview.candidateName)}`);
  lines.push('');

  if (report.decision) {
    lines.push('## 最终结论');
    lines.push('');
    lines.push(`- 推荐等级：**${report.decision.finalLevelLabel}**`);
    lines.push(`- 确认人：${mdInline(report.decision.decidedByName)}`);
    lines.push(`- 确认时间：${report.decision.decidedAt}`);
    lines.push('- 最终理由：');
    lines.push('');
    lines.push(mdBlock(report.decision.reason, '  '));
    lines.push('');
    if (report.decision.divergenceNote) {
      lines.push('- 分歧说明：');
      lines.push('');
      lines.push(mdBlock(report.decision.divergenceNote, '  '));
      lines.push('');
    }
  } else {
    lines.push('## 最终结论');
    lines.push('');
    lines.push(report.interview.status === 'completed' ? '（本版本无最终结论记录）' : '**评估中**：主考官尚未确认最终结论。');
    lines.push('');
    if (report.divergence.diverged) {
      lines.push('> 两位考官当前推荐等级不同，确认结论时必须补充分歧说明（当前尚未确认）。');
      lines.push('');
    }
  }

  lines.push('## 两位考官评价');
  lines.push('');
  lines.push(evalSection(report, 'lead'));
  lines.push(evalSection(report, 'co'));

  if (report.divergence.diverged) {
    lines.push('## 分歧');
    lines.push('');
    lines.push('两位考官推荐等级不同。');
    lines.push('');
  }

  lines.push('## 便签记录');
  lines.push('');
  if (!report.notes.length) {
    lines.push('（暂无便签）');
    lines.push('');
  }
  for (const group of report.groups) {
    if (!group.notes.length) continue;
    lines.push(`### ${group.name}`);
    lines.push('');
    for (const note of group.notes) {
      const marks = [];
      if (note.important) marks.push('重要');
      if (note.needsDiscussion) marks.push('需要讨论');
      const markText = marks.length ? `（${marks.join('、')}）` : '';
      lines.push(`- ${markText}${mdBlock(note.body)} — ${mdInline(note.authorName)}，${note.createdAt}`);
    }
    lines.push('');
  }

  if (report.openQuestions.length) {
    lines.push('## 未完成的待验证项');
    lines.push('');
    for (const item of report.openQuestions) {
      lines.push(`- [ ] ${mdBlock(item.body)}`);
    }
    lines.push('');
  }

  lines.push('## 统计');
  lines.push('');
  lines.push(`- 便签 ${report.stats.noteCount} 条（已删除 ${report.stats.deletedNoteCount} 条）`);
  lines.push(`- 讨论消息 ${report.stats.messageCount} 条`);
  lines.push(`- 重要便签 ${report.stats.importantCount} 条；需要讨论 ${report.stats.needsDiscussionCount} 条`);
  lines.push('');

  if (report.history.length) {
    lines.push('## 历史结论');
    lines.push('');
    for (const item of report.history) {
      lines.push(`### 第 ${item.round} 轮：${item.finalLevelLabel}`);
      lines.push('');
      lines.push(`- 确认人：${mdInline(item.decidedByName)}，${item.decidedAt}`);
      lines.push(`- 理由：${mdBlock(item.reason, '  ')}`);
      if (item.divergenceNote) lines.push(`- 分歧说明：${mdBlock(item.divergenceNote, '  ')}`);
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');
  lines.push('本报告为内部招聘建议，不构成 offer、拒绝或对候选人的最终告知。面试人不可访问本报告。');
  lines.push('');
  return lines.join('\n');
}

/** 导出入口：已完成优先使用该轮结论快照，避免与页面版本漂移。 */
export function reportMarkdownFor(db, interviewId, options = {}) {
  const interview = db.prepare('SELECT * FROM interviews WHERE id = ?').get(interviewId);
  if (!interview) return null;
  if (options.latestFinal !== false && interview.status === 'completed') {
    const decision = db
      .prepare('SELECT * FROM decisions WHERE interview_id = ? ORDER BY round DESC LIMIT 1')
      .get(interviewId);
    const snapshot = decision ? safeJson(decision.report_snapshot) : null;
    if (snapshot) return renderMarkdown(snapshot);
  }
  const report = buildReport(db, interviewId, { round: interview.round, includeCurrentDecision: true });
  return renderMarkdown(report);
}
