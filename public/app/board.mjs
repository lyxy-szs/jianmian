import { api, ROLE_LABELS, LEVEL_LABELS, formatTime, formatDateTime, copyText } from '/shared/api.mjs';
import { el, byId, clear, setHidden } from '/shared/dom.mjs';
import { initTheme } from '/shared/theme.mjs';
import { toast } from '/shared/toast.mjs';
import { SyncEngine } from '/shared/sync.mjs';

initTheme();
registerServiceWorker();

const interviewId = location.pathname.split('/').filter(Boolean)[1];
const pathRole = location.pathname.split('/').filter(Boolean)[2] || 'lead';

const dom = {
  candidateName: byId('candidate-name'),
  candidatePosition: byId('candidate-position'),
  statusChip: byId('status-chip'),
  roundChip: byId('round-chip'),
  presence: byId('presence'),
  syncIndicator: byId('sync-indicator'),
  draftsButton: byId('drafts-button'),
  draftsCount: byId('drafts-count'),
  evalButton: byId('eval-button'),
  manageButton: byId('manage-button'),
  discussionToggle: byId('discussion-toggle'),
  discussionClose: byId('discussion-close'),
  discussionPanel: byId('discussion-panel'),
  readonlyBanner: byId('readonly-banner'),
  offlineBanner: byId('offline-banner'),
  reportLink: byId('report-link'),
  intelPanel: byId('intel-panel'),
  filters: byId('filters'),
  newNoteButton: byId('new-note-button'),
  groupManageButton: byId('group-manage-button'),
  notesBoard: byId('notes-board'),
  boardError: byId('board-error'),
  messageList: byId('message-list'),
  composerContext: byId('composer-context'),
  messageInput: byId('message-input'),
  composerHint: byId('composer-hint'),
  sendMessage: byId('send-message'),
  noteDialog: byId('note-dialog'),
  noteDialogTitle: byId('note-dialog-title'),
  noteForm: byId('note-form'),
  noteBody: byId('note-body'),
  noteGroup: byId('note-group'),
  noteImportant: byId('note-important'),
  noteDiscussion: byId('note-discussion'),
  noteFormError: byId('note-form-error'),
  noteSave: byId('note-save'),
  groupDialog: byId('group-dialog'),
  groupList: byId('group-list'),
  groupAddForm: byId('group-add-form'),
  groupNewName: byId('group-new-name'),
  evalDialog: byId('eval-dialog'),
  myEvalStatus: byId('my-eval-status'),
  evalLevel: byId('eval-level'),
  evalReason: byId('eval-reason'),
  evalHint: byId('eval-hint'),
  evalError: byId('eval-error'),
  evalSubmit: byId('eval-submit'),
  evalSave: byId('eval-save'),
  partnerEvalTitle: byId('partner-eval-title'),
  partnerEvalStatus: byId('partner-eval-status'),
  partnerEvalBody: byId('partner-eval-body'),
  evalFinalBox: byId('eval-final-box'),
  manageDialog: byId('manage-dialog'),
  manageContent: byId('manage-content'),
  draftsDialog: byId('drafts-dialog'),
  draftsList: byId('drafts-list'),
  lockedOverlay: byId('locked-overlay'),
  lockedMessage: byId('locked-message'),
  lockedDrafts: byId('locked-drafts'),
};

const state = {
  snapshot: null,
  filter: 'all',
  editingNoteId: null,
  composer: { replyTo: null, replyExcerpt: null, noteId: null, noteExcerpt: null },
  evalDirty: false,
  evalTimer: null,
  evalRestoreTried: false,
  drafts: [],
  lastStatus: null,
  intelOpen: false,
  manageSignature: null,
  groupSignature: null,
  draggingNoteId: null,
  newInvite: null,
  isMobile: window.matchMedia('(max-width: 760px)').matches,
  firstRender: true,
};
document.body.classList.toggle('is-mobile', state.isMobile);
window.matchMedia('(max-width: 760px)').addEventListener('change', (event) => {
  state.isMobile = event.matches;
  document.body.classList.toggle('is-mobile', state.isMobile);
  if (state.snapshot) renderAll();
});

const engine = new SyncEngine({
  interviewId,
  onSnapshot: (snapshot, meta) => {
    state.snapshot = snapshot;
    renderAll(meta);
  },
  onStatus: (status) => {
    state.lastStatus = status;
    updateSyncStatus(status);
    if (status.cacheMiss) showBoardError(status.message || '离线且没有本机缓存。');
  },
  onPresence: () => renderPresence(),
  onAuthError: ({ message }) => showLocked(message),
  onDrafts: (drafts) => {
    state.drafts = drafts;
    updateDraftsButton();
    if (dom.draftsDialog.open) renderDrafts();
  },
  onNotice: ({ message }) => toast(message, { type: 'info', timeout: 6500 }),
});

bindStaticEvents();
void engine.start();

/* ------------------------------------------------------------------ */
/* 状态与安全                                                          */
/* ------------------------------------------------------------------ */

function showLocked(message) {
  dom.lockedMessage.textContent = message || '该身份已被撤销或重新邀请。';
  setHidden(dom.lockedOverlay, false);
  dom.syncIndicator.className = 'pill pill-danger';
  dom.syncIndicator.textContent = '身份已失效';
}

function showBoardError(message) {
  dom.boardError.hidden = false;
  clear(dom.boardError).append(
    el('div', { class: 'empty-icon', text: '⚠' }),
    el('h2', { text: '暂时无法加载面试板' }),
    el('p', { text: message }),
    el('button', {
      class: 'btn btn-secondary',
      type: 'button',
      text: '重试',
      onclick: () => void engine.refresh().then((snapshot) => {
        if (snapshot) dom.boardError.hidden = true;
      }),
    }),
  );
}

