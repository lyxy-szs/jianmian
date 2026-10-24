const DB_NAME = 'interview-partner';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('当前浏览器不支持 IndexedDB'));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('snapshots')) {
          db.createObjectStore('snapshots', { keyPath: 'scope' });
        }
        if (!db.objectStoreNames.contains('queue')) {
          const store = db.createObjectStore('queue', { keyPath: 'id' });
          store.createIndex('byScope', 'scope');
        }
        if (!db.objectStoreNames.contains('drafts')) {
          const store = db.createObjectStore('drafts', { keyPath: 'id' });
          store.createIndex('byScope', 'scope');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB 打开失败'));
    });
  }
  return dbPromise;
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 操作失败'));
  });
}

async function withStore(name, mode, fn) {
  const db = await openDb();
  const transaction = db.transaction(name, mode);
  const store = transaction.objectStore(name);
  const value = await fn(store);
  await new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB 事务失败'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB 事务取消'));
  });
  return value;
}

export function scopeFor(interviewId, identity) {
  const participant = identity?.participantId ?? 'anon';
  const generation = identity?.generation ?? 0;
  return `${interviewId}:${participant}:g${generation}`;
}

export function loadIdentity(interviewId) {
  try {
    const raw = localStorage.getItem(`interview.identity.${interviewId}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveIdentity(interviewId, identity) {
  try {
    localStorage.setItem(
      `interview.identity.${interviewId}`,
      JSON.stringify({
        participantId: identity.participantId,
        role: identity.role,
        generation: identity.generation,
      }),
    );
  } catch {
    /* ignore */
  }
}

/** 缓存与队列均以面试、身份和会话代次隔离。 */
export async function saveSnapshot(scope, snapshot) {
  await withStore('snapshots', 'readwrite', (store) =>
    wrap(store.put({ scope, snapshot, savedAt: new Date().toISOString() })),
  );
}

export async function getSnapshot(scope) {
  return withStore('snapshots', 'readonly', (store) => wrap(store.get(scope)));
}

export async function addQueuedOp(scope, op) {
  const record = {
    ...op,
    id: `${scope}|${op.opId}`,
    scope,
    queuedAt: op.queuedAt ?? Date.now(),
  };
  await withStore('queue', 'readwrite', (store) => wrap(store.put(record)));
  return record;
}

export async function listQueuedOps(scope) {
  const rows = await withStore('queue', 'readonly', (store) => wrap(store.index('byScope').getAll(scope)));
  return rows.sort((a, b) => (a.queuedAt === b.queuedAt ? a.id.localeCompare(b.id) : a.queuedAt - b.queuedAt));
}

export async function removeQueuedOp(id) {
  await withStore('queue', 'readwrite', (store) => wrap(store.delete(id)));
}

export async function queuedOpCount(scope) {
  return withStore('queue', 'readonly', (store) => wrap(store.index('byScope').count(scope)));
}

export async function saveDraft(draft) {
  const record = {
    createdAt: draft.createdAt ?? new Date().toISOString(),
    ...draft,
  };
  await withStore('drafts', 'readwrite', (store) => wrap(store.put(record)));
  return record;
}

export async function listDrafts(scope) {
  const rows = await withStore('drafts', 'readonly', (store) => wrap(store.index('byScope').getAll(scope)));
  return rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function deleteDraft(id) {
  await withStore('drafts', 'readwrite', (store) => wrap(store.delete(id)));
}
