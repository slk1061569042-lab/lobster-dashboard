#!/usr/bin/env node
/**
 * 灵息大陆 — 素材看板后端
 * 端口 3666 | 静态 dashboard/ + assets/ | CORS 全开 | Ludo 串行代理 | 素材 API | Supabase 代理
 */
import http from 'http';
import https from 'https';
import zlib from 'zlib';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 项目根目录 = dashboard 的父目录 */
const PROJECT_DIR = '/Users/slk/projects/ai-npc-game';
const DASHBOARD_DIR = __dirname;
const ASSETS_DIR = path.join(PROJECT_DIR, 'assets');
const PORT = 7788;
const LUDO_BASE = 'https://mcp.ludo.ai';
const LUDO_API_KEY = process.env.LUDO_API_KEY || '7497e7e5-e53b-44ee-bf1f-d672489be147';
const SUPABASE_HOST = 'fxkchzptmhecgrqjosot.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ4a2NoenB0bWhlY2dycWpvc290Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA4MjUxNDAsImV4cCI6MjA4NjQwMTE0MH0.RHcMUCWvjum4btDHiEm14d338fmxK3GYHaiv2cSNwJk';

const LIST_TYPES = new Set(['monsters', 'scenes', 'backgrounds']);
const ALLOWED_ASSET_TYPES = new Set(['monsters', 'scenes', 'backgrounds', 'npc', 'ui', 'audio', 'effects']);
const JSON_BODY_LIMIT = 50 * 1024 * 1024; // 50MB
const SCAN_INTERVAL_MS = 5 * 60 * 1000; // 5分钟静默扫描

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg',
  '.json': 'application/json', '.md': 'text/plain; charset=utf-8',
  '.tres': 'text/plain', '.gd': 'text/plain', '.gdshader': 'text/plain',
};

/** 怪物素材槽位（用于 scan） */
const MONSTER_SLOTS = [
  'fullbody.png', 'portrait.png', 'icon.png', 'card_art.png',
  'poses', 'animations/idle', 'animations/walk', 'animations/run',
  'animations/attack', 'animations/hit', 'animations/death', 'animations/skill', 'animations/summon',
  'video', 'sfx', 'voice', 'model3d', 'meta.json'
];

// ——— 扫描状态 ———
let scanState = {
  lastScanAt: 0,
  isScanning: false,
  lastError: null,
  changes: 0,
};

/** 扫描并更新 monsters_data.json，生成缩略图 */
async function scanAndUpdateMonsters() {
  if (scanState.isScanning) return;
  scanState.isScanning = true;
  scanState.lastError = null;
  let changes = 0;

  try {
    const monstersDir = path.join(ASSETS_DIR, 'monsters');
    const dataPath = path.join(DASHBOARD_DIR, 'monsters_data.json');

    let existing = [];
    if (fs.existsSync(dataPath)) {
      try {
        existing = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
      } catch {
        existing = [];
      }
    }

    const entries = fs.readdirSync(monstersDir, { withFileTypes: true });
    const ids = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
      .map((e) => e.name);

    const newData = [];
    const nowIso = new Date().toISOString();

    for (const id of ids) {
      const baseDir = path.join(monstersDir, id);
      let m = existing.find((x) => x.id === id);
      if (!m) {
        m = { id, created_at: nowIso };
        changes++;
      }

      const oldHasFullbody = !!m.has_fullbody;
      const oldHasPortrait = !!m.has_portrait;

      m.has_fullbody = fs.existsSync(path.join(baseDir, 'fullbody.png'));
      m.has_portrait = fs.existsSync(path.join(baseDir, 'portrait.png'));
      m.has_spritesheet =
        fs.existsSync(path.join(baseDir, 'animations', 'idle', 'spritesheet.png')) ||
        fs.existsSync(path.join(baseDir, 'animations', 'idle.gif'));

      if (m.has_fullbody !== oldHasFullbody || m.has_portrait !== oldHasPortrait) {
        changes++;
      }

      // 生成缩略图（如果有 fullbody 但没有 thumb.png）
      if (m.has_fullbody && !fs.existsSync(path.join(baseDir, 'thumb.png'))) {
        try {
          execSync(
            `sips -Z 400 "${path.join(baseDir, 'fullbody.png')}" --out "${path.join(
              baseDir,
              'thumb.png',
            )}"`,
            { stdio: 'ignore' },
          );
          changes++;
        } catch (e) {
          console.warn(`⚠️ 缩略图生成失败 ${id}:`, e.message);
        }
      }

      m.updated_at = nowIso;
      newData.push(m);
    }

    // 按 card_no 排序，未知的排后面
    newData.sort((a, b) => (a.card_no || 9999) - (b.card_no || 9999));

    fs.writeFileSync(dataPath, JSON.stringify(newData, null, 2), 'utf8');

    scanState.changes = changes;
    scanState.lastScanAt = Date.now();
    console.log(`✅ 扫描完成：${ids.length} 个怪物，${changes} 处变更`);
  } catch (e) {
    scanState.lastError = e.message;
    console.error('❌ 扫描失败:', e);
  } finally {
    scanState.isScanning = false;
  }
}