function updateSyncStatus(status) {
  const pending = status.pending ?? 0;
  if (status.mode === 'online') {
    dom.syncIndicator.className = 'pill pill-ok';
    dom.syncIndicator.textContent = pending > 0 ? `已连接 · 待同步 ${pending}` : '已连接';
    setHidden(dom.offlineBanner, true);
  } else if (status.mode === 'syncing') {
    dom.syncIndicator.className = 'pill pill-warn';
    dom.syncIndicator.textContent = `同步中… ${pending > 0 ? `待同步 ${pending}` : ''}`.trim();
    setHidden(dom.offlineBanner, true);
  } else if (status.mode === 'offline') {
    dom.syncIndicator.className = 'pill pill-warn';
    dom.syncIndicator.textContent = pending > 0 ? `离线 · 待同步 ${pending}` : '离线';
    setHidden(dom.offlineBanner, false);
    dom.offlineBanner.textContent = `${status.message || '连接中断。'}${pending > 0 ? ` 本机有 ${pending} 条待同步操作。` : ''}`;
  } else if (status.mode === 'locked') {
    dom.syncIndicator.className = 'pill pill-danger';
    dom.syncIndicator.textContent = '已锁定';
  }
  updateDraftsButton();
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

function renderAll(meta = {}) {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  renderHeader();
  renderIntel();
  renderBoard();
  renderMessages();
  renderComposerContext();
  if (dom.evalDialog.open) renderEvalPanel(false);
  maybeRefreshManage();
  maybeRefreshGroups();
  updateDraftsButton();
  applyPermissions();
  document.body.classList.toggle('is-readonly', snapshot.permissions.readOnly);
  if (state.firstRender && meta?.fromCache) {
    toast('离线：正在展示本机缓存，恢复连接后会自动同步。', { type: 'info', timeout: 6000 });
  }
  state.firstRender = false;
}

function renderHeader() {
  const { interview, viewer, participants, permissions } = state.snapshot;
  dom.candidateName.textContent = interview.candidateName;
  dom.candidatePosition.textContent = `${interview.position} · ${ROLE_LABELS[viewer.role]} ${viewer.name}`;
  dom.statusChip.textContent = interview.statusLabel;
  dom.statusChip.className = `chip chip-status chip-${interview.status}`;
  if (interview.round > 1) {
    dom.roundChip.hidden = false;
    dom.roundChip.textContent = `第 ${interview.round} 轮`;
  } else {
    dom.roundChip.hidden = true;
  }
  document.title = `${interview.candidateName} · 面试板 · 面试搭子`;
  dom.reportLink.href = `/interviews/${interviewId}/report`;
  setHidden(dom.readonlyBanner, !permissions.readOnly);

  const myEval = state.snapshot.evaluations[viewer.role];
  const evalState = myEval ? (myEval.status === 'submitted' ? '已提交' : '草稿') : '未填写';
  dom.evalButton.textContent = `评价 · ${evalState}`;
  dom.evalButton.classList.toggle('has-submitted', myEval?.status === 'submitted');
  dom.manageButton.hidden = viewer.role !== 'lead';
  renderPresence();
}

function renderPresence() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  clear(dom.presence);
  const byRole = new Map(snapshot.participants.map((p) => [p.role, p]));
  for (const role of ['lead', 'co', 'candidate']) {
    const person = byRole.get(role);
    const online = Boolean(snapshot.online?.[role]);
    const isMe = snapshot.viewer.role === role;
    let statusText;
    if (role === 'candidate') {
      statusText = person?.ready ? '已准备' : '未准备';
    } else {
      statusText = online ? '在线' : '离线';
    }
    dom.presence.append(
      el(
        'span',
        {
          class: `presence-item ${isMe ? 'is-me' : ''} ${role === 'candidate' ? (person?.ready ? 'is-ready' : '') : online ? 'is-online' : ''}`,
          title: `${ROLE_LABELS[role]}：${person?.name || '未加入'} · ${statusText}`,
        },
        el('span', { class: 'presence-dot', 'aria-hidden': 'true' }),
        el('span', { class: 'presence-role', text: ROLE_LABELS[role] }),
        el('span', { class: 'presence-name', text: person?.name || '未加入' }),
        el('span', { class: 'presence-state', text: statusText }),
      ),
    );
  }
}

function renderIntel() {
  const { interview } = state.snapshot;
  clear(dom.intelPanel);
  if (!interview.internalBrief && !interview.internalFocus) {
    dom.intelPanel.hidden = true;
    return;
  }
  dom.intelPanel.hidden = false;
  const details = el(
    'details',
    { class: 'intel' },
    el('summary', { text: '候选人简介与本次面试重点（内部资料）' }),
    el(
      'div',
      { class: 'intel-body' },
      interview.internalBrief
        ? el('div', { class: 'intel-block' }, el('h3', { text: '候选人简介' }), el('p', { class: 'preserve-lines', text: interview.internalBrief }))
        : null,
      interview.internalFocus
        ? el('div', { class: 'intel-block' }, el('h3', { text: '本次面试重点' }), el('p', { class: 'preserve-lines', text: interview.internalFocus }))
        : null,
    ),
  );
  details.open = state.intelOpen;
  details.addEventListener('toggle', () => {
    state.intelOpen = details.open;
  });
  dom.intelPanel.append(details);
}

function renderBoard() {
  const snapshot = state.snapshot;
  clear(dom.notesBoard);
  const canMove = snapshot.permissions.canMoveNotes;
  const filter = state.filter;
  const visibleNotes = snapshot.notes.filter((note) => matchesFilter(note, filter));
  const groups = snapshot.groups.length
    ? snapshot.groups
    : [{ id: 'fallback', name: '未分类', isSystem: true }];

  groups.forEach((group, index) => {
    const groupNotes = visibleNotes
      .filter((note) => note.groupId === group.id)
      .sort((a, b) => {
        const ao = Number.isFinite(a.sortOrder) ? a.sortOrder : Number.MAX_SAFE_INTEGER;
        const bo = Number.isFinite(b.sortOrder) ? b.sortOrder : Number.MAX_SAFE_INTEGER;
        if (ao !== bo) return ao - bo;
        return String(a.createdAt).localeCompare(String(b.createdAt));
      });
    const column = el(
      'section',
      { class: `note-column group-tone-${index % 4}`, dataset: { groupId: group.id } },
      el(
        'header',
        { class: 'note-column-head' },
        el('h2', { text: group.name }),
        el('span', { class: 'count', text: String(groupNotes.length) }),
        group.isSystem ? el('span', { class: 'tag', text: '系统' }) : null,
      ),
      el(
        'div',
        { class: 'note-column-body' },
        groupNotes.map((note) => noteCard(note)),
        groupNotes.length === 0
          ? el('p', { class: 'column-empty', text: canMove ? '拖动便签到这里，或新建一张' : '暂无便签' })
          : null,
      ),
    );
    if (canMove) {
      column.addEventListener('dragover', (event) => {
        event.preventDefault();
        column.classList.add('is-drop-target');
      });
      column.addEventListener('dragleave', () => column.classList.remove('is-drop-target'));
      column.addEventListener('drop', (event) => {
        event.preventDefault();
        column.classList.remove('is-drop-target');
        const noteId = event.dataTransfer?.getData('text/note-id') || state.draggingNoteId;
        if (noteId) void moveNote(noteId, group.id);
      });
    }
    dom.notesBoard.append(column);
  });

  if (visibleNotes.length === 0 && filter !== 'all') {
    dom.notesBoard.append(
      el('p', { class: 'board-empty full-span', text: filter === 'important' ? '没有标记为“重要”的便签。' : '没有“需要讨论”的便签。' }),
    );
  }
}

function matchesFilter(note, filter) {
  if (filter === 'important') return note.important;
  if (filter === 'discussion') return note.needsDiscussion;
  return true;
}

