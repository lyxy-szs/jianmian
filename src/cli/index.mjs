#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.mjs';
import { CliError, createAdminClient } from './api.mjs';

const STATUS_LABELS = { open: '进行中', evaluating: '评估中', completed: '已完成' };
const ROLE_LABELS = { lead: '主考官', co: '副考官', candidate: '面试人' };

function printHelp() {
  console.log(`
面试搭子 · 本机控制台

用法：
  npm run console                              打开交互菜单（不会关闭服务）
  npm run console -- <command> [参数]

命令：
  status                                       查看服务地址、数据库、在线人数与已有面试
  create [--candidate 姓名 --position 岗位 --lead 姓名 --brief 简介 --focus 重点 --public 公开说明]
                                               创建空白面试；缺省字段会逐项询问
  demo                                         使用虚构资料创建示例面试
  links <interview-id>                         输出主考官标准入口与尚未领取的邀请链接
  reinvite <interview-id> --role co|candidate|lead --yes
                                               重新邀请席位（会撤销旧身份；必须 --yes 确认）
  recover-lead <interview-id> --yes            恢复主考官入口（会撤销旧身份；必须 --yes 确认）
  report <interview-id> [--output ./exports/report.md]
                                               导出 Markdown 报告；评估中导出标注“评估中”的摘要
  stop                                         停止本机服务（等价于服务终端 Ctrl+C）
  help                                         显示本帮助

说明：
  - 浏览器访问、三角色链接与业务操作不依赖命令行；本控制台只做本机启动和管理。
  - 邀请链接原值仅保存在本机 data/secrets.json（权限 600），兑换或过期后移除。
`);
}

function resolveConfig() {
  const config = loadConfig(process.env);
  // 服务启动后会把实际地址写入状态文件；CLI 优先使用它，避免 PORT 环境变量不一致。
  try {
    const state = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'server-state.json'), 'utf8'));
    if (state?.url) config.baseUrl = state.url;
  } catch {
    /* 服务未运行时保持配置默认值 */
  }
  return config;
}

function formatStatus(status) {
  const lines = [];
  lines.push('服务状态：运行中');
  lines.push(`  访问地址：${status.url}`);
  lines.push(`  监听：${status.host}:${status.port}`);
  lines.push(`  数据库：${status.dbPath}`);
  lines.push(`  启动时间：${status.startedAt}`);
  lines.push(`  在线人数：${status.online}（浏览器实时连接，同一浏览器多窗口计 1 人）`);
  lines.push('  已有面试：');
  if (!status.interviews.length) {
    lines.push('    （暂无；在浏览器打开访问地址即可创建）');
  } else {
    for (const interview of status.interviews) {
      const label = STATUS_LABELS[interview.status] ?? interview.status;
      lines.push(
        `    - ${interview.id}  ${interview.candidateName} · ${interview.position}  ${label}（第 ${interview.round} 轮）`,
      );
    }
  }
  return lines.join('\n');
}

function formatLinks(data) {
  const lines = [];
  lines.push(`面试 ${data.interview.id}`);
  lines.push(`  ${data.interview.candidateName} · ${data.interview.position} · 第 ${data.interview.round} 轮`);
  lines.push('');
  for (const role of ['lead', 'co', 'candidate']) {
    const seat = data.seats[role];
    lines.push(`${ROLE_LABELS[role]}（${seat.claimed ? '已领取' : '未领取'}）`);
    if (!seat.claimed && seat.inviteUrl) {
      lines.push(`  邀请链接：${seat.inviteUrl}`);
      lines.push(`  有效期至：${seat.expiresAt}`);
    } else {
      if (seat.claimed && seat.name) lines.push(`  姓名：${seat.name}`);
      lines.push(`  标准入口：${seat.standardUrl}`);
      lines.push(`  提示：${seat.hint}`);
    }
    lines.push('');
  }
  lines.push(
    '注意：以上邀请链接只发给对应角色；主考官链接不可转发。已领取席位的浏览器若丢失 Cookie，请使用 recover-lead 或 reinvite。',
  );
  return lines.join('\n');
}

function formatCreated(data, mode) {
  const lines = [];
  lines.push(mode === 'demo' ? '已创建示例面试（示例数据已写入数据库，仍需真实加入流程）：' : '已创建空白面试：');
  lines.push(`  面试 ID：${data.interview.id}`);
  lines.push(`  候选人：${data.interview.candidateName} · ${data.interview.position}`);
  lines.push('');
  lines.push('三个不同角色的入口（请分别在同一电脑的不同浏览器环境打开）：');
  lines.push(`  主考官（一次性领取）：${data.links.lead}`);
  lines.push(`  副考官（需主考官审批）：${data.links.co}`);
  lines.push(`  面试人：${data.links.candidate}`);
  lines.push('');
  lines.push(`稍后可用 npm run console -- links ${data.interview.id} 查看尚未领取的邀请；已领取席位只输出标准入口。`);
  return lines.join('\n');
}

function createPrompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  rl.on('close', () => {
    closed = true;
  });
  return {
    async ask(question, defaultValue = '') {
      if (closed) throw new CliError('输入已结束，操作取消。');
      const hint = defaultValue ? `（留空使用 ${defaultValue}）` : '（可留空）';
      const answer = (await rl.question(`${question}${hint}: `)).trim();
      return answer || defaultValue;
    },
    async required(question) {
      for (;;) {
        if (closed) throw new CliError('输入已结束，操作取消。');
        const answer = (await rl.question(`${question}（必填）: `)).trim();
        if (answer) return answer;
        console.log('  该字段不能为空，请重新输入。');
      }
    },
    async confirm(question) {
      if (closed) throw new CliError('输入已结束，操作取消。');
      const answer = (await rl.question(`${question} [y/N]: `)).trim().toLowerCase();
      return answer === 'y' || answer === 'yes' || answer === '是';
    },
    close() {
      rl.close();
    },
  };
}

async function createInteractive(admin, mode, flags) {
  const fields = {
    candidateName: flags.candidate,
    position: flags.position,
    leadName: flags.lead,
    internalBrief: flags.brief,
    internalFocus: flags.focus,
    publicBrief: flags.public,
  };
  if (mode === 'demo') {
    const data = await admin.create({ mode: 'demo' });
    console.log(formatCreated(data, mode));
    return data;
  }
  if (!process.stdin.isTTY) {
    if (!fields.candidateName || !fields.position || !fields.leadName) {
      throw new CliError('非交互模式请提供 --candidate、--position、--lead（可选 --brief、--focus、--public）。');
    }
    fields.internalBrief ??= '';
    fields.internalFocus ??= '';
    fields.publicBrief ??= '';
    const data = await admin.create({ mode: 'blank', ...fields });
    console.log(formatCreated(data, mode));
    return data;
  }
  const prompter = createPrompter();
  try {
    if (!fields.candidateName) fields.candidateName = await prompter.required('候选人姓名');
    if (!fields.position) fields.position = await prompter.required('应聘岗位');
    if (!fields.leadName) fields.leadName = await prompter.required('主考官姓名');
    if (fields.internalBrief === undefined) fields.internalBrief = await prompter.ask('候选人简介');
    if (fields.internalFocus === undefined) fields.internalFocus = await prompter.ask('本次面试重点');
    if (fields.publicBrief === undefined) fields.publicBrief = await prompter.ask('公开面试说明（会展示给面试人）');
    const data = await admin.create({ mode: 'blank', ...fields });
    console.log(formatCreated(data, mode));
    return data;
  } finally {
    prompter.close();
  }
}

async function printLinks(admin, interviewId) {
  const data = await admin.links(interviewId);
  console.log(formatLinks(data));
}

async function reinvite(admin, interviewId, role, confirmed) {
  if (!interviewId) throw new CliError('用法：reinvite <interview-id> --role co|candidate|lead --yes');
  if (!['lead', 'co', 'candidate'].includes(role)) {
    throw new CliError('--role 只能是 co、candidate 或 lead。');
  }
  if (!confirmed) {
    throw new CliError('重新邀请会立即撤销旧身份和旧实时连接，请追加 --yes 显式确认。');
  }
  const data = await admin.reinvite(interviewId, role);
  console.log(`已重新邀请${ROLE_LABELS[role]}席位（旧会话已撤销）。`);
  console.log(`  新邀请链接：${data.url}`);
  console.log(`  有效期至：${data.expiresAt}`);
  console.log(`  领取后的标准入口：${data.standardUrl}`);
}

async function recoverLead(admin, interviewId, confirmed) {
  if (!interviewId) throw new CliError('用法：recover-lead <interview-id> --yes');
  if (!confirmed) {
    throw new CliError('恢复主考官会立即撤销旧主考官身份，请追加 --yes 显式确认。');
  }
  const data = await admin.recoverLead(interviewId);
  console.log('已生成新的主考官恢复链接（旧主考官会话已撤销）。');
  console.log(`  恢复链接：${data.url}`);
  console.log(`  有效期至：${data.expiresAt}`);
  console.log(`  领取后的标准入口：${data.standardUrl}`);
}

async function exportReport(admin, interviewId, output) {
  if (!interviewId) throw new CliError('用法：report <interview-id> [--output ./exports/report.md]');
  const markdown = await admin.report(interviewId);
  if (!output) {
    process.stdout.write(markdown);
    return;
  }
  const target = path.resolve(process.cwd(), output);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, markdown, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    /* ignore */
  }
  const firstLine = markdown.split('\n')[0];
  console.log(`报告已导出：${target}`);
  console.log(`  报告标题：${firstLine}`);
  console.log('  内容来自当前报告版本；评估中会明确标注“评估中”。');
}