// ——— 工具 ———
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function jsonRes(res, data, status = 200) {
  setCors(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

/** 确保路径在 assets 内，不允许路径逃逸 */
function resolveAssetPath(type, id, subpath = '') {
  if (!ALLOWED_ASSET_TYPES.has(type)) return null;
  const safeId = path.basename(id).replace(/\.\./g, '');
  const parts = subpath ? subpath.split(/[/\\]/).filter(Boolean) : [];
  const full = path.resolve(ASSETS_DIR, type, safeId, ...parts);
  if (full !== ASSETS_DIR && !full.startsWith(ASSETS_DIR + path.sep)) return null;
  return full;
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const buf = [];
    let len = 0;
    req.on('data', (chunk) => {
      len += chunk.length;
      if (len > JSON_BODY_LIMIT) {
        req.destroy();
        reject(new Error('Body too large'));
        return;
      }
      buf.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(buf).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// ——— Ludo 串行队列 ———
const ludoQueue = [];
let ludoProcessing = false;

function runLudoQueue() {
  if (ludoProcessing || ludoQueue.length === 0) return;
  ludoProcessing = true;
  const { res, action, body } = ludoQueue.shift();
  // MCP JSON-RPC call
  const rpcPayload = {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: { name: action, arguments: { requestBody: body || {} } }
  };
  const bodyStr = JSON.stringify(rpcPayload);

  const options = {
    hostname: 'mcp.ludo.ai',
    port: 443,
    path: '/mcp',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr, 'utf8'),
      'Authorization': 'ApiKey ' + LUDO_API_KEY,
    },
  };

  const proxyReq = https.request(options, (proxyRes) => {
    const chunks = [];
    proxyRes.on('data', (c) => chunks.push(c));
    proxyRes.on('end', () => {
      setCors(res);
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const rpc = JSON.parse(raw);
        // Extract MCP result content
        if (rpc.result && rpc.result.content) {
          const textParts = rpc.result.content.filter(c => c.type === 'text').map(c => c.text);
          const combined = textParts.join('\n');
          // Try to parse as JSON (Ludo returns JSON in text)
          try {
            const parsed = JSON.parse(combined);
            jsonRes(res, parsed, 200);
          } catch {
            jsonRes(res, { text: combined }, 200);
          }
        } else if (rpc.error) {
          jsonRes(res, { error: rpc.error.message || 'MCP error', details: rpc.error }, 400);
        } else {
          jsonRes(res, { raw: rpc }, 200);
        }
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(Buffer.concat(chunks));
      }
      ludoProcessing = false;
      runLudoQueue();
    });
  });

  proxyReq.on('error', (err) => {
    console.error('Ludo proxy error:', err);
    jsonRes(res, { error: 'Ludo proxy failed', details: err.message }, 502);
    ludoProcessing = false;
    runLudoQueue();
  });

  proxyReq.write(bodyStr, 'utf8');
  proxyReq.end();
}

// ——— 路由 ———

/** POST /api/ludo/:action → https://api.ludo.ai/v2/:action，串行 */
function handleLudoProxy(req, res, action) {
  if (!/^[a-zA-Z0-9_]+$/.test(action)) {
    return jsonRes(res, { error: 'Invalid action' }, 400);
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let parsed = {};
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch (_) {
      return jsonRes(res, { error: 'Invalid JSON body' }, 400);
    }
    ludoQueue.push({ res, action, body: parsed });
    runLudoQueue();
  });
  req.on('error', () => jsonRes(res, { error: 'Request error' }, 500));
}

/** GET /api/assets/list?type=monsters|scenes|backgrounds */
function handleAssetsList(req, res, url) {
  const type = url.searchParams.get('type') || 'monsters';
  if (!LIST_TYPES.has(type)) {
    return jsonRes(res, { error: 'Invalid type', allowed: [...LIST_TYPES] }, 400);
  }
  const dir = path.join(ASSETS_DIR, type);
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return jsonRes(res, { list: [], error: e.message });
  }
  const list = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
    .map((e) => ({ id: e.name, path: `${type}/${e.name}` }));
  jsonRes(res, { type, list });
}

