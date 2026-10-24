import { api, ROLE_LABELS, formatDateTime } from '/shared/api.mjs';
import { el, byId, clear } from '/shared/dom.mjs';
import { initTheme } from '/shared/theme.mjs';
import { toast } from '/shared/toast.mjs';

initTheme();
registerServiceWorker();

const root = byId('join-root');
const token = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
let pollTimer = null;
let application = null;

void bootstrap();

async function bootstrap() {
  let invitation;
  try {
    const data = await api(`/api/invitations/${encodeURIComponent(token)}`);
    invitation = data.invitation;
  } catch (error) {
    renderFatal(error.message || '链接无效。');
    return;
  }
  if (!invitation || invitation.state === 'missing') {
    renderFatal('链接无效，请向主考官索取新的邀请链接。');
    return;
  }
  if (invitation.state === 'consumed' || invitation.state === 'revoked' || invitation.state === 'expired') {
    await renderUnavailable(invitation);
    return;
  }

  const session = await getSession();
  if (session?.authenticated && session.interviewId === invitation.interview.id && session.role === invitation.role) {
    renderAlreadyClaimed(invitation, session);
    return;
  }

  if (invitation.role === 'co') {
    if (invitation.seatClaimed) {
      clear(root).append(
        interviewSummary(invitation),
        el('div', { class: 'notice notice-warn' }, el('p', { text: '副考官席位已被领取。如需更换副考官，请让主考官重新邀请。' })),
        el('a', { class: 'btn btn-ghost', href: '/', text: '返回首页' }),
      );
      return;
    }
    const existing = await checkApplication(invitation);
    if (!existing) renderApplyForm(invitation);
  } else {
    renderClaim(invitation);
  }
}

async function getSession() {
  try {
    return await api('/api/session');
  } catch {
    return null;
  }
}

function interviewSummary(invitation) {
  return el(
    'div',
    { class: 'join-summary' },
    el('p', { class: 'eyebrow', text: ROLE_LABELS[invitation.role] ?? '面试' }),
    el('h1', { text: invitation.interview.candidateName }),
    el('p', { class: 'muted', text: `应聘岗位：${invitation.interview.position}` }),
  );
}

function renderFatal(message) {
  clear(root).append(
    el('div', { class: 'empty-state' }, el('div', { class: 'empty-icon', text: '⚠' }), el('h1', { text: '无法加入' }), el('p', { text: message }), el('a', { class: 'btn btn-secondary', href: '/', text: '返回首页' })),
  );
}

async function renderUnavailable(invitation) {
  const reasons = {
    consumed: '该链接已被领取，无法再次使用。如果你就是领取人，请回到原浏览器继续；否则请让主考官重新邀请。',
    revoked: '该链接已被撤销。请向主考官索取最新的邀请链接。',
    expired: '该链接已过期。请让主考官重新生成邀请链接。',
  };
  const session = await getSession();
  let approvedRequest = null;
  try {
    const data = await api('/api/join-requests/me');
    if (
      data.request?.status === 'approved' &&
      data.request.interview?.id === invitation.interview.id
    ) {
      approvedRequest = data.request;
    }
  } catch {
    /* 没有申请 Cookie 时保持普通不可用提示 */
  }
  clear(root).append(
    interviewSummary(invitation),
    el('div', { class: 'notice notice-warn' }, el('p', { text: reasons[invitation.state] || '链接不可用。' })),
    approvedRequest
      ? el(
          'div',
          { class: 'notice notice-ok' },
          el('p', { text: '你的加入申请已获批准，可以凭当前浏览器的申请记录进入面试板。' }),
          el('button', { class: 'btn btn-primary', type: 'button', text: '进入面试板', onclick: () => void enter() }),
        )
      : null,
    session?.authenticated && session.interviewId === invitation.interview.id
      ? el('a', { class: 'btn btn-primary', href: session.redirect, text: '进入我已有的身份' })
      : null,
    el('a', { class: 'btn btn-ghost', href: '/', text: '返回首页' }),
  );
}

function renderAlreadyClaimed(invitation, session) {
  clear(root).append(
    interviewSummary(invitation),
    el('div', { class: 'notice notice-ok' }, el('p', { text: `这个浏览器已领取「${ROLE_LABELS[session.role]}」身份：${session.name || '未命名'}。` })),
    el('a', { class: 'btn btn-primary', href: session.redirect, text: '进入面试' }),
  );
}

function renderClaim(invitation) {
  const isLead = invitation.role === 'lead';
  clear(root).append(
    interviewSummary(invitation),
    el('p', {
      class: 'lead-text',
      text: isLead
        ? '你将领取本场面试的主考官身份。该链接为一次性链接，领取后请在这个浏览器中继续操作。'
        : '你将领取本场面试的面试人身份。页面只会展示公开信息，不会出现内部便签或评价。',
    }),
    el(
      'div',
      { class: 'form-actions' },
      el('button', {
        class: 'btn btn-primary',
        type: 'button',
        text: isLead ? '领取主考官身份' : '领取面试人身份',
        onclick: (event) => void claim(invitation, event.currentTarget),
      }),
      el('a', { class: 'btn btn-ghost', href: '/', text: '返回首页' }),
    ),
    el('p', { class: 'form-hint', text: `链接有效期至 ${formatDateTime(invitation.expiresAt)}。` }),
  );
}

