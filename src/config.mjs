import path from 'node:path';

const DEFAULT_PORT = 4310;
const DEFAULT_HOST = '127.0.0.1';

function positiveInt(raw, fallback) {
  const value = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * 读取运行配置。所有配置均可用环境变量覆盖，默认值保证 `npm start` 零配置可用。
 */
export function loadConfig(env = process.env, root = process.cwd()) {
  const projectRoot = path.resolve(root);
  const port = positiveInt(env.PORT, DEFAULT_PORT);
  const host = env.HOST?.trim() || DEFAULT_HOST;
  const dataDir = path.resolve(projectRoot, env.DATA_DIR?.trim() || 'data');
  const exportsDir = path.resolve(projectRoot, env.EXPORTS_DIR?.trim() || 'exports');
  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const inviteTtlHours = positiveInt(env.INVITE_TTL_HOURS, 24);
  const sessionTtlHours = positiveInt(env.SESSION_TTL_HOURS, 24 * 30);

  return {
    projectRoot,
    host,
    port,
    dataDir,
    exportsDir,
    publicDir: path.join(projectRoot, 'public'),
    dbPath: path.join(dataDir, 'interview.sqlite'),
    adminTokenPath: path.join(dataDir, 'admin-token'),
    secretsPath: path.join(dataDir, 'secrets.json'),
    baseUrl: `http://${displayHost}:${port}`,
    inviteTtlMs: inviteTtlHours * 60 * 60 * 1000,
    sessionTtlMs: sessionTtlHours * 60 * 60 * 1000,
    heartbeatMs: 15_000,
  };
}

export const LIMITS = Object.freeze({
  noteBody: 4000,
  messageBody: 2000,
  evaluationReason: 4000,
  decisionReason: 4000,
  divergenceNote: 4000,
  name: 80,
  position: 120,
  brief: 4000,
  requestBody: 128 * 1024,
  groupName: 40,
  operationsPerBatch: 50,
});
