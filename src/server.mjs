#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { openDatabase, nowIso } from './db/index.mjs';
import { ensureAdminToken, SecretStore } from './secrets.mjs';
import { createApp } from './http/app.mjs';

// 数据目录内含内部面试资料与本机凭据：新文件默认仅当前用户可读写。
process.umask(0o077);

const config = loadConfig();

function fatal(message) {
  console.error(`启动失败：${message}`);
  process.exit(1);
}

try {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(config.exportsDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(config.dataDir, 0o700);
  fs.chmodSync(config.exportsDir, 0o700);
} catch (error) {
  fatal(`无法创建数据目录 ${config.dataDir}：${error.message}`);
}

let db;
try {
  db = openDatabase(config.dbPath);
} catch (error) {
  fatal(`无法打开数据库 ${config.dbPath}：${error.message}`);
}
for (const file of [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`]) {
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* WAL/SHM 可能尚未创建 */
  }
}

const adminToken = ensureAdminToken(config.adminTokenPath);
const secrets = new SecretStore(config.secretsPath);
const activeInvitations = db
  .prepare(
    `SELECT id FROM invitations
     WHERE consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
  )
  .all(nowIso())
  .map((row) => row.id);
secrets.syncWith(activeInvitations);

const statePath = path.join(config.dataDir, 'server-state.json');
let closing = false;

// 定期清理已过期但仍留在本机保护文件中的邀请令牌原值。
const purgeTimer = setInterval(() => {
  try {
    const active = db
      .prepare(
        `SELECT id FROM invitations
         WHERE consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
      )
      .all(nowIso())
      .map((row) => row.id);
    secrets.syncWith(active);
  } catch {
    /* 清理失败不影响服务 */
  }
}, 5 * 60 * 1000);
purgeTimer.unref();

const app = createApp({
  config,
  db,
  secrets,
  adminToken,
  onStop: () => shutdown(0),
});

function writeState() {
  try {
    fs.writeFileSync(
      statePath,
      `${JSON.stringify(
        {
          pid: process.pid,
          url: config.baseUrl,
          host: config.host,
          port: config.port,
          dbPath: config.dbPath,
          online: 0,
          startedAt: app.startedAt,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    fs.chmodSync(statePath, 0o600);
  } catch (error) {
    console.warn(`提示：无法写入服务状态文件：${error.message}`);
  }
}

async function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  console.log('\n正在停止面试搭子服务…');
  try {
    await app.close();
  } catch (error) {
    console.error(`关闭 HTTP 服务时出错：${error.message}`);
  }
  try {
    db.close();
  } catch {
    /* ignore */
  }
  clearInterval(purgeTimer);
  try {
    fs.rmSync(statePath, { force: true });
  } catch {
    /* ignore */
  }
  process.exit(code);
}

process.on('SIGINT', () => {
  void shutdown(0);
});
process.on('SIGTERM', () => {
  void shutdown(0);
});

app.server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `启动失败：端口 ${config.port} 已被占用。请关闭占用该端口的进程，或使用环境变量 PORT 指定其他端口后重新启动。`,
    );
  } else if (error.code === 'EACCES') {
    console.error(`启动失败：没有权限监听 ${config.host}:${config.port}。请检查地址与端口配置。`);
  } else {
    console.error(`启动失败：${error.message}`);
  }
  process.exit(1);
});

app.server.listen(config.port, config.host, () => {
  writeState();
  const interviews = db.prepare('SELECT COUNT(*) AS count FROM interviews').get().count;
  console.log('');
  console.log('面试搭子 · 服务已启动');
  console.log(`  访问地址：${config.baseUrl}`);
  console.log(`  监听：${config.host}:${config.port}`);
  console.log(`  数据库：${config.dbPath}`);
  console.log(`  已有面试：${interviews} 场`);
  console.log('');
  console.log('  浏览器打开访问地址即可创建面试；另开终端运行 `npm run console` 使用控制台。');
  console.log('  停止服务：Ctrl+C');
  console.log('');
});