/** GET /api/assets/meta/:type/:id — 读 meta.json */
function handleAssetsMeta(req, res, type, id) {
  if (!ALLOWED_ASSET_TYPES.has(type)) return jsonRes(res, { error: 'Invalid type' }, 400);
  const safeId = path.basename(id).replace(/\.\./g, '');
  const metaPath = path.resolve(ASSETS_DIR, type, safeId, 'meta.json');
  if (!metaPath.startsWith(ASSETS_DIR + path.sep)) return jsonRes(res, { error: 'Invalid path' }, 403);
  try {
    const raw = fs.readFileSync(metaPath, 'utf8');
    const data = JSON.parse(raw);
    return jsonRes(res, data);
  } catch (e) {
    if (e.code === 'ENOENT') return jsonRes(res, {}, 200);
    return jsonRes(res, { error: e.message }, 500);
  }
}

function downloadUrl(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = { hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET' };
    const client = u.protocol === 'https:' ? https : http;
    const req = client.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.end();
  });
}

/** POST /api/assets/save — body: { type, id, subpath?, url? | data?(base64) }，下载远程图保存本地 */
function handleAssetsSave(req, res) {
  parseJsonBody(req).then(async (body) => {
    const { type, id, subpath, data: b64, url: remoteUrl } = body || {};
    if (!type || !id) return jsonRes(res, { error: 'Missing type or id' }, 400);
    const filePath = resolveAssetPath(type, id, subpath || '');
    if (!filePath) return jsonRes(res, { error: 'Invalid type or path' }, 400);

    let buf;
    if (b64) {
      try { buf = Buffer.from(b64, 'base64'); } catch (_) {
        return jsonRes(res, { error: 'Invalid base64 data' }, 400);
      }
    } else if (remoteUrl) {
      try { buf = await downloadUrl(remoteUrl); } catch (e) {
        return jsonRes(res, { error: 'Download failed', details: e.message }, 502);
      }
    } else {
      return jsonRes(res, { error: 'Provide data (base64) or url' }, 400);
    }

    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, buf);
      // 上传/保存后触发后台扫描（不等待）
      scanAndUpdateMonsters();
      return jsonRes(res, { ok: true, path: path.relative(ASSETS_DIR, filePath) });
    } catch (e) {
      return jsonRes(res, { error: e.message }, 500);
    }
  }).catch((e) => {
    if (e.message === 'Body too large') return jsonRes(res, { error: 'Body too large' }, 413);
    return jsonRes(res, { error: e.message || 'Bad request' }, 400);
  });
}

