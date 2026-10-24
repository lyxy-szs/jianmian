import http from 'node:http';
import crypto from 'node:crypto';
import { LIMITS } from '../config.mjs';
import { appendEvent, newId, nowIso, sha256, tx } from '../db/index.mjs';
import {
  authenticate,
  claimSeat,
  createJoinRequest,
  enterApprovedRequest,
  findJoinRequestByToken,
  getJoinRequestPublicView,
  getParticipantByRole,
  inspectInvitation,
  invitationPath,
  recoverLeadSeat,
  reinviteSeat,
  rejectJoinRequest,
  approveJoinRequest,
  requireCandidate,
  requireExaminer,
  requireLead,
  ROLE_LABELS,
} from '../domain/auth.mjs';
import { createInterview, getInterview, listInterviews } from '../domain/interviews.mjs';
import { runOperation } from '../domain/operations.mjs';
import { completeInterview, reopenInterview, saveEvaluation } from '../domain/evaluations.mjs';
import { buildCandidateSnapshot, buildInternalSnapshot } from '../domain/snapshot.mjs';
import { buildReportForPage, reportMarkdownFor } from '../domain/report.mjs';
import { ApiError, badRequest, conflict, forbidden, notFound, unauthorized } from '../domain/errors.mjs';
import { EventHub } from './hub.mjs';
import {
  appendCookie,
  json,
  parseCookies,
  readJson,
  safePathForLog,
  sendError,
  serializeCookie,
  serveStatic,
  text,
} from './util.mjs';

const COOKIE_SESSION = 'iv_sid';
const COOKIE_REQUEST = 'iv_jr';

function sameOriginGuard(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw forbidden('请求来源不合法。', 'bad_origin');
  }
  if (parsed.host !== req.headers.host) throw forbidden('拒绝跨站请求。', 'bad_origin');
}