async function runMenu(admin, config) {
  const prompter = createPrompter();
  process.on('SIGINT', () => {
    prompter.close();
    console.log('\n已退出控制台（服务仍在运行）。');
    process.exit(0);
  });
  try {
    for (;;) {
      console.log(`
面试搭子 · 本机控制台（${config.baseUrl}）
  1) 查看服务状态
  2) 创建面试
  3) 创建示例面试
  4) 查看角色入口
  5) 重新邀请席位
  6) 恢复主考官入口
  7) 导出报告
  8) 停止服务
  9) 退出控制台
`);
      const choice = (await prompter.ask('请选择操作（1-9）')).trim();
      try {
        switch (choice) {
          case '1':
            console.log(formatStatus(await admin.status()));
            break;
          case '2':
            await createInteractive(admin, 'blank', {});
            break;
          case '3':
            await createInteractive(admin, 'demo', {});
            break;
          case '4': {
            const id = await prompter.required('面试 ID');
            await printLinks(admin, id);
            break;
          }
          case '5': {
            const id = await prompter.required('面试 ID');
            const role = (await prompter.ask('席位角色（lead/co/candidate）', 'co')).trim();
            if (!['lead', 'co', 'candidate'].includes(role)) {
              console.log('角色无效，已取消。');
              break;
            }
            const ok = await prompter.confirm(`确认撤销旧的${ROLE_LABELS[role]}身份并生成新链接？`);
            if (!ok) {
              console.log('已取消。');
              break;
            }
            await reinvite(admin, id, role, true);
            break;
          }
          case '6': {
            const id = await prompter.required('面试 ID');
            const ok = await prompter.confirm('确认撤销旧主考官身份并生成恢复链接？');
            if (!ok) {
              console.log('已取消。');
              break;
            }
            await recoverLead(admin, id, true);
            break;
          }
          case '7': {
            const id = await prompter.required('面试 ID');
            const output = await prompter.ask('导出路径', './exports/report.md');
            await exportReport(admin, id, output);
            break;
          }
          case '8': {
            const ok = await prompter.confirm('确认停止本机服务？正在使用的浏览器将断开。');
            if (!ok) {
              console.log('已取消。');
              break;
            }
            await admin.stop();
            console.log('已发送停止指令，服务正在关闭。');
            prompter.close();
            return;
          }
          case '9':
            console.log('已退出控制台（服务仍在运行）。');
            prompter.close();
            return;
          default:
            console.log('未识别的选项，请输入 1-9。');
        }
      } catch (error) {
        if (error instanceof CliError) console.log(`操作失败：${error.message}`);
        else console.log(`操作失败：${error.message}`);
      }
    }
  } finally {
    prompter.close();
  }
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        candidate: { type: 'string' },
        position: { type: 'string' },
        lead: { type: 'string' },
        brief: { type: 'string' },
        focus: { type: 'string' },
        public: { type: 'string' },
        role: { type: 'string' },
        output: { type: 'string', short: 'o' },
        yes: { type: 'boolean', short: 'y' },
        confirm: { type: 'boolean' },
        json: { type: 'boolean' },
      },
    });
  } catch (error) {
    console.error(`参数错误：${error.message}\n使用 npm run console -- help 查看用法。`);
    process.exit(1);
  }
  const { values, positionals } = parsed;
  if (values.help || positionals[0] === 'help') {
    printHelp();
    return;
  }
  const config = resolveConfig();
  const admin = createAdminClient(config);
  const command = positionals[0];
  if (!command) {
    await runMenu(admin, config);
    return;
  }
  const confirmed = Boolean(values.yes || values.confirm);

  switch (command) {
    case 'status':
      console.log(formatStatus(await admin.status()));
      return;
    case 'create': {
      if (!process.stdin.isTTY && !(values.candidate && values.position && values.lead)) {
        throw new CliError('非交互模式下请提供 --candidate、--position、--lead（可选 --brief、--focus、--public）。');
      }
      await createInteractive(admin, 'blank', values);
      return;
    }
    case 'demo': {
      const data = await admin.create({ mode: 'demo' });
      console.log(formatCreated(data, 'demo'));
      return;
    }
    case 'links': {
      const id = positionals[1];
      if (!id) throw new CliError('用法：links <interview-id>');
      await printLinks(admin, id);
      return;
    }
    case 'reinvite':
      await reinvite(admin, positionals[1], values.role, confirmed);
      return;
    case 'recover-lead':
      await recoverLead(admin, positionals[1], confirmed);
      return;
    case 'report':
      await exportReport(admin, positionals[1], values.output);
      return;
    case 'stop': {
      const result = await admin.stop();
      if (result?.stopping) console.log('已通知服务停止。服务终端会显示关闭信息。');
      return;
    }
    default:
      throw new CliError(`未知命令：${command}\n使用 npm run console -- help 查看用法。`);
  }
}

main().catch((error) => {
  if (error instanceof CliError) {
    console.error(`错误：${error.message}`);
  } else {
    console.error(`错误：${error?.message || error}`);
    if (process.env.DEBUG_CLI) console.error(error);
  }
  process.exit(1);
});
