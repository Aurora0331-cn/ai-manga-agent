import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import mammoth from 'mammoth';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { fetch as undiciFetch, Agent as UndiciAgent } from 'undici';

// 关键修复：Node 内置 fetch（undici）默认 headersTimeout=300 秒——上游 300 秒内没返回响应头就直接断连，
// 报 "fetch failed"。gpt-5.5 出长剧本可达 300 秒以上，会被这个隐藏限制提前掐断（AbortController 的 600s 排在它后面，永远轮不到）。
// 这里改用带长超时 Agent 的 undici fetch 发起 LLM/图像请求；真正的超时仍由各调用处 AbortController 控制。
const LONG_TIMEOUT_MS = (Number(process.env.LLM_TIMEOUT_MS) || 600000) + 30000;
const longFetchAgent = new UndiciAgent({ connectTimeout: 30000, headersTimeout: LONG_TIMEOUT_MS, bodyTimeout: LONG_TIMEOUT_MS });
const longFetch = (url, init = {}) => undiciFetch(url, { ...init, dispatcher: longFetchAgent });
// 网络层错误（fetch failed）把底层 cause 带出来，否则日志里只看到 fetch failed 无从排查。
const withCause = (error) => `${error.message}${error.cause ? `（${error.cause.code || error.cause.message || error.cause}）` : ''}`;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
// 持久化根目录：设置 DATA_DIR（指向 Render 持久盘挂载点，如 /var/data）后，项目与导出落到持久盘，重启/重部署不丢。
const persistRoot = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : rootDir;
const outDir = path.resolve(persistRoot, 'exports');
const dataDir = path.resolve(persistRoot, 'data', 'projects');
const defaultSkillPath = path.resolve(rootDir, 'skills', 'template-1-video-prompt-industrial-skill-v1.9.3.md');
const skillUploadDir = path.resolve(rootDir, 'skill-templates');
const verticalRealPersonSkillPath = path.resolve(rootDir, 'skills', 'template-2-vertical-real-person-prompt.txt');
const horizontalRealPersonSkillPath = path.resolve(rootDir, 'skills', 'template-3-horizontal-real-person-prompt.txt');
const assetSkillPath = path.resolve(rootDir, 'skills', 'template-asset-art-asset-prompt.md');
const scriptGenerateSkillPath = path.resolve(rootDir, 'skills', 'template-script-generate.md');
const scriptNovelSkillPath = path.resolve(rootDir, 'skills', 'template-script-novel.md');
const scriptOptimizeSkillPath = path.resolve(rootDir, 'skills', 'template-script-optimize.md');

const app = express();
const maxBodyMb = Number(process.env.MAX_BODY_MB) || 20;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxBodyMb * 1024 * 1024 } });
const projects = new Map();
const userSkillTemplates = new Map();

const builtInSkillTemplates = [
  {
    id: 'template-1',
    name: '模板一·视频分镜',
    description: '视频提示词工业化生成工作流 V1.9.3',
    path: process.env.SKILL_PATH || defaultSkillPath,
    source: 'built-in',
    kind: 'video'
  },
  {
    id: 'template-2',
    name: '模板二·竖屏真人',
    description: '竖屏真人 Seedance 2.0 视频提示词',
    path: verticalRealPersonSkillPath,
    source: 'built-in',
    kind: 'video',
    outputMode: 'skill-native'
  },
  {
    id: 'template-3',
    name: '横板真人提示词',
    description: '横屏真人 16:9 Seedance 2.0 视频提示词',
    path: horizontalRealPersonSkillPath,
    source: 'built-in',
    kind: 'video',
    outputMode: 'skill-native'
  },
  {
    id: 'asset-default',
    name: '美术资产 SKILL',
    description: 'AI 漫剧美术资产提示词（默认，可上传替换）',
    path: assetSkillPath,
    source: 'built-in',
    kind: 'asset'
  },
  {
    id: 'script-generate',
    name: '生成剧本 SKILL',
    description: '按创意/大纲生成完整短剧剧本',
    path: scriptGenerateSkillPath,
    source: 'built-in',
    kind: 'script'
  },
  {
    id: 'script-novel',
    name: '小说转剧本 SKILL',
    description: '小说原文忠实改编成短剧剧本',
    path: scriptNovelSkillPath,
    source: 'built-in',
    kind: 'script'
  },
  {
    id: 'script-optimize',
    name: '优化完善剧本 SKILL',
    description: '粗剧本润色补全为完整剧本',
    path: scriptOptimizeSkillPath,
    source: 'built-in',
    kind: 'script'
  }
];

// 通用 OpenAI 兼容供应商注册表。全部走 POST {baseUrl}/chat/completions + Bearer。
// 用户自带 API Key（仅单次请求使用、不落盘）、可自由选模型；custom 允许任意 baseUrl。
const providerPresets = [
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    allowCustomBaseUrl: false,
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o3-mini']
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    allowCustomBaseUrl: false,
    models: ['deepseek-chat', 'deepseek-reasoner']
  },
  {
    id: 'moonshot',
    name: 'Moonshot (Kimi)',
    baseUrl: process.env.MOONSHOT_BASE_URL || 'https://api.moonshot.cn/v1',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    allowCustomBaseUrl: false,
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k']
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    allowCustomBaseUrl: false,
    models: ['openai/gpt-4o-mini', 'deepseek/deepseek-chat', 'anthropic/claude-3.5-sonnet', 'google/gemini-flash-1.5']
  },
  {
    id: 'feicai',
    name: '飞彩 API',
    baseUrl: process.env.FEICAI_BASE_URL || 'https://feicai123.top/v1',
    apiKeyEnv: 'FEICAI_API_KEY',
    allowCustomBaseUrl: true,
    models: ['deepseek-v4-flash', 'deepseek-v4-pro', 'gpt-5.4', 'gpt-5.5']
  },
  {
    id: 'geeknow',
    name: 'Geeknow API',
    baseUrl: process.env.GEEKNOW_BASE_URL || 'https://www.geeknow.top/v1',
    apiKeyEnv: 'GEEKNOW_API_KEY',
    allowCustomBaseUrl: true,
    models: ['gpt-4o', 'gpt-4.1', 'claude-sonnet-4-6', 'claude-opus-4-6', 'deepseek-v4-pro', 'deepseek-chat', 'gemini-2.5-pro', 'qwen3-max']
  },
  {
    id: 'ussn',
    name: '优尚 API',
    baseUrl: process.env.USSN_BASE_URL || 'https://api.ussn.cn/v1',
    apiKeyEnv: 'USSN_API_KEY',
    allowCustomBaseUrl: true,
    models: ['gpt-4o', 'gpt-4.1', 'gpt-5', 'claude-sonnet-4-20250514', 'deepseek-chat', 'deepseek-reasoner', 'gemini-2.5-pro', 'qwen-max']
  },
  {
    id: 'comfly',
    name: 'Comfly API',
    baseUrl: process.env.COMFLY_BASE_URL || 'https://ai.comfly.chat/v1',
    apiKeyEnv: 'COMFLY_API_KEY',
    allowCustomBaseUrl: true,
    models: ['gpt-4o', 'gpt-4.1', 'claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'deepseek-chat', 'deepseek-reasoner', 'gemini-2.5-pro', 'qwen-max']
  },
  {
    id: 'custom',
    name: '自定义 (OpenAI 兼容)',
    baseUrl: process.env.CUSTOM_BASE_URL || 'https://api.openai.com/v1',
    apiKeyEnv: 'CUSTOM_API_KEY',
    allowCustomBaseUrl: true,
    models: []
  }
];

const defaultProviderId = process.env.LLM_PROVIDER || 'openai';

// 视觉风格预设：前端只显示风格名，后端把名字展开为完整风格提示词后注入生成。
const STYLE_PRESETS = {
  '赛博朋克风格': '电影感的写实摄影风格，光影氛围强烈，质感细腻真实。以赛博朋克霓虹色为主的冷色调，赛博朋克，霓虹灯，未来感，雨街，蓝色和紫色的色调。cinematic, photorealistic, neon lighting, cyberpunk aesthetic, cool tones, dramatic lighting, shallow depth of field, wet look',
  '高清实拍真人风格': '电影感人像写真风格，照片级真实感，原始照片，数码单反相机，焦点清晰，高保真，4K 纹理，photorealistic, raw photo, DSLR, sharp focus, high fidelity, 4k texture',
  '电影大片风格': '电影感胶片摄影风格，电影感灯光，电影剧照，35毫米拍摄，逼真，8K，杰作。cinematic lighting, movie still, shot on 35mm, realistic, 8k, masterpiece',
  '暗黑哥特风格': '电影感超写实渲染风格，哥特风格，黑暗氛围，阴郁，雾，恐怖主题，低饱和度的颜色。gothic style, dark atmosphere, gloomy, fog, horror theme, muted colors',
  '日漫风格': '现代日系动画电影风格，线条干净利落，动漫风格，2D动画，赛璐璐渲染，鲜艳的色彩。anime style, 2D animation, cel shading, vibrant colors, clean lines',
  '新海诚风格': '新海诚电影动画风格，光影通透细腻，色彩清新明亮。新海诚风格，美丽的天空，镜头光斑，精致的背景，充满情感。Makoto Shinkai style, beautiful sky, lens flare, detailed background, emotional',
  '国风水墨风格': '中国水墨画，水彩画，传统艺术，流畅的线条，东方美学。Chinese ink painting, watercolor, traditional art, flowing lines, oriental aesthetic',
  '游戏原画风格': '游戏CG，封面艺术，高度细致，史诗般的构图，奇幻风格。game cg, splash art, highly detailed, epic composition, fantasy style',
  '皮克斯风格': '三维渲染二维技术风格，柔和卡通造型，极致的物理真实感，细腻材质表现，大头身比、圆润的轮廓和富有灵性的大眼睛，夸张与圆润的角色设计，情绪化的色彩运用，电影级光影，治愈系氛围。Pixar style, 3D render, cinematic lighting, expressive eyes, heartwarming'
};

function expandStyle(name) {
  return STYLE_PRESETS[name] || name || '';
}

// ===== 项目系统：默认配置与元数据 =====
const PROJECT_STYLES = {
  '电影质感': 'cinematic lighting, movie still, shot on 35mm, realistic, masterpiece',
  '高清实拍': 'photorealistic, raw photo, DSLR, sharp focus, high fidelity, 4k texture',
  '动漫风格': 'anime style, 2D animation, cel shading, vibrant colors, clean lines',
  '国风水墨': 'Chinese ink painting, watercolor, traditional art, flowing lines, oriental aesthetic',
  '赛博朋克': 'cinematic, photorealistic, neon lighting, cyberpunk aesthetic, cool tones, dramatic lighting',
  '自定义': ''
};
const DEFAULT_PROJECT_STYLE = '电影质感';
const DEFAULT_PROJECT_MODELS = { analysis: 'gpt-5.5', image: 'gpt-image-2', video: '' };
function projectStylePrompt(style) {
  return (style in PROJECT_STYLES) ? PROJECT_STYLES[style] : (STYLE_PRESETS[style] || '');
}
function projectSummary(p) {
  return {
    id: p.id,
    title: p.title || p.name || '未命名项目',
    aspectRatio: p.aspectRatio || '9:16',
    collaboration: !!p.collaboration,
    status: p.status || '已立项',
    category: p.category || '工作台',
    style: p.style || DEFAULT_PROJECT_STYLE,
    createdAt: p.createdAt || null,
    episodeCount: (p.episodes || []).length,
    hasScript: !!(p.originalScript && p.originalScript.trim())
  };
}
// 项目分类（月份/自定义标签，不含默认「工作台」）
const projectCategories = new Set();
function listProjectCategories() { return [...projectCategories]; }
async function persistCategories() {
  try {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, '_categories.json'), JSON.stringify([...projectCategories]), 'utf8');
  } catch (error) { console.warn(`Persist categories failed: ${error.message}`); }
}
async function loadCategories() {
  try {
    const raw = await fs.readFile(path.join(dataDir, '_categories.json'), 'utf8');
    for (const c of JSON.parse(raw)) if (c) projectCategories.add(c);
  } catch { /* 首次运行无分类文件 */ }
}

// ===== 异步任务：绕开免费托管层对单个 HTTP 请求约 60 秒的断连限制 =====
// 生成类请求立即返回 jobId（不阻塞），后台执行 LLM；前端轮询 /api/jobs/:id 取结果。
const jobs = new Map(); // jobId -> { status:'pending'|'done'|'error', result, error, createdAt }
function createJob() {
  const id = uid('job');
  jobs.set(id, { status: 'pending', result: null, error: null, createdAt: Date.now() });
  return id;
}
function finishJob(id, result) { const j = jobs.get(id); if (j) { j.status = 'done'; j.result = result; } }
function failJob(id, error) { const j = jobs.get(id); if (j) { j.status = 'error'; j.error = error; } }
function updateJob(id, patch) { const j = jobs.get(id); if (j) Object.assign(j, patch); }
// 定期清理 30 分钟前的旧任务，避免内存泄漏
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, j] of jobs) if (j.createdAt < cutoff) jobs.delete(id);
}, 10 * 60 * 1000).unref();

// 反向代理后取真实客户端 IP（限流准确性）
app.set('trust proxy', 1);

// CORS：配置了白名单就限制，否则放行（生产单服务为同源，无需 CORS）
const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors(allowedOrigins.length ? {
  origin(origin, cb) {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('CORS: origin not allowed'));
  }
} : {}));

// 基础安全响应头
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  next();
});

// 简易内存限流：每 IP 每分钟 RATE_LIMIT_PER_MIN 次（0=关闭）
const rateLimitPerMin = Number(process.env.RATE_LIMIT_PER_MIN) || 60;
const rateHits = new Map();
setInterval(() => {
  const cutoff = Date.now() - 60000;
  for (const [ip, arr] of rateHits) {
    const kept = arr.filter((t) => t > cutoff);
    if (kept.length) rateHits.set(ip, kept); else rateHits.delete(ip);
  }
}, 60000).unref();
app.use('/api', (req, res, next) => {
  if (rateLimitPerMin <= 0) return next();
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const arr = (rateHits.get(ip) || []).filter((t) => now - t < 60000);
  if (arr.length >= rateLimitPerMin) {
    return res.status(429).json({ error: '请求过于频繁，请稍后再试。' });
  }
  arr.push(now);
  rateHits.set(ip, arr);
  next();
});

app.use(express.json({ limit: `${maxBodyMb}mb` }));
app.use('/exports', express.static(outDir));

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

// ---- 项目持久化：内存 Map 为运行时真源，磁盘仅用于重启恢复 ----
function projectFilePath(projectId) {
  return path.join(dataDir, `${projectId}.json`);
}

async function persistProject(project) {
  try {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(projectFilePath(project.id), JSON.stringify(project), 'utf8');
  } catch (error) {
    console.warn(`Persist project ${project.id} failed: ${error.message}`);
  }
}

