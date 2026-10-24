import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { startTestServer } from './helpers.mjs';

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const CLI = path.join(ROOT, 'src', 'cli', 'index.mjs');

let server;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

function cliEnv(serverLike, extra = {}) {
  return {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(serverLike.port),
    DATA_DIR: serverLike.dir,
    ...extra,
  };
}

async function runCli(env, ...args) {
  return execFileAsync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env,
    timeout: 15000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function runCliExpectFailure(env, ...args) {
  try {
    await runCli(env, ...args);
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
  throw new Error('CLI 应当以非零退出码结束');
}

test('CLI help 与 status 输出可用', async () => {
  const env = cliEnv(server);
  const help = await runCli(env, 'help');
  assert.match(help.stdout, /用法：/);
  assert.match(help.stdout, /recover-lead/);
});

test('CLI status 输出服务地址、数据库、在线人数与面试列表', async () => {
  const env = cliEnv(server);
  const { stdout } = await runCli(env, 'status');
  assert.match(stdout, /服务状态：运行中/);
  assert.match(stdout, new RegExp(server.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(stdout, /数据库：/);
  assert.match(stdout, /在线人数：/);
  assert.match(stdout, /已有面试：/);
});

test('CLI 无参数进入交互菜单，退出菜单不关闭服务', async () => {
  const env = cliEnv(server);
  const child = spawn(process.execPath, [CLI], {
    cwd: ROOT,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });
  const waitForText = (text, timeoutMs = 8000) =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (output.includes(text)) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error(`等待 CLI 输出超时：${text}\n已输出：${output}`));
        }
      }, 60);
    });
  try {
    await waitForText('本机控制台');
    child.stdin.write('1\n');
    await waitForText('服务状态：运行中');
    child.stdin.write('9\n');
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('菜单未退出')), 6000);
      child.once('exit', (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    assert.equal(code, 0);
    assert.match(output, /已退出控制台（服务仍在运行）/);
    const status = await runCli(env, 'status');
    assert.match(status.stdout, /运行中/);
  } finally {
    if (child.exitCode == null) child.kill('SIGKILL');
  }
});

test('CLI demo/create/links/report 全链路可用且不打印多余令牌', async () => {
  const env = cliEnv(server);
  const demo = await runCli(env, 'demo');
  assert.match(demo.stdout, /示例数据已写入数据库/);
  const demoId = demo.stdout.match(/面试 ID：([0-9a-f-]{36})/)?.[1];
  assert.ok(demoId);

  const links = await runCli(env, 'links', demoId);
  assert.match(links.stdout, /主考官（未领取）/);
  assert.match(links.stdout, /副考官（未领取）/);
  assert.match(links.stdout, /面试人（未领取）/);
  assert.match(links.stdout, /邀请链接：http:\/\/127\.0\.0\.1:/);

  const created = await runCli(
    env,
    'create',
    '--candidate',
    'CLI 候选人',
    '--position',
    '数据分析师',
    '--lead',
    'CLI 主考官',
    '--brief',
    '命令行创建',
    '--focus',
    '只看关键流程',
    '--public',
    '公开说明：命令行',
  );
  assert.match(created.stdout, /已创建空白面试/);
  const createdId = created.stdout.match(/面试 ID：([0-9a-f-]{36})/)?.[1];
  assert.ok(createdId);

  const missing = await runCliExpectFailure(env, 'create');
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /非交互模式/);

  const outputPath = path.join(server.dir, 'exports', 'cli-report.md');
  const report = await runCli(env, 'report', createdId, '--output', outputPath);
  assert.match(report.stdout, /报告已导出/);
  const content = fs.readFileSync(outputPath, 'utf8');
  assert.match(content, /# 面试总结：CLI 候选人/);
  assert.match(content, /评估中/);

  const missingReport = await runCliExpectFailure(env, 'report', 'does-not-exist');
  assert.notEqual(missingReport.code, 0);
  assert.match(missingReport.stderr, /不存在/);
});

