export class ApiError extends Error {
  constructor(message, { status = 0, code = 'request_failed', details = undefined, network = false } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.network = network;
  }
}

/** 统一 API 请求；网络错误标记为 network，供离线队列判断。 */
export async function api(path, { method = 'GET', body, timeoutMs = 12000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      signal: controller.signal,
    });
  } catch (error) {
    throw new ApiError('网络连接不可用，请检查服务是否运行。', {
      status: 0,
      code: error.name === 'AbortError' ? 'timeout' : 'network_error',
      network: true,
    });
  } finally {
    clearTimeout(timer);
  }
  const type = response.headers.get('content-type') ?? '';
  let payload = null;
  if (type.includes('application/json')) {
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
  } else {
    payload = await response.text();
  }
  if (!response.ok) {
    throw new ApiError(payload?.error?.message || `请求失败（HTTP ${response.status}）`, {
      status: response.status,
      code: payload?.error?.code || 'request_failed',
      details: payload?.error?.details,
    });
  }
  return payload;
}

export const ROLE_LABELS = { lead: '主考官', co: '副考官', candidate: '面试人' };

export const LEVEL_LABELS = {
  strong_yes: '强烈推荐',
  yes: '推荐',
  hold: '待定',
  no: '不推荐',
};

export function formatTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `今天 ${time}`;
  return `${date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })} ${time}`;
}

export function formatDateTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function copyText(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  }
  return Promise.resolve(fallbackCopy(text));
}

function fallbackCopy(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand('copy');
  } finally {
    area.remove();
  }
}
