import { formatTime } from '/shared/api.mjs';
import { el, byId, clear } from '/shared/dom.mjs';
import { initTheme } from '/shared/theme.mjs';
import { toast } from '/shared/toast.mjs';
import { SyncEngine } from '/shared/sync.mjs';

initTheme();
registerServiceWorker();

const root = byId('candidate-root');
const connectionPill = byId('connection-pill');
const interviewId = location.pathname.split('/').filter(Boolean)[1];
let engine = null;
let readyBusy = false;
let offlineMessage = '';

engine = new SyncEngine({
  interviewId,
  onSnapshot: (snapshot, meta) => render(snapshot, meta),
  onStatus: (status) => {
    offlineMessage = status.mode === 'offline' ? status.message || '当前离线' : '';
    updateConnection(status);
    if (engine?.snapshot) render(engine.snapshot, {});
  },
  onAuthError: ({ message }) => renderLocked(message),
});
void engine.start();

function updateConnection(status) {
  const modes = {
    online: ['pill-ok', '实时连接正常'],
    syncing: ['pill-warn', '同步中…'],
    offline: ['pill-warn', '离线 · 自动重连中'],
    locked: ['pill-danger', '连接已失效'],
  };
  const [className, label] = modes[status.mode] ?? ['pill-muted', '连接中…'];
  connectionPill.className = `pill ${className}`;
  connectionPill.textContent = label;
}

function renderLocked(message) {
  connectionPill.className = 'pill pill-danger';
  connectionPill.textContent = '身份已失效';
  clear(root).append(
    el('div', { class: 'empty-state' }, el('div', { class: 'empty-icon', text: '🔒' }), el('h1', { text: '无法访问' }), el('p', { text: message }), el('a', { class: 'btn btn-secondary', href: '/', text: '返回首页' })),
  );
}

function render(snapshot, meta) {
  if (!snapshot) return;
  const { interview } = snapshot;
  const completed = interview.status === 'completed';
  const statusChip = el('span', { class: `chip chip-status chip-${interview.status}`, text: interview.statusLabel });

  const children = [
    el(
      'div',
      { class: 'candidate-head' },
      el('p', { class: 'eyebrow', text: '面试进行中' }),
      el('h1', { text: interview.candidateName }),
      el('p', { class: 'muted', text: interview.position }),
      statusChip,
    ),
  ];

  if (meta?.fromCache) {
    children.push(
      el('div', { class: 'notice notice-warn' }, el('p', { text: `当前展示本机缓存（${formatTime(meta.savedAt)}）。连接恢复后会自动更新。` })),
    );
  }
  if (offlineMessage) {
    children.push(el('div', { class: 'notice notice-warn' }, el('p', { text: offlineMessage })));
  }

  if (interview.publicBrief) {
    children.push(
      el(
        'section',
        { class: 'public-brief' },
        el('h2', { text: '面试说明' }),
        el('p', { class: 'preserve-lines', text: interview.publicBrief }),
      ),
    );
  }

  if (completed) {
    children.push(
      el(
        'section',
        { class: 'end-state' },
        el('div', { class: 'end-icon', text: '✓' }),
        el('h2', { text: '本次面试已结束' }),
        el('p', { class: 'muted', text: '感谢你的时间。如有后续安排，招聘团队会与你联系。' }),
      ),
    );
    clear(root).append(...children);
    return;
  }

  children.push(
    el(
      'section',
      { class: 'ready-box' },
      el('h2', { text: snapshot.ready ? '你已确认准备就绪' : '准备好了吗？' }),
      el('p', {
        class: 'muted',
        text: snapshot.ready
          ? '考官端已经看到你的准备状态。请在候场区等待面试开始。'
          : '确认后，考官端会实时看到你已经准备好。面试沟通使用现场或既有会议工具。',
      }),
      el(
        'div',
        { class: 'desktop-only ready-actions' },
        el('button', {
          class: snapshot.ready ? 'btn btn-secondary' : 'btn btn-primary',
          type: 'button',
          disabled: readyBusy,
          text: readyBusy ? '正在提交…' : snapshot.ready ? '取消准备状态' : '我已准备好',
          onclick: () => void toggleReady(!snapshot.ready),
        }),
      ),
      el('p', { class: 'mobile-only-note', text: '手机端仅可查看状态；确认准备请使用电脑端。' }),
    ),
  );

  if (snapshot.readyAt) {
    children.push(el('p', { class: 'muted small', text: `准备状态更新时间：${formatTime(snapshot.readyAt)}` }));
  }

  clear(root).append(...children);
}

async function toggleReady(next) {
  readyBusy = true;
  if (engine.snapshot) render(engine.snapshot, {});
  try {
    await engine.setReady(next);
    toast(next ? '已通知考官你准备好了。' : '已取消准备状态。');
  } catch (error) {
    if (error.network) toast('准备状态需要联网确认，请恢复连接后重试。', { type: 'error' });
    else toast(error.message || '操作失败。', { type: 'error' });
  } finally {
    readyBusy = false;
    if (engine.snapshot) render(engine.snapshot, {});
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