function noteCard(note) {
  const snapshot = state.snapshot;
  const canEdit = snapshot.permissions.canEditNotes;
  const canMove = snapshot.permissions.canMoveNotes;
  const isAuthor =
    note.authorId === snapshot.viewer.participantId &&
    (snapshot.viewer.role === 'lead' ||
      Number(note.authorGeneration ?? 0) === Number(snapshot.viewer.generation));

  const flags = el('div', { class: 'note-flags' });
  if (canEdit && isAuthor) {
    flags.append(
      flagButton('★ 重要', note.important, 'flag-important', () =>
        void toggleFlag(note, 'important', !note.important),
      ),
      flagButton('◈ 需要讨论', note.needsDiscussion, 'flag-discussion', () =>
        void toggleFlag(note, 'needsDiscussion', !note.needsDiscussion),
      ),
    );
  } else {
    if (note.important) flags.append(el('span', { class: 'flag flag-important', text: '★ 重要' }));
    if (note.needsDiscussion) flags.append(el('span', { class: 'flag flag-discussion', text: '◈ 需要讨论' }));
  }

  const actions = el('div', { class: 'note-actions' });
  actions.append(
    el('button', {
      class: 'btn btn-ghost btn-tiny',
      type: 'button',
      text: '引用',
      onclick: () => quoteNote(note),
    }),
  );
  if (canMove) {
    const select = el(
      'select',
      {
        class: 'move-select',
        'aria-label': `移动便签到其他分组`,
        onchange: (event) => {
          const target = event.target.value;
          event.target.value = note.groupId;
          if (target && target !== note.groupId) void moveNote(note.id, target);
        },
      },
      snapshot.groups.map((group) =>
        el('option', { value: group.id, text: `移动到：${group.name}`, selected: group.id === note.groupId }),
      ),
    );
    actions.append(select);
  }
  if (canEdit && isAuthor) {
    actions.append(
      el('button', { class: 'btn btn-ghost btn-tiny', type: 'button', text: '编辑', onclick: () => openNoteDialog(note) }),
      el('button', { class: 'btn btn-ghost btn-tiny danger', type: 'button', text: '删除', onclick: () => void deleteNote(note) }),
    );
  }

  const card = el(
    'article',
    {
      class: `note-card${note.localPending ? ' is-pending' : ''}${note.important ? ' is-important' : ''}`,
      dataset: { noteId: note.id },
      draggable: canMove && !snapshot.permissions.readOnly && !state.isMobile,
    },
    el(
      'header',
      { class: 'note-meta' },
      el('span', { class: 'note-author', text: isAuthor ? `${note.authorName}（我）` : note.authorName }),
      el('time', { text: formatTime(note.createdAt) }),
      note.localPending ? el('span', { class: 'pending-badge', text: '待同步' }) : null,
    ),
    el('p', { class: 'note-body preserve-lines', text: note.body }),
    flags,
    note.lastMovedBy
      ? el('p', { class: 'note-moved', text: `最近移动：${note.lastMovedBy} · ${formatTime(note.lastMovedAt)}` })
      : null,
    actions,
  );
  card.addEventListener('dragstart', (event) => {
    if (!canMove) return;
    state.draggingNoteId = note.id;
    event.dataTransfer?.setData('text/note-id', note.id);
    event.dataTransfer.effectAllowed = 'move';
    card.classList.add('is-dragging');
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('is-dragging');
    state.draggingNoteId = null;
  });
  return card;
}

function flagButton(label, active, className, onClick) {
  return el('button', {
    class: `flag flag-toggle ${className}${active ? ' is-on' : ''}`,
    type: 'button',
    'aria-pressed': active ? 'true' : 'false',
    text: label,
    onclick: onClick,
  });
}

function renderMessages() {
  const snapshot = state.snapshot;
  const list = dom.messageList;
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 100;
  clear(list);
  if (!snapshot.messages.length) {
    list.append(el('p', { class: 'muted small empty-messages', text: '还没有讨论。可以从左侧引用一条便签，或直接输入消息。' }));
    return;
  }
  for (const message of snapshot.messages) {
    const noteBlock = message.noteExcerpt
      ? el(
          message.noteDeleted || !message.noteId ? 'div' : 'button',
          {
            class: `quote-block${message.noteDeleted ? ' is-deleted' : ''}`,
            type: message.noteDeleted || !message.noteId ? undefined : 'button',
            onclick: message.noteDeleted || !message.noteId ? undefined : () => locateNote(message.noteId),
          },
          el('span', { class: 'quote-label', text: message.noteDeleted || !message.noteId ? '原便签已删除' : '引用便签' }),
          el('span', { class: 'quote-text', text: message.noteExcerpt }),
        )
      : null;
    const replyBlock = message.replyExcerpt
      ? el(
          'div',
          { class: 'reply-block' },
          el('span', { class: 'quote-label', text: '回复' }),
          el('span', { class: 'quote-text', text: message.replyExcerpt }),
        )
      : null;
    const isMine = message.authorId === snapshot.viewer.participantId;
    list.append(
      el(
        'article',
        { class: `message${isMine ? ' is-mine' : ''}${message.localPending ? ' is-pending' : ''}` },
        el(
          'header',
          { class: 'message-head' },
          el('span', { class: 'message-author', text: message.authorName }),
          el('time', { text: formatTime(message.createdAt) }),
          message.localPending ? el('span', { class: 'pending-badge', text: '待同步' }) : null,
          el('button', {
            class: 'btn btn-ghost btn-tiny',
            type: 'button',
            text: '回复',
            disabled: snapshot.permissions.readOnly,
            onclick: () => setReply(message),
          }),
        ),
        replyBlock,
        noteBlock,
        el('p', { class: 'message-body preserve-lines', text: message.body }),
      ),
    );
  }
  if (nearBottom) list.scrollTop = list.scrollHeight;
}

function renderComposerContext() {
  const context = state.composer;
  clear(dom.composerContext);
  if (!context.replyTo && !context.noteId) {
    dom.composerContext.hidden = true;
    return;
  }
  dom.composerContext.hidden = false;
  if (context.replyTo) {
    dom.composerContext.append(
      el(
        'span',
        { class: 'context-chip' },
        el('strong', { text: '回复消息' }),
        el('span', { text: context.replyExcerpt || '' }),
        el('button', { class: 'chip-remove', type: 'button', 'aria-label': '取消回复', text: '×', onclick: () => clearReply() }),
      ),
    );
  }
  if (context.noteId) {
    dom.composerContext.append(
      el(
        'span',
        { class: 'context-chip' },
        el('strong', { text: '引用便签' }),
        el('span', { text: context.noteExcerpt || '' }),
        el('button', { class: 'chip-remove', type: 'button', 'aria-label': '取消引用', text: '×', onclick: () => clearQuote() }),
      ),
    );
  }
}

function applyPermissions() {
  const { permissions } = state.snapshot;
  const mobile = state.isMobile;
  dom.newNoteButton.disabled = !permissions.canEditNotes || mobile;
  dom.groupManageButton.disabled = !permissions.canManageGroups || mobile;
  dom.messageInput.disabled = !permissions.canDiscuss || mobile;
  dom.sendMessage.disabled = !permissions.canDiscuss || mobile;
  dom.composerHint.textContent = permissions.readOnly
    ? '本次面试已完成，讨论区只读。'
    : mobile
      ? '手机端为只读模式。'
      : state.lastStatus?.mode === 'offline'
      ? '当前离线：发送后进入待同步队列'
      : '实时同步给两位考官';
  dom.evalSubmit.disabled = !permissions.canEvaluate || mobile;
  dom.evalSave.disabled = !permissions.canEvaluate || mobile;
  dom.evalLevel.disabled = !permissions.canEvaluate || mobile;
  dom.evalReason.disabled = !permissions.canEvaluate || mobile;
  dom.noteSave.disabled = !permissions.canEditNotes || mobile;
}