async function loadPersistedProjects() {
  await loadCategories();
  try {
    const files = await fs.readdir(dataDir);
    let loaded = 0;
    for (const file of files) {
      if (!file.endsWith('.json') || file.startsWith('_')) continue;
      try {
        const project = JSON.parse(await fs.readFile(path.join(dataDir, file), 'utf8'));
        if (project?.id) {
          projects.set(project.id, project);
          loaded += 1;
        }
      } catch (error) {
        console.warn(`Skip corrupt project file ${file}: ${error.message}`);
      }
    }
    if (loaded) console.log(`Restored ${loaded} project(s) from disk.`);
  } catch {
    // data 目录不存在 = 首次运行，忽略
  }
}

// ---- 有限并发执行，保持输入顺序 ----
async function mapWithConcurrency(items, limit, task) {
  const results = new Array(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await task(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: size }, worker));
  return results;
}

function normalizeText(text = '') {
  return text.replace(/\r\n/g, '\n').replace(/　/g, ' ').trim();
}

function stripMarkdownFence(value) {
  return value.replace(/^```(?:json|markdown)?\s*/i, '').replace(/```$/i, '').trim();
}

// 从 chat/completions 响应里尽可能取出正文：兼容 content 为数组（分块返回）、
// 正文被放进 reasoning_content/reasoning（gpt-5.5 等推理模型经网关时常见）等非标准返回。
// 取不到时打日志保留现场，便于排查"网关有调用但解析为空"。
function extractMessageText(data) {
  const msg = data?.choices?.[0]?.message || {};
  let c = msg.content;
  if (Array.isArray(c)) c = c.map((p) => (typeof p === 'string' ? p : (p && (p.text || p.content)) || '')).join('');
  let text = String(c || '');
  if (!text.trim()) text = String(msg.reasoning_content || msg.reasoning || '');
  if (!text.trim()) console.warn(`LLM empty content; raw choice: ${JSON.stringify(data?.choices?.[0] || {}).slice(0, 500)}`);
  return text;
}

function extractJsonCandidate(value = '') {
  const content = stripMarkdownFence(value);
  const start = content.indexOf('{');
  if (start === -1) return content.trim();

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < content.length; index += 1) {
    const char = content[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString && char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString && char === '{') depth += 1;
    if (!inString && char === '}') {
      depth -= 1;
      if (depth === 0) return content.slice(start, index + 1);
    }
  }

  return content.slice(start).trim();
}

function escapeControlCharsInJsonStrings(value = '') {
  let result = '';
  let inString = false;
  let escaped = false;

  for (const char of value) {
    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }
    if (inString && char === '\\') {
      result += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      result += char;
      inString = !inString;
      continue;
    }
    if (inString) {
      if (char === '\n') {
        result += '\\n';
        continue;
      }
      if (char === '\r') {
        result += '\\r';
        continue;
      }
      if (char === '\t') {
        result += '\\t';
        continue;
      }
      if (char.codePointAt(0) < 32) {
        result += `\\u${char.codePointAt(0).toString(16).padStart(4, '0')}`;
        continue;
      }
    }
    result += char;
  }

  return result;
}

function parseLlmJson(content = '') {
  const candidate = extractJsonCandidate(content);
  try {
    return JSON.parse(candidate);
  } catch (error) {
    try {
      return JSON.parse(escapeControlCharsInJsonStrings(candidate));
    } catch {
      error.message = `LLM returned non-strict JSON: ${error.message}`;
      throw error;
    }
  }
}

function normalizeLlmModules(modules = {}, markdown = '') {
  const source = modules && typeof modules === 'object' ? modules : {};
  return {
    characters: String(source.characters || ''),
    scenes: String(source.scenes || ''),
    props: String(source.props || ''),
    dialogues: String(source.dialogues || ''),
    videoPrompts: String(source.videoPrompts || markdown || ''),
    selfCheck: String(source.selfCheck || '')
  };
}

function composeMarkdownFromModules(title, modules) {
  return `# ${title} 视频提示词

## 角色提示词
${modules.characters || '模型未单独返回角色提示词。'}

## 场景提示词
${modules.scenes || '模型未单独返回场景提示词。'}

## 道具提示词
${modules.props || '模型未单独返回道具提示词。'}

## 台词提取表
${modules.dialogues || '模型未单独返回台词提取表。'}

## 分镜视频提示词
${modules.videoPrompts || '模型未单独返回分镜视频提示词。'}

## 自检表
${modules.selfCheck || '模型未单独返回自检表。'}
`;
}

function parseLlmError(message = '') {
  const fallback = { code: 'llm_error', message };
  const jsonStart = message.indexOf('{');
  if (jsonStart === -1) return fallback;
  try {
    const parsed = JSON.parse(message.slice(jsonStart));
    return {
      code: parsed.error?.code || fallback.code,
      message: parsed.error?.message || message,
      type: parsed.error?.type || ''
    };
  } catch {
    return fallback;
  }
}

function getConfiguredProviders() {
  return providerPresets.map((provider) => ({
    ...provider,
    configured: Boolean(process.env[provider.apiKeyEnv])
  }));
}

function maskApiKey(apiKey = '') {
  const trimmed = String(apiKey).trim();
  if (!trimmed) return '';
  return `${trimmed.slice(0, 3)}...${trimmed.slice(-4)}`;
}

// 归一化 baseUrl：去尾斜杠；若用户漏了 /v1 且像是根域名则补上（仅对常见 OpenAI 兼容站点）。
function normalizeBaseUrl(rawBaseUrl = '') {
  let url = String(rawBaseUrl).trim().replace(/\/+$/, '');
  if (!url) return '';
  if (!/\/v\d+($|\/)/.test(url) && /^https?:\/\/[^/]+$/.test(url)) {
    url = `${url}/v1`;
  }
  return url;
}

function resolveLlmConfig(llm = {}) {
  const providerId = llm.providerId || defaultProviderId;
  const preset = providerPresets.find((provider) => provider.id === providerId) || providerPresets[0];
  const envUpper = preset.id.toUpperCase();
  // baseUrl 优先级：请求（仅当该供应商允许自定义）→ 环境变量 → preset 默认
  const requestBaseUrl = preset.allowCustomBaseUrl && typeof llm.baseUrl === 'string' ? llm.baseUrl : '';
  const baseUrl = normalizeBaseUrl(requestBaseUrl || process.env[`${envUpper}_BASE_URL`] || preset.baseUrl || '');
  const requestApiKey = typeof llm.apiKey === 'string' ? llm.apiKey.trim() : '';
  const providerEnvApiKey = process.env[preset.apiKeyEnv] || '';
  const apiKey = requestApiKey || providerEnvApiKey || '';
  const apiKeySource = requestApiKey ? 'request' : providerEnvApiKey ? `env:${preset.apiKeyEnv}` : 'none';
  const model = (typeof llm.model === 'string' && llm.model.trim())
    || process.env[`${envUpper}_MODEL`]
    || preset.models[0]
    || '';

  return {
    providerId,
    providerName: preset.name,
    baseUrl,
    apiKey,
    apiKeySource,
    apiKeyHint: maskApiKey(apiKey),
    model,
    temperature: Number.isFinite(Number(llm.temperature)) ? Number(llm.temperature) : 0.4
  };
}

// 调用供应商 /models 验证 Key 并取回可用模型列表。
async function probeModels(config) {
  const timeoutMs = Number(process.env.LLM_TIMEOUT_MS) || 60000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: controller.signal
    });
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, error: parseLlmError(text), status: response.status };
    }
    const data = await response.json();
    const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    const models = list.map((item) => item?.id || item?.model || item).filter((id) => typeof id === 'string');
    return { ok: true, models };
  } catch (error) {
    if (error.name === 'AbortError') {
      return { ok: false, error: { code: 'timeout', message: `连接测试超时（>${timeoutMs}ms）` } };
    }
    return { ok: false, error: { code: 'network_error', message: error.message } };
  } finally {
    clearTimeout(timer);
  }
}

function listSkillTemplates() {
  return [
    ...builtInSkillTemplates,
    ...[...userSkillTemplates.values()]
  ].map((template) => ({
    id: template.id,
    name: template.name,
    description: template.description,
    source: template.source,
    kind: template.kind || null,
    fileName: template.fileName || path.basename(template.path || '')
  }));
}

function resolveSkillTemplate(skillTemplateId = 'template-1') {
  return builtInSkillTemplates.find((template) => template.id === skillTemplateId)
    || userSkillTemplates.get(skillTemplateId)
    || builtInSkillTemplates[0];
}

async function readSkill(skillTemplateId = 'template-1') {
  const template = resolveSkillTemplate(skillTemplateId);
  const skillPath = template.path || process.env.SKILL_PATH || defaultSkillPath;
  try {
    return {
      template,
      content: await fs.readFile(skillPath, 'utf8')
    };
  } catch {
    return {
      template,
      content: [
        '视频提示词模板读取失败，使用内置兜底规则。',
        '核心要求：先提取台词，保留标点；先生成角色、场景、道具文生图提示词，再生成视频提示词。',
        '每个镜头必须有画幅、时间码、空间连续性、台词嵌入、负面词和自检。'
      ].join('\n')
    };
  }
}
async function extractUploadedText(file) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return normalizeText(result.value);
  }
  return normalizeText(file.buffer.toString('utf8'));
}

function splitEpisodes(script) {
  const text = normalizeText(script);
  const marker = /(?:^|\n)\s*(?:第\s*[一二三四五六七八九十百千万\d]+\s*[集话回]|EP\s*\d+|Episode\s*\d+|第\s*\d+\s*集)[^\n]*/gi;
  const matches = [...text.matchAll(marker)];

  if (matches.length > 1) {
    return matches.map((match, index) => {
      const start = match.index + (match[0].startsWith('\n') ? 1 : 0);
      const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
      const chunk = text.slice(start, end).trim();
      const [titleLine, ...rest] = chunk.split('\n');
      return createEpisode(index + 1, titleLine.trim() || `第 ${index + 1} 集`, rest.join('\n').trim() || chunk);
    });
  }

  const paragraphs = text.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  if (paragraphs.length <= 8 || text.length < 3500) {
    return [createEpisode(1, '第 1 集', text)];
  }

  const targetSize = 2800;
  const episodes = [];
  let bucket = [];
  let size = 0;
  paragraphs.forEach((paragraph) => {
    if (size + paragraph.length > targetSize && bucket.length) {
      episodes.push(createEpisode(episodes.length + 1, `第 ${episodes.length + 1} 集`, bucket.join('\n\n')));
      bucket = [];
      size = 0;
    }
    bucket.push(paragraph);
    size += paragraph.length;
  });
  if (bucket.length) episodes.push(createEpisode(episodes.length + 1, `第 ${episodes.length + 1} 集`, bucket.join('\n\n')));
  return episodes;
}

