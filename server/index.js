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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const outDir = path.resolve(rootDir, 'exports');
const dataDir = path.resolve(rootDir, 'data', 'projects');
const defaultSkillPath = path.resolve(rootDir, 'skills', 'template-1-video-prompt-industrial-skill-v1.9.3.md');
const skillUploadDir = path.resolve(rootDir, 'skill-templates');
const verticalRealPersonSkillPath = path.resolve(rootDir, 'skills', 'template-2-vertical-real-person-prompt.txt');
const assetSkillPath = path.resolve(rootDir, 'skills', 'template-asset-art-asset-prompt.md');

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
    kind: 'video'
  },
  {
    id: 'asset-default',
    name: '美术资产 SKILL',
    description: 'AI 漫剧美术资产提示词（默认，可上传替换）',
    path: assetSkillPath,
    source: 'built-in',
    kind: 'asset'
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
  try {
    const files = await fs.readdir(dataDir);
    let loaded = 0;
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
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
    summary: summarizeText(script, 110),
    opening: summarizeText(lines.slice(0, 6).join(' '), 80),
    ending: summarizeText(lines.slice(-6).join(' '), 80),
    firstScene: firstScene || '未明确场景'
  };
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
async function chatCompletion(config, payload, { retriedWithoutJsonMode = false } = {}) {
  const timeoutMs = Number(process.env.LLM_TIMEOUT_MS) || 60000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`LLM request timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const errText = await response.text();
    // 部分供应商不认 response_format，报 400；去掉它重试一次。
    if (!retriedWithoutJsonMode && response.status === 400 && payload.response_format && /response_format|json_object|not support/i.test(errText)) {
      const { response_format, ...rest } = payload;
      return chatCompletion(config, rest, { retriedWithoutJsonMode: true });
    }
    throw new Error(`LLM request failed: ${errText}`);
  }
  return response.json();
}

async function callLLM({ skill, project, episode, settings, llm }) {
  const config = resolveLlmConfig(llm);
  if (!config.apiKey) return null;
  console.info(`Calling ${config.providerName} ${config.model} with key ${config.apiKeySource} ${config.apiKeyHint}`);

  const continuity = project.bible.episodeContinuity.find((item) => item.episodeId === episode.id);
  const payload = {
    model: config.model,
    messages: [
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
    max_tokens: Number(process.env.LLM_MAX_TOKENS) || 8000
  };
  // JSON 模式：OpenAI/DeepSeek 支持；不支持的供应商会在 chatCompletion 内自动重试去掉。
  if ((process.env.LLM_JSON_MODE || 'true') !== 'false') {
    payload.response_format = { type: 'json_object' };
  }

  const data = await chatCompletion(config, payload);
  const content = stripMarkdownFence(data.choices?.[0]?.message?.content || '');
  let parsed;
  try {
    parsed = parseLlmJson(content);
  } catch (error) {
    console.warn(`LLM JSON parse failed for ${episode.title}; using raw markdown. ${error.message}`);
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
      kind: (normalizeText(req.body.kind || '') === 'video') ? 'video' : 'asset'
    };
    userSkillTemplates.set(id, template);
    res.json({ template: listSkillTemplates().find((item) => item.id === id) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/projects/parse', upload.single('scriptFile'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const uploaded = req.file ? await extractUploadedText(req.file) : '';
    const script = normalizeText(uploaded || body.script || '');
    if (!script) return res.status(400).json({ error: '请粘贴剧本或上传 TXT/DOCX 文件。' });

    const episodes = splitEpisodes(script);
    const project = {
      id: uid('project'),
      name: req.body.name || '未命名漫剧项目',
      originalScript: script,
      episodes,
      bible: buildBible(episodes),
      outputs: {}
    };
    projects.set(project.id, project);
    await persistProject(project);
    res.json({ project });
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
        llmOutput = await callLLM({ skill: skill.content, project, episode, settings, llm });
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

    res.json({
      outputs,
      llmConfigured: Boolean(llmConfig.apiKey),
      provider: llmConfig.providerName,
      model: llmConfig.model,
      apiKeySource: llmConfig.apiKeySource,
      apiKeyHint: llmConfig.apiKeyHint,
      usedFallback,
      llmError,
      skillTemplate: {
        id: skill.template.id,
        name: skill.template.name
      }
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

// 为每个被选中的资产输出一条 {type, name, prompt}
function buildAssetItems(assets, modules) {
  const maps = {
    characters: splitAssetSections(modules.characters),
    scenes: splitAssetSections(modules.scenes),
    props: splitAssetSections(modules.props)
  };
  const items = [];
  for (const type of ['characters', 'scenes', 'props']) {
    for (const name of (Array.isArray(assets[type]) ? assets[type] : [])) {
      items.push({ type, name, prompt: maps[type][name] || '' });
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
  // 角色/场景固定 21:9，道具固定 16:9（依美术资产 SKILL）
  const characters = cs.map((c) => {
    const age = ages[c.name] ? `出镜年龄 ${ages[c.name]}，` : '';
    return `### ${c.name}\n比例 21:9，${style}，角色设定图（右侧头部特写 + 左侧全身三视图），纯白无缝背景，仅呈现角色本体、服装与随身饰品；${age}${c.visual} 表情自然，真实皮肤质感，柔焦边缘，克制细节。`;
  }).join('\n\n');
  const scenes = ss.map((s) => `### ${s.name}\n比例 21:9，${style}，${tone}无人空镜场景设定图，仅呈现空间结构、固定陈设和环境质感：${s.description} 明确空间结构、主光位置、色温与关键陈设，画面中无人物。`).join('\n\n');
  const props = ps.map((p) => `### ${p.name}\n比例 16:9，${style}，道具设定图，白底或中性背景，仅呈现单一道具：${p.rule} 材质统一干净，边缘柔和且形体清楚，保留必要结构细节。`).join('\n\n');
  const modules = { characters, scenes, props };
  return { mode: 'fallback', modules, markdown: composeAssetMarkdown(modules) };
}