/** POST /api/assets/replace — 同 save，先备份旧文件到 _deprecated/ */
function handleAssetsReplace(req, res) {
  parseJsonBody(req).then(async (body) => {
    const { type, id, subpath, data: b64, url: remoteUrl } = body || {};
    if (!type || !id || !subpath) return jsonRes(res, { error: 'Missing type, id or subpath' }, 400);
    const filePath = resolveAssetPath(type, id, subpath);
    if (!filePath) return jsonRes(res, { error: 'Invalid path' }, 400);

    let buf;
    if (b64) {
      try { buf = Buffer.from(b64, 'base64'); } catch (_) {
        return jsonRes(res, { error: 'Invalid base64' }, 400);
      }
    } else if (remoteUrl) {
      try { buf = await downloadUrl(remoteUrl); } catch (e) {
        return jsonRes(res, { error: 'Download failed', details: e.message }, 502);
      }
    } else {
      return jsonRes(res, { error: 'Provide data or url' }, 400);
    }

    const deprecDir = path.join(ASSETS_DIR, '_deprecated', type, id);
    const ext = path.extname(subpath) || '';
    const base = path.basename(subpath, ext);
    const backupName = `${base}_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}${ext}`;
    const backupPath = path.join(deprecDir, backupName);

    try {
      if (fs.existsSync(filePath)) {
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        fs.copyFileSync(filePath, backupPath);
      }
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, buf);
      // 替换后触发后台扫描
      scanAndUpdateMonsters();
      return jsonRes(res, { ok: true, backup: backupName });
    } catch (e) {
      return jsonRes(res, { error: e.message }, 500);
    }
  }).catch((e) => {
    if (e.message === 'Body too large') return jsonRes(res, { error: 'Body too large' }, 413);
    return jsonRes(res, { error: e.message || 'Bad request' }, 400);
  });
}

/** POST /api/assets/stage — 保存到 _staging/ */
function handleAssetsStage(req, res) {
  parseJsonBody(req).then(async (body) => {
    const { type, id, subpath, data: b64, url: remoteUrl } = body || {};
    if (!type || !id) return jsonRes(res, { error: 'Missing type or id' }, 400);
    const safeId = path.basename(id).replace(/\.\./g, '');
    const parts = (subpath || '').split(/[/\\]/).filter(Boolean);
    const stagingPath = path.resolve(ASSETS_DIR, '_staging', type, safeId, ...parts);
    if (!stagingPath.startsWith(ASSETS_DIR + path.sep)) return jsonRes(res, { error: 'Invalid path' }, 400);

    let buf;
    if (b64) {
      try { buf = Buffer.from(b64, 'base64'); } catch (_) {
        return jsonRes(res, { error: 'Invalid base64' }, 400);
      }
    } else if (remoteUrl) {
      try { buf = await downloadUrl(remoteUrl); } catch (e) {
        return jsonRes(res, { error: 'Download failed', details: e.message }, 502);
      }
    } else {
      return jsonRes(res, { error: 'Provide data or url' }, 400);
    }

    try {
      fs.mkdirSync(path.dirname(stagingPath), { recursive: true });
      fs.writeFileSync(stagingPath, buf);
      return jsonRes(res, { ok: true, path: path.relative(ASSETS_DIR, stagingPath) });
    } catch (e) {
      return jsonRes(res, { error: e.message }, 500);
    }
  }).catch((e) => {
    if (e.message === 'Body too large') return jsonRes(res, { error: 'Body too large' }, 413);
    return jsonRes(res, { error: e.message || 'Bad request' }, 400);
  });
}

function slotStatus(slot, baseDir) {
  const full = path.join(baseDir, slot);
  try {
    const st = fs.statSync(full);
    if (st.isFile()) return 'done';
    if (st.isDirectory()) {
      const entries = fs.readdirSync(full);
      return entries.length > 0 ? 'done' : 'pending';
    }
  } catch (_) {}
  return 'pending';
}