function createEpisode(number, title, script) {
  const lines = script.split('\n').map((line) => line.trim()).filter(Boolean);
  const firstScene = lines.find((line) => /场景|地点|内景|外景|INT\.|EXT\./i.test(line));
  return {
    id: uid('ep'),
    number,
    title: title.replace(/^#+\s*/, ''),
    script,
    scenes: splitScenes(script),
    summary: summarizeText(script, 110),
    opening: summarizeText(lines.slice(0, 6).join(' '), 80),
    ending: summarizeText(lines.slice(-6).join(' '), 80),
    firstScene: firstScene || '未明确场景'
  };
}

// 把一集按场次/场景拆开。场次头形如「1-1 日 外 祭坛」「场景1-1 日 内 …」「8-1 夜 内 宗人府」。
function splitScenes(script) {
  const text = normalizeText(script);
  const lines = text.split('\n');
  const headRe = /^\s*(?:场景|场|镜)?\s*\d+\s*[-－—]\s*\d+\b/;
  const idxs = [];
  lines.forEach((ln, i) => { if (headRe.test(ln)) idxs.push(i); });
  if (idxs.length < 2) {
    return [{ id: uid('sc'), name: '全场', script: text }];
  }
  const scenes = [];
  idxs.forEach((start, k) => {
    const end = k + 1 < idxs.length ? idxs[k + 1] : lines.length;
    const chunk = lines.slice(start, end).join('\n').trim();
    if (chunk) scenes.push({ id: uid('sc'), name: (lines[start].trim().slice(0, 32) || `场次 ${k + 1}`), script: chunk });
  });
  return scenes.length ? scenes : [{ id: uid('sc'), name: '全场', script: text }];
}

function summarizeText(text, length = 100) {
  const clean = normalizeText(text).replace(/\s+/g, ' ');
  return clean.length > length ? `${clean.slice(0, length)}...` : clean;
}

function unique(items) {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

// 舞台说明 / 非角色前缀：这些不是说话的人，不能当成台词或角色名。
const STAGE_DIRECTION_PREFIX = /^(场景|地点|时间|内景|外景|场内|场外|画面|镜头|旁白|字幕|背景|环境|音效|配音|说明|备注|INT|EXT|OS|VO|CG|BGM)$/i;

function isStageDirectionName(name = '') {
  return STAGE_DIRECTION_PREFIX.test(name.trim());
}

function extractDialogues(script) {
  const rows = [];
  const lines = script.split('\n').map((line) => line.trim()).filter(Boolean);
  const patterns = [
    /^([^：:]{1,16})[：:]\s*(.+)$/,
    /^([^「」"“”]{1,16})[「“"](.+)[」”"]$/
  ];

  lines.forEach((line) => {
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match && match[2].length > 1) {
        const character = match[1].replace(/[（）()]/g, '').trim();
        if (isStageDirectionName(character)) return; // 跳过"场景：…"等舞台说明行
        rows.push({
          id: rows.length + 1,
          character,
          text: match[2].trim(),
          chars: match[2].trim().length
        });
        return;
      }
    }
  });

  return rows.slice(0, 120);
}

function extractNames(script) {
  const dialogues = extractDialogues(script);
  const fromDialogue = dialogues.map((row) => row.character).filter((name) => !/旁白|内心|心声|OS/i.test(name));
  const bracketNames = [...script.matchAll(/【([^】]{1,8})】/g)].map((m) => m[1]);
  return unique([...fromDialogue, ...bracketNames]).filter((name) => !isStageDirectionName(name)).slice(0, 12);
}

function extractScenes(script) {
  const lines = script.split('\n').map((line) => line.trim()).filter(Boolean);
  const explicit = lines.filter((line) => /场景|地点|内景|外景|清晨|早晨|上午|午后|黄昏|夜|房间|客厅|街|医院|学校|公司|办公室|店|车站|雨/.test(line));
  const scenes = explicit.slice(0, 12).map((line, index) => ({
    name: line.replace(/^#+\s*/, '').slice(0, 28) || `场景 ${index + 1}`,
    description: summarizeText(line, 90)
  }));
  return scenes.length ? scenes : [{ name: '主要剧情场景', description: '根据当前剧集文本提取出的主要行动空间' }];
}

function extractProps(script) {
  const candidates = ['手机', '照片', '信', '钥匙', '戒指', '合同', '杯子', '伞', '车', '药', '包', '文件', '电脑', '花', '项链'];
  return candidates.filter((item) => script.includes(item)).slice(0, 10);
}

function buildBible(episodes) {
  const fullScript = episodes.map((ep) => ep.script).join('\n');
  const characters = extractNames(fullScript).map((name) => ({
    name,
    visual: `${name}固定视觉设定：保持同一脸型、发型、服装主色和核心记忆点，跨集不得漂移。`,
    arc: '根据每集结尾情绪和关系变化递进，不跳跃。'
  }));
  const scenes = extractScenes(fullScript);
  const props = extractProps(fullScript).map((name) => ({
    name,
    rule: `${name}作为关键道具出现时，材质、磨损、比例和持有关系保持一致。`
  }));

  return {
    characters,
    scenes,
    props,
    episodeContinuity: episodes.map((episode, index) => ({
      episodeId: episode.id,
      title: episode.title,
      summary: episode.summary,
      previousEnding: index > 0 ? episodes[index - 1].ending : '本集为开篇，无上一集承接。',
      currentEnding: episode.ending,
      nextOpening: index + 1 < episodes.length ? episodes[index + 1].opening : '本集为当前上传内容末集，无下一集预告。'
    }))
  };
}

function markdownTable(headers, rows) {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => ':---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.map((cell) => String(cell ?? '').replace(/\n/g, '<br>')).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

function fallbackGenerate({ project, episode, settings }) {
  const dialogues = extractDialogues(episode.script);
  const names = extractNames(episode.script);
  const scenes = extractScenes(episode.script);
  const props = extractProps(episode.script);
  const continuity = project.bible.episodeContinuity.find((item) => item.episodeId === episode.id);
  const aspect = settings.aspectRatio || '9:16';
  const style = settings.visualStyle || '写实电影感 + 现代都市';
  const intensity = settings.dramaIntensity || '中等情绪';
  const dialogueRows = dialogues.length ? dialogues : [{ id: 1, character: '角色', text: '本集无明确台词格式，需人工确认台词归属。', chars: 20 }];

  const characterMd = names.length
    ? names.map((name) => `### ${name}\n${aspect}，${style}，角色设定图，保持固定脸型、发型、服装主色和核心视觉记忆点；${name}的表情以${intensity}为基准，避免夸张表演，高清细节，纯净背景。`).join('\n\n')
    : `### 角色待确认\n${aspect}，${style}，根据剧本补全主要角色视觉设定，保持跨集一致。`;

  const sceneMd = scenes.map((scene) => `### ${scene.name}\n${aspect}，${style}，${scene.description}；明确空间结构、主光位置、色温、关键道具和可用于镜头承接的固定视觉符号。`).join('\n\n');
  const propMd = props.length
    ? props.map((prop) => `- ${prop}：材质、尺寸、磨损痕迹和剧情归属保持一致；近景中不得变形或漂移。`).join('\n')
    : '- 本集未识别到高频关键道具，生成时以剧本原文为准，不额外添加道具。';

  const dialogueMd = markdownTable(
    ['编号', '角色', '原台词（保留标点）', '字数', '语速类型', '预计时长', '所属组'],
    dialogueRows.map((row, index) => [row.id, row.character, row.text, row.chars, '默认正常情节对白', `${Math.max(2, Math.ceil(row.chars / 4.4))} 秒`, `第 ${Math.floor(index / 2) + 1} 组`])
  );

  const shots = dialogueRows.slice(0, Math.max(3, Math.min(10, dialogueRows.length))).map((row, index) => {
    const start = String((index * 5) % 60).padStart(2, '0');
    const end = String(Math.min((index + 1) * 5, 15)).padStart(2, '0');
    return `### 第 ${index + 1} 组：${episode.title} / ${row.character}情绪推进
**空间状态**：继承本集已描述空间，不添加原文未说明方位。
**情绪状态**：${intensity}，承接上一集：${continuity?.previousEnding || '无'}。

【全局风格与环境】
时间：依据剧本原文；天气：依据剧本原文；氛围：${intensity}
电影质感：${style} | 画幅：${aspect}
关键视觉符号：沿用全剧角色、场景、道具档案。

【镜头 1】【00:${start} - 00:${end}】（${aspect}）
1 视角/景别：稳定近景，服务当前台词与微表情。
2 机位：眼平机位，避免无依据改变站位。
3 焦段/光圈：中长焦浅景深，焦点锁定说话角色面部。
4 运镜：轻微 slow push，保留台词后的反应时间。
5 主体动作：${row.character}说："${row.text}"；保留原始标点，逗号转为短暂停顿，问号转为尾音轻微上扬，表情锚点控制在眼神停住、嘴唇压紧、呼吸变浅三项以内。
6 环境细节：只使用剧本已出现的场景信息，补充光影和生活痕迹，不新增剧情道具。
7 构图/取景：构图目的为让观众看见情绪进入身体的过程，留出 0.5-1 秒反应。
8 焦点/景深：面部焦点稳定，背景轻微虚化。
9 画质标识：高清电影质感，真实肤质，细节稳定。

【关键约束】
空间线 - 必须继承本集原文空间，不添加未写明的左右前后。
光线线 - 保持${style}的主光逻辑。
运镜线 - 避免随机快切和大幅度镜头运动。
画面线 - 必须让台词、表情、停顿可被看见。
风格线 - 保持全剧角色视觉设定一致。
表演线 - 每镜头只锁定 1 个核心情绪机制、最多 3 个微表情锚点。
台词线 - 必须完整嵌入原台词并保留标点。

【音频规范】
全局音轨：环境底噪克制，台词清晰。
逐句台词声音表演：${row.character}音量稳定，语速按标点留白，尾音服务情绪残留。

【负面词】
Layer 1 基础负面词：避免手部畸形，避免脸部变形，避免字幕，避免水印，避免多余角色。
Layer 2 类型专属负面词：避免突然大哭，避免表情一步到位，避免全程喊叫，避免嘴型与台词节奏不匹配。
Layer 3 本组专属负面词：避免新增原文未提及站位，避免忽略台词标点停顿。

视频时长 ${Math.max(5, Math.min(15, Math.ceil(row.chars / 4.4) + 2))} 秒`;
  }).join('\n\n');

  const selfCheck = markdownTable(
    ['检查项', '结果'],
    [
      ['台词完整', '已编号并嵌入镜头'],
      ['标点保留', '保留原始标点并转为停顿/尾音/重音'],
      ['文生图提示词', '已先生成角色、场景、道具提示词'],
      ['上下集承接', `上一集：${continuity?.previousEnding || '无'}；下一集：${continuity?.nextOpening || '无'}`],
      ['画幅', aspect],
      ['文戏降噪', '每镜头控制 1+3+1+1']
    ]
  );

  return {
    episodeId: episode.id,
    title: episode.title,
    mode: 'fallback',
    modules: {
      characters: characterMd,
      scenes: sceneMd,
      props: propMd,
      dialogues: dialogueMd,
      videoPrompts: shots,
      selfCheck
    },
    markdown: `# ${episode.title} 视频提示词\n\n## 生成参数\n- 画幅：${aspect}\n- 视觉风格：${style}\n- 文戏强度：${intensity}\n\n## 上下集连续性\n- 上一集结尾：${continuity?.previousEnding || '无'}\n- 本集摘要：${episode.summary}\n- 下一集开头：${continuity?.nextOpening || '无'}\n\n## 角色提示词\n${characterMd}\n\n## 场景提示词\n${sceneMd}\n\n## 道具提示词\n${propMd}\n\n## 台词提取表\n${dialogueMd}\n\n## 分镜视频提示词\n${shots}\n\n## 自检表\n${selfCheck}\n`
  };
}

function fallbackGenerateByTemplate({ project, episode, settings, skillTemplate }) {
  if (skillTemplate?.id !== 'template-2') {
    return fallbackGenerate({ project, episode, settings });
  }

  const dialogues = extractDialogues(episode.script);
  const scenes = extractScenes(episode.script);
  const props = extractProps(episode.script);
  const continuity = project.bible.episodeContinuity.find((item) => item.episodeId === episode.id);
  const aspect = settings.aspectRatio || '9:16';
  const style = settings.visualStyle || '写实真人质感';
  const intensity = settings.dramaIntensity || '强戏剧张力';
  const rows = dialogues.length ? dialogues : [{ id: 1, character: '角色', text: '本集无明确台词格式，需人工确认台词归属。', chars: 20 }];

  const globalLook = [
    `核心色调体系：${style}，竖屏${aspect}，统一明亮通透自然大平光，黑位克制，高光压制，肤色真实。`,
    '整体质感标准：真人实拍风格，电影级画质，8K超高清分辨率，皮肤质感自然，服饰贴合剧本人设。',
    '基础光影逻辑：柔和天光铺底，面部优先清晰，阴影干净，轮廓光服务人物纵向层次。',
    '风格锚点：竖屏短剧商业爽剧节奏，近景和特写为核心，严禁横屏宽画幅思维。'
  ].join('\n');

  const sceneMd = scenes.map((scene) => `### ${scene.name}\n场景整体：${scene.description}；保持全片统一光影、色调和真人质感，不出现风格跳脱。`).join('\n\n');
  const propMd = props.length
    ? props.map((prop) => `- ${prop}：作为关键叙事道具时保持材质、比例、位置和前后镜头一致。`).join('\n')
    : '- 本集未识别到关键道具，禁止额外添加无剧情支撑的道具。';

  const videoPrompts = rows.slice(0, Math.max(3, Math.min(10, rows.length))).map((row, index) => {
    const duration = Math.max(5, Math.min(15, Math.ceil(row.chars / 4) + 2));
    return `## 镜头${index + 1}
镜号作用：放大${row.character}当前台词带来的剧情压力与情绪变化，服务本集剧情推进，避免无意义炫技运镜。

人物场景位置：严格依据剧本文字与全剧连续性档案；上一集承接：${continuity?.previousEnding || '无'}；不得添加原文未说明的方位、视线或站位。

场景整体：${style}，${aspect}竖屏真人实拍风格，统一明亮通透自然大平光，人物面部清晰，纵向空间关系连贯。

对应剧本：
${row.character}："${row.text}"

对应镜头：
镜头一（0-${duration}秒）：优先使用上半身近景或面部特写，低机位微仰或近眼平固定机位，根据${intensity}控制表演强度；镜头起幅锁定${row.character}面部情绪，主体始终位于竖屏纵向视觉中心。${row.character}说："${row.text}"，台词完整保留标点，语速按剧情语境控制，每秒约4-6字，眼神、呼吸、嘴角和细微表情自然连贯。关键台词处可切换到面部特写或关键动作大特写，每一次切换必须传递新信息。

运镜规则：纵向线性微推或固定机位为主，横向运动不超过画面宽度20%，严格遵守180度轴线，不越轴、不跳切、不主体瞬移。

衔接：镜头结尾设计物理遮挡或光影遮挡接力物，实现帧级丝滑转场。`;
  }).join('\n\n');

  const negative = [
    '无字幕、无水印、无背景音乐',
    '禁止脸部畸变、手部畸形、人物穿帮、主体出画',
    '禁止无逻辑手持乱晃、鱼眼畸变、越轴跳镜、空间跳跃',
    '禁止横屏构图思维、无意义全景停留、无剧情支撑的炫技运镜'
  ].join('；');

  const selfCheck = markdownTable(
    ['检查项', '结果'],
    [
      ['模板', '模板二：竖屏真人 Seedance 2.0 提示词'],
      ['画幅', aspect],
      ['景别', '近景/特写为核心，中景/全景仅作功能辅助'],
      ['运镜', '纵向运镜优先，严格180度轴线'],
      ['上下集承接', `上一集：${continuity?.previousEnding || '无'}；下一集：${continuity?.nextOpening || '无'}`]
    ]
  );

  const markdown = `# ${episode.title} 竖屏真人视频提示词

## 使用模板
- ${skillTemplate.name}：${skillTemplate.description}
- 说明：当前为 LLM 调用失败后的本地兜底生成，结构按模板二输出。

## 全篇统一全局光影 / 质感硬性规则
${globalLook}

## 场景提示词
${sceneMd}

## 道具提示词
${propMd}

## 分镜视频提示词
${videoPrompts}

## 通用提示词
真人实拍风格，写实真人质感，服饰贴合剧本人设，人物五官、动作、表情自然连贯无畸变；人物、物品、场景特效与实景无缝衔接，采用大师级电影运镜和切换；视频为电影级画质与光影，8K超高清分辨率。

## 专业规范与禁止项
${negative}

## 自检表
${selfCheck}
`;

  return {
    episodeId: episode.id,
    title: episode.title,
    mode: 'fallback',
    skillTemplateId: skillTemplate.id,
    modules: {
      characters: '模板二偏向真人视频分镜生成，角色固定设定请以全剧连续性档案和剧本文字为准。',
      scenes: sceneMd,
      props: propMd,
      dialogues: markdownTable(['编号', '角色', '原台词', '字数'], rows.map((row) => [row.id, row.character, row.text, row.chars])),
      videoPrompts,
      selfCheck
    },
    markdown
  };
}

// 统一的 chat/completions 调用：带超时；若供应商不支持 response_format 则自动去掉重试一次。
async function chatCompletion(config, payload, { retriedWithoutJsonMode = false, retriedWithoutMaxTokens = false, timeoutMs: timeoutOverride = 0 } = {}) {
  const timeoutMs = timeoutOverride || Number(process.env.LLM_TIMEOUT_MS) || 600000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await longFetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`LLM request timed out after ${timeoutMs}ms`);
    throw new Error(withCause(error));
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const errText = await response.text();
    // 部分供应商不认 response_format，报 400；去掉它重试一次。
    if (!retriedWithoutJsonMode && response.status === 400 && payload.response_format && /response_format|json_object|not support/i.test(errText)) {
      const { response_format, ...rest } = payload;
      return chatCompletion(config, rest, { retriedWithoutJsonMode: true, retriedWithoutMaxTokens, timeoutMs: timeoutOverride });
    }
    // 部分网关把 max_tokens 转成上游不认的 max_output_tokens 报 400；去掉它重试一次。
    if (!retriedWithoutMaxTokens && response.status === 400 && payload.max_tokens && /max_tokens|max_output_tokens|max_completion_tokens/i.test(errText)) {
      const { max_tokens, ...rest } = payload;
      return chatCompletion(config, rest, { retriedWithoutJsonMode, retriedWithoutMaxTokens: true, timeoutMs: timeoutOverride });
    }
    throw new Error(`LLM request failed: ${errText}`);
  }
  return response.json();
}

async function callLLM({ skill, project, episode, settings, llm, skillTemplate }) {
  const config = resolveLlmConfig(llm);
  if (!config.apiKey) return null;
  console.info(`Calling ${config.providerName} ${config.model} with key ${config.apiKeySource} ${config.apiKeyHint}`);

  const continuity = project.bible.episodeContinuity.find((item) => item.episodeId === episode.id);
  const outputMode = skillTemplate?.outputMode || 'modules';

  // skill-native：完全按所选 SKILL 自带的"输出模板/输出结构"产出，不套用工业化六模块格式。
  const skillNativeMessages = [
    {
      role: 'system',
      content: `你是专业的短剧/漫剧分镜提示词生成专家。必须严格遵守以下硬规则：
1. 不得修改、增删、合并剧情；台词逐字提取，原文标点完整保留（逗号=短停顿、问号=尾音上扬、省略号=气口）。
2. 跨集一致性：同一角色/场景/道具在全剧保持视觉设定不漂移，严格参考下方 globalBible 与 continuity，不新增原文未写明的人物方位或道具。
3. 严格按 settings 的画幅、视觉风格、文戏强度执行，画幅在每个镜号中显式标注。

【分镜切分：必须按"节拍(beat)"切为镜号，严禁按固定时长或随意切分】
节拍定义：一个节拍=一个最小叙事单元，满足任一条件即为独立节拍：角色做出关键抉择或行动 / 情感发生可感知转折 / 重要信息或秘密被揭示 / 角色关系突变 / 空间或时间跳转 / 出现改变局面的重要台词 / 一段完整的动作或追逐序列。
切分规则：按本场剧本原文顺序忠实提取节拍，不重排、不遗漏、不自创情节；宁多勿少，可疑处宁拆为两个节拍也不合并；有台词的节拍必须逐字引用原台词。

【输出结构（最重要，必须严格遵循）】
1) 把本场剧本按上述节拍切分，每一个节拍输出为一个"镜号"，依次编号：镜号一、镜号二、镜号三……，每个镜号用二级标题，例如"## 镜号一（约6秒）"。
2) 每个镜号必须标注时长，且时长必须落在 4-15 秒之间。
3) 严禁再把单个镜号拆成"镜头一/镜头二"等子级；一个镜号就是一个完整镜头。
4) 每个镜号必须是一段【完整、可独立复制】的提示词，自包含：本镜号作用、人物场景位置、场景整体光影质感、对应剧本（该节拍逐字台词，保留原标点）、镜头规格（景别/机位/焦段/运镜/主体动作并内嵌该镜台词）、镜头时长、以及全镜头通用提示词/负面词。复制任意一个镜号即可直接用于 AI 视频生成。
5) 直接输出 Markdown，不要输出 JSON、不要用代码块包裹、不要任何解释性文字。

【SKILL（专业术语与光影/运镜/构图规范的依据，在不违反上述结构的前提下严格遵循）】
${skill.slice(0, 30000)}`
    },
    {
      role: 'user',
      content: JSON.stringify({
        task: '先按节拍把本场剧本忠实切分，再为每个节拍生成一个完整、可独立复制的镜号提示词（镜号一、镜号二…），每个镜号时长4-15秒，严格按上方 SKILL 的专业术语与规范撰写。',
        settings,
        globalBible: project.bible,
        continuity,
        episode: { title: episode.title, script: episode.script }
      })
    }
  ];

  const payload = {
    model: config.model,
    messages: outputMode === 'skill-native' ? skillNativeMessages : [
      {
        role: 'system',
        content: `你是「AI漫剧/短剧提示词工业化生成智能体」，为单集剧本产出可直接用于 AI 绘画与 AI 视频的中文提示词。

【最高优先级硬规则，必须全部满足，违反任一即视为失败】
1. 生成顺序：先产出角色/场景/道具的"文生图"提示词，再据此生成分镜"文生视频"提示词；视频提示词必须复用前面的视觉设定，不得另起一套。
2. 台词：从剧本逐句提取，原文标点完整保留；逗号=短停顿、问号=尾音上扬、省略号=气口。严禁改写、合并或漏台词。
3. 跨集一致性：同一角色/场景/道具在全剧保持脸型、发型、服装主色、材质、比例不漂移；严格参考下方 globalBible 与 continuity，不得新增原文未写明的人物方位或道具。
4. 每个镜头必含：画幅、时间码、景别/机位、运镜、主体动作（内嵌该镜原台词）、环境细节、负面词、镜头时长。
5. 文戏降噪：每镜头只锁定 1 个核心情绪、最多 3 个微表情锚点，避免表演一步到位、避免全程喊叫。
6. 严格按 settings 的画幅、视觉风格、文戏强度执行；画幅在每条视频提示词中显式标注。
7. 仅输出一个 JSON 对象，含键 modules{characters,scenes,props,dialogues,videoPrompts,selfCheck} 与 markdown；不要用代码块包裹，不要任何解释性文字。

【参考 SKILL：风格与细节规范，在不违反上述硬规则的前提下尽量遵循】
${skill.slice(0, 30000)}`
      },
      {
        role: 'user',
        content: JSON.stringify({
          task: '为"当前单集"生成可直接落地的 AI 绘画 + AI 视频中文提示词，覆盖角色、场景、道具、台词表、分镜视频、自检六个模块。',
          outputSchema: {
            modules: {
              characters: 'Markdown：每个出场角色一个 ### 小节，含固定视觉设定（脸型/发型/服装主色/核心记忆点）+ 本集情绪基调 + 画幅与视觉风格关键词。',
              scenes: 'Markdown：每个场景一个 ### 小节，含空间结构/主光位置/色温/关键道具/可用于镜头承接的固定视觉符号。',
              props: 'Markdown 列表：每个关键道具一行，含材质/磨损/比例/剧情归属，强调近景不变形不漂移。',
              dialogues: 'Markdown 表格，表头固定为：编号 | 角色 | 原台词（保留标点） | 字数 | 语速类型 | 预计时长 | 所属组。逐句覆盖本集全部台词。',
              videoPrompts: 'Markdown：按镜头分节（### 第N组/镜头N），每镜头含【画幅】【时间码】【景别/机位】【运镜】【主体动作：内嵌该镜原台词，保留标点】【环境细节】【负面词：分基础/类型/本组三层】【镜头时长】。',
              selfCheck: 'Markdown 表格，表头为：检查项 | 结果。至少覆盖：台词完整、标点保留、文生图先行、跨集承接（写明上一集/下一集承接点）、画幅、文戏降噪。'
            },
            markdown: '把上述六个模块按 角色→场景→道具→台词表→分镜视频→自检 的顺序拼成的完整 Markdown 成片，带一级标题（剧集名）和二级标题。'
          },
          settings,
          globalBible: project.bible,
          continuity,
          episode: {
            title: episode.title,
            script: episode.script
          }
        })
      }
    ],
    temperature: config.temperature,
    max_tokens: Number(process.env.LLM_MAX_TOKENS) || 16000
  };
  // JSON 模式：OpenAI/DeepSeek 支持；不支持的供应商会在 chatCompletion 内自动重试去掉。skill-native 走纯 Markdown，不开 JSON 模式。
  if (outputMode !== 'skill-native' && (process.env.LLM_JSON_MODE || 'true') !== 'false') {
    payload.response_format = { type: 'json_object' };
  }

  const data = await chatCompletion(config, payload);
  const choice = data.choices?.[0] || {};
  const msg = choice.message || {};
  const finishReason = choice.finish_reason;
  const content = stripMarkdownFence(msg.content || msg.reasoning_content || '');
  console.info(`LLM done for ${episode.title}: finish_reason=${finishReason} usage=${JSON.stringify(data.usage || {})} contentLen=${content.length}`);
  if (finishReason === 'length') {
    console.warn(`LLM output truncated (finish_reason=length) for ${episode.title}; consider raising LLM_MAX_TOKENS.`);
  }
  // 内容过短/被截断：视为生成失败，抛错让上层走本地兜底（而不是把一句开场白当成成片）。
  if (content.trim().length < 300 || finishReason === 'length') {
    throw new Error(`LLM 返回内容不完整（finish_reason=${finishReason}，长度=${content.trim().length}）。若为推理模型，请调高 LLM_MAX_TOKENS。`);
  }
  // skill-native：直接把模型返回的 Markdown 当成片，不做 JSON 解析。
  if (outputMode === 'skill-native') {
    const nativeMarkdown = stripMarkdownFence(content);
    const nativeModules = normalizeLlmModules({}, nativeMarkdown);
    return {
      episodeId: episode.id,
      title: episode.title,
      mode: 'llm',
      provider: config.providerName,
      model: config.model,
      modules: nativeModules,
      markdown: nativeMarkdown
    };
  }
  let parsed;
  try {
    parsed = parseLlmJson(content);
  } catch (error) {
    console.warn(`LLM JSON parse failed for ${episode.title}; using raw markdown. finish_reason=${finishReason} ${error.message}`);
    parsed = {
      modules: {
        videoPrompts: content
      },
      markdown: content
    };
  }
  const modules = normalizeLlmModules(parsed.modules, parsed.markdown);
  const markdown = String(parsed.markdown || composeMarkdownFromModules(episode.title, modules));
  return {
    episodeId: episode.id,
    title: episode.title,
    mode: 'llm',
    provider: config.providerName,
    model: config.model,
    modules,
    markdown
  };
}

async function saveExport(format, markdown, baseName) {
  await fs.mkdir(outDir, { recursive: true });
  const safeBase = baseName.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);

  if (format === 'docx') {
    const doc = new Document({
      sections: [{
        children: markdown.split('\n').map((line) => new Paragraph({
          children: [new TextRun(line || ' ')]
        }))
      }]
    });
    const buffer = await Packer.toBuffer(doc);
    const fileName = `${safeBase}.docx`;
    await fs.writeFile(path.join(outDir, fileName), buffer);
    return `/exports/${fileName}`;
  }

  const ext = format === 'txt' ? 'txt' : 'md';
  const fileName = `${safeBase}.${ext}`;
  await fs.writeFile(path.join(outDir, fileName), markdown, 'utf8');
  return `/exports/${fileName}`;
}

app.get('/api/health', async (_req, res) => {
  const defaultConfig = resolveLlmConfig();
  res.json({
    ok: true,
    llmConfigured: Boolean(defaultConfig.apiKey),
    provider: defaultConfig.providerName,
    model: defaultConfig.model,
    apiKeySource: defaultConfig.apiKeySource,
    apiKeyHint: defaultConfig.apiKeyHint,
    skillPath: process.env.SKILL_PATH || defaultSkillPath
  });
});

app.get('/api/llm/providers', async (_req, res) => {
  const def = resolveLlmConfig();
  res.json({
    providers: getConfiguredProviders(),
    defaults: {
      providerId: def.providerId,
      model: def.model,
      baseUrl: def.baseUrl
    }
  });
});

// 轮询任务状态/结果。请求很短，不会触发托管层的长请求断连。
app.get('/api/jobs/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: '任务不存在或已过期，请重新生成。' });
  res.json({ status: job.status, result: job.result, error: job.error, progress: job.progress || null });
});