export function createApp({ config, db, secrets, adminToken, logger = console, onStop = null }) {
  const hub = new EventHub();
  const startedAt = nowIso();
  const adminTokenHash = sha256(adminToken);

  const server = http.createServer((req, res) => {
    const started = Date.now();
    const url = new URL(req.url, 'http://127.0.0.1');
    res.on('finish', () => {
      if (url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/admin/')) {
        logger.info?.(
          `[http] ${req.method} ${safePathForLog(url.pathname)} ${res.statusCode} ${Date.now() - started}ms`,
        );
      }
    });
    handle(req, res, url).catch((error) => sendError(res, error, logger));
  });

  async function handle(req, res, url) {
    const { pathname } = url;

    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }

    const page = matchPage(pathname);
    if (page) {
      const extra = {};
      if (page === 'sw.js') extra['Service-Worker-Allowed'] = '/';
      await serveStatic(req, res, config.publicDir, page, extra);
      return;
    }

    if (pathname.startsWith('/app/') || pathname.startsWith('/shared/') || pathname.startsWith('/styles/')) {
      await serveStatic(req, res, config.publicDir, pathname);
      return;
    }

    await serveStatic(req, res, config.publicDir, '/index.html');
  }

  function matchPage(pathname) {
    if (pathname === '/') return 'index.html';
    if (pathname === '/sw.js') return 'sw.js';
    if (pathname === '/favicon.svg') return 'favicon.svg';
    if (/^\/join\/[^/]+$/.test(pathname)) return 'join.html';
    if (/^\/candidate\/join\/[^/]+$/.test(pathname)) return 'join.html';
    if (/^\/interviews\/[^/]+\/(lead|co)$/.test(pathname)) return 'board.html';
    if (/^\/interviews\/[^/]+\/candidate$/.test(pathname)) return 'candidate.html';
    if (/^\/interviews\/[^/]+\/report$/.test(pathname)) return 'report.html';
    return null;
  }

  function currentAuth(req) {
    const cookies = parseCookies(req.headers.cookie);
    return { auth: authenticate(db, cookies[COOKIE_SESSION]), cookies };
  }

  function authForInterview(req, interviewId) {
    const { auth, cookies } = currentAuth(req);
    if (!auth) throw unauthorized('请先通过有效链接进入面试。');
    if (auth.interview.id !== interviewId) throw forbidden('当前身份不属于该面试。', 'wrong_interview');
    return { auth, cookies };
  }

  function requireAdmin(req) {
    const header = String(req.headers.authorization || '');
    if (!header.startsWith('Bearer ')) throw unauthorized('缺少本机管理凭据。', 'admin_unauthorized');
    const given = sha256(header.slice(7).trim());
    const expected = adminTokenHash;
    if (given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
      throw unauthorized('本机管理凭据无效。', 'admin_unauthorized');
    }
  }

  function setSessionCookie(res, token) {
    appendCookie(
      res,
      serializeCookie(COOKIE_SESSION, token, { maxAge: Math.floor(config.sessionTtlMs / 1000), httpOnly: true }),
    );
  }

  function setRequestCookie(res, token) {
    appendCookie(
      res,
      serializeCookie(COOKIE_REQUEST, token, { maxAge: Math.floor(config.inviteTtlMs / 1000), httpOnly: true }),
    );
  }

  function clearRequestCookie(res) {
    appendCookie(res, serializeCookie(COOKIE_REQUEST, '', { maxAge: 0, httpOnly: true }));
  }

  function broadcast(events) {
    if (events?.length) hub.broadcast(events);
  }

  function snapshotFor(auth) {
    const onlineRoles = hub.onlineRoles(auth.interview.id);
    if (auth.role === 'candidate') {
      return buildCandidateSnapshot({ db, auth, onlineRoles });
    }
    return buildInternalSnapshot({ db, auth, secrets, onlineRoles });
  }

  async function handleApi(req, res, url) {
    const { pathname } = url;
    const method = req.method;
    const isAdmin = pathname.startsWith('/api/admin/');

    if (method !== 'GET' && method !== 'HEAD' && !isAdmin) sameOriginGuard(req);

    /* ---------------- 会话 ---------------- */
    if (method === 'GET' && pathname === '/api/session') {
      const { auth } = currentAuth(req);
      if (!auth) {
        json(res, 200, { authenticated: false });
        return;
      }
      json(res, 200, {
        authenticated: true,
        interviewId: auth.interview.id,
        role: auth.role,
        name: auth.participant.name ?? '',
        participantId: auth.participant.id,
        redirect:
          auth.role === 'candidate'
            ? `/interviews/${auth.interview.id}/candidate`
            : `/interviews/${auth.interview.id}/${auth.role}`,
      });
      return;
    }

    /* ---------------- 创建面试 ---------------- */
    if (method === 'POST' && pathname === '/api/interviews') {
      const body = await readJson(req, LIMITS.requestBody);
      const mode = body.mode === 'demo' ? 'demo' : 'blank';
      const { interview, invitations } = createInterview({ db, secrets, config, fields: body, mode });
      json(res, 201, {
        interviewId: interview.id,
        interview: {
          id: interview.id,
          candidateName: interview.candidate_name,
          position: interview.position,
          status: interview.status,
        },
        links: {
          lead: invitations.lead.url,
          co: invitations.co.url,
          candidate: invitations.candidate.url,
        },
      });
      return;
    }

    /* ---------------- 邀请与申请 ---------------- */
    const invitationMatch = pathname.match(/^\/api\/invitations\/([^/]+)$/);
    if (method === 'GET' && invitationMatch) {
      const token = decodeURIComponent(invitationMatch[1]);
      const result = inspectInvitation(db, token);
      json(res, 200, { invitation: result });
      return;
    }

    const claimMatch = pathname.match(/^\/api\/invitations\/([^/]+)\/claim$/);
    if (method === 'POST' && claimMatch) {
      const token = decodeURIComponent(claimMatch[1]);
      const inspected = inspectInvitation(db, token);
      if (inspected.state === 'missing') throw new ApiError(404, 'invite_missing', '链接无效，请向主考官索取新的邀请链接。');
      if (inspected.role === 'co') throw badRequest('副考官需要通过加入申请进入，请填写姓名提交审核。', 'use_apply');
      const result = claimSeat({ db, secrets, config, token, expectedRole: inspected.role });
      setSessionCookie(res, result.sessionToken);
      clearRequestCookie(res);
      broadcast(result.events);
      json(res, 200, { redirect: result.redirect, role: result.participant.role, name: result.participant.name });
      return;
    }

    const applyMatch = pathname.match(/^\/api\/invitations\/([^/]+)\/apply$/);
    if (method === 'POST' && applyMatch) {
      const token = decodeURIComponent(applyMatch[1]);
      const body = await readJson(req, LIMITS.requestBody);
      const result = createJoinRequest({ db, secrets, config, token, name: body.name });
      setRequestCookie(res, result.requestToken);
      broadcast(result.events);
      json(res, 200, { status: result.status, interview: result.interview });
      return;
    }

    if (method === 'GET' && pathname === '/api/join-requests/me') {
      const { cookies } = currentAuth(req);
      const request = findJoinRequestByToken(db, cookies[COOKIE_REQUEST]);
      if (!request) throw unauthorized('没有找到加入申请记录，请重新通过邀请链接申请。', 'request_missing');
      json(res, 200, { request: getJoinRequestPublicView(db, request) });
      return;
    }

    if (method === 'POST' && pathname === '/api/join-requests/me/enter') {
      const { cookies } = currentAuth(req);
      const result = enterApprovedRequest({ db, config, requestToken: cookies[COOKIE_REQUEST] });
      setSessionCookie(res, result.sessionToken);
      json(res, 200, { redirect: result.redirect });
      return;
    }

    /* ---------------- 面试数据 ---------------- */
    const interviewMatch = pathname.match(/^\/api\/interviews\/([^/]+)(\/.*)?$/);
    if (interviewMatch) {
      const interviewId = interviewMatch[1];
      const rest = interviewMatch[2] || '';
      await handleInterviewApi(req, res, url, interviewId, rest, method);
      return;
    }

    /* ---------------- 本机管理 ---------------- */
    if (isAdmin) {
      await handleAdminApi(req, res, url, method, pathname);
      return;
    }

    throw notFound('接口不存在。');
  }

  async function handleInterviewApi(req, res, url, interviewId, rest, method) {
    if (method === 'GET' && rest === '/snapshot') {
      const { auth } = authForInterview(req, interviewId);
      json(res, 200, { snapshot: snapshotFor(auth) });
      return;
    }

    if (method === 'GET' && rest === '/events') {
      const { auth } = authForInterview(req, interviewId);
      handleEvents(req, res, url, auth);
      return;
    }

    if (method === 'POST' && rest === '/operations') {
      const { auth } = authForInterview(req, interviewId);
      requireExaminer(auth);
      const body = await readJson(req, LIMITS.requestBody);
      if (!Array.isArray(body.ops) || body.ops.length === 0) throw badRequest('ops 必须是非空数组。', 'ops_required');
      if (body.ops.length > LIMITS.operationsPerBatch) {
        throw badRequest(`单次最多提交 ${LIMITS.operationsPerBatch} 条操作。`, 'too_many_operations');
      }
      const results = [];
      const events = [];
      for (const raw of body.ops) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          results.push({ status: 'invalid', reason: 'invalid_operation', message: '操作格式无效。' });
          continue;
        }
        const opId = typeof raw.opId === 'string' ? raw.opId.trim() : '';
        if (!opId || opId.length < 8 || opId.length > 100) {
          results.push({ ...raw, status: 'invalid', reason: 'invalid_op_id', message: '操作 ID 缺失或格式无效。' });
          continue;
        }
        if (typeof raw.type !== 'string' || !raw.type) {
          results.push({ opId, status: 'invalid', reason: 'invalid_type', message: '操作类型缺失。' });
          continue;
        }
        try {
          const { result, events: emitted } = runOperation({
            db,
            interview: auth.interview,
            participant: auth.participant,
            role: auth.role,
            op: { ...raw, opId },
          });
          results.push(result);
          events.push(...emitted);
        } catch (error) {
          logger.error?.('[operations] 操作执行失败', error);
          results.push({
            opId,
            type: raw.type,
            status: error instanceof ApiError && error.status === 403 ? 'forbidden' : 'error',
            reason: error.code ?? 'server_error',
            message: error instanceof ApiError ? error.message : '服务端处理该操作时出错，正文已保留为本地草稿。',
          });
        }
      }
      broadcast(events);
      json(res, 200, { results });
      return;
    }

    if (method === 'PUT' && rest === '/evaluations/me') {
      const { auth } = authForInterview(req, interviewId);
      requireExaminer(auth);
      const body = await readJson(req, LIMITS.requestBody);
      const { evaluation, events } = saveEvaluation({
        db,
        interview: auth.interview,
        participant: auth.participant,
        input: body,
      });
      broadcast(events);
      json(res, 200, { evaluation });
      return;
    }

    if (method === 'POST' && rest === '/complete') {
      const { auth } = authForInterview(req, interviewId);
      requireLead(auth);
      const body = await readJson(req, LIMITS.requestBody);
      const { decision, report, events } = completeInterview({
        db,
        interview: auth.interview,
        participant: auth.participant,
        input: body,
      });
      broadcast(events);
      json(res, 200, { decision, report });
      return;
    }

    if (method === 'POST' && rest === '/reopen') {
      const { auth } = authForInterview(req, interviewId);
      requireLead(auth);
      const { round, events } = reopenInterview({ db, interview: auth.interview, participant: auth.participant });
      broadcast(events);
      json(res, 200, { round });
      return;
    }

    if (method === 'GET' && rest === '/report') {
      const { auth } = authForInterview(req, interviewId);
      requireExaminer(auth);
      const report = buildReportForPage(db, interviewId);
      if (!report) throw notFound('面试不存在。');
      json(res, 200, { report });
      return;
    }

    if (method === 'GET' && rest === '/report.md') {
      const { auth } = authForInterview(req, interviewId);
      requireExaminer(auth);
      const markdown = reportMarkdownFor(db, interviewId);
      if (markdown == null) throw notFound('面试不存在。');
      text(res, 200, markdown, 'text/markdown; charset=utf-8', {
        'Content-Disposition': 'attachment; filename="interview-report.md"',
      });
      return;
    }

    if (method === 'GET' && rest === '/candidate') {
      const { auth } = authForInterview(req, interviewId);
      requireCandidate(auth);
      json(res, 200, { candidate: buildCandidateSnapshot({ db, auth, onlineRoles: hub.onlineRoles(interviewId) }) });
      return;
    }

    if (method === 'POST' && rest === '/ready') {
      const { auth } = authForInterview(req, interviewId);
      requireCandidate(auth);
      const body = await readJson(req, LIMITS.requestBody);
      if (typeof body.ready !== 'boolean') throw badRequest('ready 必须是布尔值。', 'invalid_ready');
      if (auth.interview.status === 'completed') {
        throw conflict('本次面试已结束。', 'board_completed');
      }
      const now = nowIso();
      const events = tx(db, () => {
        db.prepare('UPDATE participants SET ready = ?, ready_at = ? WHERE id = ?').run(
          body.ready ? 1 : 0,
          body.ready ? now : null,
          auth.participant.id,
        );
        db.prepare('UPDATE interviews SET revision = revision + 1, updated_at = ? WHERE id = ?').run(now, interviewId);
        return [
          appendEvent(db, {
            interviewId,
            scope: 'candidate',
            type: 'ready_changed',
            payload: { ready: body.ready },
            at: now,
          }),
          appendEvent(db, {
            interviewId,
            scope: 'internal',
            type: 'candidate_ready_changed',
            payload: { ready: body.ready, participantId: auth.participant.id },
            at: now,
          }),
        ];
      });
      broadcast(events);
      json(res, 200, { ready: body.ready, readyAt: body.ready ? now : null });
      return;
    }

    const decisionMatch = rest.match(/^\/join-requests\/([^/]+)\/(approve|reject)$/);
    if (method === 'POST' && decisionMatch) {
      const { auth } = authForInterview(req, interviewId);
      requireLead(auth);
      if (auth.interview.status === 'completed') {
        throw conflict('面试已完成，不能再审核加入申请。', 'board_completed');
      }
      const requestId = decisionMatch[1];
      if (decisionMatch[2] === 'approve') {
        const result = approveJoinRequest({ db, secrets, interviewId, requestId });
        broadcast(result.events);
        json(res, 200, { status: 'approved', participant: result.participant });
      } else {
        const result = rejectJoinRequest({ db, interviewId, requestId });
        broadcast(result.events);
        json(res, 200, { status: 'rejected' });
      }
      return;
    }

    if (method === 'POST' && rest === '/reinvite') {
      const { auth } = authForInterview(req, interviewId);
      requireLead(auth);
      if (auth.interview.status === 'completed') {
        throw conflict('面试已完成，不能重新邀请席位。如需继续请先重新开启。', 'board_completed');
      }
      const body = await readJson(req, LIMITS.requestBody);
      const role = body.role;
      if (!['co', 'candidate'].includes(role)) throw badRequest('只能重新邀请副考官或面试人席位。', 'invalid_role');
      const result = reinviteSeat({ db, secrets, config, interviewId, role });
      hub.kickParticipant(result.participantId, '席位已重新邀请，本连接已失效。');
      broadcast(result.events);
      json(res, 200, {
        role,
        url: result.invitation.url,
        expiresAt: result.invitation.expiresAt,
      });
      return;
    }

    throw notFound('接口不存在。');
  }

  function handleEvents(req, res, url, auth) {
    const scope = auth.role === 'candidate' ? 'candidate' : 'internal';
    const sinceRaw = url.searchParams.get('since') ?? req.headers['last-event-id'];
    const since = sinceRaw == null ? null : Number(sinceRaw);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    });
    res.write('retry: 3000\n\n');
    if (since != null && Number.isFinite(since) && since >= 0) {
      const rows = db
        .prepare('SELECT * FROM events WHERE interview_id = ? AND scope = ? AND seq > ? ORDER BY seq')
        .all(auth.interview.id, scope, since);
      for (const row of rows) {
        res.write(
          `id: ${row.seq}\ndata: ${JSON.stringify({
            seq: row.seq,
            type: row.type,
            scope: row.scope,
            payload: (() => {
              try {
                return JSON.parse(row.payload);
              } catch {
                return {};
              }
            })(),
            at: row.created_at,
          })}\n\n`,
        );
      }
    } else {
      res.write(`data: ${JSON.stringify({ type: 'resync' })}\n\n`);
    }
    const client = {
      id: newId(),
      interviewId: auth.interview.id,
      participantId: auth.participant.id,
      role: auth.role,
      scope,
      res,
    };
    hub.add(client);
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(heartbeat);
        hub.remove(client);
      }
    }, config.heartbeatMs);
    const cleanup = () => {
      clearInterval(heartbeat);
      hub.remove(client);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  }

  async function handleAdminApi(req, res, url, method, pathname) {
    requireAdmin(req);

    if (method === 'GET' && pathname === '/api/admin/status') {
      json(res, 200, {
        running: true,
        url: config.baseUrl,
        host: config.host,
        port: config.port,
        dbPath: config.dbPath,
        dataDir: config.dataDir,
        startedAt,
        online: hub.onlineCount(),
        interviews: listInterviews(db),
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/admin/interviews') {
      const body = await readJson(req, LIMITS.requestBody);
      const mode = body.mode === 'demo' ? 'demo' : 'blank';
      const { interview, invitations } = createInterview({ db, secrets, config, fields: body, mode });
      json(res, 201, {
        interview: {
          id: interview.id,
          candidateName: interview.candidate_name,
          position: interview.position,
          status: interview.status,
        },
        links: {
          lead: invitations.lead.url,
          co: invitations.co.url,
          candidate: invitations.candidate.url,
        },
      });
      return;
    }

    const linksMatch = pathname.match(/^\/api\/admin\/interviews\/([^/]+)\/links$/);
    if (method === 'GET' && linksMatch) {
      const interviewId = linksMatch[1];
      const interview = getInterview(db, interviewId);
      if (!interview) throw notFound('面试不存在。');
      json(res, 200, buildAdminLinks(interview));
      return;
    }

    const reinviteMatch = pathname.match(/^\/api\/admin\/interviews\/([^/]+)\/reinvite$/);
    if (method === 'POST' && reinviteMatch) {
      const interviewId = reinviteMatch[1];
      const body = await readJson(req, LIMITS.requestBody);
      if (body.confirm !== true) throw badRequest('重新邀请会立即撤销旧身份，请显式传入 confirm: true。', 'confirm_required');
      if (!['lead', 'co', 'candidate'].includes(body.role)) throw badRequest('席位角色无效。', 'invalid_role');
      const result = reinviteSeat({ db, secrets, config, interviewId, role: body.role });
      hub.kickParticipant(result.participantId, '席位已重新邀请，旧身份已失效。');
      broadcast(result.events);
      json(res, 200, {
        role: body.role,
        url: result.invitation.url,
        expiresAt: result.invitation.expiresAt,
        standardUrl: `${config.baseUrl}/interviews/${interviewId}/${body.role === 'candidate' ? 'candidate' : body.role}`,
      });
      return;
    }

    const recoverMatch = pathname.match(/^\/api\/admin\/interviews\/([^/]+)\/recover-lead$/);
    if (method === 'POST' && recoverMatch) {
      const interviewId = recoverMatch[1];
      const body = await readJson(req, LIMITS.requestBody);
      if (body.confirm !== true) throw badRequest('恢复主考官会撤销旧身份，请显式传入 confirm: true。', 'confirm_required');
      const result = recoverLeadSeat({ db, secrets, config, interviewId });
      hub.kickParticipant(result.participantId, '主考官身份已恢复，旧连接已失效。');
      broadcast(result.events);
      json(res, 200, {
        role: 'lead',
        url: result.invitation.url,
        expiresAt: result.invitation.expiresAt,
        standardUrl: `${config.baseUrl}/interviews/${interviewId}/lead`,
      });
      return;
    }

    const reportMatch = pathname.match(/^\/api\/admin\/interviews\/([^/]+)\/report$/);
    if (method === 'GET' && reportMatch) {
      const interviewId = reportMatch[1];
      const interview = getInterview(db, interviewId);
      if (!interview) throw notFound('面试不存在。');
      const format = url.searchParams.get('format') || 'md';
      if (format === 'json') {
        json(res, 200, { report: buildReportForPage(db, interviewId) });
      } else {
        const markdown = reportMarkdownFor(db, interviewId);
        text(res, 200, markdown, 'text/markdown; charset=utf-8');
      }
      return;
    }

    if (method === 'POST' && pathname === '/api/admin/stop') {
      json(res, 200, { stopping: true });
      if (onStop) setTimeout(() => onStop(), 30);
      return;
    }

    throw notFound('管理接口不存在。');
  }

  function buildAdminLinks(interview) {
    const interviewId = interview.id;
    const seats = {};
    for (const role of ['lead', 'co', 'candidate']) {
      const seat = getParticipantByRole(db, interviewId, role);
      const invitation = db
        .prepare(
          `SELECT * FROM invitations
           WHERE interview_id = ? AND role = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(interviewId, role, nowIso());
      const token = invitation ? secrets.getInvitation(invitation.id) : null;
      const standardPath = `/interviews/${interviewId}/${role === 'candidate' ? 'candidate' : role}`;
      seats[role] = {
        role,
        roleLabel: ROLE_LABELS[role],
        name: seat?.name ?? '',
        claimed: Boolean(seat?.claimed_at),
        standardUrl: `${config.baseUrl}${standardPath}`,
        inviteUrl: token ? `${config.baseUrl}${invitationPath(role, token)}` : null,
        expiresAt: invitation?.expires_at ?? null,
        hint: seat?.claimed_at
          ? '席位已领取；同一浏览器可通过标准入口恢复，如需更换请执行 reinvite。'
          : token
            ? '席位尚未领取，请把邀请链接发给对应角色。'
            : '席位尚未领取且没有可用邀请，请执行 reinvite 生成新链接。',
      };
    }
    return {
      interview: {
        id: interview.id,
        candidateName: interview.candidate_name,
        position: interview.position,
        status: interview.status,
        round: interview.round,
      },
      seats,
      entry: `${config.baseUrl}/interviews/${interviewId}/lead`,
    };
  }

  async function close() {
    hub.closeAll();
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  return { server, hub, db, config, close, startedAt };
}