/** GET /api/assets/scan/:type/:id — 扫描素材完成度 */
function handleAssetsScan(req, res, type, id) {
  if (!ALLOWED_ASSET_TYPES.has(type)) return jsonRes(res, { error: 'Invalid type' }, 400);
  const safeId = path.basename(id).replace(/\.\./g, '');
  const baseDir = path.resolve(ASSETS_DIR, type, safeId);
  if (!baseDir.startsWith(ASSETS_DIR + path.sep)) return jsonRes(res, { error: 'Invalid path' }, 403);

  const slots = type === 'monsters' || type === 'npc' ? MONSTER_SLOTS : ['meta.json'];
  const result = {};
  for (const slot of slots) result[slot] = slotStatus(slot, baseDir);
  jsonRes(res, { type, id: safeId, slots: result });
}

/** GET /api/stories — 返回故事列表 */
function handleStories(req, res) {
  const storyDir = path.join(PROJECT_DIR, 'docs', 'story');
  if (!fs.existsSync(storyDir)) return jsonRes(res, [], 200);
  try {
    const files = fs.readdirSync(storyDir).filter(f => f.endsWith('.md') && !f.includes('migration')).sort();
    const list = files.map((f, i) => {
      const raw = fs.readFileSync(path.join(storyDir, f), 'utf8');
      const title = (raw.match(/^#\s+(.+)/m) || ['', f])[1];
      return { id: f.replace('.md',''), file: f, title, index: i };
    });
    jsonRes(res, list, 200);
  } catch (e) { jsonRes(res, { error: e.message }, 500); }
}

/** GET /api/stories/:id — 返回单个故事内容 */
function handleStoryContent(req, res, storyId) {
  const storyDir = path.join(PROJECT_DIR, 'docs', 'story');
  const filePath = path.join(storyDir, storyId + '.md');
  if (!fs.existsSync(filePath)) return jsonRes(res, { error: 'not found' }, 404);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    jsonRes(res, { id: storyId, content: raw }, 200);
  } catch (e) { jsonRes(res, { error: e.message }, 500); }
}

/** POST /api/monsters/:id/update — 更新怪物字段 */
function handleUpdateMonster(req, res, monsterId) {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    try {
      const updates = JSON.parse(body);
      const filePath = path.join(DASHBOARD_DIR, 'monsters_data.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const m = data.find(x => x.id === monsterId);
      if (!m) return jsonRes(res, { error: 'not found' }, 404);
      for (const [k, v] of Object.entries(updates)) {
        if (['id'].includes(k)) continue; // protect id
        m[k] = v;
      }
      m.updated_at = new Date().toISOString();
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
      console.log(`✏️ ${monsterId} updated: ${Object.keys(updates).join(',')}`);
      jsonRes(res, { id: monsterId, updated: Object.keys(updates) }, 200);
    } catch (e) {
      jsonRes(res, { error: e.message }, 500);
    }
  });
}