app.post('/api/llm/test', async (req, res, next) => {
  try {
    const config = resolveLlmConfig(req.body?.llm || req.body || {});
    if (!config.apiKey) {
      return res.json({
        ok: false,
        apiKeySource: config.apiKeySource,
        error: { code: 'missing_api_key', message: '未填写 API Key，无法测试连接。' }
      });
    }
    const probe = await probeModels(config);
    res.json({
      ok: probe.ok,
      provider: config.providerName,
      baseUrl: config.baseUrl,
      apiKeySource: config.apiKeySource,
      apiKeyHint: config.apiKeyHint,
      models: probe.models || [],
      error: probe.ok ? null : probe.error,
      message: probe.ok
        ? `连接成功，发现 ${probe.models?.length || 0} 个可用模型。`
        : `连接失败：${probe.error?.message || '未知错误'}`
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/skill-templates', async (_req, res) => {
  res.json({
    templates: listSkillTemplates(),
    defaultTemplateId: 'template-1'
  });
});

app.post('/api/skill-templates/upload', upload.single('skillFile'), async (req, res, next) => {
  try {
    const content = req.file ? await extractUploadedText(req.file) : normalizeText(req.body.content || '');
    if (!content) return res.status(400).json({ error: '请上传或粘贴 SKILL 模板内容。' });

    await fs.mkdir(skillUploadDir, { recursive: true });
    const id = uid('skill');
    const originalName = req.file?.originalname || `${id}.txt`;
    const safeName = originalName.replace(/[\\/:*?"<>|]/g, '_');
    const fileName = `${id}_${safeName}`;
    const filePath = path.join(skillUploadDir, fileName);
    await fs.writeFile(filePath, content, 'utf8');

    const template = {
      id,
      name: normalizeText(req.body.name || '').slice(0, 30) || `自定义模板 ${userSkillTemplates.size + 1}`,
      description: '用户上传的 SKILL 模板',
      path: filePath,
      fileName,
      source: 'user',
      kind: (['video', 'script'].includes(normalizeText(req.body.kind || '')) ? normalizeText(req.body.kind) : 'asset')
    };
    userSkillTemplates.set(id, template);
    res.json({ template: listSkillTemplates().find((item) => item.id === id) });
  } catch (error) {
    next(error);
  }
});

// ===== 项目汇总：列表 / 创建 / 读取 / 更新 / 删除 / 批量 =====
app.get('/api/projects', (req, res) => {
  const { type = '全部', status = '全部', q = '', category = '工作台' } = req.query;
  let list = [...projects.values()].map(projectSummary);
  if (type === 'collab' || type === '协作') list = list.filter((p) => p.collaboration);
  else if (type === 'personal' || type === '个人') list = list.filter((p) => !p.collaboration);
  if (status && status !== '全部') list = list.filter((p) => p.status === status);
  if (category && category !== '工作台') list = list.filter((p) => p.category === category);
  const kw = String(q || '').trim();
  if (kw) list = list.filter((p) => (p.title || '').includes(kw));
  list.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  res.json({ projects: list, categories: listProjectCategories() });
});

app.post('/api/projects', async (req, res, next) => {
  try {
    const { title = '', aspectRatio = '9:16', collaboration = false, style = DEFAULT_PROJECT_STYLE, category = '工作台', models = {} } = req.body || {};
    const project = {
      id: uid('project'),
      title: String(title).trim() || '未命名项目',
      name: String(title).trim() || '未命名项目',
      aspectRatio: aspectRatio === '16:9' ? '16:9' : '9:16',
      collaboration: !!collaboration,
      status: '已立项',
      category: category || '工作台',
      style: style in PROJECT_STYLES ? style : DEFAULT_PROJECT_STYLE,
      stylePrompt: projectStylePrompt(style in PROJECT_STYLES ? style : DEFAULT_PROJECT_STYLE),
      models: { ...DEFAULT_PROJECT_MODELS, ...(models || {}) },
      createdAt: new Date().toISOString(),
      originalScript: '',
      episodes: [],
      bible: { characters: [], scenes: [], props: [], episodeContinuity: [] },
      outputs: {}
    };
    projects.set(project.id, project);
    await persistProject(project);
    res.json({ project });
  } catch (error) { next(error); }
});

app.get('/api/projects/:id', (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) return res.status(404).json({ error: '项目不存在。' });
  res.json({ project: p });
});

app.patch('/api/projects/:id', async (req, res, next) => {
  try {
    const p = projects.get(req.params.id);
    if (!p) return res.status(404).json({ error: '项目不存在。' });
    const allow = ['title', 'aspectRatio', 'collaboration', 'status', 'category', 'style', 'stylePrompt', 'models'];
    for (const k of allow) if (k in req.body) p[k] = req.body[k];
    if ('title' in req.body) p.name = p.title;
    if ('style' in req.body && !('stylePrompt' in req.body)) p.stylePrompt = projectStylePrompt(p.style);
    await persistProject(p);
    res.json({ project: projectSummary(p) });
  } catch (error) { next(error); }
});

app.delete('/api/projects/:id', async (req, res, next) => {
  try {
    projects.delete(req.params.id);
    try { await fs.unlink(projectFilePath(req.params.id)); } catch { /* 文件可能不存在 */ }
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.post('/api/projects/batch', async (req, res, next) => {
  try {
    const { ids = [], action, patch = {} } = req.body || {};
    for (const id of ids) {
      const p = projects.get(id);
      if (action === 'delete') {
        projects.delete(id);
        try { await fs.unlink(projectFilePath(id)); } catch { /* ignore */ }
      } else if (action === 'update' && p) {
        const allow = ['status', 'category', 'collaboration'];
        for (const k of allow) if (k in patch) p[k] = patch[k];
        await persistProject(p);
      }
    }
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// 分类（月份/自定义标签）
app.get('/api/categories', (_req, res) => res.json({ categories: listProjectCategories() }));
app.post('/api/categories', async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (name && name !== '工作台') projectCategories.add(name);
    await persistCategories();
    res.json({ categories: listProjectCategories() });
  } catch (error) { next(error); }
});
app.patch('/api/categories', async (req, res, next) => {
  try {
    const from = String(req.body?.from || '').trim();
    const to = String(req.body?.to || '').trim();
    if (projectCategories.has(from) && to) {
      projectCategories.delete(from);
      projectCategories.add(to);
      for (const p of projects.values()) if (p.category === from) { p.category = to; await persistProject(p); }
      await persistCategories();
    }
    res.json({ categories: listProjectCategories() });
  } catch (error) { next(error); }
});
app.delete('/api/categories/:name', async (req, res, next) => {
  try {
    const name = req.params.name;
    projectCategories.delete(name);
    for (const p of projects.values()) if (p.category === name) { p.category = '工作台'; await persistProject(p); }
    await persistCategories();
    res.json({ categories: listProjectCategories() });
  } catch (error) { next(error); }
});

app.post('/api/projects/parse', upload.single('scriptFile'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const uploaded = req.file ? await extractUploadedText(req.file) : '';
    const script = normalizeText(uploaded || body.script || '');
    if (!script) return res.status(400).json({ error: '请粘贴剧本或上传 TXT/DOCX 文件。' });

    const episodes = splitEpisodes(script);
    const bible = buildBible(episodes);
    const existing = body.projectId ? projects.get(body.projectId) : null;
    let project;
    if (existing) {
      existing.originalScript = script;
      existing.episodes = episodes;
      existing.bible = bible;
      existing.outputs = {};
      project = existing;
    } else {
      project = {
        id: uid('project'),
        title: body.name || '未命名漫剧项目',
        name: body.name || '未命名漫剧项目',
        aspectRatio: '9:16',
        collaboration: false,
        status: '已立项',
        category: '工作台',
        style: DEFAULT_PROJECT_STYLE,
        stylePrompt: projectStylePrompt(DEFAULT_PROJECT_STYLE),
        models: { ...DEFAULT_PROJECT_MODELS },
        createdAt: new Date().toISOString(),
        originalScript: script,
        episodes,
        bible,
        outputs: {}
      };
    }
    projects.set(project.id, project);
    await persistProject(project);
    res.json({ project });
  } catch (error) {
    next(error);
  }
});

// 按「场次」生成分镜：把某集某一场当作独立单元生成视频提示词。
app.post('/api/projects/:projectId/scene-generate', async (req, res, next) => {
  try {
    const project = projects.get(req.params.projectId);
    if (!project) return res.status(404).json({ error: '项目不存在，请重新上传剧本。' });
    const { episodeId, sceneId, settings = {}, llm = {}, skillTemplateId = 'template-1' } = req.body;
    settings.visualStyle = expandStyle(settings.visualStyle);
    const episode = project.episodes.find((e) => e.id === episodeId);
    if (!episode) return res.status(400).json({ error: '剧集不存在。' });
    const scene = (episode.scenes || []).find((s) => s.id === sceneId);
    if (!scene) return res.status(400).json({ error: '场次不存在。' });

    const llmConfig = resolveLlmConfig(llm);
    const jobId = createJob();
    res.json({ jobId, status: 'pending' });

    (async () => {
      const skill = await readSkill(skillTemplateId);
      let usedFallback = false;
      let llmError = llmConfig.apiKey ? null : {
        code: 'missing_api_key',
        message: `未填写 ${llmConfig.providerName} 的 API Key。请在 LLM 设置面板填写后再生成。`
      };
      // 用「伪剧集」承载本场：复用同集 id 以便连续性查找，标题/正文用本场。
      const pseudoEpisode = { id: episode.id, number: episode.number, title: `${episode.title} · ${scene.name}`, script: scene.script };
      let output = null;
      try {
        output = await callLLM({ skill: skill.content, project, episode: pseudoEpisode, settings, llm, skillTemplate: skill.template });
      } catch (error) {
        if (!llmError) llmError = parseLlmError(error.message);
        console.warn(`Scene LLM fell back: ${error.message}`);
      }
      if (!output) { usedFallback = true; output = fallbackGenerateByTemplate({ project, episode: pseudoEpisode, settings, skillTemplate: skill.template }); }

      finishJob(jobId, {
        markdown: output.markdown,
        usedFallback,
        provider: llmConfig.providerName,
        model: llmConfig.model,
        apiKeySource: llmConfig.apiKeySource,
        llmError
      });
    })().catch((error) => {
      console.error(`Scene job failed: ${error.message}`);
      failJob(jobId, parseLlmError(error.message));
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/projects/:projectId/generate', async (req, res, next) => {
  try {
    const project = projects.get(req.params.projectId);
    if (!project) return res.status(404).json({ error: '项目不存在，请重新上传剧本。' });

    const { episodeIds = [], settings = {}, llm = {}, skillTemplateId = 'template-1' } = req.body;
    settings.visualStyle = expandStyle(settings.visualStyle);
    const llmConfig = resolveLlmConfig(llm);
    const selected = project.episodes.filter((episode) => episodeIds.includes(episode.id));
    if (!selected.length) return res.status(400).json({ error: '请至少选择一集。' });

    // 立即返回 jobId，后台执行（绕开托管层长请求断连）。
    const jobId = createJob();
    res.json({ jobId, status: 'pending' });

    (async () => {
      const skill = await readSkill(skillTemplateId);
      let usedFallback = false;
      let llmError = llmConfig.apiKey ? null : {
        code: 'missing_api_key',
        message: `未填写 ${llmConfig.providerName} 的 API Key。请在 LLM 设置面板里选择供应商并粘贴你自己的 API Key 后再生成。`,
        type: 'configuration_error'
      };

      // 有限并发生成，避免选"全部剧集"时一集一集串行排队。
      const concurrency = Number(process.env.LLM_CONCURRENCY) || 3;
      const outputs = await mapWithConcurrency(selected, concurrency, async (episode) => {
        let llmOutput = null;
        try {
          llmOutput = await callLLM({ skill: skill.content, project, episode, settings, llm, skillTemplate: skill.template });
        } catch (error) {
          if (!llmError) llmError = parseLlmError(error.message);
          console.warn(`LLM generation fell back for ${episode.title}: ${error.message}`);
        }
        if (!llmOutput) usedFallback = true;
        const output = llmOutput || fallbackGenerateByTemplate({ project, episode, settings, skillTemplate: skill.template });
        project.outputs[episode.id] = output;
        return output;
      });
      await persistProject(project);

      finishJob(jobId, {
        outputs,
        llmConfigured: Boolean(llmConfig.apiKey),
        provider: llmConfig.providerName,
        model: llmConfig.model,
        apiKeySource: llmConfig.apiKeySource,
        apiKeyHint: llmConfig.apiKeyHint,
        usedFallback,
        llmError,
        skillTemplate: { id: skill.template.id, name: skill.template.name }
      });
    })().catch((error) => {
      console.error(`Generate job failed: ${error.message}`);
      failJob(jobId, parseLlmError(error.message));
    });
  } catch (error) {
    next(error);
  }
});

// ===== 美术资产提示词（文生图）=====
function composeAssetMarkdown(modules) {
  return `# 美术资产提示词

## 角色
${modules.characters || '（本次未选择角色）'}

## 场景
${modules.scenes || '（本次未选择场景）'}

## 道具
${modules.props || '（本次未选择道具）'}
`;
}

// 把某个模块的 markdown 按 "### 名称" 切成 名称 -> 正文 的映射
function splitAssetSections(markdown) {
  const map = {};
  if (!markdown) return map;
  for (const part of markdown.split(/\n(?=###\s)/)) {
    const m = part.match(/^###\s*(.+?)\s*(?:\n([\s\S]*))?$/);
    if (m) map[m[1].trim()] = (m[2] || '').trim();
  }
  return map;
}

// 资产名归一化：去掉 @ 前缀、括号补充说明、空格/下划线/间隔号，便于模糊匹配。
function normalizeAssetName(s = '') {
  return String(s).replace(/^@+/, '').replace(/[（(][^）)]*[）)]/g, '').replace(/[\s_·、,，-]/g, '').trim();
}

// 从小节映射里为某个资产名挑出提示词：精确匹配 → 归一化后包含匹配。
function pickAssetPrompt(sectionMap, name) {
  if (sectionMap[name]) return sectionMap[name];
  const target = normalizeAssetName(name);
  if (!target) return '';
  for (const [key, val] of Object.entries(sectionMap)) {
    const k = normalizeAssetName(key);
    if (k && (k === target || k.includes(target) || target.includes(k))) return val;
  }
  return '';
}

// 为每个被选中的资产输出一条 {type, name, prompt}
function buildAssetItems(assets, modules) {
  const maps = {
    characters: splitAssetSections(modules.characters),
    scenes: splitAssetSections(modules.scenes),
    props: splitAssetSections(modules.props)
  };
  const items = [];
  for (const type of ['characters', 'scenes', 'props']) {
    const names = Array.isArray(assets[type]) ? assets[type] : [];
    for (const name of names) {
      let prompt = pickAssetPrompt(maps[type], name);
      // 兜底：该类只选了一个资产却没匹配到小节标题，但模型确实输出了内容 → 直接用整段。
      if (!prompt && names.length === 1) prompt = String(modules[type] || '').trim();
      items.push({ type, name, prompt });
    }
  }
  return items;
}

function fallbackAssetPrompts({ project, assets, settings, ages = {}, styleTone = '' }) {
  const style = settings.visualStyle || '写实电影感 + 现代都市';
  const tone = styleTone ? `${styleTone}，` : '';
  const b = project.bible;
  const pick = (key) => (Array.isArray(assets[key]) ? assets[key] : []);
  const cs = b.characters.filter((c) => pick('characters').includes(c.name));
  const ss = b.scenes.filter((s) => pick('scenes').includes(s.name));
  const ps = b.props.filter((p) => pick('props').includes(p.name));
  // 角色造型/场景固定 16:9，道具固定 1:1（基准脸另走 1:1，见前端）
  const characters = cs.map((c) => {
    const age = ages[c.name] ? `出镜年龄 ${ages[c.name]}，` : '';
    return `### ${c.name}\n比例 16:9，${style}，角色设定图（右侧头部特写 + 左侧全身三视图），纯白无缝背景，仅呈现角色本体、服装与随身饰品；${age}${c.visual} 表情自然，真实皮肤质感，柔焦边缘，克制细节。`;
  }).join('\n\n');
  const scenes = ss.map((s) => `### ${s.name}\n比例 16:9，${style}，${tone}无人空镜场景设定图，仅呈现空间结构、固定陈设和环境质感：${s.description} 明确空间结构、主光位置、色温与关键陈设，画面中无人物。`).join('\n\n');
  const props = ps.map((p) => `### ${p.name}\n比例 1:1，${style}，道具设定图，白底或中性背景，仅呈现单一道具：${p.rule} 材质统一干净，边缘柔和且形体清楚，保留必要结构细节。`).join('\n\n');
  const modules = { characters, scenes, props };
  return { mode: 'fallback', modules, markdown: composeAssetMarkdown(modules) };
}

async function callAssetLLM({ skill, project, assets, settings, llm, ages = {}, styleTone = '', characterLook = '', worldview = '' }) {
  const config = resolveLlmConfig(llm);
  if (!config.apiKey) return null;
  const payload = {
    model: config.model,
    messages: [
      {
        role: 'system',
        content: `你是「美术资产提示词生成专家」，为短剧/漫剧生成可直接用于 AI 绘画（文生图）的中文资产提示词。
硬规则：①只为 user 给出的"被选中资产"生成，不要新增；②每个资产一个 ### 小节，小节标题必须与资产名完全一致（不加@、不加任何前后缀）；场景与道具严禁再拆日间/夜间等子状态、严禁使用 #### 子标题，一个场景/道具只输出一段完整提示词；③角色造型与场景比例固定 16:9、道具固定 1:1；④角色提示词只写人物本体（纯白无缝背景，仅呈现角色本体/服装/随身饰品），不写场景、道具、镜头；场景为无人空镜，道具为白底特写；⑤角色年龄一律采用 user 提供的 confirmedAges（出镜年龄），不使用剧本推理年龄；⑥参考风格基调 styleTone 只用于场景，不污染角色与道具；⑦只输出一个 JSON 对象，键为 modules{characters,scenes,props}（不需要 markdown 键），不要代码块、不要解释；⑧【角色多造型，重要】modules.characters 中每个角色用「### 角色名」作小节标题（角色名与被选中资产名完全一致、不加@符号），标题下先写一行「面部锚点（全状态固定）：」锁定该角色脸型/骨相/五官结构/核心视觉记忆点与确认年龄；随后必须依据 globalBible 与剧情主动推算该角色需要的多个造型/状态——凡剧情中存在时间跨度、回忆闪回、身份或处境变化、外观物理变化（受伤/换装/年龄阶段等）导致该角色外观明显不同的，都要各自生成一个造型，用「#### @角色名_状态名」作子标题（状态名取自剧情，如 少年/成年/老年/受伤/旧工装/正装 等），每个造型都是一段完整的中文文生图提示词，且必须采用「角色设定图」版式：右侧为该造型的角色头部清晰特写、左侧为该造型的全身三视图（正面/侧面/背面），纯白无缝背景；显式继承上面的面部锚点、只改服饰妆发配饰，绝不写场景/道具/镜头；每个角色默认 1-4 个造型：外观确实全程一致的才只给 1 个，凡剧情有明显变化就必须给出多个，不得只给一个。⑨角色审美 characterLook（如 东方面孔/西方面孔/混血面孔）决定所有角色的面孔族裔与审美取向，必须体现在每个角色的面部锚点与造型里；⑩世界观架构 worldview（年代/时代背景，如 现代都市/古代古装/民国/未来科幻/武侠仙侠）决定所有角色服饰妆造与场景建筑、道具材质的年代风格，必须贯穿全部资产、统一不跳脱。严格遵循下方 SKILL。

【参考 SKILL（美术资产风格规范）】
${skill.slice(0, 24000)}`
      },
      {
        role: 'user',
        // 只发本批资产相关的 bible 条目 + 剧情摘要：全量 bible 每批要重复 4 万+ token 输入，
        // 既慢（首字等待长）又贵；摘要足够支撑角色多造型推导。
        content: JSON.stringify({
          task: '仅为下列被选中的美术资产生成文生图提示词',
          selectedAssets: assets,
          settings,
          confirmedAges: ages,
          styleTone,
          characterLook,
          worldview,
          globalBible: {
            characters: (project.bible?.characters || []).filter((c) => (assets.characters || []).includes(c.name)),
            scenes: (project.bible?.scenes || []).filter((s) => (assets.scenes || []).includes(s.name)),
            props: (project.bible?.props || []).filter((p) => (assets.props || []).includes(p.name)),
            episodeContinuity: (project.bible?.episodeContinuity || []).map((e) => ({ title: e.title, summary: e.summary }))
          }
        })
      }
    ],
    temperature: config.temperature,
    max_tokens: Number(process.env.LLM_MAX_TOKENS) || 8000
  };
  if ((process.env.LLM_JSON_MODE || 'true') !== 'false') payload.response_format = { type: 'json_object' };
  // 单批资产不大，用更短的超时（默认 240s）+ 上层重试一次，避免网关卡队列时一等 600s。
  const data = await chatCompletion(config, payload, { timeoutMs: Number(process.env.ASSET_CHUNK_TIMEOUT_MS) || 240000 });
  const content = stripMarkdownFence(extractMessageText(data));
  let parsed;
  try { parsed = parseLlmJson(content); } catch { parsed = { modules: {}, markdown: content }; }
  // 模型有时把 modules.xxx 返回成数组/对象/中文键而非字符串（道具批次尤其常见），
  // 这里做归一化：数组逐项拼接、{name,prompt} 对象转 "### 名称\n提示词"、映射对象按键名转小节。
  const rawMods = (parsed.modules && typeof parsed.modules === 'object') ? parsed.modules : {};
  const toText = (v) => {
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(toText).filter(Boolean).join('\n\n');
    if (v && typeof v === 'object') {
      const name = v.name || v['名称'] || v['资产名'] || '';
      const body = v.prompt || v['提示词'] || v.description || v['描述'] || '';
      if (name && typeof body === 'string' && body) return `### ${name}\n${body}`;
      return Object.entries(v).map(([k, val]) => {
        const text = toText(val);
        if (!text) return '';
        return text.trimStart().startsWith('###') ? text : `### ${k}\n${text}`;
      }).filter(Boolean).join('\n\n');
    }
    return '';
  };
  let modules = {
    characters: toText(rawMods.characters ?? rawMods['角色']),
    scenes: toText(rawMods.scenes ?? rawMods['场景']),
    props: toText(rawMods.props ?? rawMods['道具'])
  };
  const markdown = String(parsed.markdown || ((modules.characters || modules.scenes || modules.props) ? composeAssetMarkdown(modules) : content));
  // 兜底：模型没按 JSON 的 modules 返回（只给了 markdown/纯文本）时，从 markdown 文本重建分段，
  // 否则前端按 modules 抽取会全空、看不到内容。
  if (!modules.characters && !modules.scenes && !modules.props && markdown) {
    modules = extractAssetModulesFromMarkdown(markdown);
  }
  return { mode: 'llm', provider: config.providerName, model: config.model, modules, markdown };
}

// 分批生成资产提示词：一次塞几十个资产会超时/超 max_tokens，整体失败后全部静默降级为本地模板（表现为
// 每个资产只有通用句式）。这里按类别切小批（角色 3 / 场景 6 / 道具 8），最多 3 路并发；哪批失败只对那批兜底。
const ASSET_BATCH_SIZES = { characters: 3, scenes: 8, props: 12 };
const ASSET_CHUNK_CONCURRENCY = Number(process.env.ASSET_CHUNK_CONCURRENCY) || 6;
async function callAssetLLMChunked(args) {
  const { assets } = args;
  const chunks = [];
  for (const type of ['characters', 'scenes', 'props']) {
    const names = Array.isArray(assets[type]) ? assets[type] : [];
    for (let i = 0; i < names.length; i += ASSET_BATCH_SIZES[type]) {
      chunks.push({ type, names: names.slice(i, i + ASSET_BATCH_SIZES[type]) });
    }
  }
  const parts = { characters: [], scenes: [], props: [] };
  const failed = [];
  let firstError = null;
  let cursor = 0;
  let completed = 0;
  const { onProgress } = args;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= chunks.length) return;
      const chunk = chunks[i];
      const subAssets = { characters: [], scenes: [], props: [], [chunk.type]: chunk.names };
      let text = '';
      let lastError = null;
      for (let attempt = 1; attempt <= 2 && !text; attempt += 1) {
        try {
          const out = await callAssetLLM({ ...args, assets: subAssets });
          text = String(out?.modules?.[chunk.type] || '').trim();
          if (!text) throw new Error('模型返回空内容');
        } catch (error) {
          lastError = error;
          if (attempt === 1) console.warn(`Asset chunk retrying (${chunk.type}: ${chunk.names.join('、')}): ${error.message}`);
        }
      }
      if (text) {
        // 场景/道具偶发被模型写成「#### @名称_状态」子标题（造型格式），拆分器只认 ###，
        // 会把多个资产粘成一段。这里统一规格化成 ### 顶级小节再存。
        if (chunk.type !== 'characters') text = text.replace(/^####\s*@?/gm, '### ');
        parts[chunk.type][i] = text; // 用全局批次序号占位，保持原始顺序
      } else {
        if (!firstError) firstError = lastError;
        console.warn(`Asset chunk failed (${chunk.type}: ${chunk.names.join('、')}): ${lastError?.message}`);
        failed.push(...chunk.names);
        const fb = fallbackAssetPrompts({ project: args.project, assets: subAssets, settings: args.settings, ages: args.ages, styleTone: args.styleTone });
        parts[chunk.type][i] = fb.modules[chunk.type];
      }
      completed += 1;
      if (typeof onProgress === 'function') { try { onProgress(completed, chunks.length); } catch { /* ignore */ } }
    }
  }
  await Promise.all(Array.from({ length: Math.min(ASSET_CHUNK_CONCURRENCY, Math.max(chunks.length, 1)) }, worker));
  const modules = {
    characters: parts.characters.filter(Boolean).join('\n\n'),
    scenes: parts.scenes.filter(Boolean).join('\n\n'),
    props: parts.props.filter(Boolean).join('\n\n')
  };
  return { modules, failed, firstError, chunkCount: chunks.length };
}

// 剧本构建工坊：按所选 SKILL（生成/小说转/优化）产出完整剧本正文（纯 Markdown）。
// ===== 移植自 PlotPilot（墨枢）的叙事法则 / 反AI腔协议 / 宏观规划原则 =====
const PLOTPILOT_NARRATIVE_LAWS = `【高阶叙事法则 · 落笔前先推演，勿机械套模板】
1. 势能守恒：每集/每场是能量单元。蓄势期累积未释放的冲突势能（压抑/悬念/误会加深）；引爆点把势能转成爽点动能（爆发/反转/碾压）；余震带处理势能衰减与转化（消化战果/关系重塑/锚定新目标）。
2. 信息锥度：信息释放要有"已知—未知"的锥形梯度——哪些用台词抛出、哪些用画面细节暗示、哪些只让主角知道而观众猜疑、哪些彻底隐藏。
3. 节奏切变：由"叙述时间/故事时间"之比控制。开篇制造时间膨胀（细节放大入戏）；高潮时间压缩（连续动作、短句冲击）；过渡等速或跳跃。
4. 情感压强差：情绪来自"预期"与"实际"的落差。铺垫抬高预期再延迟满足；爽点突然释放超预期奖赏。明确每段要制造多大压强差。
5. 视域锚定：确定本场感知主体（通常主角），所有细节/反应/心理都过该主体的情绪滤镜。`;

const PLOTPILOT_ANTI_AI = `【反AI腔协议 P1-P5（不可违反）+ 替换策略 R1-R8】
P1 信息密度：每段至少推进一项——具体动作带后果 / 有信息量的对白 / 发现或决定 / 可见位移；禁止连续两段纯写景无人物取舍。
P2 感官优先：表达情绪/氛围按此顺序——感官细节(温度/光线/声音/触感/气味)→动作变化→对白；禁止跳过前两步直接贴情绪标签。
P3 角色差异化：不同角色对同一事件反应必须不同（=背景×身体状态×利益关系）；每人有专属紧张小动作。
P4 节奏与段落：快→短句、动词前移；慢→长短交替、感官穿插；禁止连续3句以上长度相近；独句成段仅用于引爆/揭露/情绪暴击。
P5 衔接：节拍间无断点、情绪有惯性；禁止用"后来/之后/转眼间"开头省略过渡。
替换策略：R1情绪→写此刻最可能的小动作(手停住/话顿住/杯子端起又放下)；R2微表情→写完整姿态或让对白自己传递；R3比喻→写体温/光线角度/衣料触感；R4声线→用对白标点断句表现语气；R5纠正式对照→拆成平叙或直接写动作结果；R6破折号→句号断开；R7动物比喻→删掉改人的动作；R8生理性→直接写生理反应(眼睛酸了/鼻子红了/声音发闷)。`;

const PLOTPILOT_MACRO_PRINCIPLES = `【宏观规划原则】
1. 源设定优先：作者梗概/题材/人物权重最高，不擅自更换题材、时代、身份体系或标志性元素。
2. 类型发动机：先提炼该题材的持续追看动力（升级/破案/关系推进/权力博弈/真相揭示等），再分配到各集。
3. 长线动力链：每个结构单元都要看得出"压制或缺口→欲望→阶段目标→阻力→选择→代价→反击或突破→新问题"的因果推进。
4. 阶段承诺：每集承担一个可追看的阶段问题，集末给阶段回报，同时留下更高压力或诱因，别只做地点切换。
5. 开篇留存：首集优先建立主角处境、核心欲望、可感知威胁、即时目标和第一次正反馈，别过度铺背景。
6. 钩子服从原设：每集末留未完成问题或正反馈预期，钩子形态来自原始设定，不硬塞无关阴谋/系统/血脉/豪门/末世外壳。`;

async function scriptChat(config, system, user, temperature, maxTokens) {
  const payload = {
    model: config.model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature,
    max_tokens: maxTokens
  };
  const data = await chatCompletion(config, payload);
  const choice = data.choices?.[0] || {};
  const msg = choice.message || {};
  const content = stripMarkdownFence(msg.content || msg.reasoning_content || '').trim();
  return { content, finishReason: choice.finish_reason, usage: data.usage };
}

// PlotPilot 式多阶段：generate 走「宏观规划 → 成稿」双阶段；novel/optimize 单阶段但注入叙事法则与反AI协议。
async function callScriptLLM({ skill, mode, input, settings, llm }) {
  const config = resolveLlmConfig(llm);
  if (!config.apiKey) return null;
  const maxTokens = Number(process.env.LLM_MAX_TOKENS) || 16000;
  const s = settings || {};
  let plan = '';
  let scriptSystem;
  let scriptUser;

  if (mode === 'generate') {
    // 阶段一：宏观规划
    const planSystem = `你是资深短剧总编剧与结构顾问。基于用户创意，产出一份可落地的【短剧宏观规划】。\n${PLOTPILOT_MACRO_PRINCIPLES}\n用中文 markdown 依次输出：一、题材定位与类型发动机（一句话故事 + 持续追看动力）；二、主要人物（3-6个，每人：身份、核心欲望、性格、专属紧张小动作、人物弧光）；三、世界观/规则要点；四、分集大纲（每集：集名 + 核心冲突(谁跟谁、赌注) + 情绪转折 + 爽点/反转 + 集末钩子 + 阶段回报）。只输出规划本身，不写解释与点评。`;
    const planUser = JSON.stringify({ 任务: '短剧宏观规划', 参数: s, 用户创意: String(input || '').slice(0, 60000) });
    try {
      const planRes = await scriptChat(config, planSystem, planUser, 0.7, Math.min(maxTokens, 8000));
      if (planRes.content.length >= 80) plan = planRes.content;
      console.info(`Script plan done: finish_reason=${planRes.finishReason} len=${planRes.content.length}`);
    } catch (error) {
      console.warn(`Script plan stage failed, continue to draft: ${error.message}`);
    }
    // 阶段二：按规划成稿
    scriptSystem = `你是掌握叙事动力学的短剧编剧。根据【宏观规划】把它写成一部可直接投拍的竖屏短剧【成稿剧本】。\n${PLOTPILOT_NARRATIVE_LAWS}\n${PLOTPILOT_ANTI_AI}\n严格遵循下方 SKILL 的输出格式（集/场次头/人物行/【动作】/台词/OS/字幕），用中文直接输出剧本正文；不要输出 JSON、不要用代码块包裹、不要任何创作说明或点评。\n\n【SKILL】\n${String(skill || '').slice(0, 20000)}`;
    scriptUser = JSON.stringify({ 任务: '按宏观规划成稿', 参数: s, 宏观规划: plan || '（规划阶段未产出，请你先在心里快速规划再成稿）', 原始创意: String(input || '').slice(0, 20000) });
  } else {
    const modeLabel = mode === 'novel' ? '小说转剧本' : '优化完善剧本';
    scriptSystem = `你是专业短剧编剧，当前任务：${modeLabel}。严格遵循下方 SKILL 的创作原则与输出格式，用中文直接输出剧本正文；不要输出 JSON、不要用代码块包裹、不要任何创作说明或点评。\n${PLOTPILOT_NARRATIVE_LAWS}\n${PLOTPILOT_ANTI_AI}\n\n【SKILL】\n${String(skill || '').slice(0, 20000)}`;
    scriptUser = JSON.stringify({ 任务: modeLabel, 参数: s, 用户输入: String(input || '').slice(0, 120000) });
  }

  const res = await scriptChat(config, scriptSystem, scriptUser, mode === 'novel' ? 0.45 : 0.8, maxTokens);
  const content = res.content;
  console.info(`Script LLM done (${mode}): finish_reason=${res.finishReason} usage=${JSON.stringify(res.usage || {})} len=${content.length} planLen=${plan.length}`);
  if (res.finishReason === 'length' && content.length >= 100) {
    return { mode: 'llm', provider: config.providerName, model: config.model, plan, markdown: content + '\n\n（注：内容较长被截断，可调高 LLM_MAX_TOKENS 或分批生成。）' };
  }
  if (content.length < 100) {
    throw new Error(`剧本生成内容不完整（finish_reason=${res.finishReason}，长度=${content.length}）。`);
  }
  return { mode: 'llm', provider: config.providerName, model: config.model, plan, markdown: content };
}

// 用 LLM 通读剧本，智能识别真实的角色/场景/道具清单（替代规则提取）。
async function callAssetAnalyzeLLM({ script, llm }) {
  const config = resolveLlmConfig(llm);
  if (!config.apiKey) return null;
  const payload = {
    model: config.model,
    messages: [
      {
        role: 'system',
        content: `你是专业的剧本分析助手。通读用户提供的剧本，识别出需要制作美术资产的三类对象：
① 角色：有明确身份的人物（主角、配角、有台词或关键表演的人）。严禁把动作提示、旁白、OS/VO、字幕、场景名、台词内容当成角色；同一人物的不同称呼/带括号动作合并为一个标准姓名（如「冯衍（放下茶盏）」→「冯衍」）。并且必须给出该角色的出镜年龄判断（age 字段一律不得留空）：剧本写明的直接采用；未写明的，必须结合人物身份、称谓、职务、剧情关系、时代背景与外貌线索做出合理推断，给出一个具体数字或紧凑区间（如 "28" 或 "25-30"）；实在无从判断也要给出最接近的合理估值，不得返回空字符串。
② 场景：故事发生的空间地点（如「宗人府」「西街」「冯府书房」「全国陶瓷技艺大赛现场」），给一句话简短描述。不要把台词行或人物当场景。
③ 关键道具：剧情中重要、反复出现或有近景特写的物件（如「银鱼袋」「策论」「日记本」）。不要列没有剧情意义的通用物件。
只输出一个 JSON 对象，结构为：{"characters":[{"name":"","age":""}],"scenes":[{"name":"","description":""}],"props":[{"name":""}]}。每类去重、按重要性排序；角色最多 24 个、场景最多 24 个、道具最多 16 个。不要输出任何解释或代码块。`
      },
      { role: 'user', content: `剧本如下：\n${String(script || '').slice(0, 100000)}` }
    ],
    temperature: 0.2,
    max_tokens: Number(process.env.LLM_MAX_TOKENS) || 8000
  };
  if ((process.env.LLM_JSON_MODE || 'true') !== 'false') payload.response_format = { type: 'json_object' };
  const data = await chatCompletion(config, payload);
  const content = stripMarkdownFence(extractMessageText(data));
  let parsed;
  try { parsed = parseLlmJson(content); } catch { parsed = {}; }
  return { provider: config.providerName, model: config.model, ...normalizeAnalyzedAssets(parsed) };
}

// 把识别/复核模型返回的 JSON 归一化成 {characters:[{name,age}], scenes:[{name,description}], props:[string]}，三类各自去重。
function normalizeAnalyzedAssets(parsed = {}) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  const cleanName = (s) => String((s && typeof s === 'object') ? (s.name ?? '') : (s ?? '')).replace(/^@+/, '').replace(/[（(][^）)]*[）)]/g, '').trim();
  const cSeen = new Set();
  const characters = arr(parsed.characters)
    .map((c) => ({ name: cleanName(c), age: String((c && c.age != null) ? c.age : '').trim() }))
    .filter((c) => c.name && !cSeen.has(c.name) && cSeen.add(c.name));
  const sSeen = new Set(); const scenes = arr(parsed.scenes).map((s) => ({ name: cleanName(s), description: String((s && s.description) || '').trim() })).filter((s) => s.name && !sSeen.has(s.name) && sSeen.add(s.name));
  const pSeen = new Set(); const props = arr(parsed.props).map(cleanName).filter((n) => n && !pSeen.has(n) && pSeen.add(n));
  return { characters, scenes, props };
}

// 资产复核（第二遍）：用快速便宜的文字模型（ASSET_VERIFY_MODEL 可覆盖，默认 deepseek-v4-flash，
// 不可用时自动退回主模型）通读剧本，跳过已识别的资产，只找第一遍漏掉的对象。
async function callAssetVerifyLLM({ script, llm, verifyLlm = null, found }) {
  const config = resolveLlmConfig(llm);
  if (!config.apiKey) return null;
  // 用户在设置里指定了复核模型实例 → 完全按该实例调用（baseUrl/Key/模型）。
  const chosen = (verifyLlm && verifyLlm.apiKey) ? resolveLlmConfig(verifyLlm) : null;
  const mkPayload = (model) => {
    const payload = {
      model,
      messages: [
        {
          role: 'system',
          content: `你是剧本资产复核员。已有一份第一遍识别出的美术资产清单，你的唯一任务是通读剧本，找出【第一遍漏掉的】角色、场景、关键道具。
规则：①凡已在清单里的对象（包括同一对象的别名/简称/全称变体）一律跳过，不要重复输出；②只补真正需要制作美术资产的遗漏对象：角色=剧中有戏份的具体人物；场景=故事发生的空间地点；道具=剧情重要、反复出现或有近景特写的物件；③宁缺毋滥，不确定的不补；④没有任何遗漏就输出三个空数组；⑤补充的每个角色都必须给出出镜年龄（age 字段不得留空）：剧本写明的直接采用，未写明的结合身份、称谓、职务、剧情关系推算出具体数字或紧凑区间（如 "28" 或 "25-30"）。
只输出一个 JSON 对象：{"characters":[{"name":"","age":""}],"scenes":[{"name":"","description":""}],"props":[{"name":""}]}，不要解释、不要代码块。`
        },
        { role: 'user', content: `【已识别清单】\n${JSON.stringify(found)}\n\n【剧本】\n${String(script || '').slice(0, 100000)}` }
      ],
      temperature: 0.1,
      max_tokens: Number(process.env.LLM_MAX_TOKENS) || 8000
    };
    if ((process.env.LLM_JSON_MODE || 'true') !== 'false') payload.response_format = { type: 'json_object' };
    return payload;
  };
  let data;
  if (chosen) {
    data = await chatCompletion(chosen, mkPayload(chosen.model));
  } else {
    const verifyModel = process.env.ASSET_VERIFY_MODEL || 'deepseek-v4-flash';
    try {
      data = await chatCompletion(config, mkPayload(verifyModel));
    } catch (error) {
      console.warn(`Verify model ${verifyModel} unavailable (${String(error.message).slice(0, 120)}), retrying with ${config.model}`);
      data = await chatCompletion(config, mkPayload(config.model));
    }
  }
  const content = stripMarkdownFence(extractMessageText(data));
  let parsed;
  try { parsed = parseLlmJson(content); } catch { parsed = {}; }
  return normalizeAnalyzedAssets(parsed);
}

// 为已有角色增补一个造型：复用给定的面部锚点，只改服饰发型，输出单段文生图提示词。
async function callOutfitLLM({ skill, character, anchor, outfit, settings, age, llm }) {
  const config = resolveLlmConfig(llm);
  if (!config.apiKey) return null;
  const style = settings.visualStyle || '';
  const payload = {
    model: config.model,
    messages: [
      {
        role: 'system',
        content: `你是「美术资产提示词生成专家」，为一个已有角色增补一个新造型（换装/换发型/新状态）。硬规则：
① 必须完整沿用给定的【面部锚点】——脸型、骨相、五官结构、核心视觉记忆点与年龄完全一致，只改变服饰、妆发、配饰等造型变量，绝不另起一张脸。
② 比例固定 16:9，「角色设定图」版式：右侧为该造型的角色头部清晰特写，左侧为该造型的全身三视图（正面/侧面/背面），纯白无缝背景，仅呈现角色本体、服装与随身饰品；不写场景、道具、镜头、运镜。
③ 只输出该造型的一段中文文生图提示词正文，不要 JSON、不要标题、不要解释、不要代码块。
④ 中文句末之后原样附加固定英文尾缀【Remove the noise and high-frequency details from the image. Keep all the lines, colors, and brightness unchanged.】。
请遵循下方 SKILL 的风格与质感规范。

【参考 SKILL（美术资产风格规范）】
${String(skill || '').slice(0, 16000)}`
      },
      { role: 'user', content: JSON.stringify({ 角色: character, 出镜年龄: age || '按面部锚点为准', 新造型描述: outfit, 视觉风格: style, 必须沿用的面部锚点: anchor }) }
    ],
    temperature: config.temperature,
    max_tokens: Number(process.env.LLM_MAX_TOKENS) || 4000
  };
  const data = await chatCompletion(config, payload);
  const content = stripMarkdownFence(extractMessageText(data)).trim();
  return { provider: config.providerName, model: config.model, prompt: content };
}

// 从一段 markdown 里按"角色/场景/道具"一级或二级标题分区，重建 modules。
function extractAssetModulesFromMarkdown(md = '') {
  const out = { characters: '', scenes: '', props: '' };
  if (!md) return out;
  let current = '';
  for (const block of md.split(/\n(?=#{1,2}\s)/)) {
    const head = (block.match(/^#{1,2}\s*(.+)/) || [, ''])[1];
    if (/^#{1,2}\s/.test(block)) {
      if (/角色|人物|character/i.test(head)) current = 'characters';
      else if (/场景|scene/i.test(head)) current = 'scenes';
      else if (/道具|prop/i.test(head)) current = 'props';
      // 三级小节（### 资产名）不切换分区，归入当前分区
      else if (!/^###/.test(block)) current = '';
    }
    if (current) out[current] += (out[current] ? '\n\n' : '') + block.trim();
  }
  // 若整段没有任何分区标题，但有 ### 小节，默认全部归到角色，保证至少能显示。
  if (!out.characters && !out.scenes && !out.props && /###\s/.test(md)) {
    out.characters = md.trim();
  }
  return out;
}

// 为角色增补造型：复用面部锚点，返回单段提示词。
app.post('/api/projects/:projectId/assets/outfit', async (req, res, next) => {
  try {
    const project = projects.get(req.params.projectId);
    if (!project) return res.status(404).json({ error: '项目不存在，请重新上传剧本。' });
    const { character = '', anchor = '', outfit = '', settings = {}, llm = {}, age = '', skillTemplateId = 'template-1' } = req.body;
    if (!character || !outfit) return res.status(400).json({ error: '缺少角色或造型描述。' });
    settings.visualStyle = expandStyle(settings.visualStyle);
    const llmConfig = resolveLlmConfig(llm);
    const jobId = createJob();
    res.json({ jobId, status: 'pending' });

    (async () => {
      let usedFallback = false;
      let llmError = llmConfig.apiKey ? null : { code: 'missing_api_key', message: `未填写 ${llmConfig.providerName} 的 API Key。` };
      let result = null;
      try {
        const skill = await readSkill(skillTemplateId);
        result = await callOutfitLLM({ skill: skill.content, character, anchor, outfit, settings, age, llm });
      } catch (error) {
        if (!llmError) llmError = parseLlmError(error.message);
        console.warn(`Outfit LLM failed: ${error.message}`);
      }
      const prompt = (result && result.prompt) || '';
      if (!prompt) usedFallback = true;
      finishJob(jobId, { prompt, usedFallback, provider: llmConfig.providerName, model: llmConfig.model, llmError });
    })().catch((error) => {
      console.error(`Outfit job failed: ${error.message}`);
      failJob(jobId, parseLlmError(error.message));
    });
  } catch (error) {
    next(error);
  }
});

// 智能识别资产：用 LLM 通读剧本，重建 project.bible 的角色/场景/道具清单。
app.post('/api/projects/:projectId/assets/analyze', async (req, res, next) => {
  try {
    const project = projects.get(req.params.projectId);
    if (!project) return res.status(404).json({ error: '项目不存在，请重新上传剧本。' });
    const { llm = {}, verifyLlm = null } = req.body;
    const llmConfig = resolveLlmConfig(llm);
    const jobId = createJob();
    res.json({ jobId, status: 'pending' });

    (async () => {
      let usedFallback = false;
      let llmError = llmConfig.apiKey ? null : {
        code: 'missing_api_key',
        message: `未填写 ${llmConfig.providerName} 的 API Key。请在 LLM 设置面板填写后再智能识别。`
      };
      let result = null;
      try {
        result = await callAssetAnalyzeLLM({ script: project.originalScript, llm });
      } catch (error) {
        if (!llmError) llmError = parseLlmError(error.message);
        console.warn(`Asset analyze fell back: ${error.message}`);
      }
      // 二次复核：单次识别数量有随机性。用便宜快速模型只找"第一遍漏掉的"资产并增补；
      // 直到某一轮零新增（=检验通过，清单完整）或最多补 2 轮，再返回前端。
      if (result) {
        for (let round = 1; round <= 2; round += 1) {
          let extra = null;
          try {
            extra = await callAssetVerifyLLM({
              script: project.originalScript,
              llm,
              verifyLlm,
              found: {
                characters: result.characters.map((c) => c.name),
                scenes: result.scenes.map((s) => s.name),
                props: result.props
              }
            });
          } catch (error) {
            console.warn(`Asset verify round ${round} failed: ${error.message}`);
            break;
          }
          if (!extra) break;
          const has = (names, name) => names.some((n) => normalizeAssetName(n) === normalizeAssetName(name));
          const addC = extra.characters.filter((c) => !has(result.characters.map((x) => x.name), c.name));
          const addS = extra.scenes.filter((s) => !has(result.scenes.map((x) => x.name), s.name));
          const addP = extra.props.filter((p) => !has(result.props, p));
          if (!addC.length && !addS.length && !addP.length) break; // 复核通过：无遗漏
          console.info(`Asset verify round ${round} added c:${addC.length} s:${addS.length} p:${addP.length}`);
          result.characters.push(...addC);
          result.scenes.push(...addS);
          result.props.push(...addP);
        }
      }
      const ages = {};
      if (result && (result.characters.length || result.scenes.length || result.props.length)) {
        // 只替换三类清单，保留 episodeContinuity（剧集生成要用）。
        project.bible.characters = result.characters.map((c) => ({
          name: c.name,
          visual: `${c.name}固定视觉设定：保持同一脸型、发型、服装主色和核心记忆点，跨集不得漂移。`,
          arc: '根据每集结尾情绪和关系变化递进，不跳跃。'
        }));
        result.characters.forEach((c) => { if (c.age) ages[c.name] = c.age; }); // 剧本有年龄就回传，前端自动填入
        project.bible.scenes = result.scenes.map((s) => ({ name: s.name, description: s.description || `${s.name}的空间环境。` }));
        project.bible.props = result.props.map((name) => ({ name, rule: `${name}作为关键道具出现时，材质、磨损、比例和持有关系保持一致。` }));
        await persistProject(project);
      } else {
        usedFallback = true; // LLM 没返回有效清单，保留原规则识别结果
      }
      finishJob(jobId, {
        bible: project.bible,
        ages,
        usedFallback,
        provider: llmConfig.providerName,
        model: llmConfig.model,
        apiKeySource: llmConfig.apiKeySource,
        llmError,
        counts: {
          characters: project.bible.characters.length,
          scenes: project.bible.scenes.length,
          props: project.bible.props.length
        }
      });
    })().catch((error) => {
      console.error(`Analyze job failed: ${error.message}`);
      failJob(jobId, parseLlmError(error.message));
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/projects/:projectId/assets/generate', async (req, res, next) => {
  try {
    const project = projects.get(req.params.projectId);
    if (!project) return res.status(404).json({ error: '项目不存在，请重新上传剧本。' });
    const { assets = {}, settings = {}, llm = {}, skillTemplateId = 'template-1', ages = {}, styleTone = '', characterLook = '', worldview = '' } = req.body;
    settings.visualStyle = expandStyle(settings.visualStyle);
    const total = ['characters', 'scenes', 'props']
      .reduce((n, k) => n + (Array.isArray(assets[k]) ? assets[k].length : 0), 0);
    if (!total) return res.status(400).json({ error: '请至少选择一个美术资产。' });

    const llmConfig = resolveLlmConfig(llm);

    // 立即返回 jobId，后台执行（绕开托管层长请求断连）。
    const jobId = createJob();
    res.json({ jobId, status: 'pending' });

    (async () => {
      const skill = await readSkill(skillTemplateId);
      let usedFallback = false;
      let llmError = llmConfig.apiKey ? null : {
        code: 'missing_api_key',
        message: `未填写 ${llmConfig.providerName} 的 API Key。请在 LLM 设置面板填写后再生成，或先查看本地兜底结果。`
      };
      let output = null;
      if (!llmError) {
        try {
          const { modules, failed, firstError } = await callAssetLLMChunked({
            skill: skill.content, project, assets, settings, llm, ages, styleTone, characterLook, worldview,
            onProgress: (done, totalChunks) => updateJob(jobId, { progress: { done, total: totalChunks } })
          });
          if (failed.length >= total) throw (firstError || new Error('模型未返回可用内容'));
          output = { mode: 'llm', modules, markdown: composeAssetMarkdown(modules) };
          if (failed.length && firstError) {
            llmError = {
              code: 'partial_fallback',
              message: `${failed.length}/${total} 个资产模型调用失败（${parseLlmError(firstError.message).message || firstError.message}），已用本地模板兜底：${failed.join('、')}。可对这些资产单独点「重新生成」。`
            };
          }
        } catch (error) {
          llmError = parseLlmError(error.message);
          console.warn(`Asset LLM fell back: ${error.message}`);
        }
      }
      if (!output) { usedFallback = true; output = fallbackAssetPrompts({ project, assets, settings, ages, styleTone }); }
      output.items = buildAssetItems(assets, output.modules);
      // 名字级兜底：某批成功但模型小节标题对不上资产名时，提取为空会显示"未生成"。
      // 这里逐个补上本地模板，并如实计入部分失败提示。
      const missing = output.items.filter((it) => !String(it.prompt || '').trim());
      if (missing.length) {
        for (const it of missing) {
          const fb = fallbackAssetPrompts({ project, assets: { characters: [], scenes: [], props: [], [it.type]: [it.name] }, settings, ages, styleTone });
          it.prompt = String(fb.modules[it.type] || '').replace(/^###[^\n]*\n?/, '').trim();
          if (!it.prompt) {
            const kind = it.type === 'characters' ? '角色设定图（右侧头部特写 + 左侧全身三视图），纯白无缝背景' : it.type === 'scenes' ? '无人空镜场景设定图' : '道具设定图，白底或中性背景，仅呈现单一道具';
            it.prompt = `比例 ${it.type === 'props' ? '1:1' : '16:9'}，${settings.visualStyle || '写实电影感'}，${kind}：${it.name}。高清细节，材质真实，画面干净。`;
          }
        }
        if (!usedFallback) {
          const msg = `${missing.length} 个资产未能从模型输出中匹配到内容，已用本地模板兜底：${missing.map((it) => it.name).join('、')}。可对它们单独点「重新生成」。`;
          llmError = llmError ? { ...llmError, message: `${llmError.message} 另有 ${msg}` } : { code: 'partial_fallback', message: msg };
        }
      }
      // 持久化生成结果：轮询中断（刷新/网络/实例重启）后重开项目仍能看到已生成的提示词。
      try {
        project.assetItems = {
          ...(project.assetItems || {}),
          ...Object.fromEntries(output.items.map((it) => [`${it.type}|${it.name}`, it.prompt]))
        };
        await persistProject(project);
      } catch (persistError) {
        console.warn(`Persist asset items failed: ${persistError.message}`);
      }

      finishJob(jobId, {
        output,
        usedFallback,
        provider: llmConfig.providerName,
        model: llmConfig.model,
        apiKeySource: llmConfig.apiKeySource,
        apiKeyHint: llmConfig.apiKeyHint,
        llmError,
        counts: { characters: (assets.characters || []).length, scenes: (assets.scenes || []).length, props: (assets.props || []).length }
      });
    })().catch((error) => {
      console.error(`Asset job failed: ${error.message}`);
      failJob(jobId, parseLlmError(error.message));
    });
  } catch (error) {
    next(error);
  }
});

// ===== 剧本构建工坊：生成 / 小说转 / 优化 =====
app.post('/api/script/build', async (req, res, next) => {
  try {
    const { mode = 'generate', input = '', settings = {}, llm = {}, skillTemplateId } = req.body;
    if (!String(input || '').trim()) return res.status(400).json({ error: '请先填写创意 / 小说 / 粗剧本内容。' });
    const defaultSkill = mode === 'novel' ? 'script-novel' : mode === 'optimize' ? 'script-optimize' : 'script-generate';
    const sid = skillTemplateId || defaultSkill;
    const llmConfig = resolveLlmConfig(llm);
    const jobId = createJob();
    res.json({ jobId, status: 'pending' });

    (async () => {
      const skill = await readSkill(sid);
      let usedFallback = false;
      let llmError = llmConfig.apiKey ? null : {
        code: 'missing_api_key',
        message: `未填写 ${llmConfig.providerName} 的 API Key。请在 LLM 设置面板填写后再生成。`
      };
      let output = null;
      try {
        output = await callScriptLLM({ skill: skill.content, mode, input, settings, llm });
      } catch (error) {
        if (!llmError) llmError = parseLlmError(error.message);
        console.warn(`Script build fell back: ${error.message}`);
      }
      if (!output) {
        usedFallback = true;
        output = { plan: '', markdown: `# 剧本构建未完成\n\n模型未能生成剧本（${llmError?.message || '未知错误'}）。请检查 LLM 设置或换个稳定的模型后重试。\n\n---\n你的原始输入：\n\n${String(input).slice(0, 4000)}` };
      }
      finishJob(jobId, {
        markdown: output.markdown,
        plan: output.plan || '',
        usedFallback,
        provider: llmConfig.providerName,
        model: llmConfig.model,
        apiKeySource: llmConfig.apiKeySource,
        llmError,
        skillTemplate: { id: skill.template.id, name: skill.template.name }
      });
    })().catch((error) => {
      console.error(`Script job failed: ${error.message}`);
      failJob(jobId, parseLlmError(error.message));
    });
  } catch (error) {
    next(error);
  }
});

// 参考图 → Blob（data URL 解码 / http 下载）。
async function refImageToBlob(ref) {
  if (String(ref).startsWith('data:')) {
    const b64 = String(ref).split(',')[1] || '';
    return new Blob([Buffer.from(b64, 'base64')], { type: 'image/png' });
  }
  const r = await fetch(ref);
  const ab = await r.arrayBuffer();
  return new Blob([Buffer.from(ab)], { type: r.headers.get('content-type') || 'image/png' });
}

// 用项目选定的「图像模型实例」出图（异步任务，绕开免费层长请求断连）。
// 有参考图（基准脸）→ /images/edits（保持同脸）；否则 → /images/generations。
app.post('/api/generate-image', async (req, res, next) => {
  try {
    const { prompt = '', image = {}, size = '1024x1024', referenceImage = '' } = req.body || {};
    if (!String(prompt).trim()) return res.status(400).json({ error: '缺少图像提示词。' });
    const baseUrl = normalizeBaseUrl(image.baseUrl || '');
    if (!baseUrl || !image.apiKey || !image.model) {
      return res.status(400).json({ error: '未配置图像模型实例（需 Base URL / 模型 ID / API Key）。请在右上角「模型设置」的图像生成模型里添加。' });
    }
    const jobId = createJob();
    res.json({ jobId, status: 'pending' });

    (async () => {
      const timeoutMs = Number(process.env.IMAGE_TIMEOUT_MS) || 180000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let r;
        if (referenceImage) {
          const form = new FormData();
          form.append('image', await refImageToBlob(referenceImage), 'reference.png');
          form.append('model', image.model);
          form.append('prompt', String(prompt).slice(0, 4000));
          form.append('n', '1');
          form.append('size', size);
          r = await longFetch(`${baseUrl}/images/edits`, {
            method: 'POST', headers: { Authorization: `Bearer ${image.apiKey}` }, body: form, signal: controller.signal
          });
        } else {
          r = await longFetch(`${baseUrl}/images/generations`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${image.apiKey}` },
            body: JSON.stringify({ model: image.model, prompt: String(prompt).slice(0, 4000), n: 1, size }), signal: controller.signal
          });
        }
        if (!r.ok) { const t = await r.text(); finishJob(jobId, { error: `图像生成失败：${t.slice(0, 400)}` }); return; }
        const data = await r.json();
        const item = (Array.isArray(data?.data) ? data.data[0] : data?.data) || {};
        const url = item.url || (item.b64_json ? `data:image/png;base64,${item.b64_json}` : '');
        if (!url) { finishJob(jobId, { error: '图像生成返回为空（该模型可能不兼容该接口，可换一个图像模型实例）。' }); return; }
        finishJob(jobId, { url });
      } catch (error) {
        finishJob(jobId, { error: error.name === 'AbortError' ? `图像生成超时（>${timeoutMs}ms）` : withCause(error) });
      } finally { clearTimeout(timer); }
    })().catch((error) => failJob(jobId, { message: error.message }));
  } catch (error) { next(error); }
});

// 取图像字节：支持 data: URL 与 http(s) URL。
async function imageToBuffer(url) {
  if (String(url).startsWith('data:')) {
    const b64 = String(url).split(',')[1] || '';
    return { buf: Buffer.from(b64, 'base64'), ext: 'png' };
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`下载失败 ${r.status}`);
  const ab = await r.arrayBuffer();
  const ct = r.headers.get('content-type') || '';
  const ext = ct.includes('jpeg') || ct.includes('jpg') ? 'jpg' : ct.includes('webp') ? 'webp' : 'png';
  return { buf: Buffer.from(ab), ext };
}

function safeName(s) {
  return String(s || '未命名').replace(/[\\/:*?"<>|\n\r\t]+/g, '_').replace(/\s+/g, '').slice(0, 60) || '未命名';
}

// 单张下载：后端代理取图并带上文件名（解决跨域 + 命名）。
app.get('/api/download-image', async (req, res, next) => {
  try {
    const url = String(req.query.url || '');
    const name = safeName(req.query.name || '图片');
    if (!url) return res.status(400).send('缺少 url');
    const { buf, ext } = await imageToBuffer(url);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name + '.' + ext)}`);
    res.send(buf);
  } catch (error) { next(error); }
});

// 打包下载：body.items = [{ group:'角色'|'场景'|'道具', character, outfit, name, url }]
// ZIP 内三个文件夹 角色/场景/道具；角色下每人一个以名字命名的子文件夹，放其全部造型。
app.post('/api/download-assets', async (req, res, next) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: '没有可打包的图片。' });
    const zip = new JSZip();
    const roots = { characters: '角色', scenes: '场景', props: '道具' };
    for (const it of items) {
      if (!it || !it.url) continue;
      let buf, ext;
      try { ({ buf, ext } = await imageToBuffer(it.url)); } catch { continue; }
      const root = roots[it.group] || roots[it.type] || '角色';
      let filePath;
      if (root === '角色') {
        const person = safeName(it.character || it.name);
        const fname = safeName(`${person}_${it.outfit || '默认'}`);
        filePath = `角色/${person}/${fname}.${ext}`;
      } else {
        filePath = `${root}/${safeName(it.name)}.${ext}`;
      }
      zip.file(filePath, buf);
    }
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const zipName = safeName(req.body?.zipName || '资产图片') + '.zip';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`);
    res.send(buffer);
  } catch (error) { next(error); }
});

app.post('/api/export', async (req, res, next) => {
  try {
    const { format = 'md', title = '视频提示词', markdown = '' } = req.body;
    if (!markdown) return res.status(400).json({ error: '没有可导出的内容。' });
    const url = await saveExport(format, markdown, title);
    res.json({ url });
  } catch (error) {
    next(error);
  }
});

// ===== 生产模式：同源托管打包后的前端 dist/ =====
const distDir = path.resolve(rootDir, 'dist');
if (process.env.NODE_ENV === 'production') {
  try {
    await fs.access(path.join(distDir, 'index.html'));
    app.use(express.static(distDir));
    // SPA fallback：非 /api、非 /exports 的 GET 一律返回 index.html
    app.get(/^(?!\/api|\/exports).*/, (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
    console.log('Serving built frontend from ./dist');
  } catch {
    console.warn('NODE_ENV=production 但未找到 dist/index.html，请先运行 npm run build。仅提供 API。');
  }
}

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: error.message || '服务器内部错误' });
});

// 服务端口
const port = Number(process.env.PORT || 5174);
const host = process.env.HOST || '0.0.0.0';
await loadPersistedProjects();
app.listen(port, host, () => {
  console.log(`AI manga agent running at http://${host}:${port}`);
});
