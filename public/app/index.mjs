import { api, copyText, ROLE_LABELS } from '/shared/api.mjs';
import { el, byId, clear, setHidden } from '/shared/dom.mjs';
import { initTheme } from '/shared/theme.mjs';
import { toast } from '/shared/toast.mjs';

initTheme();
registerServiceWorker();

const form = byId('create-form');
const submitButton = byId('create-submit');
const demoButton = byId('demo-button');
const resultBox = byId('created-result');
const sessionBanner = byId('session-banner');

void showExistingSession();

async function showExistingSession() {
  try {
    const session = await api('/api/session');
    if (!session.authenticated) return;
    setHidden(sessionBanner, false);
    clear(sessionBanner).append(
      el('span', { text: `当前浏览器已领取「${ROLE_LABELS[session.role] ?? session.role}」身份：${session.name || '未命名'}` }),
      el('a', { class: 'btn btn-small btn-secondary', href: session.redirect, text: '继续进入面试' }),
    );
  } catch {
    setHidden(sessionBanner, true);
  }
}

function formValues() {
  const data = new FormData(form);
  return {
    candidateName: String(data.get('candidateName') ?? '').trim(),
    position: String(data.get('position') ?? '').trim(),
    leadName: String(data.get('leadName') ?? '').trim(),
    internalBrief: String(data.get('internalBrief') ?? '').trim(),
    internalFocus: String(data.get('internalFocus') ?? '').trim(),
    publicBrief: String(data.get('publicBrief') ?? '').trim(),
  };
}

async function createInterview(mode) {
  const body = { mode };
  if (mode !== 'demo') {
    const values = formValues();
    if (!values.candidateName || !values.position || !values.leadName) {
      toast('请先填写候选人姓名、应聘岗位和主考官姓名。', { type: 'error' });
      return;
    }
    Object.assign(body, values);
  }
  submitButton.disabled = true;
  demoButton.disabled = true;
  submitButton.textContent = '正在创建…';
  try {
    const data = await api('/api/interviews', { method: 'POST', body });
    renderCreated(data, mode);
  } catch (error) {
    toast(error.message || '创建失败，请稍后重试。', { type: 'error', timeout: 8000 });
  } finally {
    submitButton.disabled = false;
    demoButton.disabled = false;
    submitButton.textContent = '创建空白面试';
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void createInterview('blank');
});

demoButton.addEventListener('click', () => {
  void createInterview('demo');
});

function renderCreated(data, mode) {
  setHidden(form, true);
  setHidden(resultBox, false);
  const links = [
    { role: 'lead', url: data.links.lead, note: '一次性领取，领取后请保留该浏览器；丢失后可用 CLI 恢复。' },
    { role: 'co', url: data.links.co, note: '在另一个浏览器窗口打开，提交姓名后等待主考官审批。' },
    { role: 'candidate', url: data.links.candidate, note: '建议使用第三个浏览器环境（或第二台设备的独立窗口）。' },
  ];
  clear(resultBox).append(
    el(
      'div',
      { class: 'created-head' },
      el('p', { class: 'eyebrow', text: mode === 'demo' ? '示例面试已创建' : '面试已创建' }),
      el('h2', { text: `${data.interview.candidateName} · ${data.interview.position}` }),
      el('p', {
        class: 'muted',
        text: '请把三个链接分别发给对应角色。同一浏览器只能保持一个活动身份，因此验收时请使用普通窗口 + 无痕窗口 + 另一个浏览器。',
      }),
    ),
    el(
      'div',
      { class: 'link-list' },
      links.map((item) =>
        el(
          'div',
          { class: 'link-card', dataset: { role: item.role } },
          el('div', { class: 'link-card-head' }, el('strong', { text: ROLE_LABELS[item.role] }), el('span', { class: 'tag', text: item.role })),
          el('code', { class: 'link-url', text: item.url }),
          el('p', { class: 'muted small', text: item.note }),
          el(
            'div',
            { class: 'link-actions' },
            el('button', {
              class: 'btn btn-small btn-secondary',
              type: 'button',
              text: '复制链接',
              onclick: async () => {
                await copyText(item.url);
                toast('链接已复制。');
              },
            }),
            el('a', {
              class: 'btn btn-small btn-ghost',
              href: item.url,
              target: '_blank',
              rel: 'noreferrer',
              text: '打开',
            }),
          ),
        ),
      ),
    ),
    el(
      'div',
      { class: 'created-foot' },
      el('a', { class: 'btn btn-primary', href: data.links.lead, text: '我是主考官，领取身份并进入' }),
      el('button', {
        class: 'btn btn-ghost',
        type: 'button',
        text: '再创建一场',
        onclick: () => {
          setHidden(resultBox, true);
          setHidden(form, false);
          form.reset();
        },
      }),
    ),
  );
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* 离线缓存不可用不影响在线使用 */
    });
  });
}
