import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`CDP HTTP ${response.status}: ${url}`);
  return response.json();
}

async function waitForHttp(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await fetchJson(url);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  throw new Error(`等待 Chrome CDP 超时：${url}`);
}

export class CdpPage {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.errors = [];
    this.exceptions = [];
    this.dialogs = [];
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(`${message.error.message} (${entry.method})`));
        else entry.resolve(message.result);
        return;
      }
      this.#handleEvent(message);
    });
  }

  #handleEvent(message) {
    if (message.method === 'Runtime.exceptionThrown') {
      this.exceptions.push(message.params.exceptionDetails?.exception?.description || 'Runtime exception');
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      const text = message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ');
      this.errors.push(`console.error: ${text}`);
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      this.errors.push(`log: ${message.params.entry.text}`);
    }
    if (message.method === 'Page.javascriptDialogOpening') {
      this.dialogs.push(message.params.message);
      this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    }
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP 超时：${method}`));
      }, 20000);
    });
  }

  async init() {
    await Promise.all([
      this.send('Page.enable'),
      this.send('Runtime.enable'),
      this.send('Network.enable'),
      this.send('Log.enable'),
    ]);
  }

  async goto(url, { timeoutMs = 15000 } = {}) {
    await this.send('Page.navigate', { url });
    await this.waitFor("document.readyState === 'complete'", { timeoutMs });
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  async reload({ timeoutMs = 15000 } = {}) {
    await this.send('Page.reload', { ignoreCache: false });
    await this.waitFor("document.readyState === 'complete'", { timeoutMs });
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(`页面脚本异常：${description}\n表达式：${expression.slice(0, 300)}`);
    }
    return result.result?.value;
  }

  async waitFor(expression, { timeoutMs = 8000, intervalMs = 100, label = expression } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate(`Boolean(${expression})`)) return true;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`等待条件超时（${timeoutMs}ms）：${label}${lastError ? `\n最后错误：${lastError.message}` : ''}`);
  }

  async click(selector) {
    const clicked = await this.evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return false;
      node.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`找不到可点击元素：${selector}`);
  }

  async fill(selector, value) {
    const filled = await this.evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return false;
      const setter = Object.getOwnPropertyDescriptor(node.constructor.prototype, 'value')?.set;
      if (setter) setter.call(node, ${JSON.stringify(value)});
      else node.value = ${JSON.stringify(value)};
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    if (!filled) throw new Error(`找不到输入元素：${selector}`);
  }

  async select(selector, value) {
    const selected = await this.evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return false;
      node.value = ${JSON.stringify(value)};
      node.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    if (!selected) throw new Error(`找不到选择元素：${selector}`);
  }

  async text(selector = 'body') {
    return this.evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`);
  }

  async url() {
    return this.evaluate('location.href');
  }

  async setViewport(width, height, { mobile = false } = {}) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile,
      screenWidth: width,
      screenHeight: height,
    });
    if (mobile) await this.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    else await this.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  }

  async setOffline(offline) {
    await this.send('Network.emulateNetworkConditions', {
      offline,
      latency: 0,
      downloadThroughput: offline ? 0 : -1,
      uploadThroughput: offline ? 0 : -1,
    });
  }

  async screenshot(filePath) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

export async function launchBrowser({ port, userDataDir, windowSize = '1440,1000' }) {
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  const child = spawn(
    'google-chrome',
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--hide-scrollbars',
      '--no-proxy-server',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      `--window-size=${windowSize}`,
      'about:blank',
    ],
    { stdio: 'ignore', detached: true },
  );
  await waitForHttp(`http://127.0.0.1:${port}/json/version`);
  const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
  const target = targets.find((item) => item.type === 'page');
  if (!target) throw new Error('没有找到 Chrome 页面目标');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('Chrome WebSocket 连接失败')), { once: true });
  });
  const page = new CdpPage(ws);
  await page.init();
  return {
    child,
    page,
    async close() {
      page.close();
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    },
  };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