async function claim(invitation, button) {
  button.disabled = true;
  button.textContent = '正在领取…';
  try {
    const data = await api(`/api/invitations/${encodeURIComponent(token)}/claim`, { method: 'POST', body: {} });
    location.assign(data.redirect);
  } catch (error) {
    toast(error.message || '领取失败。', { type: 'error' });
    button.disabled = false;
    button.textContent = invitation.role === 'lead' ? '领取主考官身份' : '领取面试人身份';
  }
}

function renderApplyForm(invitation) {
  const input = el('input', {
    name: 'name',
    required: true,
    maxlength: '80',
    autocomplete: 'name',
    placeholder: '例如：王琳',
    id: 'applicant-name',
  });
  const submit = el('button', { class: 'btn btn-primary', type: 'submit', text: '提交加入申请' });
  const form = el(
    'form',
    {
      class: 'form',
      onsubmit: async (event) => {
        event.preventDefault();
        const name = String(input.value ?? '').trim();
        if (!name) {
          toast('请填写姓名。', { type: 'error' });
          return;
        }
        submit.disabled = true;
        submit.textContent = '提交中…';
        try {
          await api(`/api/invitations/${encodeURIComponent(token)}/apply`, { method: 'POST', body: { name } });
          await checkApplication(invitation, true);
        } catch (error) {
          toast(error.message || '提交失败。', { type: 'error' });
          submit.disabled = false;
          submit.textContent = '提交加入申请';
        }
      },
    },
    el('label', { class: 'field' }, el('span', { text: '你的姓名' }), input),
    el('div', { class: 'form-actions' }, submit),
    el('p', { class: 'form-hint', text: '主考官批准后，本页面会自动进入副考官面试板。' }),
  );
  clear(root).append(
    interviewSummary(invitation),
    el('p', { class: 'lead-text', text: '你正在申请副考官席位。提交后需等待主考官审批，审批前不会看到任何候选人内部资料。' }),
    form,
  );
  input.focus();
}

async function checkApplication(invitation, justSubmitted = false) {
  try {
    const data = await api('/api/join-requests/me');
    application = data.request;
  } catch (error) {
    if (error.status === 401) {
      if (justSubmitted) renderApplyForm(invitation);
      return false;
    }
    if (justSubmitted) renderApplyForm(invitation);
    toast(error.message || '无法读取申请状态。', { type: 'error' });
    return false;
  }
  if (!application) return false;
  if (application.interview?.id !== invitation.interview.id) {
    application = null;
    return false;
  }
  if (application.status === 'approved') {
    renderApproved(invitation);
    clearInterval(pollTimer);
    pollTimer = null;
    // 审批通过后自动兑换会话并进入副考官页面。
    setTimeout(() => void enter(), 600);
    return true;
  }
  if (application.status === 'rejected') {
    renderRejected(invitation);
    clearInterval(pollTimer);
    pollTimer = null;
    return true;
  }
  renderPending(invitation);
  startPolling(invitation);
  return true;
}

function startPolling(invitation) {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    void checkApplication(invitation);
  }, 3000);
}

function renderPending(invitation) {
  clear(root).append(
    interviewSummary(invitation),
    el(
      'div',
      { class: 'waiting-box' },
      el('div', { class: 'spinner', 'aria-hidden': 'true' }),
      el('h2', { text: '申请已提交，等待主考官审批' }),
      el('p', { class: 'muted', text: '本页面会自动刷新状态。审批通过后，你会自动进入副考官面试板。' }),
      application?.name ? el('p', { class: 'muted', text: `申请人：${application.name}` }) : null,
    ),
    el('a', { class: 'btn btn-ghost', href: '/', text: '返回首页' }),
  );
}

function renderApproved(invitation) {
  clear(root).append(
    interviewSummary(invitation),
    el('div', { class: 'notice notice-ok' }, el('p', { text: '主考官已批准你的加入申请，正在进入面试板…' })),
    el('button', { class: 'btn btn-primary', type: 'button', text: '立即进入', onclick: () => void enter() }),
  );
}

function renderRejected(invitation) {
  clear(root).append(
    interviewSummary(invitation),
    el('div', { class: 'notice notice-warn' }, el('p', { text: '本次加入申请未通过。如有疑问，请联系主考官。' })),
    el('a', { class: 'btn btn-ghost', href: '/', text: '返回首页' }),
  );
}

async function enter() {
  try {
    const data = await api('/api/join-requests/me/enter', { method: 'POST', body: {} });
    location.assign(data.redirect);
  } catch (error) {
    toast(error.message || '进入失败，请重新申请。', { type: 'error' });
    renderFatal(error.message || '进入失败，请重新申请。');
  }
}

window.addEventListener('beforeunload', () => {
  if (pollTimer) clearInterval(pollTimer);
});

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