/* ------------------------------------------------------------------ */
/* 便签与分组操作                                                      */
/* ------------------------------------------------------------------ */

function newIdWithPrefix(prefix) {
  const random = crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${random}`;
}

function openNoteDialog(note = null) {
  if (state.isMobile) {
    toast('手机端为只读模式，请在电脑端编辑便签。', { type: 'info' });
    return;
  }
  if (!state.snapshot?.permissions.canEditNotes) return;
  state.editingNoteId = note?.id ?? null;
  dom.noteDialogTitle.textContent = note ? '编辑便签' : '新建便签';
  dom.noteBody.value = note?.body ?? '';
  fillGroupOptions(note?.groupId);
  dom.noteImportant.checked = Boolean(note?.important);
  dom.noteDiscussion.checked = Boolean(note?.needsDiscussion);
  dom.noteFormError.hidden = true;
  dom.noteDialog.showModal();
  dom.noteBody.focus();
}

function fillGroupOptions(selectedId) {
  const groups = state.snapshot.groups;
  const fallback = groups.find((group) => group.isSystem) ?? groups[0];
  clear(dom.noteGroup);
  for (const group of groups) {
    dom.noteGroup.append(el('option', { value: group.id, text: group.name, selected: group.id === selectedId }));
  }
  if (!state.snapshot.groups.some((group) => group.id === selectedId) && fallback) dom.noteGroup.value = fallback.id;
}

async function saveNoteFromDialog() {
  const body = dom.noteBody.value.trim();
  if (!body) {
    dom.noteFormError.textContent = '便签正文不能为空。';
    dom.noteFormError.hidden = false;
    return;
  }
  const payload = {
    body,
    groupId: dom.noteGroup.value,
    important: dom.noteImportant.checked,
    needsDiscussion: dom.noteDiscussion.checked,
  };
  dom.noteSave.disabled = true;
  try {
    if (state.editingNoteId) {
      const note = state.snapshot.notes.find((item) => item.id === state.editingNoteId);
      if (!note) throw new Error('便签已被删除。');
      await engine.enqueue('note.update', { ...payload, noteId: note.id, version: note.version });
    } else {
      await engine.enqueue('note.create', { ...payload, noteId: newIdWithPrefix('note') });
    }
    dom.noteDialog.close();
    state.editingNoteId = null;
    toast(state.lastStatus?.mode === 'offline' ? '便签已保存到本机，等待同步。' : '便签已保存。');
  } catch (error) {
    dom.noteFormError.textContent = error.message || '保存失败。';
    dom.noteFormError.hidden = false;
  } finally {
    dom.noteSave.disabled = false;
  }
}

async function moveNote(noteId, groupId) {
  if (state.isMobile) {
    toast('手机端为只读模式，请在电脑端移动便签。', { type: 'info' });
    return;
  }
  try {
    await engine.enqueue('note.move', { noteId, groupId });
  } catch (error) {
    toast(error.message || '移动失败。', { type: 'error' });
  }
}

async function toggleFlag(note, field, value) {
  if (state.isMobile) return;
  try {
    await engine.enqueue('note.flags', { noteId: note.id, version: note.version, [field]: value });
  } catch (error) {
    toast(error.message || '标记修改失败。', { type: 'error' });
  }
}

async function deleteNote(note) {
  if (state.isMobile) return;
  if (!confirm('确定删除这张便签吗？删除后便签从墙上移除，历史讨论中的引用会保留摘要。')) return;
  try {
    await engine.enqueue('note.delete', { noteId: note.id, version: note.version });
    toast('便签已删除。');
  } catch (error) {
    toast(error.message || '删除失败。', { type: 'error' });
  }
}

function openGroupDialog() {
  if (state.isMobile) {
    toast('手机端为只读模式，请在电脑端管理分组。', { type: 'info' });
    return;
  }
  if (!state.snapshot?.permissions.canManageGroups) return;
  renderGroupList();
  dom.groupDialog.showModal();
}

function groupSignature() {
  const snapshot = state.snapshot;
  if (!snapshot) return '';
  return JSON.stringify(snapshot.groups.map((group) => [group.id, group.name, group.isSystem]));
}

function maybeRefreshGroups() {
  if (!dom.groupDialog.open || !state.snapshot) return;
  const next = groupSignature();
  if (next === state.groupSignature) return;
  const active = document.activeElement;
  if (active && dom.groupList.contains(active)) return; // 不打断正在改名的输入
  const values = new Map(
    [...dom.groupList.querySelectorAll('input')].map((input) => [input.dataset.groupId, input.value]),
  );
  renderGroupList();
  for (const input of dom.groupList.querySelectorAll('input')) {
    if (values.has(input.dataset.groupId)) input.value = values.get(input.dataset.groupId);
  }
}

function renderGroupList() {
  const snapshot = state.snapshot;
  state.groupSignature = groupSignature();
  clear(dom.groupList);
  for (const group of snapshot.groups) {
    const count = snapshot.notes.filter((note) => note.groupId === group.id).length;
    if (group.isSystem) {
      dom.groupList.append(
        el(
          'div',
          { class: 'group-row is-system' },
          el('strong', { text: group.name }),
          el('span', { class: 'tag', text: '系统分组' }),
          el('span', { class: 'muted small', text: `${count} 张便签 · 不可删除` }),
        ),
      );
      continue;
    }
    const input = el('input', {
      value: group.name,
      maxlength: '40',
      'aria-label': `${group.name} 分组名称`,
      dataset: { groupId: group.id },
    });
    dom.groupList.append(
      el(
        'div',
        { class: 'group-row' },
        input,
        el('span', { class: 'muted small', text: `${count} 张` }),
        el('button', {
          class: 'btn btn-small btn-secondary',
          type: 'button',
          text: '保存名称',
          onclick: () => void renameGroup(group, input.value),
        }),
        el('button', {
          class: 'btn btn-small btn-ghost danger',
          type: 'button',
          text: '删除',
          onclick: () => void deleteGroup(group, count),
        }),
      ),
    );
  }
}

async function renameGroup(group, rawName) {
  const name = String(rawName ?? '').trim();
  if (!name) {
    toast('分组名称不能为空。', { type: 'error' });
    return;
  }
  try {
    await engine.enqueue('group.rename', { groupId: group.id, name });
    toast('分组已改名。');
    renderGroupList();
  } catch (error) {
    toast(error.message || '改名失败。', { type: 'error' });
  }
}

async function deleteGroup(group, count) {
  if (!confirm(`确定删除分组“${group.name}”吗？${count > 0 ? `组内 ${count} 张便签会移入“未分类”。` : ''}`)) return;
  try {
    await engine.enqueue('group.delete', { groupId: group.id });
    toast('分组已删除，便签已移入“未分类”。');
    renderGroupList();
  } catch (error) {
    toast(error.message || '删除分组失败。', { type: 'error' });
  }
}

function locateNote(noteId) {
  const card = dom.notesBoard.querySelector(`[data-note-id="${CSS.escape(noteId)}"]`);
  if (!card) {
    toast('引用的便签已删除，无法定位。', { type: 'info' });
    return;
  }
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.add('is-highlighted');
  setTimeout(() => card.classList.remove('is-highlighted'), 2400);
}

/* ------------------------------------------------------------------ */
/* 讨论                                                                */
/* ------------------------------------------------------------------ */

function quoteNote(note) {
  state.composer.noteId = note.id;
  state.composer.noteExcerpt = note.body.length > 120 ? `${note.body.slice(0, 120)}…` : note.body;
  renderComposerContext();
  dom.messageInput.focus();
}

function clearQuote() {
  state.composer.noteId = null;
  state.composer.noteExcerpt = null;
  renderComposerContext();
}

function setReply(message) {
  state.composer.replyTo = message.id;
  state.composer.replyExcerpt = message.body.length > 120 ? `${message.body.slice(0, 120)}…` : message.body;
  renderComposerContext();
  dom.messageInput.focus();
}

function clearReply() {
  state.composer.replyTo = null;
  state.composer.replyExcerpt = null;
  renderComposerContext();
}

async function sendMessage() {
  if (state.isMobile) {
    toast('手机端为只读模式，请在电脑端参与讨论。', { type: 'info' });
    return;
  }
  if (!state.snapshot?.permissions.canDiscuss) return;
  const body = dom.messageInput.value.trim();
  if (!body) return;
  if (body.length > 2000) {
    toast('讨论消息不能超过 2000 个字符。', { type: 'error' });
    return;
  }
  const payload = {
    messageId: newIdWithPrefix('msg'),
    body,
    replyTo: state.composer.replyTo,
    noteId: state.composer.noteId,
  };
  dom.sendMessage.disabled = true;
  try {
    await engine.enqueue('message.create', payload);
    dom.messageInput.value = '';
    clearReply();
    clearQuote();
    toast(state.lastStatus?.mode === 'offline' ? '消息已加入待同步队列。' : '消息已发送。');
  } catch (error) {
    toast(error.message || '发送失败。', { type: 'error' });
  } finally {
    dom.sendMessage.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* 评价                                                                */
/* ------------------------------------------------------------------ */

function openEvalDialog() {
  state.evalDirty = false;
  state.evalRestoreTried = false;
  renderEvalPanel(true);
  dom.evalDialog.showModal();
  void restoreEvaluationDraft();
}

function isEvalFieldFocused() {
  return document.activeElement === dom.evalLevel || document.activeElement === dom.evalReason;
}

function renderEvalPanel(force) {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const myRole = snapshot.viewer.role;
  const partnerRole = myRole === 'lead' ? 'co' : 'lead';
  const myEval = snapshot.evaluations[myRole];
  const partnerEval = snapshot.evaluations[partnerRole];

  const statusText = state.evalDirty ? '草稿（未保存）' : myEval ? (myEval.status === 'submitted' ? '已提交' : '草稿') : '未填写';
  dom.myEvalStatus.textContent = statusText;
  dom.myEvalStatus.className = `chip ${myEval?.status === 'submitted' && !state.evalDirty ? 'chip-ok' : 'chip-muted'}`;
  dom.myEvalStatus.classList.toggle('chip-warn', state.evalDirty);

  if (force || (!state.evalDirty && !isEvalFieldFocused())) {
    dom.evalLevel.value = myEval?.level ?? '';
    if (!state.evalDirty) dom.evalReason.value = myEval?.reason ?? '';
  }

  if (!state.evalDirty) {
    if (myEval?.status === 'submitted') dom.evalHint.textContent = '评价已正式提交；修改内容会退回草稿，需重新提交。';
    else if (myEval) dom.evalHint.textContent = '草稿会自动保存并与对方实时共享；正式提交需要联网确认。';
    else dom.evalHint.textContent = '编辑内容会自动保存草稿；正式提交需要联网并被服务端确认。';
  }

  dom.partnerEvalTitle.textContent = `对方评价（${ROLE_LABELS[partnerRole]}）`;
  renderPartnerEvaluation(partnerRole, partnerEval);
  renderEvalFinalBox(myEval, partnerEval);
}

function renderPartnerEvaluation(partnerRole, partnerEval) {
  clear(dom.partnerEvalBody);
  if (!partnerEval) {
    dom.partnerEvalStatus.textContent = '未填写';
    dom.partnerEvalStatus.className = 'chip chip-muted';
    dom.partnerEvalBody.append(el('p', { class: 'muted', text: '对方还没有开始填写评价。' }));
    return;
  }
  const submitted = partnerEval.status === 'submitted';
  dom.partnerEvalStatus.textContent = submitted ? '已提交' : '草稿（实时）';
  dom.partnerEvalStatus.className = `chip ${submitted ? 'chip-ok' : 'chip-warn'}`;
  dom.partnerEvalBody.append(
    el(
      'div',
      { class: 'partner-eval-summary' },
      el('span', { class: 'partner-level', text: partnerEval.level ? LEVEL_LABELS[partnerEval.level] : '未选择等级' }),
      el('span', { class: 'muted small', text: `更新于 ${formatTime(partnerEval.updatedAt)}` }),
    ),
    el('p', { class: 'preserve-lines partner-reason', text: partnerEval.reason || '（对方还没有填写理由）' }),
    submitted
      ? el('p', { class: 'muted small', text: '对方已正式提交。若修改内容，状态会回到草稿。' })
      : el('p', { class: 'muted small', text: '这是对方尚未提交的草稿，内容实时同步。' }),
  );
}

function renderEvalFinalBox(myEval, partnerEval) {
  const snapshot = state.snapshot;
  clear(dom.evalFinalBox);
  const bothSubmitted = myEval?.status === 'submitted' && partnerEval?.status === 'submitted';
  if (snapshot.viewer.role !== 'lead') {
    dom.evalFinalBox.hidden = true;
    return;
  }
  dom.evalFinalBox.hidden = false;
  const decision = snapshot.decisions.find((item) => item.round === snapshot.interview.round);
  if (snapshot.interview.status === 'completed' && decision) {
    dom.evalFinalBox.append(
      el('h3', { text: '最终结论（已完成）' }),
      el(
        'div',
        { class: 'final-summary' },
        el('span', { class: 'final-level', text: LEVEL_LABELS[decision.finalLevel] ?? decision.finalLevel }),
        el('p', { class: 'preserve-lines', text: decision.reason }),
        decision.divergenceNote
          ? el('p', { class: 'muted small preserve-lines', text: `分歧说明：${decision.divergenceNote}` })
          : null,
      ),
      el('p', { class: 'muted small', text: '如需继续评估，请在“管理 → 最终结论”中重新开启。' }),
    );
    return;
  }
  if (!bothSubmitted) {
    dom.evalFinalBox.append(
      el('h3', { text: '最终结论' }),
      el('p', {
        class: 'muted small',
        text: '两位考官都完成正式提交后，主考官才能确认最终结论。',
      }),
      el(
        'div',
        { class: 'eval-status-row' },
        el('span', { text: `${ROLE_LABELS.lead}：${myEval?.status === 'submitted' ? '已提交' : '未提交'}` }),
        el('span', { text: `${ROLE_LABELS.co}：${partnerEval?.status === 'submitted' ? '已提交' : '未提交'}` }),
      ),
    );
    return;
  }
  const diverged = myEval.level !== partnerEval.level;
  dom.evalFinalBox.append(
    el('h3', { text: '两位考官均已提交，可以确认最终结论' }),
    diverged
      ? el('p', { class: 'notice-inline', text: '两位推荐等级不同，确认时必须填写分歧说明。' })
      : el('p', { class: 'muted small', text: '两位推荐等级一致；确认时仍可补充最终理由。' }),
    el(
      'div',
      { class: 'form-actions' },
      el('button', {
        class: 'btn btn-primary btn-small',
        type: 'button',
        text: '前往确认最终结论',
        onclick: () => {
          dom.evalDialog.close();
          openManageDialog('final');
        },
      }),
    ),
  );
}

function scheduleEvalSave() {
  state.evalDirty = true;
  renderEvalPanel(false);
  void engine.saveEvaluationDraft({
    level: dom.evalLevel.value || null,
    reason: dom.evalReason.value,
  });
  clearTimeout(state.evalTimer);
  state.evalTimer = setTimeout(() => void persistEvaluation(false), 900);
}

async function persistEvaluation(submit) {
  if (!state.snapshot || state.isMobile) return false;
  const level = dom.evalLevel.value || null;
  const reason = dom.evalReason.value;
  if (submit) {
    if (!level) {
      showEvalError('请选择推荐等级。');
      return false;
    }
    if (!reason.trim()) {
      showEvalError('正式提交前请填写理由。');
      return false;
    }
    if (navigator.onLine === false) {
      showEvalError('正式提交评价需要联网并被服务端确认；草稿已保存在本机。');
      return false;
    }
  }
  dom.evalSubmit.disabled = true;
  dom.evalSave.disabled = true;
  try {
    const evaluation = await engine.saveEvaluation({ level, reason, submit });
    state.evalDirty = false;
    dom.evalError.hidden = true;
    if (submit) {
      dom.evalHint.textContent = '评价已正式提交，服务端已确认。';
      toast('评价已正式提交。');
    } else {
      dom.evalHint.textContent =
        evaluation.status === 'submitted'
          ? '内容未变化，评价仍为已提交状态。'
          : '草稿已保存到服务端，并与对方实时共享。';
    }
    renderEvalPanel(true);
    return true;
  } catch (error) {
    if (error.network) {
      dom.evalHint.textContent = '当前离线：草稿已保存在本机，恢复连接后会自动重试保存。';
      return false;
    }
    showEvalError(error.message || '保存失败。');
    return false;
  } finally {
    dom.evalSubmit.disabled = !state.snapshot?.permissions.canEvaluate;
    dom.evalSave.disabled = !state.snapshot?.permissions.canEvaluate;
  }
}

function showEvalError(message) {
  dom.evalError.textContent = message;
  dom.evalError.hidden = false;
}

async function restoreEvaluationDraft() {
  if (state.evalRestoreTried) return;
  state.evalRestoreTried = true;
  const draft = await engine.getEvaluationDraft();
  if (!draft || !state.snapshot) return;
  if (state.evalDirty || isEvalFieldFocused()) return;
  const myEval = state.snapshot.evaluations[state.snapshot.viewer.role];
  const draftTime = Date.parse(draft.createdAt || 0);
  const serverTime = myEval?.updatedAt ? Date.parse(myEval.updatedAt) : 0;
  if (draftTime > serverTime) {
    dom.evalLevel.value = draft.evaluation?.level ?? dom.evalLevel.value;
    dom.evalReason.value = draft.evaluation?.reason ?? draft.body ?? '';
    dom.evalHint.textContent = '已恢复本机保存但尚未同步的评价草稿；请检查后重新提交。';
    state.evalDirty = true;
    renderEvalPanel(false);
  }
}

/* ------------------------------------------------------------------ */
/* 主考官管理                                                          */
/* ------------------------------------------------------------------ */

function openManageDialog(focusSection = null) {
  if (state.isMobile) {
    toast('手机端为只读模式，请在电脑端进行管理操作。', { type: 'info' });
    return;
  }
  renderManage();
  dom.manageDialog.showModal();
  if (focusSection) {
    const target = dom.manageContent.querySelector(`[data-manage-section="${focusSection}"]`);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function manageSignature() {
  const snapshot = state.snapshot;
  if (!snapshot) return '';
  return JSON.stringify({
    round: snapshot.interview.round,
    status: snapshot.interview.status,
    requests: snapshot.joinRequests.map((request) => [request.id, request.status]),
    invites: snapshot.invites.map((invite) => [invite.id, invite.role]),
    decisions: snapshot.decisions.map((decision) => [decision.round, decision.finalLevel]),
    evaluations: [snapshot.evaluations.lead?.status, snapshot.evaluations.lead?.version, snapshot.evaluations.co?.status, snapshot.evaluations.co?.version],
    permissions: [snapshot.permissions.readOnly, snapshot.permissions.canReopen, snapshot.permissions.canConfirm],
  });
}

/** 管理面板打开时，如果申请/评价/状态变化则刷新；正在输入最终表单时不打断。 */
function maybeRefreshManage() {
  if (!dom.manageDialog.open) return;
  const next = manageSignature();
  if (next === state.manageSignature) return;
  const active = document.activeElement;
  if (active && dom.manageContent.contains(active) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) {
    state.manageSignature = next;
    return;
  }
  renderManage();
}

function renderManage() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const preserved = dom.manageContent.querySelector('#final-level')
    ? {
        level: dom.manageContent.querySelector('#final-level').value,
        reason: dom.manageContent.querySelector('#final-reason')?.value ?? '',
        divergence: dom.manageContent.querySelector('#final-divergence')?.value ?? '',
        error: dom.manageContent.querySelector('#final-error')?.textContent ?? '',
      }
    : null;
  clear(dom.manageContent);
  state.manageSignature = manageSignature();

  const joinSection = el('section', { class: 'manage-section', dataset: { manageSection: 'join' } }, el('h3', { text: '加入审核' }));
  const pending = snapshot.joinRequests.filter((request) => request.status === 'pending');
  if (!pending.length) {
    joinSection.append(el('p', { class: 'muted small', text: '没有待审核的副考官申请。' }));
  } else {
    for (const request of pending) {
      joinSection.append(
        el(
          'div',
          { class: 'request-row' },
          el('div', {}, el('strong', { text: request.name }), el('p', { class: 'muted small', text: `申请于 ${formatTime(request.createdAt)}` })),
          el(
            'div',
            { class: 'row-actions' },
            el('button', {
              class: 'btn btn-small btn-primary',
              type: 'button',
              text: '批准',
              disabled: snapshot.permissions.readOnly,
              onclick: () => void decideRequest(request.id, 'approve'),
            }),
            el('button', {
              class: 'btn btn-small btn-ghost',
              type: 'button',
              text: '拒绝',
              disabled: snapshot.permissions.readOnly,
              onclick: () => void decideRequest(request.id, 'reject'),
            }),
          ),
        ),
      );
    }
  }
  const history = snapshot.joinRequests.filter((request) => request.status !== 'pending').slice(0, 6);
  if (history.length) {
    joinSection.append(
      el('h4', { text: '最近处理' }),
      el(
        'ul',
        { class: 'plain-list' },
        history.map((request) =>
          el('li', {
            class: 'muted small',
            text: `${request.name} · ${request.status === 'approved' ? '已批准' : '已拒绝'} · ${formatTime(request.decidedAt || request.createdAt)}`,
          }),
        ),
      ),
    );
  }

  const inviteSection = el('section', { class: 'manage-section', dataset: { manageSection: 'invites' } }, el('h3', { text: '邀请链接' }));
  const invites = snapshot.invites;
  if (!invites.length) {
    inviteSection.append(el('p', { class: 'muted small', text: '当前没有未领取的邀请链接。' }));
  } else {
    for (const invite of invites) {
      const url = new URL(invite.url, location.origin).toString();
      inviteSection.append(
        el(
          'div',
          { class: 'invite-row' },
          el('span', { class: 'tag', text: ROLE_LABELS[invite.role] ?? invite.role }),
          el('code', { class: 'link-url small', text: url }),
          el('button', {
            class: 'btn btn-small btn-secondary',
            type: 'button',
            text: '复制',
            onclick: async () => {
              await copyText(url);
              toast('邀请链接已复制。');
            },
          }),
        ),
      );
    }
  }
  if (state.newInvite) {
    const url = new URL(state.newInvite.url, location.origin).toString();
    inviteSection.append(
      el(
        'div',
        { class: 'notice notice-ok' },
        el('p', { text: `已生成新的${ROLE_LABELS[state.newInvite.role]}邀请：` }),
        el('code', { class: 'link-url small', text: url }),
        el('button', {
          class: 'btn btn-small btn-secondary',
          type: 'button',
          text: '复制新链接',
          onclick: async () => {
            await copyText(url);
            toast('新邀请链接已复制。');
          },
        }),
        el('p', { class: 'muted small', text: '旧身份已被撤销，旧实时连接已关闭。' }),
      ),
    );
  }
  if (snapshot.permissions.canManageInvites && !snapshot.permissions.readOnly) {
    inviteSection.append(
      el(
        'div',
        { class: 'form-actions' },
        el('button', {
          class: 'btn btn-small btn-secondary',
          type: 'button',
          text: '重新邀请副考官',
          onclick: () => void reinvite('co'),
        }),
        el('button', {
          class: 'btn btn-small btn-secondary',
          type: 'button',
          text: '重新邀请面试人',
          onclick: () => void reinvite('candidate'),
        }),
      ),
      el('p', { class: 'form-hint', text: '重新邀请会撤销旧身份与旧实时连接；历史便签仍保留作者名快照。主考官链接丢失请使用 CLI 的 recover-lead。' }),
    );
  }

  const finalSection = el('section', { class: 'manage-section', dataset: { manageSection: 'final' } }, el('h3', { text: '最终结论' }));
  if (snapshot.permissions.canReopen) {
    const decision = snapshot.decisions.find((item) => item.round === snapshot.interview.round);
    finalSection.append(
      el('p', { class: 'muted small', text: `本次面试已完成（第 ${snapshot.interview.round} 轮）。` }),
      decision
        ? el(
            'div',
            { class: 'final-summary' },
            el('span', { class: 'final-level', text: LEVEL_LABELS[decision.finalLevel] ?? decision.finalLevel }),
            el('p', { class: 'preserve-lines', text: decision.reason }),
            decision.divergenceNote ? el('p', { class: 'muted small preserve-lines', text: `分歧说明：${decision.divergenceNote}` }) : null,
          )
        : null,
      el('button', {
        class: 'btn btn-secondary btn-small',
        type: 'button',
        text: '重新开启（进入新一轮评估，保留历史结论）',
        onclick: () => void reopenInterview(),
      }),
      el('p', { class: 'form-hint', text: '重新开启后两份评价正文保留但恢复为草稿，必须重新提交；旧轮次操作不会写入新轮次。' }),
    );
  } else if (snapshot.permissions.canConfirm) {
    finalSection.append(finalForm(snapshot));
  } else {
    finalSection.append(el('p', { class: 'muted small', text: '只有主考官可以确认最终结论。' }));
  }

  dom.manageContent.append(joinSection, inviteSection, finalSection);
  if (preserved) {
    const levelSelect = dom.manageContent.querySelector('#final-level');
    const reason = dom.manageContent.querySelector('#final-reason');
    const divergence = dom.manageContent.querySelector('#final-divergence');
    const error = dom.manageContent.querySelector('#final-error');
    if (levelSelect && preserved.level) levelSelect.value = preserved.level;
    if (reason) reason.value = preserved.reason;
    if (divergence) divergence.value = preserved.divergence;
    if (error && preserved.error) {
      error.textContent = preserved.error;
      error.hidden = false;
    }
  }
}

function finalForm(snapshot) {
  const leadEval = snapshot.evaluations.lead;
  const coEval = snapshot.evaluations.co;
  const both = leadEval?.status === 'submitted' && coEval?.status === 'submitted';
  const diverged = leadEval?.level !== coEval?.level;
  const levelSelect = el(
    'select',
    { id: 'final-level' },
    el('option', { value: '', text: '请选择最终推荐等级' }),
    Object.entries(LEVEL_LABELS).map(([value, label]) =>
      el('option', {
        value,
        text: label,
        selected: snapshot.decisions.find((item) => item.round === snapshot.interview.round)?.finalLevel === value,
      }),
    ),
  );
  const reason = el('textarea', { id: 'final-reason', rows: '4', maxlength: '4000', placeholder: '写明最终判断的依据；提交前必填' });
  const divergence = el('textarea', {
    id: 'final-divergence',
    rows: '3',
    maxlength: '4000',
    placeholder: diverged ? '两位考官等级不同，分歧说明必填' : '两位考官等级一致，可留空',
  });
  const error = el('p', { id: 'final-error', class: 'form-error', hidden: true });
  const statusRow = el(
    'div',
    { class: 'eval-status-row' },
    el('span', {}, '主考官：', el('strong', { text: leadEval?.status === 'submitted' ? '已提交' : '未提交' })),
    el('span', {}, '副考官：', el('strong', { text: coEval?.status === 'submitted' ? '已提交' : '未提交' })),
  );
  const form = el(
    'form',
    { class: 'form', onsubmit: (event) => event.preventDefault() },
    statusRow,
    !both ? el('p', { class: 'notice-inline', text: '两位考官都提交后才可以确认最终结论。' }) : null,
    el('label', { class: 'field' }, el('span', { text: '最终推荐等级' }), levelSelect),
    el('label', { class: 'field' }, el('span', { text: '最终理由' }), reason),
    el('label', { class: 'field' }, el('span', { text: diverged ? '分歧说明（必填）' : '分歧说明（可选）' }), divergence),
    error,
    el(
      'div',
      { class: 'form-actions' },
      el('button', {
        class: 'btn btn-primary',
        type: 'button',
        text: '确认最终结论',
        disabled: !both,
        onclick: async (event) => {
          const button = event.currentTarget;
          const finalLevel = levelSelect.value;
          const finalReason = reason.value.trim();
          const divergenceNote = divergence.value.trim();
          if (!finalLevel) {
            error.textContent = '请选择最终推荐等级。';
            error.hidden = false;
            return;
          }
          if (!finalReason) {
            error.textContent = '请填写最终理由。';
            error.hidden = false;
            return;
          }
          if (diverged && !divergenceNote) {
            error.textContent = '两位考官等级不同，必须填写分歧说明。';
            error.hidden = false;
            return;
          }
          if (!confirm('确认后面试板将只读，最终结论会写入报告；确定提交吗？')) return;
          button.disabled = true;
          try {
            await api(`/api/interviews/${interviewId}/complete`, {
              method: 'POST',
              body: {
                finalLevel,
                reason: finalReason,
                divergenceNote,
                expectedVersions: {
                  lead: leadEval?.version ?? null,
                  co: coEval?.version ?? null,
                },
              },
            });
            toast('最终结论已确认，面试板转为只读。');
            await engine.refresh();
            renderManage();
          } catch (err) {
            error.textContent = err.message || '确认失败。';
            error.hidden = false;
            button.disabled = false;
          }
        },
      }),
    ),
  );
  return form;
}

async function decideRequest(requestId, action) {
  try {
    await api(`/api/interviews/${interviewId}/join-requests/${requestId}/${action}`, { method: 'POST', body: {} });
    toast(action === 'approve' ? '已批准加入申请。' : '已拒绝加入申请。');
    await engine.refresh();
    if (dom.manageDialog.open) renderManage();
  } catch (error) {
    toast(error.message || '操作失败。', { type: 'error' });
  }
}

async function reinvite(role) {
  if (!confirm(`重新邀请会撤销当前${ROLE_LABELS[role]}的旧身份和旧实时连接。确定继续吗？`)) return;
  try {
    const data = await api(`/api/interviews/${interviewId}/reinvite`, { method: 'POST', body: { role } });
    state.newInvite = { role, url: data.url };
    toast('已生成新的邀请链接。');
    await engine.refresh();
    renderManage();
  } catch (error) {
    toast(error.message || '重新邀请失败。', { type: 'error' });
  }
}

async function reopenInterview() {
  if (!confirm('重新开启会进入新一轮评估，本轮评价恢复为草稿，历史结论保留。确定继续吗？')) return;
  try {
    await api(`/api/interviews/${interviewId}/reopen`, { method: 'POST', body: {} });
    state.newInvite = null;
    toast('已重新开启，进入新一轮评估。');
    await engine.refresh();
    renderManage();
  } catch (error) {
    toast(error.message || '重新开启失败。', { type: 'error' });
  }
}

/* ------------------------------------------------------------------ */
/* 草稿                                                                */
/* ------------------------------------------------------------------ */

function updateDraftsButton() {
  const count = state.drafts.length;
  dom.draftsButton.hidden = count === 0;
  dom.draftsCount.textContent = String(count);
}

function openDrafts() {
  renderDrafts();
  dom.draftsDialog.showModal();
}

function renderDrafts() {
  clear(dom.draftsList);
  if (!state.drafts.length) {
    dom.draftsList.append(el('p', { class: 'muted', text: '没有本地草稿。' }));
    return;
  }
  for (const draft of state.drafts) {
    dom.draftsList.append(
      el(
        'article',
        { class: 'draft-card' },
        el(
          'header',
          { class: 'draft-head' },
          el('strong', { text: draft.title }),
          el('time', { class: 'muted small', text: formatTime(draft.createdAt) }),
        ),
        el('p', { class: 'draft-reason', text: draft.reason }),
        el('p', { class: 'preserve-lines draft-body', text: draft.body || '（无正文）' }),
        el(
          'div',
          { class: 'row-actions' },
          el('button', {
            class: 'btn btn-small btn-secondary',
            type: 'button',
            text: '复制正文',
            onclick: async () => {
              await copyText(draft.body || '');
              toast('草稿正文已复制。');
            },
          }),
          el('button', {
            class: 'btn btn-small btn-ghost danger',
            type: 'button',
            text: '删除草稿',
            onclick: async () => {
              await engine.deleteDraft(draft.id);
              renderDrafts();
            },
          }),
        ),
      ),
    );
  }
}

/* ------------------------------------------------------------------ */
/* 事件绑定                                                            */
/* ------------------------------------------------------------------ */

function bindStaticEvents() {
  dom.filters.addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    state.filter = button.dataset.filter;
    for (const chip of dom.filters.querySelectorAll('[data-filter]')) {
      chip.classList.toggle('is-active', chip === button);
    }
    renderBoard();
  });

  dom.newNoteButton.addEventListener('click', () => openNoteDialog());
  dom.groupManageButton.addEventListener('click', () => openGroupDialog());
  dom.noteForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveNoteFromDialog();
  });
  dom.groupAddForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = dom.groupNewName.value.trim();
    if (!name) return;
    try {
      await engine.enqueue('group.create', { groupId: newIdWithPrefix('group'), name });
      dom.groupNewName.value = '';
      toast('分组已添加。');
      renderGroupList();
    } catch (error) {
      toast(error.message || '添加分组失败。', { type: 'error' });
    }
  });

  dom.evalButton.addEventListener('click', () => openEvalDialog());
  dom.evalLevel.addEventListener('change', scheduleEvalSave);
  dom.evalReason.addEventListener('input', scheduleEvalSave);
  dom.evalSave.addEventListener('click', () => void persistEvaluation(false));
  dom.evalSubmit.addEventListener('click', () => void persistEvaluation(true));

  dom.manageButton.addEventListener('click', () => openManageDialog());

  dom.sendMessage.addEventListener('click', () => void sendMessage());
  dom.messageInput.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void sendMessage();
    }
  });

  dom.discussionToggle.addEventListener('click', () => {
    dom.discussionPanel.classList.toggle('is-open');
    document.body.classList.toggle('discussion-open', dom.discussionPanel.classList.contains('is-open'));
  });
  dom.discussionClose.addEventListener('click', () => {
    dom.discussionPanel.classList.remove('is-open');
    document.body.classList.remove('discussion-open');
  });

  dom.draftsButton.addEventListener('click', () => openDrafts());
  dom.lockedDrafts.addEventListener('click', () => openDrafts());

  for (const button of document.querySelectorAll('[data-close-dialog]')) {
    button.addEventListener('click', () => button.closest('dialog')?.close());
  }
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  }
  dom.noteDialog.addEventListener('close', () => {
    state.editingNoteId = null;
  });
  window.addEventListener('beforeunload', () => {
    engine.stop();
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