async function callAssetLLM({ skill, project, assets, settings, llm, ages = {}, styleTone = '' }) {
  const config = resolveLlmConfig(llm);
  if (!config.apiKey) return null;
  const payload = {
    model: config.model,
    messages: [
      {
        role: 'system',
        content: `你是「美术资产提示词生成专家」，为短剧/漫剧生成可直接用于 AI 绘画（文生图）的中文资产提示词。
硬规则：①只为 user 给出的"被选中资产"生成，不要新增；②每个资产一个 ### 小节；③角色与场景比例固定 21:9、道具固定 16:9；④角色提示词只写人物本体（纯白无缝背景，仅呈现角色本体/服装/随身饰品），不写场景、道具、镜头；场景为无人空镜，道具为白底特写；⑤角色年龄一律采用 user 提供的 confirmedAges（出镜年龄），不使用剧本推理年龄；⑥参考风格基调 styleTone 只用于场景，不污染角色与道具；⑦只输出一个 JSON 对象，键为 modules{characters,scenes,props} 与 markdown，不要代码块、不要解释。严格遵循下方 SKILL。

【参考 SKILL（美术资产风格规范）】
${skill.slice(0, 24000)}`
      },
      {
        role: 'user',
        content: JSON.stringify({ task: '仅为下列被选中的美术资产生成文生图提示词', selectedAssets: assets, settings, confirmedAges: ages, styleTone, globalBible: project.bible })
      }
    ],
    temperature: config.temperature,
    max_tokens: Number(process.env.LLM_MAX_TOKENS) || 8000
  };
  if ((process.env.LLM_JSON_MODE || 'true') !== 'false') payload.response_format = { type: 'json_object' };
  const data = await chatCompletion(config, payload);
  const content = stripMarkdownFence(data.choices?.[0]?.message?.content || '');
  let parsed;
  try { parsed = parseLlmJson(content); } catch { parsed = { modules: {}, markdown: content }; }
  const modules = {
    characters: String(parsed.modules?.characters || ''),
    scenes: String(parsed.modules?.scenes || ''),
    props: String(parsed.modules?.props || '')
  };
  const markdown = String(parsed.markdown || composeAssetMarkdown(modules));
  return { mode: 'llm', provider: config.providerName, model: config.model, modules, markdown };
}

app.post('/api/projects/:projectId/assets/generate', async (req, res, next) => {
  try {
    const project = projects.get(req.params.projectId);
    if (!project) return res.status(404).json({ error: '项目不存在，请重新上传剧本。' });
    const { assets = {}, settings = {}, llm = {}, skillTemplateId = 'template-1', ages = {}, styleTone = '' } = req.body;
    settings.visualStyle = expandStyle(settings.visualStyle);
    const total = ['characters', 'scenes', 'props']
      .reduce((n, k) => n + (Array.isArray(assets[k]) ? assets[k].length : 0), 0);
    if (!total) return res.status(400).json({ error: '请至少选择一个美术资产。' });

    const llmConfig = resolveLlmConfig(llm);
    const skill = await readSkill(skillTemplateId);
    let usedFallback = false;
    let llmError = llmConfig.apiKey ? null : {
      code: 'missing_api_key',
      message: `未填写 ${llmConfig.providerName} 的 API Key。请在 LLM 设置面板填写后再生成，或先查看本地兜底结果。`
    };
    let output = null;
    try {
      output = await callAssetLLM({ skill: skill.content, project, assets, settings, llm, ages, styleTone });
    } catch (error) {
      if (!llmError) llmError = parseLlmError(error.message);
      console.warn(`Asset LLM fell back: ${error.message}`);
    }
    if (!output) { usedFallback = true; output = fallbackAssetPrompts({ project, assets, settings, ages, styleTone }); }
    output.items = buildAssetItems(assets, output.modules);

    res.json({
      output,
      usedFallback,
      provider: llmConfig.providerName,
      model: llmConfig.model,
      apiKeySource: llmConfig.apiKeySource,
      apiKeyHint: llmConfig.apiKeyHint,
      llmError,
      counts: { characters: (assets.characters || []).length, scenes: (assets.scenes || []).length, props: (assets.props || []).length }
    });
  } catch (error) {
    next(error);
  }
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
