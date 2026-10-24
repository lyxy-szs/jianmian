import fs from 'node:fs';
import path from 'node:path';
import { randomToken } from './db/index.mjs';

/**
 * 本机受保护状态文件（权限 0600）：
 * - 邀请令牌原值只在服务进程与 CLI 之间通过本机管理接口流转，不入数据库明文；
 * - 令牌兑换、撤销或过期后立即从文件移除。
 */
export class SecretStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { invitations: {} };
    this.#load();
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      /* 文件可能尚未创建 */
    }
  }

  #load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.invitations && typeof parsed.invitations === 'object') {
        this.data = { invitations: parsed.invitations };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // 损坏时保留空对象，但把坏文件备份下来，避免静默丢失现场。
        try {
          fs.renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
        } catch {
          /* ignore */
        }
      }
    }
  }

  #flush() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.filePath);
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      /* ignore */
    }
  }

  putInvitation(invitationId, token) {
    this.data.invitations[invitationId] = token;
    this.#flush();
  }

  getInvitation(invitationId) {
    return this.data.invitations[invitationId] ?? null;
  }

  removeInvitation(invitationId) {
    if (this.data.invitations[invitationId] !== undefined) {
      delete this.data.invitations[invitationId];
      this.#flush();
    }
  }

  /** 清理数据库中已失效但仍留在文件里的令牌。 */
  syncWith(activeInvitationIds) {
    const active = new Set(activeInvitationIds);
    let changed = false;
    for (const id of Object.keys(this.data.invitations)) {
      if (!active.has(id)) {
        delete this.data.invitations[id];
        changed = true;
      }
    }
    if (changed) this.#flush();
  }
}

export function ensureAdminToken(filePath) {
  try {
    const existing = fs.readFileSync(filePath, 'utf8').trim();
    if (existing.length >= 32) {
      try {
        fs.chmodSync(filePath, 0o600);
      } catch {
        /* ignore */
      }
      return existing;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const token = randomToken(32);
  fs.writeFileSync(filePath, `${token}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* ignore */
  }
  return token;
}

export function readAdminToken(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