test('CLI 重新邀请与恢复主考官必须显式确认，并撤销旧身份', async () => {
  const env = cliEnv(server);
  const demo = await runCli(env, 'demo');
  const id = demo.stdout.match(/面试 ID：([0-9a-f-]{36})/)?.[1];
  assert.ok(id);

  const withoutConfirm = await runCliExpectFailure(env, 'reinvite', id, '--role', 'co');
  assert.notEqual(withoutConfirm.code, 0);
  assert.match(withoutConfirm.stderr, /--yes/);

  const reinvite = await runCli(env, 'reinvite', id, '--role', 'co', '--yes');
  assert.match(reinvite.stdout, /已重新邀请副考官席位/);
  assert.match(reinvite.stdout, /新邀请链接：http:\/\/127\.0\.0\.1:/);

  const recover = await runCli(env, 'recover-lead', id, '--yes');
  assert.match(recover.stdout, /新的主考官恢复链接/);

  const recoverWithout = await runCliExpectFailure(env, 'recover-lead', id);
  assert.match(recoverWithout.stderr, /--yes/);

  const links = await runCli(env, 'links', id);
  assert.match(links.stdout, /副考官（未领取）/);
});

test('服务未运行时 CLI 给出清晰中文错误与非零退出码', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interview-cli-offline-'));
  const env = {
    ...process.env,
    PORT: '9',
    HOST: '127.0.0.1',
    DATA_DIR: dir,
  };
  const status = await runCliExpectFailure(env, 'status');
  assert.notEqual(status.code, 0);
  assert.match(status.stderr, /无法连接|未找到本机管理凭据|请先/);
  fs.rmSync(dir, { recursive: true, force: true });
});

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function waitForOutput(child, pattern, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`等待输出超时：${pattern}\n${buffer}`)), timeoutMs);
    const onData = (chunk) => {
      buffer += chunk.toString();
      if (pattern.test(buffer)) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve(buffer);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => {
      buffer += chunk.toString();
    });
  });
}

test('真实服务进程可由 CLI 启动、查询并停止', async () => {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interview-cli-server-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const startup = await waitForOutput(child, /停止服务：Ctrl\+C/);
    assert.match(startup, /访问地址：http:\/\/127\.0\.0\.1:/);
    assert.match(startup, /数据库：/);
    const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dir };
    const status = await runCli(env, 'status');
    assert.match(status.stdout, /服务状态：运行中/);
    const stopped = await runCli(env, 'stop');
    assert.match(stopped.stdout, /停止/);
    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('服务未在 5 秒内退出')), 5000);
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    assert.equal(exitCode, 0);
    const response = await fetch(`http://127.0.0.1:${port}/`).then(
      () => 'up',
      () => 'down',
    );
    assert.equal(response, 'down');
  } finally {
    if (child.exitCode == null) child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('端口占用时服务明确报错退出', async () => {
  const port = await freePort();
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'interview-port-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'interview-port-b-'));
  const env = (dir) => ({ ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dir });
  const first = spawn(process.execPath, [path.join(ROOT, 'src', 'server.mjs')], {
    cwd: ROOT,
    env: env(dirA),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForOutput(first, /停止服务：Ctrl\+C/);
    const second = spawn(process.execPath, [path.join(ROOT, 'src', 'server.mjs')], {
      cwd: ROOT,
      env: env(dirB),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('端口冲突进程未退出')), 5000);
      let err = '';
      second.stderr.on('data', (chunk) => {
        err += chunk.toString();
      });
      second.once('exit', (exitCode) => {
        clearTimeout(timer);
        assert.match(err, /端口 .* 已被占用/);
        resolve(exitCode);
      });
    });
    assert.equal(code, 1);
    await runCli({ ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dirA }, 'stop');
  } finally {
    if (first.exitCode == null) first.kill('SIGKILL');
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});
