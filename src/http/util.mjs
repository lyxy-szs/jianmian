import fs from 'node:fs/promises';
import path from 'node:path';
import { ApiError } from '../domain/errors.mjs';

export function json(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

export function text(res, status, body, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

export function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

export function serializeCookie(name, value, { maxAge, httpOnly = true, sameSite = 'Lax', path: cookiePath = '/' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${cookiePath}`, `SameSite=${sameSite}`];
  if (httpOnly) parts.push('HttpOnly');
  if (Number.isFinite(maxAge)) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  return parts.join('; ');
}

export function appendCookie(res, cookie) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) res.setHeader('Set-Cookie', cookie);
  else if (Array.isArray(existing)) res.setHeader('Set-Cookie', [...existing, cookie]);
  else res.setHeader('Set-Cookie', [existing, cookie]);
}

export function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '').toLowerCase();
    if (!type.includes('application/json')) {
      reject(new ApiError(415, 'unsupported_media_type', '请求必须使用 application/json。'));
      return;
    }
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new ApiError(413, 'payload_too_large', `请求体超过 ${Math.floor(limit / 1024)} KiB 上限。`));
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new ApiError(400, 'invalid_json', '请求体必须是 JSON 对象。'));
          return;
        }
        resolve(parsed);
      } catch {
        reject(new ApiError(400, 'invalid_json', '请求体不是合法 JSON。'));
      }
    });
    req.on('error', (error) => reject(error));
  });
}

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
});

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export async function serveStatic(req, res, publicDir, pathname, extraHeaders = {}) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    text(res, 405, 'Method Not Allowed');
    return;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    text(res, 400, 'Bad Request');
    return;
  }
  if (decoded.includes('\0')) {
    text(res, 400, 'Bad Request');
    return;
  }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const resolved = path.resolve(publicDir, relative);
  const root = path.resolve(publicDir);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    text(res, 403, 'Forbidden');
    return;
  }
  const base = path.basename(resolved);
  if (base.startsWith('.') || base.endsWith('.sqlite') || resolved.includes(`${path.sep}data${path.sep}`)) {
    text(res, 404, 'Not Found');
    return;
  }
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    text(res, 404, 'Not Found');
    return;
  }
  if (!stat.isFile()) {
    text(res, 404, 'Not Found');
    return;
  }
  const extension = path.extname(resolved).toLowerCase();
  const body = await fs.readFile(resolved);
  const headers = {
    'Content-Type': MIME[extension] ?? 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': extension === '.html' ? 'no-cache' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  };
  if (extension === '.html') {
    headers['Content-Security-Policy'] = CSP;
    headers['Referrer-Policy'] = 'same-origin';
  }
  if (resolved.endsWith('sw.js')) headers['Service-Worker-Allowed'] = '/';
  res.writeHead(200, headers);
  if (req.method === 'HEAD') res.end();
  else res.end(body);
}

export function sendError(res, error, log = console) {
  if (res.headersSent) {
    res.end();
    return;
  }
  const status = Number.isInteger(error?.status) ? error.status : 500;
  if (status >= 500) {
    log.error?.(error);
  }
  const payload = {
    error: {
      code: error?.code || 'internal_error',
      message: status >= 500 ? '服务器内部错误，请稍后重试。' : error?.message || '请求失败。',
    },
  };
  if (error?.details !== undefined) payload.error.details = error.details;
  json(res, status, payload);
}

export function safePathForLog(pathname) {
  return pathname
    .split('/')
    .map((segment) => (segment.length > 24 ? ':token' : segment))
    .join('/');
}
