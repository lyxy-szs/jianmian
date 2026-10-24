import { api, ROLE_LABELS, LEVEL_LABELS, formatDateTime } from '/shared/api.mjs';
import { el, byId, clear } from '/shared/dom.mjs';
import { initTheme } from '/shared/theme.mjs';

initTheme();
registerServiceWorker();

const interviewId = location.pathname.split('/').filter(Boolean)[1];
const root = byId('report-root');
const versionPill = byId('report-version');

byId('back-button').addEventListener('click', () => {
  if (history.length > 1) history.back();
  else location.assign(`/interviews/${interviewId}/lead`);
});

void load();

async function load() {
  try {
    const data = await api(`/api/interviews/${interviewId}/report`);
    render(data.report);
  } catch (error) {
    versionPill.className = 'pill pill-danger';
    versionPill.textContent = '无法读取';
    clear(root).append(
      el(
        'div',
        { class: 'empty-state' },
        el('div', { class: 'empty-icon', text: '🔒' }),
        el('h1', { text: '无法查看总结' }),
        el('p', { text: error.message || '只有考官可以查看总结与导出报告。' }),
        el('a', { class: 'btn btn-secondary', href: '/', text: '返回首页' }),
      ),
    );
  }
}

function render(report) {
  if (!report) return;
  const { interview } = report;
  versionPill.className = `pill ${interview.status === 'completed' ? 'pill-ok' : 'pill-warn'}`;
  versionPill.textContent = `${interview.statusLabel} · ${report.reportVersion}`;

  const actions = el(
    'div',
    { class: 'report-actions' },
    el('a', {
      class: 'btn btn-primary btn-small',
      href: `/api/interviews/${interviewId}/report.md`,
      text: '导出 Markdown',
    }),
    el('button', {
      class: 'btn btn-secondary btn-small',
      type: 'button',
      text: '打印 / 另存 PDF',
      onclick: () => window.print(),
    }),
    el('a', { class: 'btn btn-ghost btn-small', href: `/interviews/${interviewId}/lead`, text: '返回面试板' }),
  );

  const children = [
    el(
      'header',
      { class: 'report-head' },
      el('p', { class: 'eyebrow', text: '面试总结（内部）' }),
      el('h1', { text: `${interview.candidateName} · ${interview.position}` }),
      el(
        'div',
        { class: 'report-meta' },
        el('span', { class: `chip chip-status chip-${interview.status}`, text: interview.statusLabel }),
        el('span', { class: 'muted', text: `第 ${report.round} 轮` }),
        el('span', { class: 'muted', text: `生成于 ${formatDateTime(report.generatedAt)}` }),
      ),
      el(
        'p',
        {
          class: 'muted small',
          text: `主考官：${report.participants.lead?.name || '未加入'} · 副考官：${report.participants.co?.name || '未加入'} · 面试人：${report.participants.candidate?.name || interview.candidateName}`,
        },
      ),
      actions,
    ),
  ];

  const decision = report.decision;
  const decisionCard = el(
    'section',
    { class: `report-card decision-card ${decision ? 'is-final' : 'is-pending'}` },
    el('h2', { text: decision ? '最终结论' : '最终结论（评估中）' }),
  );
  if (decision) {
    decisionCard.append(
      el(
        'div',
        { class: 'decision-headline' },
        el('span', { class: 'decision-level', text: decision.finalLevelLabel }),
        el('span', { class: 'muted small', text: `${decision.decidedByName} 于 ${formatDateTime(decision.decidedAt)} 确认` }),
      ),
      el('h3', { text: '最终理由' }),
      el('p', { class: 'preserve-lines', text: decision.reason }),
    );
    if (decision.divergenceNote) {
      decisionCard.append(el('h3', { text: '分歧说明' }), el('p', { class: 'preserve-lines', text: decision.divergenceNote }));
    }
  } else {
    decisionCard.append(
      el('p', {
        text:
          interview.status === 'completed'
            ? '本版本没有最终结论记录。'
            : '主考官尚未确认最终结论。本页导出会标注“评估中”。',
      }),
      report.divergence.diverged
        ? el('p', { class: 'notice-inline', text: '两位考官当前推荐等级不同；确认最终结论时必须填写分歧说明。' })
        : null,
    );
  }
  children.push(decisionCard);

  children.push(
    el(
      'section',
      { class: 'report-card' },
      el('h2', { text: '两位考官评价' }),
      el('div', { class: 'report-eval-grid' }, evaluateCard(report, 'lead'), evaluateCard(report, 'co')),
    ),
  );

  const notesCard = el('section', { class: 'report-card' }, el('h2', { text: '便签记录' }));
  if (!report.notes.length) notesCard.append(el('p', { class: 'muted', text: '暂无便签。' }));
  for (const group of report.groups) {
    if (!group.notes.length) continue;
    notesCard.append(
      el('h3', { class: 'report-group-title' }, group.name, el('span', { class: 'count', text: ` ${group.notes.length}` })),
      el(
        'ul',
        { class: 'report-note-list' },
        group.notes.map((note) =>
          el(
            'li',
            { class: 'report-note' },
            el(
              'div',
              { class: 'report-note-meta' },
              el('span', { class: 'note-author', text: note.authorName }),
              note.important ? el('span', { class: 'flag flag-important', text: '★ 重要' }) : null,
              note.needsDiscussion ? el('span', { class: 'flag flag-discussion', text: '◈ 需要讨论' }) : null,
              el('time', { class: 'muted small', text: formatDateTime(note.createdAt) }),
            ),
            el('p', { class: 'preserve-lines', text: note.body }),
          ),
        ),
      ),
    );
  }
  children.push(notesCard);

  if (report.openQuestions.length) {
    children.push(
      el(
        'section',
        { class: 'report-card' },
        el('h2', { text: '未完成的待验证项' }),
        el('p', { class: 'muted small', text: '这些便签被标记为需要讨论或位于“待验证”分组。它们不阻塞结论，但如实保留在此。' }),
        el(
          'ul',
          { class: 'plain-list' },
          report.openQuestions.map((item) => el('li', { class: 'preserve-lines', text: item.body })),
        ),
      ),
    );
  }

  if (report.history.length) {
    children.push(
      el(
        'section',
        { class: 'report-card' },
        el('h2', { text: '历史结论' }),
        report.history.map((item) =>
          el(
            'div',
            { class: 'history-item' },
            el('h3', {}, `第 ${item.round} 轮：`, el('span', { class: 'decision-level small', text: item.finalLevelLabel })),
            el('p', { class: 'muted small', text: `${item.decidedByName} · ${formatDateTime(item.decidedAt)}` }),
            el('p', { class: 'preserve-lines', text: item.reason }),
            item.divergenceNote ? el('p', { class: 'muted small preserve-lines', text: `分歧说明：${item.divergenceNote}` }) : null,
          ),
        ),
      ),
    );
  }

  children.push(
    el(
      'section',
      { class: 'report-card report-stats' },
      el('h2', { text: '统计' }),
      el(
        'dl',
        {},
        stat('便签', `${report.stats.noteCount} 条（已删除 ${report.stats.deletedNoteCount} 条）`),
        stat('讨论消息', `${report.stats.messageCount} 条`),
        stat('重要便签', `${report.stats.importantCount} 条`),
        stat('需要讨论', `${report.stats.needsDiscussionCount} 条`),
        stat('报告版本', report.reportVersion),
      ),
    ),
  );

  children.push(
    el(
      'p',
      { class: 'report-disclaimer' },
      '本报告为内部招聘建议，不构成 offer、拒绝或对候选人的最终告知。面试人不可访问本页或导出文件。',
    ),
  );

  clear(root).append(...children);
  document.title = `${interview.candidateName} · 面试总结 · 面试搭子`;
}

