#!/usr/bin/env node
import { readdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const ROOT = '/Users/slk/.openclaw';
const SHARED_DIR = join(ROOT, 'shared');
const GAME_DIR = '/Users/slk/Projects/ai-npc-game';
const OUT_DIR = import.meta.dirname;

async function main() {
  const data = {
    generated_at: new Date().toLocaleString('zh-CN'),
    agents: {},
    shared: {},
    ops_stats: {}
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

  // 3. 生成怪物数据（从游戏项目）
  try {
    const raw = await readFile(join(GAME_DIR, 'data/monster_cards.json'), 'utf8');
    const mc = JSON.parse(raw);
    const cards = mc.cards || mc;
    await writeFile(join(OUT_DIR, 'monsters_data.json'), JSON.stringify(cards, null, 2));
    console.log('✅ monsters_data.json:', cards.length, 'monsters');
  } catch (e) {
    console.warn('⚠️ Failed to generate monsters_data.json:', e.message);
  }

  // 4. 写 data.json
  await writeFile(join(OUT_DIR, 'data.json'), JSON.stringify(data, null, 2));
  console.log('✅ data.json generated');
  console.log('  - Agents:', Object.keys(data.agents).length);
  console.log('  - Shared:', Object.keys(data.shared).length);

  // 5. 写 data_meta.json（更新时间戳）
  const meta = {
    updated_at: new Date().toLocaleString('zh-CN'),
    monsters_count: 0
  };
  try {
    const raw = await readFile(join(OUT_DIR, 'monsters_data.json'), 'utf8');
    meta.monsters_count = JSON.parse(raw).length;
  } catch {}
  await writeFile(join(OUT_DIR, 'data_meta.json'), JSON.stringify(meta));
  console.log('✅ data_meta.json:', meta.updated_at);
}

main().catch(console.error);
