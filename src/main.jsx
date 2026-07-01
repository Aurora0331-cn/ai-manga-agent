import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Box, CheckSquare, Copy, Download, FileText, Layers, MapPin, Moon, Play, RefreshCw, Sparkles, Square, Sun, Upload, Users, X } from 'lucide-react';
import './styles.css';

const DEV = typeof location !== 'undefined' && location.port === '5173';
const API = DEV ? 'http://127.0.0.1:5174/api' : '/api';
const FILE_ORIGIN = DEV ? 'http://127.0.0.1:5174' : '';
const LLM_STORAGE_KEY = 'ai-manga-agent.llm';
const THEME_KEY = 'ai-manga-agent.theme';

const defaultLlm = {
  providerId: 'openai',
  model: 'gpt-4o-mini',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  temperature: 0.4
};

function loadStoredLlm() {
  try {
    const raw = localStorage.getItem(LLM_STORAGE_KEY);
    if (!raw) return null;
    return { ...defaultLlm, ...JSON.parse(raw) };
  } catch { return null; }
}

function loadTheme() {
  try { return localStorage.getItem(THEME_KEY) || 'light'; } catch { return 'light'; }
}

const DOCK_KEY = 'ai-manga-agent.dock';
function loadDockPos() {
  try { const raw = localStorage.getItem(DOCK_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}

const ASSET_GROUPS = [
  { key: 'characters', label: '角色', icon: Users },
  { key: 'scenes', label: '场景', icon: MapPin },
  { key: 'props', label: '道具', icon: Box }
];

// 视觉风格名（仅展示名字；后端按名字展开为完整风格提示词执行）
const STYLE_NAMES = [
  '高清实拍真人风格', '电影大片风格', '赛博朋克风格', '暗黑哥特风格',
  '日漫风格', '新海诚风格', '国风水墨风格', '游戏原画风格', '皮克斯风格'
];

function App() {
  const [script, setScript] = useState(sampleScript);
  const [file, setFile] = useState(null);
  const [project, setProject] = useState(null);
  const [theme, setTheme] = useState(loadTheme);
  const [loading, setLoading] = useState('');
  const [notice, setNotice] = useState('');
  // 提示消息 3 秒后自动消失
  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(''), 3000);
    return () => clearTimeout(timer);
  }, [notice]);
  const [showModelSettings, setShowModelSettings] = useState(false);
  const [dockPos, setDockPos] = useState(loadDockPos);
  const [providers, setProviders] = useState([]);
  const [skillTemplates, setSkillTemplates] = useState([]);
  const [videoSkillId, setVideoSkillId] = useState('template-1');
  const [assetSkillId, setAssetSkillId] = useState('asset-default');
  const storedLlmRef = React.useRef(loadStoredLlm());
  const [llm, setLlm] = useState(() => storedLlmRef.current || defaultLlm);
  const [availableModels, setAvailableModels] = useState(null);
  const [settings, setSettings] = useState({
    aspectRatio: '9:16',
    visualStyle: '高清实拍真人风格',
    dramaIntensity: '中等情绪'
  });

  // 二级弹窗
  const [scriptModal, setScriptModal] = useState(false);
  const [scriptMode, setScriptMode] = useState('generate'); // generate | novel | optimize
  const [scriptInput, setScriptInput] = useState('');
  const [scriptOutput, setScriptOutput] = useState('');
  const [scriptPlan, setScriptPlan] = useState('');
  const [showPlan, setShowPlan] = useState(true);
  const [scriptSkillId, setScriptSkillId] = useState('');

  // 三步流程：1 剧本构造 → 2 资产构成 → 3 分镜提示词
  const [step, setStep] = useState(1);
  const [scriptConfirmed, setScriptConfirmed] = useState(false);
  const [assetsConfirmed, setAssetsConfirmed] = useState(false);

  // 美术资产
  const [assetSel, setAssetSel] = useState({ characters: [], scenes: [], props: [] });
  const [assetCat, setAssetCat] = useState('characters');
  const [assetItems, setAssetItems] = useState({}); // key `${type}|${name}` -> prompt
  const [assetView, setAssetView] = useState(null); // {type, name}
  const [assetAges, setAssetAges] = useState({}); // 角色名 -> 出镜年龄
  const [newAssetName, setNewAssetName] = useState(''); // 手动添加资产输入
  const [outfitInput, setOutfitInput] = useState(''); // 添加造型描述输入
  const [styleTone, setStyleTone] = useState(''); // 参考风格基调（仅用于场景）

  // 剧集提示词
  const [selectedIds, setSelectedIds] = useState([]);
  const [outputs, setOutputs] = useState([]);
  const [activeEpisodeId, setActiveEpisodeId] = useState(null);
  const [copyIds, setCopyIds] = useState([]);
  const [focusedEpisodeId, setFocusedEpisodeId] = useState(null); // 右上「剧本原文」展示哪一集
  const [expandedEp, setExpandedEp] = useState({}); // 剧集是否展开显示场次
  const [focusedScene, setFocusedScene] = useState(null); // { episodeId, sceneId }
  const [sceneOutputs, setSceneOutputs] = useState({}); // sceneId -> 分镜 markdown

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
  }, [theme]);

  useEffect(() => {
    try { if (dockPos) localStorage.setItem(DOCK_KEY, JSON.stringify(dockPos)); } catch { /* ignore */ }
  }, [dockPos]);

  function onDockDown(e) {
    const dock = e.currentTarget.closest('.model-dock');
    const r = dock.getBoundingClientRect();
    const start = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false };
    const move = (ev) => {
      const dx = ev.clientX - start.sx, dy = ev.clientY - start.sy;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) start.moved = true;
      if (start.moved) {
        const x = Math.max(8, Math.min(window.innerWidth - 72, start.ox + dx));
        const y = Math.max(8, Math.min(window.innerHeight - 72, start.oy + dy));
        setDockPos({ x, y });
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (!start.moved) setShowModelSettings((v) => !v);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  useEffect(() => {
    try { localStorage.setItem(LLM_STORAGE_KEY, JSON.stringify(llm)); } catch { /* ignore */ }
  }, [llm]);

  useEffect(() => {
    fetch(`${API}/llm/providers`).then(readJson).then((data) => {
      const nextProviders = data.providers || [];
      setProviders(nextProviders);
      if (storedLlmRef.current) return;
      const provider = nextProviders.find((item) => item.id === data.defaults?.providerId) || nextProviders[0];
      if (provider) {
        setLlm((current) => ({
          ...current,
          providerId: provider.id,
          model: data.defaults?.model || provider.models?.[0] || current.model,
          baseUrl: data.defaults?.baseUrl || provider.baseUrl || current.baseUrl
        }));
      }
    }).catch(() => {});
    loadSkillTemplates();
  }, []);

  const selectedProvider = useMemo(() => providers.find((p) => p.id === llm.providerId), [providers, llm.providerId]);

  const modelOptions = useMemo(() => {
    // 该供应商的可用模型（连接测试拿到的真实列表优先，否则用预置列表）。
    // 不强行把当前 llm.model 塞进来：当它不在列表里时，ModelField 会切换到“自定义模型”输入。
    return availableModels && availableModels.length
      ? availableModels
      : (selectedProvider?.models || []);
  }, [availableModels, selectedProvider]);

  const selectedOutput = useMemo(() => outputs.find((o) => o.episodeId === activeEpisodeId) || outputs[0], [outputs, activeEpisodeId]);
  const focusedEpisode = useMemo(() => (project?.episodes || []).find((e) => e.id === focusedEpisodeId) || null, [project, focusedEpisodeId]);

  async function loadSkillTemplates() {
    try {
      const data = await readJson(await fetch(`${API}/skill-templates`));
      setSkillTemplates(data.templates || []);
    } catch { setSkillTemplates([]); }
  }

  async function readJsonSafe(res) { return readJson(res); }

  async function copyText(text, label) {
    if (!text) return;
    try { await navigator.clipboard.writeText(text); setNotice(label || '已复制。'); }
    catch { setNotice('当前环境不支持自动复制，请手动选择文本。'); }
  }

  async function exportDoc(format, title, markdown) {
    if (!markdown) return;
    setLoading(`export-${format}`);
    try {
      const res = await fetch(`${API}/export`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format, title, markdown })
      });
      const data = await readJsonSafe(res);
      window.open(`${FILE_ORIGIN}${data.url}`, '_blank');
      setNotice(`已导出 ${format.toUpperCase()} 文件。`);
    } catch (error) { setNotice(error.message); } finally { setLoading(''); }
  }

  async function buildScript() {
    const inputText = scriptInput.trim();
    if (!inputText) { setNotice('请先填写内容（创意 / 小说 / 粗剧本）。'); return; }
    const defSkill = scriptMode === 'novel' ? 'script-novel' : scriptMode === 'optimize' ? 'script-optimize' : 'script-generate';
    setLoading('script'); setScriptOutput(''); setScriptPlan('');
    try {
      const data = await runJob(`${API}/script/build`,
        { mode: scriptMode, input: inputText, settings, llm, skillTemplateId: scriptSkillId || defSkill });
      setScriptOutput(data.markdown || '');
      setScriptPlan(data.plan || '');
      setShowPlan(true);
      setNotice(data.usedFallback ? `${mapLlmError(data.llmError)}，剧本未生成完整。` : `已用 ${data.provider} / ${data.model} 生成剧本。`);
    } catch (error) { setNotice(error.message); } finally { setLoading(''); }
  }

  async function testConnection() {
    setLoading('llm-test');
    try {
      const res = await fetch(`${API}/llm/test`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ llm })
      });
      const data = await readJson(res);
      if (data.ok) {
        setAvailableModels(data.models || []);
        const keyInfo = data.apiKeySource ? `（Key来源：${data.apiKeySource}${data.apiKeyHint ? ` ${data.apiKeyHint}` : ''}）` : '';
        setNotice(`${data.message}${keyInfo}`);
      } else {
        setAvailableModels(null);
        setNotice(`连接测试失败：${data.error?.message || data.message || '未知错误'}`);
      }
    } catch (error) { setNotice(error.message); } finally { setLoading(''); }
  }

  async function parseProject() {
    setLoading('parse');
    setNotice('');
    try {
      const form = new FormData();
      // txt/md 已读入文本框（可编辑），用文本框内容解析；docx 交后端提取。
      const ext = file ? (file.name.toLowerCase().split('.').pop() || '') : '';
      if (file && ext !== 'txt' && ext !== 'md') form.append('scriptFile', file);
      form.append('script', script);
      form.append('name', 'AI 漫剧项目');
      const res = await fetch(`${API}/projects/parse`, { method: 'POST', body: form });
      const data = await readJson(res);
      const p = data.project;
      setProject(p);
      setSelectedIds(p.episodes.map((ep) => ep.id));
      setAssetSel({
        characters: p.bible.characters.map((c) => c.name),
        scenes: p.bible.scenes.map((s) => s.name),
        props: p.bible.props.map((pr) => pr.name)
      });
      setAssetItems({});
      setScriptConfirmed(false);
      setAssetsConfirmed(false);
      setStep(1);
      setAssetView(null);
      setAssetCat('characters');
      setAssetAges({});
      setOutputs([]);
      setCopyIds([]);
      setActiveEpisodeId(p.episodes[0]?.id || null);
      const b = p.bible;
      setNotice(`已解析 ${p.episodes.length} 集，提取到 角色 ${b.characters.length} · 场景 ${b.scenes.length} · 道具 ${b.props.length}。`);
    } catch (error) { setNotice(error.message); } finally { setLoading(''); }
  }

  // ===== 美术资产 =====
  function bibleNames(key) {
    if (!project) return [];
    if (key === 'characters') return project.bible.characters.map((c) => c.name);
    if (key === 'scenes') return project.bible.scenes.map((s) => s.name);
    return project.bible.props.map((p) => p.name);
  }
  function toggleAsset(key, name) {
    setAssetSel((sel) => {
      const arr = sel[key] || [];
      return { ...sel, [key]: arr.includes(name) ? arr.filter((x) => x !== name) : [...arr, name] };
    });
  }
  function toggleAssetGroup(key) {
    setAssetSel((sel) => {
      const all = bibleNames(key);
      const arr = sel[key] || [];
      return { ...sel, [key]: arr.length === all.length ? [] : all };
    });
  }
  const assetTotal = (assetSel.characters.length + assetSel.scenes.length + assetSel.props.length);
  const assetKey = (type, name) => `${type}|${name}`;
  function mergeAssetItems(items) {
    setAssetItems((prev) => {
      const next = { ...prev };
      (items || []).forEach((it) => { next[assetKey(it.type, it.name)] = it.prompt || ''; });
      return next;
    });
  }

  async function callAssetGen(assets) {
    return runJob(`${API}/projects/${project.id}/assets/generate`,
      { assets, settings, llm, skillTemplateId: assetSkillId, ages: assetAges, styleTone });
  }

  async function generateAssets() {
    if (!project || assetTotal === 0) return;
    setLoading('assets');
    setNotice('');
    try {
      const data = await callAssetGen(assetSel);
      mergeAssetItems(data.output?.items);
      setNotice(data.usedFallback
        ? `美术资产：${mapLlmError(data.llmError)}，已用本地兜底生成。`
        : `已用 ${data.provider} / ${data.model} 生成 ${data.output?.items?.length || 0} 个资产提示词。`);
    } catch (error) { setNotice(error.message); } finally { setLoading(''); }
  }

  // 用 LLM 通读剧本，重新智能识别真实的角色/场景/道具，替换规则识别结果。
  async function analyzeAssets() {
    if (!project) return;
    setLoading('asset-analyze');
    setNotice('');
    try {
      const data = await runJob(`${API}/projects/${project.id}/assets/analyze`, { llm });
      if (data.usedFallback || !data.bible) {
        setNotice(`智能识别失败：${mapLlmError(data.llmError)}。已保留原识别结果。`);
        return;
      }
      setProject((p) => ({ ...p, bible: data.bible }));
      // 清空旧的选择与已生成内容（清单已变）
      setAssetSel({ characters: [], scenes: [], props: [] });
      setAssetItems({});
      setAssetAges(data.ages || {}); // 剧本有年龄则自动填入年龄确认表
      setAssetView(null);
      const c = data.counts || {};
      setNotice(`已用 ${data.provider} / ${data.model} 重新识别：角色 ${c.characters} · 场景 ${c.scenes} · 道具 ${c.props}。`);
    } catch (error) { setNotice(error.message); } finally { setLoading(''); }
  }

  // 手动添加一个资产到当前分类（角色添加后年龄确认表会自动多出一行）。
  function addAsset() {
    const name = newAssetName.trim();
    if (!project || !name) return;
    if (bibleNames(assetCat).includes(name)) { setNewAssetName(''); return; }
    setProject((p) => {
      const bible = { ...p.bible };
      if (assetCat === 'characters') {
        bible.characters = [...bible.characters, { name, visual: `${name}固定视觉设定：保持同一脸型、发型、服装主色和核心记忆点，跨集不得漂移。`, arc: '根据每集结尾情绪和关系变化递进，不跳跃。' }];
      } else if (assetCat === 'scenes') {
        bible.scenes = [...bible.scenes, { name, description: `${name}的空间环境。` }];
      } else {
        bible.props = [...bible.props, { name, rule: `${name}作为关键道具出现时，材质、磨损、比例和持有关系保持一致。` }];
      }
      return { ...p, bible };
    });
    setNewAssetName('');
  }

  // 为当前角色增补一个造型：复用已生成的面部锚点，只换服饰发型，面部五官保持一致。
  async function addOutfit() {
    const desc = outfitInput.trim();
    if (!project || !assetView || assetView.type !== 'characters' || !desc) return;
    const name = assetView.name;
    const { anchor } = parseCharacterOutfits(assetItems[assetKey('characters', name)] || '');
    if (!anchor) { setNotice('请先点「生成此项」生成该角色，得到面部锚点后再添加造型。'); return; }
    setLoading('outfit');
    setNotice('');
    try {
      const data = await runJob(`${API}/projects/${project.id}/assets/outfit`,
        { character: name, anchor, outfit: desc, settings, llm, age: assetAges[name] || '', skillTemplateId: assetSkillId });
      if (data.usedFallback || !data.prompt) { setNotice(`添加造型失败：${mapLlmError(data.llmError)}。`); return; }
      const block = `\n\n#### @${name}_${desc}\n${data.prompt}`;
      setAssetItems((prev) => ({ ...prev, [assetKey('characters', name)]: (prev[assetKey('characters', name)] || '') + block }));
      setOutfitInput('');
      setNotice(`已为「${name}」增补造型：${desc}。`);
    } catch (error) { setNotice(error.message); } finally { setLoading(''); }
  }

  async function generateOne(type, name) {
    if (!project) return;
    setLoading(`asset-${type}-${name}`);
    try {
      const data = await callAssetGen({ characters: [], scenes: [], props: [], [type]: [name] });
      mergeAssetItems(data.output?.items);
      setAssetView({ type, name });
      if (data.usedFallback && data.llmError?.code === 'missing_api_key') setNotice('未填写 API Key，已用本地兜底生成该资产。');
    } catch (error) { setNotice(error.message); } finally { setLoading(''); }
  }

  function assetExportMarkdown() {
    const order = ['characters', 'scenes', 'props'];
    const labels = { characters: '角色', scenes: '场景', props: '道具' };
    const blocks = [];
    order.forEach((type) => {
      const names = bibleNames(type).filter((n) => assetItems[assetKey(type, n)]);
      if (names.length) {
        blocks.push(`## ${labels[type]}\n\n` + names.map((n) => `### ${n}\n${assetItems[assetKey(type, n)]}`).join('\n\n'));
      }
    });
    return blocks.length ? `# 美术资产提示词\n\n${blocks.join('\n\n')}\n` : '';
  }
  const assetGenCount = Object.keys(assetItems).length;

  // ===== 剧集提示词 =====
  function toggleEpisode(id) {
    setSelectedIds((ids) => ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  }
  function selectAllEpisodes() {
    if (!project) return;
    const all = project.episodes.map((ep) => ep.id);
    setSelectedIds(selectedIds.length === all.length ? [] : all);
  }
  async function generatePrompts() {
    if (!project || selectedIds.length === 0) return;
    setLoading('generate');
    setNotice('');
    try {
      const data = await runJob(`${API}/projects/${project.id}/generate`,
        { episodeIds: selectedIds, settings, llm, skillTemplateId: videoSkillId });
      setOutputs(data.outputs);
      setCopyIds(data.outputs.map((o) => o.episodeId));
      setActiveEpisodeId(data.outputs[0]?.episodeId || null);
      const keyInfo = data.apiKeySource ? `Key来源：${data.apiKeySource}` : '';
      setNotice(data.usedFallback
        ? `模型调用失败：${mapLlmError(data.llmError)}。${keyInfo}。已用本地兜底生成。`
        : `已用 ${data.provider} / ${data.model} 生成提示词。${keyInfo}`);
    } catch (error) { setNotice(error.message); } finally { setLoading(''); }
  }
  // ===== 按场次拆分 + 分镜分段 =====
  function episodeScenes(ep) {
    return (ep && ep.scenes && ep.scenes.length) ? ep.scenes : (ep ? [{ id: `${ep.id}_all`, name: ep.title || '全场', script: ep.script }] : []);
  }
  function toggleExpandEp(id) {
    setExpandedEp((m) => ({ ...m, [id]: !m[id] }));
  }
  async function generateScene() {
    if (!project || !focusedScene) return;
    setLoading('scene');
    setNotice('');
    try {
      const data = await runJob(`${API}/projects/${project.id}/scene-generate`,
        { episodeId: focusedScene.episodeId, sceneId: focusedScene.sceneId, settings, llm, skillTemplateId: videoSkillId });
      setSceneOutputs((prev) => ({ ...prev, [focusedScene.sceneId]: data.markdown || '' }));
      setNotice(data.usedFallback
        ? `本场：${mapLlmError(data.llmError)}，已用本地兜底生成。`
        : `已用 ${data.provider} / ${data.model} 生成本场分镜。`);
    } catch (error) { setNotice(error.message); } finally { setLoading(''); }
  }
  function toggleCopy(id) {
    setCopyIds((ids) => ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  }
  function selectAllCopy() {
    const all = outputs.map((o) => o.episodeId);
    setCopyIds(copyIds.length === all.length ? [] : all);
  }
  function chosenOutputs() {
    const picked = outputs.filter((o) => copyIds.includes(o.episodeId));
    if (picked.length) return picked;
    return selectedOutput ? [selectedOutput] : [];
  }
  const allCopyChecked = outputs.length > 0 && copyIds.length === outputs.length;

  async function uploadSkillTemplate(event) {
    const skillFile = event.target.files?.[0];
    if (!skillFile) return;
    setLoading('skill-upload');
    try {
      const form = new FormData();
      form.append('skillFile', skillFile);
      form.append('name', skillFile.name.replace(/\.[^.]+$/, ''));
      form.append('kind', 'asset');
      const data = await readJson(await fetch(`${API}/skill-templates/upload`, { method: 'POST', body: form }));
      await loadSkillTemplates();
      if (data.template?.id) setAssetSkillId(data.template.id);
      setNotice('已上传并选用新的美术资产 SKILL。');
    } catch (error) { setNotice(error.message); } finally { event.target.value = ''; setLoading(''); }
  }

  const b = project?.bible;
  const videoSkillOptions = skillTemplates.filter((t) => t.kind === 'video' || !t.kind);
  const assetSkillOptions = skillTemplates.filter((t) => t.kind === 'asset' || !t.kind);
  const scriptSkillOptions = skillTemplates.filter((t) => t.kind === 'script');

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <div className="brand-mark"><Sparkles size={24} /></div>
          <div className="brand-text">
            <p className="eyebrow">AI 漫剧提示词智能体</p>
            <h1>剧集级提示词生成工作台</h1>
          </div>
        </div>
        <div className="topbar-right">
          <button type="button" className="theme-toggle" onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))} aria-label="切换深色模式">
            {theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}
          </button>
          <div className="status-pill">{project ? `${project.episodes.length} 集已解析` : '等待上传剧本'}</div>
        </div>
      </section>

      <nav className="stepper">
        {[
          { n: 1, label: '剧本构造', desc: '生成 / 优化 / 解析' },
          { n: 2, label: '资产构成', desc: '角色 / 场景 / 道具' },
          { n: 3, label: '分镜提示词', desc: '逐镜号生成' },
        ].map((s, i) => {
          const unlocked = s.n === 1 || (s.n === 2 && scriptConfirmed) || (s.n === 3 && assetsConfirmed);
          const done = (s.n === 1 && scriptConfirmed) || (s.n === 2 && assetsConfirmed);
          const active = step === s.n;
          return (
            <React.Fragment key={s.n}>
              <button type="button"
                className={`step-node${active ? ' active' : ''}${done ? ' done' : ''}${unlocked ? '' : ' locked'}`}
                onClick={() => { if (unlocked) setStep(s.n); }}
                disabled={!unlocked}>
                <span className="step-idx">{done ? <CheckSquare size={15} /> : s.n}</span>
                <span className="step-meta"><strong>{s.label}</strong><em>{s.desc}</em></span>
              </button>
              {i < 2 && <span className={`step-line${done ? ' done' : ''}`} />}
            </React.Fragment>
          );
        })}
      </nav>

      {step === 1 && (
      <section className="home-grid">
        <aside className="panel input-panel">
          <div className="panel-title"><FileText size={18} /><span>整剧输入</span></div>
          <label className="upload-box">
            <Upload size={18} />
            <span>{file ? file.name : '上传 TXT / DOCX'}</span>
            <input type="file" accept=".txt,.md,.docx" onChange={async (e) => {
              const f = e.target.files?.[0] || null;
              setFile(f);
              if (!f) return;
              const ext = (f.name.toLowerCase().split('.').pop() || '');
              if (ext === 'txt' || ext === 'md') {
                try { setScript(await f.text()); } catch { /* 读取失败则保留文件，交后端解析 */ }
              } else {
                setScript(`（已上传 ${f.name}，点击「解析剧本」后将自动提取其文本）`);
              }
            }} />
          </label>
          <button type="button" className="script-workshop-btn" onClick={() => setScriptModal(true)}>
            <Sparkles size={16} />剧本构建工坊 · 生成 / 小说转 / 优化
          </button>
          <textarea value={script} onChange={(e) => setScript(e.target.value)} />
          <button className="primary" onClick={parseProject} disabled={loading === 'parse'}>
            {loading === 'parse' ? <RefreshCw className="spin" size={18} /> : <Layers size={18} />}
            解析剧本
          </button>
        </aside>

        <section className="panel overview-panel">
          <div className="panel-title"><Sparkles size={18} /><span>工作台</span></div>
          {!project ? (
            <div className="empty-state">上传或粘贴整部剧本并点击「解析剧本」，确认无误后即可进入下一步「资产构成」。</div>
          ) : (
            <div className="step1-confirm">
              <div className="step1-summary">
                <div className="s1-stat"><strong>{project.episodes.length}</strong><span>集</span></div>
                <div className="s1-stat"><strong>{b.characters.length}</strong><span>角色</span></div>
                <div className="s1-stat"><strong>{b.scenes.length}</strong><span>场景</span></div>
                <div className="s1-stat"><strong>{b.props.length}</strong><span>道具</span></div>
              </div>
              <p className="step1-tip">剧本已解析。请核对左侧剧本正文与上方统计——需要修改可在左侧编辑后重新「解析剧本」。确认无误后进入「资产构成」。</p>
              <button className="primary step-next" onClick={() => { setScriptConfirmed(true); setStep(2); }}>
                确认剧本无误，进入资产构成 →
              </button>
              {scriptConfirmed && <p className="step1-hint">已确认。可点上方步骤条随时回来修改，或前往「资产构成 / 分镜提示词」。</p>}
            </div>
          )}
        </section>
      </section>
      )}

      {/* ===== 剧本构建工坊 ===== */}
      {scriptModal && (
        <Modal className="modal-wide" title="剧本构建工坊" subtitle="生成剧本 / 小说转剧本 / 优化完善剧本 —— 产出的剧本可复制或导出，再粘贴到「整剧输入」继续。" onClose={() => setScriptModal(false)}>
          <div className="script-tabs">
            {[['generate', '生成剧本'], ['novel', '小说转剧本'], ['optimize', '优化完善剧本']].map(([m, lbl]) => (
              <button key={m} type="button" className={`script-tab${scriptMode === m ? ' active' : ''}`}
                onClick={() => { setScriptMode(m); setScriptSkillId(''); }}>{lbl}</button>
            ))}
          </div>
          {scriptSkillOptions.length > 0 && (
            <div className="modal-settings">
              <SelectField label="剧本 SKILL"
                value={scriptSkillId || (scriptMode === 'novel' ? 'script-novel' : scriptMode === 'optimize' ? 'script-optimize' : 'script-generate')}
                options={scriptSkillOptions.map((t) => t.id)}
                optionLabels={Object.fromEntries(scriptSkillOptions.map((t) => [t.id, t.name]))}
                onChange={setScriptSkillId} />
            </div>
          )}
          <div className="script-grid">
            <div className="script-in">
              <div className="ep-pane-head"><h3>{scriptMode === 'novel' ? '小说原文' : scriptMode === 'optimize' ? '粗剧本 / 草稿' : '创意 / 题材 / 大纲 / 人设'}</h3></div>
              <textarea className="script-input" value={scriptInput} onChange={(e) => setScriptInput(e.target.value)}
                placeholder={scriptMode === 'novel' ? '粘贴小说原文……' : scriptMode === 'optimize' ? '粘贴你的粗剧本 / 草稿……' : '例：都市甜宠，女主是刑侦队长，男主是法医，共 6 集，每集一个案子推进感情线……'} />
              <button className="primary" onClick={buildScript} disabled={loading === 'script' || !scriptInput.trim()}>
                {loading === 'script' ? <RefreshCw className="spin" size={16} /> : <Sparkles size={16} />}
                {scriptMode === 'novel' ? '转成剧本' : scriptMode === 'optimize' ? '优化剧本' : '生成剧本'}
              </button>
            </div>
            <div className="script-out">
              <div className="result-head">
                <h3>剧本结果</h3>
                <div className="actions">
                  {scriptOutput && <button className="secondary" onClick={() => copyText(scriptOutput, '已复制剧本。')}><Copy size={15} />复制全部</button>}
                  {scriptOutput && <button className="secondary" onClick={() => exportDoc('docx', '剧本', scriptOutput)}><Download size={15} />Word</button>}
                  {scriptOutput && <button className="secondary" onClick={() => exportDoc('txt', '剧本', scriptOutput)}><Download size={15} />TXT</button>}
                </div>
              </div>
              {scriptPlan && (
                <div className="plan-block">
                  <button type="button" className="plan-head" onClick={() => setShowPlan((v) => !v)}>
                    <span className="plan-caret">{showPlan ? '▾' : '▸'}</span>
                    <strong>宏观规划</strong>
                    <em>PlotPilot 式第一阶段 · 题材/人物/世界观/分集大纲</em>
                    <span className="plan-copy" onClick={(e) => { e.stopPropagation(); copyText(scriptPlan, '已复制宏观规划。'); }}><Copy size={13} />复制</span>
                  </button>
                  {showPlan && <pre className="markdown-view plan-view">{scriptPlan}</pre>}
                </div>
              )}
              {scriptOutput
                ? <pre className="markdown-view">{scriptOutput}</pre>
                : <div className="empty-state">{loading === 'script' ? '正在按 PlotPilot 式双阶段生成：先出宏观规划，再据此成稿，可能需要 2-4 分钟……' : '填写左侧内容，点按钮生成剧本。'}</div>}
            </div>
          </div>
        </Modal>
      )}

      {/* ===== 步骤② 资产构成（内联工作区） ===== */}
      {step === 2 && project && (
        <section className="step-surface">
          <div className="step-surface-head">
            <div>
              <h2>资产构成 · 美术资产库</h2>
              <p className="modal-sub">从全剧提取 · 共 {b.characters.length + b.scenes.length + b.props.length} 项 · 已生成 {assetGenCount}</p>
            </div>
            <div className="step-surface-nav">
              <button className="secondary" onClick={() => setStep(1)}>← 返回剧本</button>
              <button className="primary" onClick={() => { setAssetsConfirmed(true); setStep(3); }} disabled={!assetGenCount} title={!assetGenCount ? '请至少生成一项资产提示词' : ''}>确认资产无误，进入分镜提示词 →</button>
            </div>
          </div>
          <div className="modal-settings">
            <SelectField label="美术资产 SKILL" value={assetSkillId}
              options={assetSkillOptions.map((t) => t.id)}
              optionLabels={Object.fromEntries(assetSkillOptions.map((t) => [t.id, t.name]))}
              onChange={setAssetSkillId} />
            <div className="field">
              <span>上传美术资产 SKILL</span>
              <label className="secondary skill-upload-btn">
                <Upload size={15} />{loading === 'skill-upload' ? '上传中…' : '上传 .txt / .md'}
                <input type="file" accept=".txt,.md" onChange={uploadSkillTemplate} />
              </label>
            </div>
            <SelectField label="画幅" value={settings.aspectRatio} options={['9:16', '16:9', '21:9', '2.35:1']} onChange={(v) => setSettings({ ...settings, aspectRatio: v })} />
            <SelectField label="视觉风格" value={settings.visualStyle} options={STYLE_NAMES} onChange={(v) => setSettings({ ...settings, visualStyle: v })} />
            <label className="field">
              <span>参考风格基调（选填·仅用于场景）</span>
              <input value={styleTone} placeholder="如：现实主义悬疑，低饱和冷暖对比" onChange={(e) => setStyleTone(e.target.value)} />
            </label>
          </div>

          <div className="asset-tabs">
            {ASSET_GROUPS.map((g) => {
              const Icon = g.icon;
              const total = bibleNames(g.key).length;
              const gen = bibleNames(g.key).filter((n) => assetItems[assetKey(g.key, n)]).length;
              return (
                <button key={g.key} className={`asset-tab ${assetCat === g.key ? 'on' : ''}`} onClick={() => { setAssetCat(g.key); setAssetView(null); }}>
                  <Icon size={16} />{g.label}<em>{gen}/{total}</em>
                </button>
              );
            })}
            <button className="secondary asset-analyze-btn" onClick={analyzeAssets} disabled={loading === 'asset-analyze'} title="用 LLM 通读剧本，重新识别真实的角色/场景/道具">
              {loading === 'asset-analyze' ? <RefreshCw className="spin" size={15} /> : <Sparkles size={15} />}智能识别资产
            </button>
          </div>

          <div className="asset-toolbar">
            <div className="asset-toolbar-left">
              <button className="link-btn" onClick={() => toggleAssetGroup(assetCat)} disabled={!bibleNames(assetCat).length}>
                {bibleNames(assetCat).length && assetSel[assetCat].length === bibleNames(assetCat).length ? '取消全选' : '全选本类'}
              </button>
              <span className="muted-cap">已选 {assetSel[assetCat].length}/{bibleNames(assetCat).length}</span>
              <span className="add-asset">
                <input value={newAssetName}
                  placeholder={`添加${ASSET_GROUPS.find((g) => g.key === assetCat)?.label || '资产'}…`}
                  onChange={(e) => setNewAssetName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') addAsset(); }} />
                <button className="link-btn" onClick={addAsset} disabled={!newAssetName.trim()}>+ 添加</button>
              </span>
            </div>
            <div className="actions">
              <button className="primary asset-gen-btn" onClick={generateAssets} disabled={loading === 'assets' || assetTotal === 0}>
                {loading === 'assets' ? <RefreshCw className="spin" size={15} /> : <Sparkles size={15} />}生成选中（{assetTotal}）
              </button>
              <button className="secondary" onClick={() => copyText(assetExportMarkdown(), '已复制全部已生成资产提示词。')} disabled={!assetGenCount}><Copy size={15} />复制全部</button>
              <button className="secondary" onClick={() => exportDoc('docx', '美术资产提示词', assetExportMarkdown())} disabled={!assetGenCount}><Download size={15} />Word</button>
              <button className="secondary" onClick={() => exportDoc('txt', '美术资产提示词', assetExportMarkdown())} disabled={!assetGenCount}><Download size={15} />TXT</button>
            </div>
          </div>

          {assetCat === 'characters' && bibleNames('characters').length > 0 && (
            <div className="age-confirm">
              <div className="age-confirm-head">
                <span>人物出镜年龄确认</span>
                <em>短剧出镜年龄常≠剧本年龄；填写后角色提示词将采用此年龄（留空则由模型按剧本判断）</em>
              </div>
              <div className="age-grid">
                {bibleNames('characters').map((name) => (
                  <label key={name} className="age-item">
                    <span>{name}</span>
                    <input value={assetAges[name] || ''} placeholder="出镜年龄 如 26 / 25-30" onChange={(e) => setAssetAges({ ...assetAges, [name]: e.target.value })} />
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="asset-library">
            <div className="asset-gallery">
              {bibleNames(assetCat).length ? bibleNames(assetCat).map((name) => {
                const done = !!assetItems[assetKey(assetCat, name)];
                const checked = assetSel[assetCat].includes(name);
                const active = assetView && assetView.type === assetCat && assetView.name === name;
                return (
                  <div key={name} className={`asset-card ${active ? 'active' : ''} ${checked ? 'checked' : ''}`} onClick={() => setAssetView({ type: assetCat, name })}>
                    <span className="asset-card-check" onClick={(e) => { e.stopPropagation(); toggleAsset(assetCat, name); }}>
                      {checked ? <CheckSquare size={16} /> : <Square size={16} />}
                    </span>
                    <div className="asset-card-thumb">{assetCat === 'characters' ? <Users size={22} /> : assetCat === 'scenes' ? <MapPin size={22} /> : <Box size={22} />}</div>
                    <div className="asset-card-name">{name}</div>
                    <span className={`asset-status ${done ? 'done' : ''}`}>{done ? '已生成' : '未生成'}</span>
                  </div>
                );
              }) : <p className="asset-empty">未识别到该类词条。</p>}
            </div>

            <div className="asset-detail">
              {assetView ? (() => {
                const raw = assetItems[assetKey(assetView.type, assetView.name)] || '';
                const isChar = assetView.type === 'characters';
                const parsed = isChar ? parseCharacterOutfits(raw) : null;
                return (
                  <>
                    <div className="asset-detail-head">
                      <h3>{assetView.name}{isChar && raw ? <em className="outfit-count"> · {parsed.outfits.length} 个造型</em> : null}</h3>
                      <div className="actions">
                        {raw && <button className="secondary" onClick={() => copyText(raw, '已复制该资产全部提示词。')}><Copy size={14} />复制全部</button>}
                        <button className="secondary" onClick={() => generateOne(assetView.type, assetView.name)} disabled={loading === `asset-${assetView.type}-${assetView.name}`}>
                          {loading === `asset-${assetView.type}-${assetView.name}` ? <RefreshCw className="spin" size={14} /> : <Sparkles size={14} />}
                          {raw ? '重新生成' : '生成此项'}
                        </button>
                      </div>
                    </div>

                    {!raw && <div className="empty-state">该资产尚未生成。点「生成此项」单独生成，或在上方「生成选中」批量生成。</div>}

                    {raw && isChar && (
                      <div className="outfit-list">
                        {parsed.anchor && (
                          <div className="outfit-anchor">
                            <div className="outfit-anchor-tag">面部锚点（全状态固定 · 所有造型共用同一张脸）</div>
                            <pre className="markdown-view">{parsed.anchor}</pre>
                          </div>
                        )}
                        {parsed.outfits.map((o, i) => (
                          <div key={i} className="outfit-block">
                            <div className="outfit-block-head">
                              <span className="outfit-name">{o.name}</span>
                              <button className="secondary" onClick={() => copyText(o.prompt, '已复制该造型提示词。')}><Copy size={13} />复制</button>
                            </div>
                            <pre className="markdown-view">{o.prompt}</pre>
                          </div>
                        ))}
                        <div className="add-outfit">
                          <input value={outfitInput} placeholder="添加造型：描述服饰/发型，如 红色礼服+束发"
                            onChange={(e) => setOutfitInput(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') addOutfit(); }} />
                          <button className="secondary" onClick={addOutfit} disabled={loading === 'outfit' || !outfitInput.trim()}>
                            {loading === 'outfit' ? <RefreshCw className="spin" size={13} /> : <Sparkles size={13} />}添加造型
                          </button>
                        </div>
                      </div>
                    )}

                    {raw && !isChar && <pre className="markdown-view">{raw}</pre>}
                  </>
                );
              })() : <div className="empty-state">点击左侧资产卡片，查看或生成它的文生图提示词。</div>}
            </div>
          </div>
        </section>
      )}

      {/* ===== 步骤③ 分镜提示词（内联工作区） ===== */}
      {step === 3 && project && (() => {
        const fEp = focusedScene ? project.episodes.find((e) => e.id === focusedScene.episodeId) : null;
        const fScene = fEp ? episodeScenes(fEp).find((s) => s.id === focusedScene.sceneId) : null;
        const sceneMd = (fScene && sceneOutputs[fScene.id]) || '';
        const parsed = sceneMd ? parseShots(sceneMd) : null;
        const totalScenes = project.episodes.reduce((n, ep) => n + episodeScenes(ep).length, 0);
        const doneScenes = Object.values(sceneOutputs).filter(Boolean).length;
        return (
        <section className="step-surface surface-wide">
          <div className="step-surface-head">
            <div>
              <h2>分镜提示词工作台</h2>
              <p className="modal-sub">共 {project.episodes.length} 集 · {totalScenes} 场次 · 已生成 {doneScenes}</p>
            </div>
            <div className="step-surface-nav">
              <button className="secondary" onClick={() => setStep(2)}>← 返回资产</button>
            </div>
          </div>
          <div className="ep-workbench">
            {/* 左栏：前置设置 + 剧集→场次 */}
            <div className="ep-left">
              <div className="modal-settings ep-settings">
                <SelectField label="视频分镜 SKILL" value={videoSkillId}
                  options={videoSkillOptions.map((t) => t.id)}
                  optionLabels={Object.fromEntries(videoSkillOptions.map((t) => [t.id, t.name]))}
                  onChange={setVideoSkillId} />
                <SelectField label="画幅" value={settings.aspectRatio} options={['9:16', '16:9', '21:9', '2.35:1']} onChange={(v) => setSettings({ ...settings, aspectRatio: v })} />
                <SelectField label="视觉风格" value={settings.visualStyle} options={STYLE_NAMES} onChange={(v) => setSettings({ ...settings, visualStyle: v })} />
                <SelectField label="文戏强度" value={settings.dramaIntensity} options={['低克制', '中等情绪', '高压对峙', '崩溃边缘']} onChange={(v) => setSettings({ ...settings, dramaIntensity: v })} />
              </div>

              <div className="ep-picker">
                {project.episodes.map((episode) => {
                  const scenes = episodeScenes(episode);
                  const open = !!expandedEp[episode.id];
                  return (
                    <div key={episode.id} className="ep-group">
                      <button className="ep-group-head" onClick={() => toggleExpandEp(episode.id)}>
                        <span className="ep-caret">{open ? '▾' : '▸'}</span>
                        <span className="episode-number">第 {episode.number} 集</span>
                        <strong>{episode.title}</strong>
                        <em>{scenes.length} 场</em>
                      </button>
                      {open && (
                        <div className="scene-sublist">
                          {scenes.map((sc) => (
                            <button key={sc.id}
                              className={`scene-item ${focusedScene && focusedScene.sceneId === sc.id ? 'focused' : ''}`}
                              onClick={() => setFocusedScene({ episodeId: episode.id, sceneId: sc.id })}>
                              <span className="scene-name">{sc.name}</span>
                              {sceneOutputs[sc.id] && <span className="scene-done">已生成</span>}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 右栏：上=本场剧本，下=分镜(按镜头分段) */}
            <div className="ep-right">
              <div className="ep-script">
                <div className="ep-pane-head"><h3>剧本原文 · {fScene ? fScene.name : '未选择场次'}</h3></div>
                <pre className="markdown-view script-view">{fScene ? fScene.script : '展开剧集、点击某一场次，这里显示该场剧本。'}</pre>
              </div>

              <div className="ep-output">
                <div className="result-head">
                  <h3>分镜提示词{fScene ? ` · ${fScene.name}` : ''}{parsed ? `（${parsed.shots.length} 个分镜）` : ''}</h3>
                  <div className="actions">
                    {fScene && (
                      <button className="primary" onClick={generateScene} disabled={loading === 'scene'}>
                        {loading === 'scene' ? <RefreshCw className="spin" size={15} /> : <Play size={15} />}{sceneMd ? '重新生成本场' : '生成本场分镜'}
                      </button>
                    )}
                    {sceneMd && <button className="secondary" onClick={() => copyText(sceneMd, '已复制本场全部分镜。')}><Copy size={15} />复制全部</button>}
                    {sceneMd && <button className="secondary" onClick={() => exportDoc('docx', `分镜_${fScene.name}`, sceneMd)}><Download size={15} />Word</button>}
                    {sceneMd && <button className="secondary" onClick={() => exportDoc('txt', `分镜_${fScene.name}`, sceneMd)}><Download size={15} />TXT</button>}
                  </div>
                </div>
                {parsed ? (
                  <div className="shot-list">
                    {parsed.head && <pre className="markdown-view">{parsed.head}</pre>}
                    {parsed.shots.map((s, i) => (
                      <div key={i} className="shot-block">
                        <div className="shot-block-head">
                          <span className="shot-name">{s.name}</span>
                          <button className="secondary" onClick={() => copyText(s.text, `已复制「${s.name}」。`)}><Copy size={13} />复制</button>
                        </div>
                        <pre className="markdown-view">{s.text}</pre>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="empty-state">{fScene ? '点「生成本场分镜」生成该场分镜，将按镜号（每段约 4-15 秒）分段、可单独复制。' : '展开剧集并选择一个场次后，点「生成本场分镜」。'}</div>
                )}
              </div>
            </div>
          </div>
        </section>
        );
      })()}

      <section className="model-dock" style={dockPos ? { left: dockPos.x, top: dockPos.y, right: 'auto', bottom: 'auto' } : undefined}>
        <button type="button" className="model-dock-toggle" onPointerDown={onDockDown} title="拖动可移动，点击展开/收起">
          <RefreshCw size={20} /><span>LLM</span>
        </button>
        {showModelSettings && (
          <div className="model-panel bottom-model-panel">
            <div className="panel-title compact"><RefreshCw size={16} /><span>LLM 模型接口</span></div>
            <SelectField label="供应商" value={llm.providerId}
              options={providers.map((p) => p.id)}
              optionLabels={Object.fromEntries(providers.map((p) => [p.id, `${p.name}${p.configured ? '（已配置）' : ''}`]))}
              onChange={(value) => {
                const provider = providers.find((p) => p.id === value);
                setAvailableModels(null);
                setLlm({ ...llm, providerId: value, model: provider?.models?.[0] || '', baseUrl: provider?.baseUrl || llm.baseUrl });
              }} />
            <ModelField idKey="dock" label="模型" value={llm.model} options={modelOptions} onChange={(v) => setLlm({ ...llm, model: v })} />
            <label className="field">
              <span>Base URL{selectedProvider && !selectedProvider.allowCustomBaseUrl ? '（该供应商固定）' : ''}</span>
              <input value={llm.baseUrl} disabled={selectedProvider && !selectedProvider.allowCustomBaseUrl} onChange={(e) => setLlm({ ...llm, baseUrl: e.target.value })} />
            </label>
            <label className="field">
              <span>本次 API Key（可选，留空使用后端 .env）</span>
              <input type="password" value={llm.apiKey} placeholder="sk-..." onChange={(e) => setLlm({ ...llm, apiKey: e.target.value })} />
            </label>
            <button className="secondary test-connection" onClick={testConnection} disabled={loading === 'llm-test'}>
              {loading === 'llm-test' ? <RefreshCw className="spin" size={16} /> : <RefreshCw size={16} />}测试连接
            </button>
          </div>
        )}
      </section>

      {notice && <div className="toast">{notice}</div>}
    </main>
  );
}

function Modal({ title, subtitle, onClose, children, className = '' }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className={`modal ${className}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p className="modal-sub">{subtitle}</p>}
          </div>
          <button className="modal-close" onClick={onClose} aria-label="关闭"><X size={20} /></button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

function SelectField({ label, value, options, optionLabels = {}, onChange }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o} value={o}>{optionLabels[o] || o}</option>)}
      </select>
    </label>
  );
}

function ModelField({ idKey, label, value, options, onChange }) {
  const CUSTOM = '__custom__';
  // 当前模型不在该供应商的预置/可用列表里（含留空）→ 视为“自定义模型”，展开手动输入框。
  const isCustom = !options.includes(value);
  return (
    <label className="field">
      <span>{label}</span>
      <select value={isCustom ? CUSTOM : value}
        onChange={(e) => onChange(e.target.value === CUSTOM ? '' : e.target.value)}>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
        <option value={CUSTOM}>自定义模型（手动输入）</option>
      </select>
      {isCustom && (
        <input className="custom-model-input" value={value} autoFocus
          placeholder="输入模型 ID，如 gpt-4 / doubao-seedance-2-0-260128"
          onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}

async function readJson(res) {
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}

// 把角色的整段提示词拆成「面部锚点」+ 各造型块（#### / ### 子节）。
function parseCharacterOutfits(md = '') {
  const text = String(md || '').trim();
  if (!text) return { anchor: '', outfits: [] };
  const idx = text.search(/(^|\n)#{3,4}\s/);
  let anchor = '';
  let rest = text;
  if (idx >= 0) {
    anchor = text.slice(0, idx).replace(/^#{1,3}\s*.+\n?/, '').trim(); // 去掉「### @角色名」标题行，保留面部锚点
    rest = text.slice(idx).replace(/^\n/, '');
  }
  const outfits = [];
  for (const part of rest.split(/\n(?=#{3,4}\s)/)) {
    const m = part.match(/^#{3,4}\s*(.+?)\s*(?:\n([\s\S]*))?$/);
    if (m) outfits.push({ name: m[1].replace(/^@/, '').trim(), prompt: (m[2] || '').trim() });
  }
  if (!outfits.length) {
    // 没有子标题：整段当作一个默认造型；锚点取含「面部锚点」的那段（若有）
    const anchorMatch = text.match(/(面部锚点[\s\S]*?)(?:\n\n|$)/);
    return { anchor: anchorMatch ? anchorMatch[1].trim() : '', outfits: [{ name: '默认造型', prompt: text }] };
  }
  return { anchor, outfits };
}

// 把分镜 markdown 拆成「头部(全局/模板说明)」+ 各镜头段(每段约 4-15 秒，可单独复制)。
function parseShots(md = '') {
  const text = String(md || '').trim();
  if (!text) return { head: '', shots: [] };
  // 镜头头：## 镜头N / ### 第N组 / 【镜头N】 等
  const re = /\n(?=(?:#{2,4}\s*)?(?:镜号\s*[一二三四五六七八九十\d]+|镜头\s*[一二三四五六七八九十\d]+|第\s*[一二三四五六七八九十\d]+\s*[组镜]|【\s*镜[头号]))/;
  const parts = text.split(re).map((p) => p.trim()).filter(Boolean);
  const shots = [];
  let head = '';
  parts.forEach((p, i) => {
    const isShot = /^(?:#{2,4}\s*)?(?:镜号\s*[一二三四五六七八九十\d]+|镜头\s*[一二三四五六七八九十\d]+|第\s*[一二三四五六七八九十\d]+\s*[组镜]|【\s*镜[头号])/.test(p);
    if (i === 0 && !isShot) { head = p; return; }
    const m = p.match(/^(?:#{2,4}\s*)?【?\s*(镜号\s*[一二三四五六七八九十\d]+[^\n】]*|镜头\s*[一二三四五六七八九十\d]+|第\s*[一二三四五六七八九十\d]+\s*[组镜][^\n】]*)/);
    const name = m ? m[1].replace(/[#【】]/g, '').trim() : `镜号 ${shots.length + 1}`;
    shots.push({ name, text: p });
  });
  if (!shots.length) shots.push({ name: '全部', text });
  return { head, shots };
}

// 发起生成任务并轮询结果：后端立即返回 jobId，前端每隔几秒查一次。
// 每个请求都很短，绕开免费托管层对单个长请求约 60 秒的断连限制。
async function runJob(url, body, { intervalMs = 2500, maxWaitMs = 720000 } = {}) {
  const start = await readJson(await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }));
  if (!start || !start.jobId) return start; // 兼容旧的同步返回
  const deadline = Date.now() + maxWaitMs;
  let pollFails = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    let s;
    try {
      s = await readJson(await fetch(`${API}/jobs/${start.jobId}`));
    } catch (e) {
      if (++pollFails > 6) throw e; // 连续多次查询失败才放弃，容忍偶发网络抖动
      continue;
    }
    pollFails = 0;
    if (s.status === 'done') return s.result;
    if (s.status === 'error') throw new Error(s.error?.message || '生成失败');
  }
  throw new Error('生成超时，请重试');
}

function mapLlmError(llmError) {
  if (!llmError) return '模型未返回可用内容';
  if (llmError.message) return llmError.message;
  const map = {
    missing_api_key: '请在 LLM 设置面板选择供应商并填写你自己的 API Key',
    timeout: '模型响应超时，请重试或换更快的模型',
    network_error: '无法连接到该供应商，请检查 Base URL 与网络',
    insufficient_user_quota: '该 Key 额度不足或不可用',
    invalid_api_key: 'API Key 无效，请检查后重试',
    model_not_found: '该供应商下未找到此模型，请换一个模型名'
  };
  return map[llmError.code] || '模型调用失败';
}

const sampleScript = `第1集 雨夜重逢
场景：深夜，老城区便利店门口，雨声很密。
林屿：你怎么会在这里？
唐柚：我只是路过。
林屿看见她手里的旧伞，停了一下。
林屿：那把伞……你还留着？
唐柚：有些东西，不是想丢就能丢掉。
两人隔着便利店的玻璃门沉默，雨水沿着门框往下滑。

第2集 没寄出的信
场景：清晨，唐柚的出租屋。
唐柚翻出抽屉里的信封，信封边角已经磨白。
唐柚：如果当年我把信寄出去，你会不会回来？
林屿站在门口，没有立刻回答。
林屿：我回来过，只是你不知道。
唐柚抬头，手指收紧，信纸轻轻发皱。`;

createRoot(document.getElementById('root')).render(<App />);
