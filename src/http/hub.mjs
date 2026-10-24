/**
 * SSE 连接管理：按面试与可见范围隔离；事件先落库，提交后由路由层推送给授权客户端。
 */
export class EventHub {
  constructor() {
    this.clients = new Set();
    this.startedAt = new Date().toISOString();
  }

  add(client) {
    this.clients.add(client);
    this.#broadcastPresence(client.interviewId);
    return client;
  }

  remove(client) {
    if (!this.clients.delete(client)) return;
    this.#broadcastPresence(client.interviewId);
  }

  onlineRoles(interviewId) {
    const roles = new Set();
    for (const client of this.clients) {
      if (client.interviewId === interviewId) roles.add(client.role);
    }
    return roles;
  }

  onlineCount(interviewId = null) {
    const participants = new Set();
    for (const client of this.clients) {
      if (interviewId && client.interviewId !== interviewId) continue;
      participants.add(client.participantId);
    }
    return participants.size;
  }

  #write(client, frame) {
    try {
      client.res.write(frame);
    } catch {
      this.remove(client);
      try {
        client.res.end();
      } catch {
        /* ignore */
      }
    }
  }

  broadcast(events) {
    for (const event of events) {
      if (!event) continue;
      const frame = `id: ${event.seq}\ndata: ${JSON.stringify({
        seq: event.seq,
        type: event.type,
        scope: event.scope,
        payload: event.payload,
        at: event.at,
      })}\n\n`;
      for (const client of this.clients) {
        if (client.interviewId !== event.interviewId) continue;
        if (client.scope !== event.scope) continue;
        this.#write(client, frame);
      }
    }
  }

  #broadcastPresence(interviewId) {
    const roles = this.onlineRoles(interviewId);
    const frame = `data: ${JSON.stringify({
      type: 'presence',
      payload: { online: Object.fromEntries([...roles].map((role) => [role, true])) },
    })}\n\n`;
    for (const client of this.clients) {
      if (client.interviewId !== interviewId) continue;
      this.#write(client, frame);
    }
  }

  /** 席位撤销/重新邀请时关闭旧实时连接，旧客户端不得继续接收推送。 */
  kickParticipant(participantId, reason = '身份已被撤销，请使用新的邀请链接。') {
    for (const client of [...this.clients]) {
      if (client.participantId !== participantId) continue;
      this.#write(client, `data: ${JSON.stringify({ type: 'revoked', reason })}\n\n`);
      this.remove(client);
      try {
        client.res.end();
      } catch {
        /* ignore */
      }
    }
  }

  closeAll() {
    for (const client of [...this.clients]) {
      try {
        client.res.end();
      } catch {
        /* ignore */
      }
      this.clients.delete(client);
    }
  }
}
