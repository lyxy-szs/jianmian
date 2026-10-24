#!/usr/bin/env node
/**
 * 浏览器端到端实测（可选，需本机已安装 Google Chrome）：
 * 用三个独立 Chrome 用户目录模拟三位角色，覆盖实时协作、评价确认、报告、离线队列、
 * 手机只读与深浅主题。运行前先启动服务：
 *
 *   npm start
 *   node scripts/browser-verify.mjs [baseUrl]
 *
 * 截图输出到 docs/screenshots/。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser, sleep } from './cdp.mjs';

const BASE = (process.argv[2] || 'http://127.0.0.1:4310').replace(/\/$/, '');
const SHOTS = path.resolve('docs/screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

const log = (message) => console.log(`[verify] ${message}`);
const shot = (page, name) => page.screenshot(path.join(SHOTS, name));

async function clickText(page, text, selector = 'button') {
  const clicked = await page.evaluate(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const node = nodes.find((item) => item.textContent.includes(${JSON.stringify(text)}));
    if (!node) return false;
    node.click();
    return true;
  })()`);
  assert.equal(clicked, true, `找不到文本为「${text}」的 ${selector}`);
}

async function main() {
  log(`目标服务：${BASE}`);
  const leadBrowser = await launchBrowser({ port: 9411, userDataDir: '/tmp/iv-browser-lead' });
  const coBrowser = await launchBrowser({ port: 9412, userDataDir: '/tmp/iv-browser-co' });
  const candidateBrowser = await launchBrowser({ port: 9413, userDataDir: '/tmp/iv-browser-candidate' });
  const { page: lead } = leadBrowser;
  const { page: co } = coBrowser;
  const { page: candidate } = candidateBrowser;

  async function coApi(method, urlPath, body) {
    const cookies = await co.send('Network.getCookies', { urls: [BASE] });
    const cookieHeader = cookies.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    const headers = { cookie: cookieHeader };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${BASE}${urlPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  }

  try {
    /* ---------------- 创建示例面试 ---------------- */
    await lead.goto(BASE);
    await lead.waitFor("!!document.querySelector('#demo-button')");
    await lead.click('#demo-button');
    await lead.waitFor("!document.querySelector('#created-result').hidden", { timeoutMs: 12000 });
    const links = await lead.evaluate(`(() => {
      const result = {};
      for (const card of document.querySelectorAll('.link-card')) {
        result[card.dataset.role] = card.querySelector('.link-url').textContent.trim();
      }
      return result;
    })()`);
    assert.ok(links.lead && links.co && links.candidate, '创建后应输出三个角色链接');
    await shot(lead, '01-home-created.png');
    log('示例面试已创建，三个角色链接已输出');

    /* ---------------- 主考官领取 ---------------- */
    await lead.goto(links.lead);
    await lead.waitFor("[...document.querySelectorAll('button')].some((b) => b.textContent.includes('领取主考官身份'))");
    await clickText(lead, '领取主考官身份');
    await lead.waitFor("location.pathname.endsWith('/lead')", { timeoutMs: 8000 });
    await lead.waitFor("document.querySelectorAll('.note-card').length >= 4", { timeoutMs: 8000 });
    const interviewId = new URL(await lead.url()).pathname.split('/').filter(Boolean)[1];
    assert.ok(interviewId);
    await shot(lead, '02-board-lead.png');
    log(`主考官已领取身份并进入面试板（${interviewId}）`);

    /* ---------------- 副考官申请与审批 ---------------- */
    await co.goto(links.co);
    await co.waitFor("!!document.querySelector('#applicant-name')");
    await co.fill('#applicant-name', '王副考');
    await co.click('#join-root form button[type="submit"]');
    await co.waitFor("document.querySelector('#join-root').innerText.includes('等待主考官审批')", { timeoutMs: 6000 });

    await lead.click('#manage-button');
    await lead.waitFor("!!document.querySelector('#manage-dialog[open] .request-row')");
    await lead.evaluate(`(() => {
      const row = document.querySelector('#manage-dialog .request-row');
      const button = [...row.querySelectorAll('button')].find((b) => b.textContent.includes('批准'));
      button.click();
      return true;
    })()`);
    await lead.waitFor("!document.querySelector('#manage-dialog .request-row')", { timeoutMs: 6000 });
    await lead.click('#manage-dialog [data-close-dialog]');
    await co.waitFor("location.pathname.endsWith('/co')", { timeoutMs: 12000 });
    await co.waitFor("document.querySelector('#candidate-name')?.textContent.includes('林悦')", { timeoutMs: 8000 });
    await shot(co, '04-board-co.png');
    log('副考官申请已批准并进入面试板');

    /* ---------------- 面试人领取与准备状态 ---------------- */
    await candidate.goto(links.candidate);
    await candidate.waitFor("[...document.querySelectorAll('button')].some((b) => b.textContent.includes('领取面试人身份'))");
    await clickText(candidate, '领取面试人身份');
    await candidate.waitFor("location.pathname.endsWith('/candidate') && !!document.querySelector('.ready-box')", {
      timeoutMs: 8000,
    });
    await clickText(candidate, '我已准备好');
    await candidate.waitFor("document.querySelector('#candidate-root').innerText.includes('你已确认准备就绪')", {
      timeoutMs: 5000,
    });
    await lead.waitFor("document.querySelector('#presence').innerText.includes('已准备')", { timeoutMs: 5000 });
    await candidate.setViewport(1280, 900);
    await shot(candidate, '05-candidate-ready.png');
    log('面试人已领取身份，准备状态同步到考官端');

    /* ---------------- 实时便签 ---------------- */
    await lead.click('#new-note-button');
    await lead.waitFor("document.querySelector('#note-dialog').open");
    await lead.fill('#note-body', '端到端：候选人解释了冲突合并方案，能说清取舍。');
    await lead.click('#note-important');
    await lead.click('#note-save');
    await lead.waitFor("!document.querySelector('#note-dialog').open");
    await lead.waitFor("document.querySelector('.notes-board').innerText.includes('端到端：候选人解释了冲突合并方案')");

    const noteStart = Date.now();
    await co.waitFor("document.querySelector('.notes-board').innerText.includes('端到端：候选人解释了冲突合并方案')", {
      timeoutMs: 3000,
      label: '副考官窗口在 3 秒内看到新便签',
    });
    const noteLatency = Date.now() - noteStart;
    assert.ok(noteLatency < 3000, `便签实时同步耗时 ${noteLatency}ms，超过 3 秒`);
    log(`便签实时同步耗时 ${noteLatency}ms（目标 1 秒内可见）`);

    await lead.evaluate(`(() => {
      const card = [...document.querySelectorAll('.note-card')].find((item) =>
        item.textContent.includes('为什么选择操作变换'));
      [...card.querySelectorAll('button')].find((button) => button.textContent === '编辑').click();
      return true;
    })()`);
    await lead.waitFor("document.querySelector('#note-dialog').open");
    await lead.fill('#note-body', '编辑后的亮点：实时协同经验扎实，边界条件仍需继续验证。');
    await lead.click('#note-save');
    await lead.waitFor("!document.querySelector('#note-dialog').open");
    await co.waitFor("document.querySelector('.notes-board').innerText.includes('编辑后的亮点：实时协同经验扎实')", {
      timeoutMs: 3000,
      label: '便签修改实时同步到副考官窗口',
    });
    log('便签修改实时同步（作者编辑，副考官实时可见）');

    /* ---------------- 非作者移动（拖动之外的分组菜单） ---------------- */
    const targetGroup = await co.evaluate(`(() => {
      const card = [...document.querySelectorAll('.note-card')].find((item) => item.textContent.includes('端到端'));
      const select = card.querySelector('select.move-select');
      const option = [...select.options].find((item) => item.textContent.includes('疑虑'));
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return option.textContent;
    })()`);
    await lead.waitFor(`(() => {
      const card = [...document.querySelectorAll('.note-card')].find((item) => item.textContent.includes('端到端'));
      return card?.closest('.note-column')?.querySelector('h2')?.textContent.includes('疑虑');
    })()`, { timeoutMs: 4000, label: '便签移动同步到主考官窗口' });
    log(`副考官把便签移动到「${targetGroup}」，主考官窗口已同步`);

    // 无头浏览器无法产生原生拖动，通过 DataTransfer + DragEvent 触发真实拖放处理器
    const draggedNote = await lead.evaluate(`(() => {
      const card = [...document.querySelectorAll('.note-card')].find((item) => item.textContent.includes('端到端'));
      const target = [...document.querySelectorAll('.note-column')].find((column) =>
        column.querySelector('h2').textContent.includes('待验证'));
      const dataTransfer = new DataTransfer();
      card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
      card.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer }));
      return { id: card.dataset.noteId, data: dataTransfer.getData('text/note-id') };
    })()`);
    assert.equal(draggedNote.data, draggedNote.id);
    await lead.waitFor(`(() => {
      const card = document.querySelector('[data-note-id="${draggedNote.id}"]');
      return card?.closest('.note-column')?.querySelector('h2')?.textContent.includes('待验证');
    })()`, { timeoutMs: 3000, label: '拖动便签到待验证分组' });
    log('拖动便签跨分组可用（拖放事件与最终位置一致）');

    /* ---------------- 分组管理与筛选 ---------------- */
    await lead.click('#group-manage-button');
    await lead.waitFor("document.querySelector('#group-dialog').open");
    await lead.fill('#group-new-name', 'UI 新建分组');
    await lead.click('#group-add-form button[type="submit"]');
    await lead.waitFor("[...document.querySelectorAll('#group-list input')].some((input) => input.value === 'UI 新建分组')", { timeoutMs: 4000 });
    await lead.click('#group-dialog [data-close-dialog]');
    await lead.waitFor("document.querySelector('.notes-board').innerText.includes('UI 新建分组')", { timeoutMs: 4000 });
    await lead.click('#group-manage-button');
    await lead.waitFor("document.querySelector('#group-dialog').open");
    await lead.waitFor("[...document.querySelectorAll('#group-list input')].some((input) => input.value === 'UI 新建分组')", {
      timeoutMs: 4000,
      label: '重新打开分组管理后仍能看到新分组',
    });
    const groupRows = await lead.evaluate("[...document.querySelectorAll('#group-list .group-row')].map((row) => [...row.querySelectorAll('input')].map((input) => input.value))");
    assert.ok(groupRows.flat().includes('UI 新建分组'), `分组列表缺少新分组：${JSON.stringify(groupRows)}`);
    await lead.evaluate(`(() => {
      const row = [...document.querySelectorAll('#group-list .group-row')].find((item) =>
        [...item.querySelectorAll('input')].some((input) => input.value === 'UI 新建分组'));
      [...row.querySelectorAll('button')].find((button) => button.textContent === '删除').click();
      return true;
    })()`);
    await lead.waitFor("![...document.querySelectorAll('#group-list input')].some((input) => input.value === 'UI 新建分组')", { timeoutMs: 4000 });
    await lead.click('#group-dialog [data-close-dialog]');
    log('分组新增与删除（含确认）在界面中可用');

    await lead.click('#filters [data-filter="important"]');
    await lead.waitFor(`(() => {
      const cards = [...document.querySelectorAll('.note-card')];
      return cards.length > 0 && cards.every((card) => card.classList.contains('is-important'));
    })()`, { timeoutMs: 3000 });
    await lead.click('#filters [data-filter="all"]');
    log('重要/需要讨论筛选可用');

    /* ---------------- 讨论、回复与引用 ---------------- */
    await co.fill('#message-input', '王副考：我同意，继续追问冲突合并的边界条件。');
    await co.click('#send-message');
    await lead.waitFor("document.querySelector('#message-list').innerText.includes('继续追问冲突合并的边界条件')", {
      timeoutMs: 3000,
    });
    await lead.evaluate(`(() => {
      const message = [...document.querySelectorAll('.message')].find((item) =>
        item.textContent.includes('继续追问冲突合并的边界条件'));
      const button = [...message.querySelectorAll('button')].find((item) => item.textContent === '回复');
      button.click();
      return true;
    })()`);
    await lead.fill('#message-input', '主考官：补充追问，断线重连时如何避免本机队列覆盖服务端版本。');
    await lead.click('#send-message');
    await co.waitFor("document.querySelector('#message-list').innerText.includes('断线重连时如何避免本机队列')", {
      timeoutMs: 3000,
    });
    await co.waitFor("document.querySelector('.reply-block')?.textContent.includes('继续追问冲突合并')", {
      timeoutMs: 3000,
    });
    await co.evaluate(`(() => {
      const card = [...document.querySelectorAll('.note-card')].find((item) => item.textContent.includes('端到端'));
      const button = [...card.querySelectorAll('button')].find((item) => item.textContent === '引用');
      button.click();
      return true;
    })()`);
    await co.fill('#message-input', '引用便签：这一条建议保留到待验证分组继续跟进。');
    await co.click('#send-message');
    await lead.waitFor("document.querySelector('.message-list').innerText.includes('这一条建议保留到待验证分组')", {
      timeoutMs: 3000,
    });
    await lead.evaluate(`(() => {
      const block = [...document.querySelectorAll('button.quote-block')].find((item) =>
        item.textContent.includes('候选人解释了冲突合并方案'));
      block.click();
      return true;
    })()`);
    await lead.waitFor("[...document.querySelectorAll('.note-card')].some((card) => card.classList.contains('is-highlighted'))", {
      timeoutMs: 3000,
    });
    await shot(lead, '06-board-discussion.png');
    log('讨论、回复与便签引用均已实时同步');

    /* ---------------- 评价与最终确认 ---------------- */
    await lead.click('#eval-button');
    await lead.waitFor("document.querySelector('#eval-dialog').open");
    await lead.select('#eval-level', 'hold');
    await lead.fill('#eval-reason', '协同项目经验扎实，但离职原因需要补充验证。');
    await lead.click('#eval-submit');
    await lead.waitFor("document.querySelector('#my-eval-status').textContent.includes('已提交')", { timeoutMs: 5000 });
    await lead.click('#eval-dialog [data-close-dialog]');

    await co.click('#eval-button');
    await co.waitFor("document.querySelector('#eval-dialog').open");
    await co.select('#eval-level', 'yes');
    await co.fill('#eval-reason', '项目深度与沟通表达符合预期，可以推荐。');
    await co.click('#eval-submit');
    await co.waitFor("document.querySelector('#my-eval-status').textContent.includes('已提交')", { timeoutMs: 5000 });
    await co.waitFor("document.querySelector('#partner-eval-body').innerText.includes('离职原因需要补充验证')", {
      timeoutMs: 4000,
    });
    await co.click('#eval-dialog [data-close-dialog]');
    log('两位考官分别提交评价，对方评价实时可见');

    await lead.click('#eval-button');
    await lead.waitFor("document.querySelector('#eval-dialog').open");
    await lead.waitFor("document.querySelector('#eval-final-box').innerText.includes('两位考官均已提交')", {
      timeoutMs: 4000,
    });
    await clickText(lead, '前往确认最终结论', '#eval-dialog button');
    await lead.waitFor("!!document.querySelector('#manage-dialog[open] #final-level')", { timeoutMs: 5000 });
    await lead.select('#final-level', 'yes');
    await lead.fill('#final-reason', '综合两轮讨论，建议进入下一轮面试。');
    await lead.fill('#final-divergence', '主考官对离职原因保留意见，副考官认为可以接受；建议背景调查时重点核实。');
    await clickText(lead, '确认最终结论', '#manage-dialog button');
    await lead.waitFor("!document.querySelector('#readonly-banner').hidden", { timeoutMs: 8000 });
    await lead.waitFor("document.querySelector('#status-chip').textContent.includes('已完成')", { timeoutMs: 5000 });
    await shot(lead, '07-board-completed.png');
    log('最终结论已确认，面试板转为只读');

    /* ---------------- 报告与导出 ---------------- */
    await lead.goto(`${BASE}/interviews/${interviewId}/report`);
    await lead.waitFor("document.querySelector('#report-root').innerText.includes('最终结论')", { timeoutMs: 8000 });
    const reportText = await lead.text('#report-root');
    assert.match(reportText, /推荐/);
    assert.match(reportText, /综合两轮讨论/);
    assert.match(reportText, /背景调查时重点核实/);
    const markdown = await lead.evaluate(`fetch('/api/interviews/${interviewId}/report.md').then((response) => response.text())`);
    assert.match(markdown, /round-1-final/);
    assert.match(markdown, /综合两轮讨论/);
    assert.match(markdown, /面试人不可访问/);
    await shot(lead, '08-report.png');

    await candidate.waitFor("document.querySelector('#candidate-root').innerText.includes('本次面试已结束')", {
      timeoutMs: 8000,
    });
    const candidateText = await candidate.text('#candidate-root');
    assert.equal(candidateText.includes('综合两轮讨论'), false);
    assert.equal(candidateText.includes('背景调查时重点核实'), false);
    assert.equal(candidateText.includes('近三年负责企业协作产品'), false);
    const candidateCache = await candidate.evaluate(`new Promise((resolve, reject) => {
      const request = indexedDB.open('interview-partner');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('snapshots')) return resolve('[]');
        const transaction = db.transaction('snapshots', 'readonly');
        const all = transaction.objectStore('snapshots').getAll();
        all.onsuccess = () => resolve(JSON.stringify(all.result));
        all.onerror = () => reject(all.error);
      };
    })`);
    assert.equal(candidateCache.includes('端到端'), false, '面试人离线缓存不应包含内部便签');
    assert.equal(candidateCache.includes('evaluations'), false, '面试人离线缓存不应包含评价');
    assert.equal(candidateCache.includes('internalBrief'), false, '面试人离线缓存不应包含内部简介');
    await shot(candidate, '09-candidate-completed.png');
    log('报告页面与 Markdown 一致；面试人只看到结束状态，未收到内部结论');
    log('面试人 IndexedDB 缓存经检查不含便签、评价或内部简介');

    /* ---------------- 重新开启 ---------------- */
    await lead.goto(`${BASE}/interviews/${interviewId}/lead`);
    await lead.waitFor("document.querySelector('#candidate-name')?.textContent.includes('林悦')", { timeoutMs: 8000 });
    await lead.click('#manage-button');
    await lead.waitFor("!!document.querySelector('#manage-dialog[open]')");
    await clickText(lead, '重新开启', '#manage-dialog button');
    await lead.waitFor("document.querySelector('#status-chip').textContent.includes('评估中')", { timeoutMs: 8000 });
    await lead.waitFor("!document.querySelector('#round-chip').hidden && document.querySelector('#round-chip').textContent.includes('第 2 轮')");
    await lead.click('#manage-dialog [data-close-dialog]');
    log('主考官重新开启面试，进入第 2 轮评估');

    /* ---------------- 离线编辑、刷新恢复与重连 ---------------- */
    await co.goto(`${BASE}/interviews/${interviewId}/co`);
    await co.waitFor("document.querySelector('#candidate-name')?.textContent.includes('林悦')", { timeoutMs: 8000 });
    await co.setOffline(true);
    await co.waitFor("document.querySelector('#sync-indicator').textContent.includes('离线')", { timeoutMs: 12000 });
    await co.click('#new-note-button');
    await co.waitFor("document.querySelector('#note-dialog').open");
    await co.fill('#note-body', '离线记录：网络中断时写下的便签，恢复后应自动同步。');
    await co.click('#note-save');
    await co.waitFor("document.querySelector('.note-card.is-pending')", { timeoutMs: 4000 });
    await shot(co, '10-offline-pending.png');

    await co.reload({ timeoutMs: 15000 });
    await co.waitFor("document.querySelector('#candidate-name')?.textContent.includes('林悦')", { timeoutMs: 10000 });
    await co.waitFor("document.querySelector('.notes-board').innerText.includes('离线记录：网络中断时写下的便签')", {
      timeoutMs: 6000,
      label: '离线刷新后仍显示缓存与未同步便签',
    });
    await shot(co, '11-offline-reloaded.png');
    log('离线刷新后，本机缓存与未同步便签仍然存在');

    await co.setOffline(false);
    await co.waitFor("document.querySelector('#sync-indicator').textContent.includes('已连接')", { timeoutMs: 20000 });
    await co.waitFor("document.querySelectorAll('.note-card.is-pending').length === 0", { timeoutMs: 8000 });
    await lead.goto(`${BASE}/interviews/${interviewId}/lead`);
    await lead.waitFor("document.querySelector('.notes-board').innerText.includes('离线记录：网络中断时写下的便签')", {
      timeoutMs: 8000,
      label: '重连后离线便签同步到主考官窗口',
    });
    log('恢复联网后队列成功同步，主考官窗口看到离线便签');

    /* ---------------- 冲突转本地草稿 ---------------- */
    await co.click('#new-note-button');
    await co.waitFor("document.querySelector('#note-dialog').open");
    await co.fill('#note-body', '冲突草稿：原始正文');
    await co.click('#note-save');
    await co.waitFor("document.querySelector('.notes-board').innerText.includes('冲突草稿：原始正文')", { timeoutMs: 4000 });
    await co.waitFor("document.querySelectorAll('.note-card.is-pending').length === 0", { timeoutMs: 5000 });
    const conflictSnapshot = await coApi('GET', `/api/interviews/${interviewId}/snapshot`);
    const conflictNote = conflictSnapshot.data.snapshot.notes.find((note) => note.body.includes('冲突草稿：原始正文'));
    assert.ok(conflictNote, '应能在服务端找到冲突测试便签');

    await co.setOffline(true);
    await co.waitFor("document.querySelector('#sync-indicator').textContent.includes('离线')", { timeoutMs: 12000 });
    await co.evaluate(`(() => {
      const card = [...document.querySelectorAll('.note-card')].find((item) =>
        item.textContent.includes('冲突草稿：原始正文'));
      [...card.querySelectorAll('button')].find((button) => button.textContent === '编辑').click();
      return true;
    })()`);
    await co.waitFor("document.querySelector('#note-dialog').open");
    await co.fill('#note-body', '冲突草稿：离线修改后的正文应保留在本地草稿');
    await co.click('#note-save');
    await co.waitFor("document.querySelector('.notes-board').innerText.includes('离线修改后的正文应保留在本地草稿')", {
      timeoutMs: 3000,
    });

    // 模拟另一个同身份窗口在服务端删除该便签
    const deletedByOtherWindow = await coApi('POST', `/api/interviews/${interviewId}/operations`, {
      ops: [
        {
          opId: `note-${crypto.randomUUID()}`,
          type: 'note.delete',
          round: conflictNote.round,
          payload: { noteId: conflictNote.id, version: conflictNote.version },
        },
      ],
    });
    assert.equal(deletedByOtherWindow.status, 200);
    assert.equal(deletedByOtherWindow.data.results[0].status, 'ok');

    await co.setOffline(false);
    await co.waitFor("document.querySelector('#sync-indicator').textContent.includes('已连接')", { timeoutMs: 20000 });
    await co.waitFor("!document.querySelector('#drafts-button').hidden", { timeoutMs: 8000 });
    await co.click('#drafts-button');
    await co.waitFor("document.querySelector('#drafts-dialog').open");
    const draftText = await co.text('#drafts-list');
    assert.match(draftText, /离线修改后的正文应保留在本地草稿/);
    assert.match(draftText, /便签已被删除/);
    await shot(co, '12-conflict-draft.png');
    await co.click('#drafts-dialog [data-close-dialog]');
    log('目标便签被他人删除后，离线正文保留为本地草稿并可查看');

    /* ---------------- 手机只读 ---------------- */
    await co.setViewport(390, 844, { mobile: true });
    await co.reload({ timeoutMs: 15000 });
    await co.waitFor("document.querySelector('#candidate-name')?.textContent.includes('林悦')", { timeoutMs: 8000 });
    const mobileBoard = await co.evaluate(`(() => ({
      overflow: document.documentElement.scrollWidth <= window.innerWidth + 2,
      newNoteHidden: !document.querySelector('#new-note-button').checkVisibility(),
      composerHidden: !document.querySelector('.composer').checkVisibility(),
      hintVisible: document.querySelector('.mobile-readonly-hint').checkVisibility(),
    }))()`);
    assert.equal(mobileBoard.overflow, true, '390px 视口下不应出现横向溢出');
    assert.equal(mobileBoard.newNoteHidden, true, '手机端应隐藏新建便签');
    assert.equal(mobileBoard.composerHidden, true, '手机端应隐藏讨论输入框');
    assert.equal(mobileBoard.hintVisible, true, '手机端应显示只读提示');
    await shot(co, '13-mobile-board.png');

    await candidate.setViewport(390, 844, { mobile: true });
    await candidate.reload({ timeoutMs: 15000 });
    await candidate.waitFor("document.querySelector('#candidate-root').innerText.includes('面试进行中')", {
      timeoutMs: 8000,
    });
    const mobileCandidate = await candidate.evaluate(`(() => ({
      overflow: document.documentElement.scrollWidth <= window.innerWidth + 2,
      hintVisible: document.querySelector('.mobile-only-note').checkVisibility(),
    }))()`);
    assert.equal(mobileCandidate.overflow, true, '面试人手机页不应横向溢出');
    assert.equal(mobileCandidate.hintVisible, true, '面试人手机页应显示只读提示');
    await shot(candidate, '14-mobile-candidate.png');
    log('390px 手机视口只读展示通过，无关键内容横向溢出');

    /* ---------------- 深色主题 ---------------- */
    await lead.setViewport(1440, 1000);
    await lead.goto(`${BASE}/interviews/${interviewId}/lead`);
    await lead.waitFor("document.querySelector('#candidate-name')?.textContent.includes('林悦')", { timeoutMs: 8000 });
    await lead.click('[data-theme-toggle]');
    await lead.waitFor("document.documentElement.dataset.theme === 'dark'");
    await shot(lead, '15-dark-theme.png');
    await lead.reload();
    await lead.waitFor("document.documentElement.dataset.theme === 'dark'", { timeoutMs: 5000 });
    log('深色主题切换成功并在刷新后保留');

    const exceptionReports = [
      ['主考官', lead.exceptions],
      ['副考官', co.exceptions],
      ['面试人', candidate.exceptions],
    ];
    for (const [name, exceptions] of exceptionReports) {
      assert.deepEqual(exceptions, [], `${name}页面出现未捕获脚本异常：${JSON.stringify(exceptions)}`);
    }
    const consoleErrors = [lead.errors, co.errors, candidate.errors].flat();
    if (consoleErrors.length) {
      console.log('[verify] 浏览器控制台错误（含离线网络失败，仅供参考）：');
      for (const error of [...new Set(consoleErrors)].slice(0, 10)) console.log(`  - ${error}`);
    }

    console.log('\n[verify] 浏览器实测全部通过。截图目录：docs/screenshots/');
  } finally {
    await Promise.all([leadBrowser.close(), coBrowser.close(), candidateBrowser.close()]);
  }
}

main().catch(async (error) => {
  console.error('[verify] 实测失败：', error);
  process.exitCode = 1;
  await sleep(100);
});
