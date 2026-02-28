#!/usr/bin/env node
import { readdir, readFile, writeFile } from 'fs/promises';
import { join, basename } from 'path';

const ROOT = '/Users/slk/.openclaw';
const SHARED_DIR = join(ROOT, 'shared');
const OUTPUT = join(import.meta.dirname, 'data.json');

async function main() {
  const data = {
    generated_at: new Date().toLocaleString('zh-CN'),
    agents: {},
    shared: {}
  };

  // 1. 扫描所有 agent workspaces
  const dirs = await readdir(ROOT);
  for (const dir of dirs) {
    if (!dir.startsWith('workspace-')) continue;
    const agentId = dir.replace('workspace-', '');
    const workspace = join(ROOT, dir);
    data.agents[agentId] = { files: {} };

    const fileNames = ['SOUL.md', 'AGENTS.md', 'HEARTBEAT.md', 'TOOLS.md', 'MEMORY.md', 'IDENTITY.md', 'USER.md'];
    for (const fn of fileNames) {
      try {
        const content = await readFile(join(workspace, fn), 'utf8');
        const lines = content.split('\n').filter(l => l.trim().length > 0).length;
        data.agents[agentId].files[fn] = { content, lines };
      } catch { /* skip */ }
    }
  }

  // 2. 扫描 shared 目录
  const sharedFiles = await readdir(SHARED_DIR);
  for (const fn of sharedFiles) {
    if (!fn.endsWith('.md')) continue;
    try {
      const content = await readFile(join(SHARED_DIR, fn), 'utf8');
      const lines = content.split('\n').filter(l => l.trim().length > 0).length;
      data.shared[fn] = { content, lines };
    } catch { /* skip */ }
  }

  // 3. 写 data.json
  await writeFile(OUTPUT, JSON.stringify(data, null, 2));
  console.log('✅ Generated', OUTPUT);
  console.log('  - Agents:', Object.keys(data.agents).length);
  console.log('  - Shared:', Object.keys(data.shared).length);
}

main().catch(console.error);