/** POST /api/assets/upload — 上传文件 (multipart) */
function handleAssetUpload(req, res) {
  const boundary = req.headers['content-type']?.split('boundary=')[1];
  if (!boundary) return jsonRes(res, { error: 'no boundary' }, 400);
  let body = Buffer.alloc(0);
  req.on('data', chunk => { body = Buffer.concat([body, chunk]); });
  req.on('end', () => {
    try {
      const str = body.toString('latin1');
      // parse fields
      const fieldRe = /name="(\w+)"\r\n\r\n([^\r]*)/g;
      const fields = {};
      let fm;
      while ((fm = fieldRe.exec(str)) !== null) fields[fm[1]] = fm[2];
      // parse file
      const fileMatch = str.match(/name="file"; filename="([^"]+)"\r\nContent-Type: ([^\r]+)\r\n\r\n/);
      if (!fileMatch) return jsonRes(res, { error: 'no file' }, 400);
      const fileStart = str.indexOf(fileMatch[0]) + fileMatch[0].length;
      const fileEnd = str.indexOf('\r\n--' + boundary, fileStart);
      const fileData = body.slice(fileStart, fileEnd);
      const type = fields.type || 'monsters';
      const id = fields.id;
      const subpath = fields.subpath || fileMatch[1];
      const destDir = path.join(PROJECT_DIR, 'assets', type, id);
      const destPath = path.join(destDir, subpath);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, fileData);
      console.log(`📤 uploaded ${type}/${id}/${subpath} (${fileData.length} bytes)`);
      // 上传后触发后台扫描
      scanAndUpdateMonsters();
      jsonRes(res, { ok: true, path: `${type}/${id}/${subpath}`, size: fileData.length }, 200);
    } catch (e) {
      jsonRes(res, { error: e.message }, 500);
    }
  });
}

/** POST /api/monsters/:id/toggle-public — 切换怪物公开状态 */
function handleTogglePublic(req, res, monsterId) {
  const filePath = path.join(DASHBOARD_DIR, 'monsters_data.json');
  if (!fs.existsSync(filePath)) return jsonRes(res, { error: 'data not found' }, 404);
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const m = data.find(x => x.id === monsterId);
    if (!m) return jsonRes(res, { error: 'monster not found' }, 404);
    m.public = !m.public;
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    console.log(`🔓 ${monsterId} public=${m.public}`);
    jsonRes(res, { id: monsterId, public: m.public }, 200);
  } catch (e) {
    jsonRes(res, { error: e.message }, 500);
  }
}

/** POST /api/monsters/batch-public — 批量设置公开状态 { ids: [...], public: true/false } */
function handleBatchPublic(req, res) {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    try {
      const { ids, public: pub } = JSON.parse(body);
      const filePath = path.join(DASHBOARD_DIR, 'monsters_data.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      let count = 0;
      for (const m of data) {
        if (ids.includes(m.id)) { m.public = !!pub; count++; }
      }
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
      console.log(`🔓 batch public=${pub} count=${count}`);
      jsonRes(res, { updated: count }, 200);
    } catch (e) {
      jsonRes(res, { error: e.message }, 500);
    }
  });
}

/** GET /api/monsters — 返回 monsters_data.json */
function handleMonsters(req, res) {
  const filePath = path.join(DASHBOARD_DIR, 'monsters_data.json');
  if (!fs.existsSync(filePath)) return jsonRes(res, [], 200);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    setCors(res);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(raw);
  } catch (e) {
    jsonRes(res, { error: e.message }, 500);
  }
}

/** GET /api/scan/status — 返回扫描状态 */
function handleScanStatus(req, res) {
  jsonRes(res, scanState);
}

/** POST /api/scan/refresh — 手动触发扫描 */
async function handleScanRefresh(req, res) {
  if (scanState.isScanning) {
    return jsonRes(res, { error: 'already scanning' }, 409);
  }
  jsonRes(res, { ok: true, message: 'scan started' });
  // 后台执行扫描
  scanAndUpdateMonsters();
}

/** POST /api/refresh — 重新生成 data.json + 更新 index.html + git push（静默） */
async function handleDashboardRefresh(req, res) {
  try {
    // Step 1: 运行 generate.mjs 生成 data.json + monsters_data.json
    execSync('node generate.mjs', { cwd: DASHBOARD_DIR, stdio: 'pipe', timeout: 30000 });
    // Step 2: 运行 update-dashboard.mjs --push 更新 index.html 并推送
    execSync('node update-dashboard.mjs --push', { cwd: DASHBOARD_DIR, stdio: 'pipe', timeout: 60000 });
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    jsonRes(res, { ok: true, timestamp: now, message: '仪表盘已刷新并推送' });
  } catch (e) {
    console.error('Dashboard refresh error:', e.message);
    jsonRes(res, { ok: false, error: e.message }, 500);
  }
}