function stat(label, value) {
  return el('div', { class: 'stat-row' }, el('dt', { text: label }), el('dd', { text: value }));
}

function evaluateCard(report, role) {
  const person = report.participants[role];
  const evaluation = report.evaluations[role];
  const card = el(
    'article',
    { class: `eval-card ${evaluation?.status === 'submitted' ? 'is-submitted' : 'is-draft'}` },
    el(
      'header',
      { class: 'eval-card-head' },
      el('h3', { text: `${ROLE_LABELS[role]}：${evaluation?.evaluatorName || person?.name || '未加入'}` }),
      el('span', {
        class: `chip ${evaluation?.status === 'submitted' ? 'chip-ok' : 'chip-warn'}`,
        text: evaluation ? (evaluation.status === 'submitted' ? '已提交' : '草稿未提交') : '未填写',
      }),
    ),
  );
  if (!evaluation) {
    card.append(el('p', { class: 'muted', text: '尚未填写评价。' }));
    return card;
  }
  card.append(
    el('p', { class: 'eval-level-line' }, el('strong', { text: '推荐等级：' }), evaluation.level ? LEVEL_LABELS[evaluation.level] : '未选择'),
    el('p', { class: 'preserve-lines', text: evaluation.reason || '（未填写理由）' }),
    el('p', { class: 'muted small', text: `更新于 ${formatDateTime(evaluation.updatedAt)}` }),
  );
  return card;
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
