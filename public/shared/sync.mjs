import { api } from './api.mjs';
import * as store from './store.mjs';

const DRAFT_TITLES = {
  'note.create': '未同步的新便签',
  'note.update': '未同步的便签修改',
  'note.delete': '未同步的便签删除',
  'note.move': '未同步的便签移动',
  'note.flags': '未同步的标记修改',
  'group.create': '未同步的新分组',
  'group.rename': '未同步的分组改名',
  'group.delete': '未同步的分组删除',
  'message.create': '未发送的讨论消息',
};

function nowIso() {
  return new Date().toISOString();
}

function makeOpId(type) {
  const random =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `${type.replace('.', '-')}-${random}`;
}

/**
 * 离线优先同步引擎：
 * - 在线写操作也走队列，保证 opId 幂等与顺序一致；
 * - 断线时本地乐观更新并写入 IndexedDB；
 * - 重连后按队列顺序重放，冲突项转本地草稿；
 * - SSE 只负责提示“有变化”，客户端拉取当前角色可见快照。
 */
export class SyncEngine {
  constructor({ interviewId, onSnapshot, onStatus, onPresence, onAuthError, onDrafts, onNotice }) {
    this.interviewId = interviewId;
    this.onSnapshot = onSnapshot;
    this.onStatus = onStatus;
    this.onPresence = onPresence;
    this.onAuthError = onAuthError;
    this.onDrafts = onDrafts;
    this.onNotice = onNotice;
    this.snapshot = null;
    this.scope = null;
    this.mode = 'online';
    this.es = null;
    this.flushing = false;
    this.refreshing = null;
    this.refreshQueued = false;
    this.refreshTimer = null;
    this.retryTimer = null;
    this.stopped = false;
    this.#bindNetworkEvents();
  }