/** GET /api/ops-materials — 返回 workspace-ops 的 ops_materials.json */
function handleOpsMaterials(req, res) {
  const opsPath = '/Users/slk/.openclaw/workspace-ops/memory/ops_materials.json';
  try {
    const raw = fs.readFileSync(opsPath, 'utf8');
    JSON.parse(raw); // validate
    setCors(res);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(raw);
  } catch (e) {
    jsonRes(res, { error: e.message }, 500);
  }
}

/** Supabase 代理：/supabase/* → fxkchzptmhecgrqjosot.supabase.co */
function proxyToSupabase(req, res, pathname, searchParamsStr) {
  const pathAndQuery = pathname + (searchParamsStr ? '?' + searchParamsStr : '');
  const filteredHeaders = {};
  for (const [key, val] of Object.entries(req.headers)) {
    const k = key.toLowerCase();
    if (k === 'host' || k === 'connection') continue;
    filteredHeaders[key] = val;
  }
  filteredHeaders['apikey'] = SUPABASE_ANON_KEY;
  filteredHeaders['Authorization'] = `Bearer ${SUPABASE_ANON_KEY}`;

  const options = {
    hostname: SUPABASE_HOST,
    port: 443,
    path: pathAndQuery,
    method: req.method,
    headers: filteredHeaders,
  };

  const proxyReq = https.request(options, (proxyRes) => {
    setCors(res);
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('Supabase proxy error:', err);
    jsonRes(res, { error: 'Supabase proxy failed', details: err.message }, 502);
  });

  req.pipe(proxyReq);
}

