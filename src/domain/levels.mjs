export const LEVELS = Object.freeze({
  strong_yes: '强烈推荐',
  yes: '推荐',
  hold: '待定',
  no: '不推荐',
});

export const LEVEL_KEYS = Object.freeze(Object.keys(LEVELS));

export function levelLabel(level) {
  return LEVELS[level] ?? '未选择';
}

export function mapEvaluationRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    round: row.round,
    evaluatorId: row.evaluator_id,
    evaluatorName: row.evaluator_name,
    level: row.level,
    levelLabel: row.level ? levelLabel(row.level) : '未选择',
    reason: row.reason,
    status: row.status,
    version: row.version,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at,
  };
}
