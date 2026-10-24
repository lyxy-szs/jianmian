/** 统一的业务错误：HTTP 层据此返回状态码与中文说明。 */
export class ApiError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, code = 'bad_request', details) => new ApiError(400, code, message, details);
export const unauthorized = (message = '请先通过有效链接进入面试。', code = 'unauthorized') =>
  new ApiError(401, code, message);
export const forbidden = (message = '当前身份没有该操作权限。', code = 'forbidden') =>
  new ApiError(403, code, message);
export const notFound = (message = '未找到对应内容。', code = 'not_found') => new ApiError(404, code, message);
export const conflict = (message, code = 'conflict', details) => new ApiError(409, code, message, details);
export const gone = (message = '链接已失效。', code = 'gone') => new ApiError(410, code, message);

export function assert(condition, factory) {
  if (!condition) throw (typeof factory === 'function' ? factory() : factory);
}