  #bindNetworkEvents() {
    window.addEventListener('offline', () => {
      if (this.stopped) return;
      this.#emitStatus('offline', { message: '网络已断开，编辑会先保存在本机。' });
    });
    window.addEventListener('online', () => {
      if (this.stopped) return;
      this.refresh().then(() => this.flush());
    });
  }

  async start() {
    const identity = store.loadIdentity(this.interviewId);
    this.scope = store.scopeFor(this.interviewId, identity);
    if (navigator.onLine === false) {
      await this.#loadCache();
      return;
    }
    try {
      const data = await api(`/api/interviews/${this.interviewId}/snapshot`, { timeoutMs: 8000 });
      await this.#adopt(data.snapshot);
      this.#emitStatus('online');
      this.#connect();
      await this.flush();
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        this.onAuthError?.({ message: error.message, code: error.code });
        return;
      }
      await this.#loadCache(error);
    }
  }

  async #loadCache(failure = null) {
    try {
      const cached = await store.getSnapshot(this.scope);
      if (cached) {
        this.snapshot = cached.snapshot;
        this.onSnapshot?.(cached.snapshot, { fromCache: true, savedAt: cached.savedAt });
        await this.#emitStatus('offline', {
          message: '当前处于离线状态，展示本机缓存；编辑会排队等待同步。',
          cachedAt: cached.savedAt,
        });
        await this.#emitDrafts();
        this.#startRetryLoop();
        return;
      }
    } catch {
      /* ignore */
    }
    await this.#emitStatus('offline', {
      message: failure?.message || '离线且没有本机缓存；请恢复连接后刷新。',
      cacheMiss: true,
    });
    this.#startRetryLoop();
  }

  /** 服务恢复后自动重连（EventSource 在初次失败时尚未建立）。 */
  #startRetryLoop() {
    if (this.retryTimer || this.stopped) return;
    this.retryTimer = setInterval(async () => {
      if (this.stopped) return;
      try {
        const data = await api(`/api/interviews/${this.interviewId}/snapshot`, { timeoutMs: 5000 });
        clearInterval(this.retryTimer);
        this.retryTimer = null;
        await this.#adopt(data.snapshot);
        await this.#emitStatus('online');
        this.#connect();
        await this.flush();
      } catch (error) {
        if (error.status === 401 || error.status === 403) {
          clearInterval(this.retryTimer);
          this.retryTimer = null;
          this.#handleRevoked(error.message);
        }
      }
    }, 5000);
  }

  async #adopt(snapshot) {
    const identity = {
      participantId: snapshot.viewer.participantId,
      role: snapshot.viewer.role,
      generation: snapshot.viewer.generation,
    };
    const previous = store.loadIdentity(this.interviewId);
    const nextScope = store.scopeFor(this.interviewId, identity);
    this.scope = nextScope;
    if (
      previous &&
      (previous.participantId !== identity.participantId || previous.generation !== identity.generation)
    ) {
      await this.#lockOldScope(previous);
    }
    store.saveIdentity(this.interviewId, identity);
    this.snapshot = snapshot;
    this.onSnapshot?.(snapshot, {});
    try {
      await store.saveSnapshot(this.scope, snapshot);
    } catch {
      /* 存储失败不阻断在线协作 */
    }
  }

  async #lockOldScope(previous) {
    const oldScope = store.scopeFor(this.interviewId, previous);
    try {
      const ops = await store.listQueuedOps(oldScope);
      for (const op of ops) {
        await store.saveDraft({
          id: `${this.scope}|locked|${op.opId}`,
          scope: this.scope,
          kind: 'operation',
          title: DRAFT_TITLES[op.type] ?? '身份更新后未同步的操作',
          body: describeOp(op),
          reason: '身份已更新（重新邀请或恢复），旧身份队列已锁定，未继续写入。',
        });
        await store.removeQueuedOp(op.id);
      }
    } catch {
      /* ignore */
    }
  }

  #connect() {
    if (this.stopped) return;
    if (this.es) this.es.close();
    const cursor = this.snapshot?.eventCursor ?? 0;
    const es = new EventSource(`/api/interviews/${this.interviewId}/events?since=${encodeURIComponent(cursor)}`);
    this.es = es;
    es.onopen = () => {
      if (this.stopped) return;
      this.#emitStatus('online');
      this.refresh().then(() => this.flush());
    };
    es.onerror = () => {
      if (this.stopped) return;
      this.#emitStatus('offline', { message: '实时连接中断，正在重连；编辑会先保存在本机。' });
    };
    es.onmessage = (event) => {
      if (this.stopped) return;
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      if (data.type === 'presence') {
        if (this.snapshot) {
          this.snapshot.online = { ...(this.snapshot.online ?? {}), ...(data.payload?.online ?? {}) };
          // 不存在于在线集合中的角色置为离线
          for (const role of ['lead', 'co', 'candidate']) {
            this.snapshot.online[role] = Boolean(data.payload?.online?.[role]);
          }
          this.onPresence?.(this.snapshot.online);
        }
        return;
      }
      if (data.type === 'revoked') {
        this.#handleRevoked(data.reason || '身份已失效，请使用新的邀请链接。');
        return;
      }
      if (data.type === 'resync') {
        this.#scheduleRefresh();
        return;
      }
      if (this.mode === 'offline') this.#emitStatus('online');
      this.#scheduleRefresh();
    };
  }

  #scheduleRefresh() {
    if (this.refreshTimer || this.stopped) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refresh();
    }, 120);
  }

  async refresh() {
    if (this.stopped) return null;
    if (this.refreshing) {
      // 合并并发刷新，但在当前请求结束后再拉取一次，避免调用方拿到旧快照。
      this.refreshQueued = true;
      return this.refreshing.then(() => (this.refreshQueued ? this.refresh() : this.snapshot));
    }
    this.refreshQueued = false;
    this.refreshing = (async () => {
      try {
        const data = await api(`/api/interviews/${this.interviewId}/snapshot`);
        await this.#adopt(data.snapshot);
        if (this.mode === 'offline') this.#emitStatus('online');
        try {
          const pending = await store.queuedOpCount(this.scope);
          if (pending > 0 && !this.flushing && this.mode === 'online') {
            setTimeout(() => this.flush(), 0);
          }
        } catch {
          /* ignore */
        }
        return data.snapshot;
      } catch (error) {
        if (error.status === 401 || error.status === 403) {
          this.#handleRevoked(error.message);
        } else if (error.network) {
          this.#emitStatus('offline', { message: '与服务的连接中断，编辑会先保存在本机。' });
        }
        return null;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  #handleRevoked(message) {
    this.stopped = true;
    this.es?.close();
    this.es = null;
    this.#convertQueueToDrafts(message || '身份已失效，队列已停止写入。').finally(() => {
      this.onAuthError?.({ message: message || '身份已失效，请让主考官重新邀请。', code: 'revoked' });
    });
  }

  async #convertQueueToDrafts(reason) {
    if (!this.scope) return;
    try {
      const ops = await store.listQueuedOps(this.scope);
      for (const op of ops) {
        await store.saveDraft({
          id: `${this.scope}|revoked|${op.opId}`,
          scope: this.scope,
          kind: 'operation',
          title: DRAFT_TITLES[op.type] ?? '未同步的操作',
          body: describeOp(op),
          reason: reason || '身份已失效，未同步内容已保留为本地草稿。',
        });
        await store.removeQueuedOp(op.id);
      }
      await this.#emitDrafts();
      await this.#emitStatus('locked', { message: reason, pending: 0 });
    } catch {
      /* ignore */
    }
  }

  stop() {
    this.stopped = true;
    this.es?.close();
    this.es = null;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.retryTimer) clearInterval(this.retryTimer);
  }

  async #emitStatus(mode, extra = {}) {
    this.mode = mode;
    let pending = 0;
    if (this.scope) {
      try {
        pending = await store.queuedOpCount(this.scope);
      } catch {
        pending = 0;
      }
    }
    this.onStatus?.({ mode, pending, ...extra });
  }

  async #emitDrafts() {
    if (!this.scope) return;
    try {
      this.onDrafts?.(await store.listDrafts(this.scope));
    } catch {
      /* ignore */
    }
  }

  async enqueue(type, payload, { baseRevision } = {}) {
    if (!this.snapshot) throw new Error('页面尚未加载完成');
    const op = {
      opId: makeOpId(type),
      type,
      payload,
      round: this.snapshot.interview.round,
      baseRevision: baseRevision ?? null,
    };
    await store.addQueuedOp(this.scope, op);
    this.#applyOptimistic(op);
    this.onSnapshot?.(this.snapshot, { pending: true });
    try {
      await store.saveSnapshot(this.scope, this.snapshot);
    } catch {
      /* ignore */
    }
    await this.#emitStatus(this.mode === 'offline' ? 'offline' : 'online');
    if (this.mode === 'online') await this.flush();
    return op.opId;
  }

  async flush() {
    if (this.flushing || this.stopped || !this.scope) return;
    if (this.mode === 'offline' || this.mode === 'locked') return;
    let ops = [];
    try {
      ops = await store.listQueuedOps(this.scope);
    } catch {
      return;
    }
    if (!ops.length) {
      await this.#emitStatus('online');
      return;
    }
    this.flushing = true;
    const notices = new Map();
    await this.#emitStatus('syncing');
    try {
      for (let index = 0; index < ops.length; index += 20) {
        const chunk = ops.slice(index, index + 20);
        let data;
        try {
          data = await api(`/api/interviews/${this.interviewId}/operations`, {
            method: 'POST',
            body: {
              ops: chunk.map((op) => ({
                opId: op.opId,
                type: op.type,
                payload: op.payload,
                round: op.round,
                baseRevision: op.baseRevision ?? undefined,
              })),
            },
          });
        } catch (error) {
          if (error.status === 401 || error.status === 403) {
            this.#handleRevoked(error.message);
            return;
          }
          if (error.network || error.status >= 500) {
            await this.#emitStatus('offline', { message: '同步失败，队列保留，稍后自动重试。' });
            return;
          }
          for (const op of chunk) {
            await store.removeQueuedOp(op.id);
            await this.#moveToDraft(op, { message: error.message });
          }
          continue;
        }
        const results = Array.isArray(data.results) ? data.results : [];
        for (let i = 0; i < chunk.length; i += 1) {
          const op = chunk[i];
          const result = results[i];
          if (result && (result.status === 'ok' || result.status === 'duplicate')) {
            await store.removeQueuedOp(op.id);
            for (const warning of result.warnings ?? []) {
              if (warning?.message) notices.set(`warn:${warning.code}:${warning.message}`, warning.message);
            }
          } else {
            await store.removeQueuedOp(op.id);
            await this.#moveToDraft(op, result ?? { message: '服务端未返回结果，已保留为本地草稿。' });
            if (result?.message) notices.set(`draft:${op.opId}`, result.message);
          }
        }
      }
      await this.refresh();
      await this.#emitDrafts();
      if (this.onNotice) {
        for (const message of notices.values()) this.onNotice({ message });
      }
      if (this.mode !== 'offline' && this.mode !== 'locked') await this.#emitStatus('online');
    } finally {
      this.flushing = false;
    }
  }

  async #moveToDraft(op, result) {
    try {
      await store.saveDraft({
        id: `${this.scope}|draft|${op.opId}`,
        scope: this.scope,
        kind: op.type.startsWith('message') ? 'message' : op.type.startsWith('group') ? 'group' : 'note',
        title: DRAFT_TITLES[op.type] ?? '未同步的操作',
        body: describeOp(op),
        reason: result?.message || '操作未能同步，已保留为本地草稿。',
      });
    } catch {
      /* ignore */
    }
  }

  #applyOptimistic(op) {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    const payload = op.payload ?? {};
    const at = nowIso();
    const fallbackGroup = snapshot.groups.find((group) => group.isSystem) ?? snapshot.groups[0];
    const findGroup = (id) => snapshot.groups.find((group) => group.id === id);

    switch (op.type) {
      case 'note.create': {
        const group = findGroup(payload.groupId) ?? fallbackGroup;
        snapshot.notes.push({
          id: payload.noteId,
          round: snapshot.interview.round,
          body: payload.body,
          groupId: group?.id ?? '',
          groupName: group?.name ?? '未分类',
          authorId: snapshot.viewer.participantId,
          authorGeneration: snapshot.viewer.generation,
          authorName: snapshot.viewer.name,
          important: Boolean(payload.important),
          needsDiscussion: Boolean(payload.needsDiscussion),
          version: 0,
          createdAt: at,
          updatedAt: at,
          lastMovedBy: null,
          lastMovedAt: null,
          sortOrder: Number.MAX_SAFE_INTEGER,
          localPending: true,
        });
        break;
      }
      case 'note.update': {
        const note = snapshot.notes.find((item) => item.id === payload.noteId);
        if (note) {
          note.body = payload.body;
          note.version = Number(note.version) + 1;
          note.updatedAt = at;
          note.localPending = true;
        }
        break;
      }
      case 'note.delete': {
        snapshot.notes = snapshot.notes.filter((item) => item.id !== payload.noteId);
        break;
      }
      case 'note.move': {
        const note = snapshot.notes.find((item) => item.id === payload.noteId);
        const group = findGroup(payload.groupId) ?? fallbackGroup;
        if (note) {
          note.groupId = group?.id ?? note.groupId;
          note.groupName = group?.name ?? '未分类';
          note.lastMovedBy = snapshot.viewer.name;
          note.lastMovedAt = at;
          note.localPending = true;
        }
        break;
      }
      case 'note.flags': {
        const note = snapshot.notes.find((item) => item.id === payload.noteId);
        if (note) {
          if (payload.important != null) note.important = Boolean(payload.important);
          if (payload.needsDiscussion != null) note.needsDiscussion = Boolean(payload.needsDiscussion);
          note.localPending = true;
        }
        break;
      }
      case 'group.create': {
        snapshot.groups.push({
          id: payload.groupId,
          name: payload.name,
          sortOrder: snapshot.groups.length + 1,
          isSystem: false,
          localPending: true,
        });
        break;
      }
      case 'group.rename': {
        const group = findGroup(payload.groupId);
        if (group) {
          group.name = payload.name;
          group.localPending = true;
          for (const note of snapshot.notes) {
            if (note.groupId === group.id) note.groupName = payload.name;
          }
        }
        break;
      }
      case 'group.delete': {
        const group = findGroup(payload.groupId);
        if (group && !group.isSystem) {
          for (const note of snapshot.notes) {
            if (note.groupId === group.id) {
              note.groupId = fallbackGroup?.id ?? '';
              note.groupName = fallbackGroup?.name ?? '未分类';
              note.localPending = true;
            }
          }
          snapshot.groups = snapshot.groups.filter((item) => item.id !== group.id);
        }
        break;
      }
      case 'message.create': {
        const reply = payload.replyTo
          ? snapshot.messages.find((message) => message.id === payload.replyTo)
          : null;
        const note = payload.noteId ? snapshot.notes.find((item) => item.id === payload.noteId) : null;
        snapshot.messages.push({
          id: payload.messageId,
          round: snapshot.interview.round,
          body: payload.body,
          authorId: snapshot.viewer.participantId,
          authorName: snapshot.viewer.name,
          replyTo: payload.replyTo ?? null,
          replyExcerpt: reply ? (reply.body.length > 120 ? `${reply.body.slice(0, 120)}…` : reply.body) : null,
          noteId: note ? note.id : null,
          noteExcerpt: note ? (note.body.length > 120 ? `${note.body.slice(0, 120)}…` : note.body) : payload.noteId ? '原便签已删除' : null,
          noteDeleted: Boolean(payload.noteId && !note),
          createdAt: at,
          localPending: true,
        });
        break;
      }
      default:
        break;
    }
  }

  async saveEvaluation({ level, reason, submit }) {
    const data = await api(`/api/interviews/${this.interviewId}/evaluations/me`, {
      method: 'PUT',
      body: { level, reason, submit },
    });
    try {
      await store.deleteDraft(`${this.scope}|evaluation|me`);
      await this.#emitDrafts();
    } catch {
      /* ignore */
    }
    if (this.snapshot) {
      this.snapshot.evaluations[this.snapshot.viewer.role] = data.evaluation;
      this.onSnapshot?.(this.snapshot, {});
      try {
        await store.saveSnapshot(this.scope, this.snapshot);
      } catch {
        /* ignore */
      }
    }
    if (this.mode === 'offline') await this.#emitStatus('online');
    return data.evaluation;
  }

  async setReady(ready) {
    const data = await api(`/api/interviews/${this.interviewId}/ready`, { method: 'POST', body: { ready } });
    if (this.snapshot) {
      this.snapshot.ready = data.ready;
      this.snapshot.readyAt = data.readyAt;
      this.onSnapshot?.(this.snapshot, {});
      try {
        await store.saveSnapshot(this.scope, this.snapshot);
      } catch {
        /* ignore */
      }
    }
    return data;
  }

  async saveLocalDraft({ kind, title, body, reason, entityKey, extra }) {
    const id = `${this.scope}|${kind}|${entityKey ?? 'default'}`;
    await store.saveDraft({
      id,
      scope: this.scope,
      kind,
      title,
      body,
      reason,
      createdAt: nowIso(),
      ...(extra ?? {}),
    });
    await this.#emitDrafts();
  }

  async saveEvaluationDraft({ level, reason }) {
    await this.saveLocalDraft({
      kind: 'evaluation',
      title: '我的评价草稿',
      body: reason,
      reason: '尚未正式提交的评价草稿（只保存在本机）',
      entityKey: 'me',
      extra: { evaluation: { level, reason } },
    });
  }

  async getEvaluationDraft() {
    if (!this.scope) return null;
    try {
      const drafts = await store.listDrafts(this.scope);
      return drafts.find((draft) => draft.kind === 'evaluation') ?? null;
    } catch {
      return null;
    }
  }

  async listDrafts() {
    return store.listDrafts(this.scope);
  }

  async deleteDraft(id) {
    await store.deleteDraft(id);
    await this.#emitDrafts();
  }
}

function describeOp(op) {
  const payload = op.payload ?? {};
  if (payload.body) return payload.body;
  if (payload.name) return `分组名称：${payload.name}`;
  if (payload.groupId) return `目标分组：${payload.groupId}`;
  if (payload.noteId) return `便签：${payload.noteId}`;
  return JSON.stringify(payload);
}
