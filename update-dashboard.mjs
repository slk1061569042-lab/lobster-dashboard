#!/usr/bin/env node
// update-dashboard.mjs — 纯脚本更新仪表盘，不走 AI
// 用法：node update-dashboard.mjs [--push]

import { readdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { execSync } from 'child_process';

const ROOT = '/Users/slk/.openclaw';
const SHARED_DIR = join(ROOT, 'shared');
const DASH_DIR = join(ROOT, 'workspace-cursor/lobster-dashboard');

async function main() {
  const doPush = process.argv.includes('--push');

  // 1. 读取原始 index.html 模板（head 部分）
  const oldHtml = await readFile(join(DASH_DIR, 'index.html'), 'utf8');

  // 找到 const CONTENT = 的位置
  const contentStart = oldHtml.indexOf('const CONTENT = ');
  const contentEnd = oldHtml.indexOf(';\n', contentStart);
  if (contentStart === -1 || contentEnd === -1) {
    console.error('❌ 找不到 CONTENT 变量');
    process.exit(1);
  }

  // 2. 收集所有 agent 数据
  const content = {};
  let idx = 1;

  const dirs = await readdir(ROOT);
  const agentDirs = dirs.filter(d => d.startsWith('workspace-')).sort();

  for (const dir of agentDirs) {
    const agentId = dir.replace('workspace-', '');
    const workspace = join(ROOT, dir);
    const fileNames = ['SOUL.md', 'AGENTS.md', 'HEARTBEAT.md', 'TOOLS.md', 'MEMORY.md'];

    for (const fn of fileNames) {
      try {
        const c = await readFile(join(workspace, fn), 'utf8');
        content[`content_${idx}`] = { title: `${agentId}/${fn}`, content: c };
        idx++;
      } catch { /* skip */ }
    }
  }

  // 3. 收集 shared 文件
  const sharedFiles = (await readdir(SHARED_DIR)).filter(f => f.endsWith('.md')).sort();
  for (const fn of sharedFiles) {
    try {
      const c = await readFile(join(SHARED_DIR, fn), 'utf8');
      content[`content_${idx}`] = { title: `shared/${fn}`, content: c };
      idx++;
    } catch { /* skip */ }
  }

  // 4. 更新时间
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  // 5. 替换 CONTENT 和更新时间
  let newHtml = oldHtml.substring(0, contentStart)
    + 'const CONTENT = ' + JSON.stringify(content)
    + oldHtml.substring(contentEnd);

  // 更新时间戳
  newHtml = newHtml.replace(/更新时间：[^<]+/, `更新时间：${now}`);

  await writeFile(join(DASH_DIR, 'index.html'), newHtml);
  console.log(`✅ 仪表盘已更新 (${idx - 1} 个文件, ${now})`);

  // 6. Git commit + push
  if (doPush) {
    try {
      execSync('git add index.html && git commit -m "chore: 自动更新仪表盘 ' + now + '" --allow-empty', { cwd: DASH_DIR, stdio: 'pipe' });
      execSync('git push origin main', { cwd: DASH_DIR, stdio: 'pipe' });
      console.log('✅ 已推送到 GitHub');
    } catch (e) {
      console.error('⚠️ Git push 失败:', e.message);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
