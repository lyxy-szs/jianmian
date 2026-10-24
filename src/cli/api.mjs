import { readAdminToken } from '../secrets.mjs';

export class CliError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'CliError';
    this.cause = cause;
    this.exitCode = 1;
  }
}

export function createAdminClient(config) {
  async function request(pathname, { method = 'GET', body, timeoutMs = 5000 } = {}) {
    const token = readAdminToken(config.adminTokenPath);
    if (!token) {
      throw new CliError('未找到本机管理凭据。请确认服务已启动过，并在项目目录运行 CLI。');
    }
    const headers = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response;
    try {
      response = await fetch(`${config.baseUrl}${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error.name === 'TimeoutError') {
        throw new CliError(`连接 ${config.baseUrl} 超时。请检查服务是否正常运行。`, { cause: error });
      }
      throw new CliError(`无法连接 ${config.baseUrl}。请先在另一个终端运行 npm start。`, { cause: error });
    }
    const type = response.headers.get('content-type') ?? '';
    const payload = type.includes('application/json') ? await response.json() : await response.text();
    if (!response.ok) {
      const message = payload?.error?.message || (typeof payload === 'string' ? payload : '') || `请求失败（HTTP ${response.status}）`;
      throw new CliError(message);
    }
    return payload;
  }

  return {
    status: () => request('/api/admin/status'),
    create: (body) => request('/api/admin/interviews', { method: 'POST', body }),
    links: (interviewId) => request(`/api/admin/interviews/${encodeURIComponent(interviewId)}/links`),
    reinvite: (interviewId, role) =>
      request(`/api/admin/interviews/${encodeURIComponent(interviewId)}/reinvite`, {
        method: 'POST',
        body: { role, confirm: true },
      }),
    recoverLead: (interviewId) =>
      request(`/api/admin/interviews/${encodeURIComponent(interviewId)}/recover-lead`, {
        method: 'POST',
        body: { confirm: true },
      }),
    report: async (interviewId, format = 'md') => {
      const token = readAdminToken(config.adminTokenPath);
      if (!token) throw new CliError('未找到本机管理凭据。请确认服务已启动过。');
      let response;
      try {
        response = await fetch(
          `${config.baseUrl}/api/admin/interviews/${encodeURIComponent(interviewId)}/report?format=${format}`,
          { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) },
        );
      } catch (error) {
        throw new CliError(`无法连接 ${config.baseUrl}。请先运行 npm start。`, { cause: error });
      }
      const textBody = await response.text();
      if (!response.ok) {
        let message = `导出失败（HTTP ${response.status}）`;
        try {
          message = JSON.parse(textBody)?.error?.message || message;
        } catch {
          /* ignore */
        }
        throw new CliError(message);
      }
      return textBody;
    },
    stop: () => request('/api/admin/stop', { method: 'POST', body: {} }),
  };
}