/** 静态文件：dashboard/ 与 assets/ */
function serveStatic(req, res, pathname) {
  let baseDir;
  let rel;
  if (pathname.startsWith('/assets/')) {
    baseDir = ASSETS_DIR;
    rel = pathname.slice(7).replace(/^\//, '').replace(/\.\./g, '');
  } else {
    baseDir = DASHBOARD_DIR;
    rel = pathname === '/' ? 'home.html' : pathname.replace(/^\//, '').replace(/\.\./g, '');
  }

  let filePath = path.resolve(baseDir, rel);
  const allowedBase = baseDir + path.sep;
  if (filePath !== baseDir && !filePath.startsWith(allowedBase)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) {
    filePath = path.join(filePath, 'index.html');
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
  }
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const isImg = /^\.(png|jpg|jpeg|gif|webp|svg)$/.test(ext);
  const cacheTime = isImg ? 604800 : 3600;
  const headers = { 'Content-Type': mime, 'Cache-Control': 'public, max-age=' + cacheTime };
  setCors(res);
  // gzip text content
  const acceptGzip = (req.headers['accept-encoding'] || '').includes('gzip');
  if (!isImg && acceptGzip && stat.size > 1024) {
    headers['Content-Encoding'] = 'gzip';
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(zlib.createGzip()).pipe(res);
    return;
  }
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

// ——— 主服务 ———
function handleRequest(req, res) {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const pathname = decodeURIComponent(url.pathname);

  setCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname.startsWith('/supabase/')) {
    proxyToSupabase(req, res, pathname.replace('/supabase', ''), url.searchParams.toString());
    return;
  }

  const ludoMatch = pathname.match(/^\/api\/ludo\/([a-zA-Z0-9_]+)$/);
  if (req.method === 'POST' && ludoMatch) {
    handleLudoProxy(req, res, ludoMatch[1]);
    return;
  }

  if (pathname === '/api/assets/list') {
    handleAssetsList(req, res, url);
    return;
  }
  const metaMatch = pathname.match(/^\/api\/assets\/meta\/([^/]+)\/([^/]+)$/);
  if (req.method === 'GET' && metaMatch) {
    handleAssetsMeta(req, res, metaMatch[1], metaMatch[2]);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/assets/save') {
    handleAssetsSave(req, res);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/assets/replace') {
    handleAssetsReplace(req, res);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/assets/stage') {
    handleAssetsStage(req, res);
    return;
  }
  const scanMatch = pathname.match(/^\/api\/assets\/scan\/([^/]+)\/([^/]+)$/);
  if (req.method === 'GET' && scanMatch) {
    handleAssetsScan(req, res, scanMatch[1], scanMatch[2]);
    return;
  }

  if (pathname === '/api/stories') { handleStories(req, res); return; }
  const storyMatch = pathname.match(/^\/api\/stories\/(.+)$/);
  if (req.method === 'GET' && storyMatch) { handleStoryContent(req, res, storyMatch[1]); return; }
  const updateMatch = pathname.match(/^\/api\/monsters\/([^/]+)\/update$/);
  if (req.method === 'POST' && updateMatch) {
    handleUpdateMonster(req, res, updateMatch[1]);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/assets/upload') {
    handleAssetUpload(req, res);
    return;
  }
  const toggleMatch = pathname.match(/^\/api\/monsters\/([^/]+)\/toggle-public$/);
  if (req.method === 'POST' && toggleMatch) {
    handleTogglePublic(req, res, toggleMatch[1]);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/monsters/batch-public') {
    handleBatchPublic(req, res);
    return;
  }
  if (pathname === '/api/monsters') {
    handleMonsters(req, res);
    return;
  }
  if (pathname === '/api/scan/status') {
    handleScanStatus(req, res);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/scan/refresh') {
    handleScanRefresh(req, res);
    return;
  }
  if (pathname === '/api/ops-materials') {
    handleOpsMaterials(req, res);
    return;
  }

  // POST /api/refresh — 手动刷新：重新生成 data.json + 更新 index.html + git push
  if (req.method === 'POST' && pathname === '/api/refresh') {
    handleDashboardRefresh(req, res);
    return;
  }

  serveStatic(req, res, pathname);
}

const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  console.log('✅ 灵息大陆看板服务：http://localhost:' + PORT);
  console.log('📂 项目根目录：' + PROJECT_DIR);
  console.log('📁 静态：dashboard/ + assets/');
  console.log('🤖 Ludo 代理：POST /api/ludo/:action（串行）');
  console.log('🎨 素材 API：/api/assets/list|meta|save|replace|stage|scan');
  console.log('📋 GET /api/monsters');
   console.log('🔍 扫描 API：GET /api/scan/status | POST /api/scan/refresh');
  console.log('🔄 手动刷新：POST /api/refresh');
  console.log('⏰ 静默扫描：每 ' + (SCAN_INTERVAL_MS / 60000) + ' 分钟');
  console.log('🗄️ Supabase：/supabase/* → ' + SUPABASE_HOST);
  // 启动时立即扫描一次，然后每 5 分钟静默扫描
  scanAndUpdateMonsters();
  setInterval(scanAndUpdateMonsters, SCAN_INTERVAL_MS);

  // 静默仪表盘刷新：每 5 分钟重新生成 data.json + 更新 index.html + git push
  function silentDashboardRefresh() {
    try {
      execSync('node generate.mjs', { cwd: DASHBOARD_DIR, stdio: 'ignore', timeout: 30000 });
      execSync('node update-dashboard.mjs --push', { cwd: DASHBOARD_DIR, stdio: 'ignore', timeout: 60000 });
      console.log('🔄 静默仪表盘刷新完成 ' + new Date().toLocaleTimeString('zh-CN'));
    } catch (e) {
      console.warn('⚠️ 静默仪表盘刷新失败:', e.message);
    }
  }
  // 启动 2 分钟后首次刷新（避免和 monster scan 冲突），之后每 5 分钟
  setTimeout(() => {
    silentDashboardRefresh();
    setInterval(silentDashboardRefresh, SCAN_INTERVAL_MS);
  }, 2 * 60 * 1000);
});
