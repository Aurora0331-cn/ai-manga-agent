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

function App() {
  const [script, setScript] = useState(sampleScript);
  const [file, setFile] = useState(null);
  const [project, setProject] = useState(null);
  const [theme, setTheme] = useState(loadTheme);
  const [loading, setLoading] = useState('');
  const [notice, setNotice] = useState('');
  const [showModelSettings, setShowModelSettings] = useState(false);
  const [dockPos, setDockPos] = useState(loadDockPos);
  const dockDrag = React.useRef({ dragging: false, moved: false, sx: 0, sy: 0, ox: 0, oy: 0 });
  const [providers, setProviders] = useState([]);
  const [skillTemplates, setSkillTemplates] = useState([]);
  const [videoSkillId, setVideoSkillId] = useState('template-1');
  const [assetSkillId, setAssetSkillId] = useState('asset-default');
  const storedLlmRef = React.useRef(loadStoredLlm());
  const [llm, setLlm] = useState(() => storedLlmRef.current || defaultLlm);
  const [availableModels, setAvailableModels] = useState(null);
  const [settings, setSettings] = useState({
    aspectRatio: '9:16',
    visualStyle: '写实电影感 + 现代都市',
    dramaIntensity: '中等情绪'
  });

  // 二级弹窗
  const [assetModal, setAssetModal] = useState(false);
  const [episodeModal, setEpisodeModal] = useState(false);

  // 美术资产
  const [assetSel, setAssetSel] = useState({ characters: [], scenes: [], props: [] });
  const [assetCat, setAssetCat] = useState('characters');
  const [assetItems, setAssetItems] = useState({}); // key `${type}|${name}` -> prompt
  const [assetView, setAssetView] = useState(null); // {type, name}
  const [assetAges, setAssetAges] = useState({}); // 角色名 -> 出镜年龄
  const [styleTone, setStyleTone] = useState(''); // 参考风格基调（仅用于场景）

  // 剧集提示词
  const [selectedIds, setSelectedIds] = useState([]);
  const [outputs, setOutputs] = useState([]);
  const [activeEpisodeId, setActiveEpisodeId] = useState(null);
  const [copyIds, setCopyIds] = useState([]);

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
    dockDrag.current = { dragging: true, moved: false, sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }
  function onDockMove(e) {
    const d = dockDrag.current;
    if (!d.dragging) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) d.moved = true;
    if (d.moved) {
      const x = Math.max(8, Math.min(window.innerWidth - 72, d.ox + dx));
      const y = Math.max(8, Math.min(window.innerHeight - 72, d.oy + dy));
      setDockPos({ x, y });
    }
  }
  function onDockUp(e) {
    const d = dockDrag.current;
    if (!d.dragging) return;
    d.dragging = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (!d.moved) setShowModelSettings((v) => !v);
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
    const base = availableModels && availableModels.length
      ? availableModels
      : (selectedProvider?.models?.length ? selectedProvider.models : [llm.model]);
    return base.includes(llm.model) ? base : [llm.model, ...base];
  }, [availableModels, selectedProvider, llm.model]);

  const selectedOutput = useMemo(() => outputs.find((o) => o.episodeId === activeEpisodeId) || outputs[0], [outputs, activeEpisodeId]);

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
      if (file) form.append('scriptFile', file);
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
    const res = await fetch(`${API}/projects/${project.id}/assets/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assets, settings, llm, skillTemplateId: assetSkillId, ages: assetAges, styleTone })
    });
    return readJson(res);
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
      const res = await fetch(`${API}/projects/${project.id}/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ episodeIds: selectedIds, settings, llm, skillTemplateId: videoSkillId })
      });
      const data = await readJson(res);
      setOutputs(data.outputs);
      setCopyIds(data.outputs.map((o) => o.episodeId));
      setActiveEpisodeId(data.outputs[0]?.episodeId || null);
      const keyInfo = data.apiKeySource ? `Key来源：${data.apiKeySource}` : '';
      setNotice(data.usedFallback
        ? `模型调用失败：${mapLlmError(data.llmError)}。${keyInfo}。已用本地兜底生成。`
        : `已用 ${data.provider} / ${data.model} 生成提示词。${keyInfo}`);
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

      <section className="home-grid">
        <aside className="panel input-panel">
          <div className="panel-title"><FileText size={18} /><span>整剧输入</span></div>
          <label className="upload-box">
            <Upload size={18} />
            <span>{file ? file.name : '上传 TXT / DOCX'}</span>
            <input type="file" accept=".txt,.md,.docx" onChange={(e) => setFile(e.target.files?.[0] || null)} />
          </label>
          <textarea value={script} onChange={(e) => setScript(e.target.value)} />
          <button className="primary" onClick={parseProject} disabled={loading === 'parse'}>
            {loading === 'parse' ? <RefreshCw className="spin" size={18} /> : <Layers size={18} />}
            解析剧本
          </button>
        </aside>

        <section className="panel overview-panel">
          <div className="panel-title"><Sparkles size={18} /><span>工作台</span></div>
          {!project ? (
            <div className="empty-state">上传或粘贴整部剧本并点击「解析剧本」后，这里会出现美术资产与剧集提示词两个工作入口。</div>
          ) : (
            <div className="entry-grid">
              <button className="entry-card" onClick={() => setAssetModal(true)}>
                <div className="entry-icon assets"><Box size={22} /></div>
                <h3>美术资产提示词</h3>
                <p className="entry-stat">角色 {b.characters.length} · 场景 {b.scenes.length} · 道具 {b.props.length}</p>
                <p className="entry-desc">从全剧提取的资产词条，可单选/多选/全选后生成文生图提示词。</p>
                <span className="entry-go">选择并生成 →</span>
              </button>
              <button className="entry-card" onClick={() => setEpisodeModal(true)}>
                <div className="entry-icon eps"><Layers size={22} /></div>
                <h3>剧集提示词</h3>
                <p className="entry-stat">共 {project.episodes.length} 集</p>
                <p className="entry-desc">选择剧集与参数，生成逐镜头视频提示词，支持多选复制与导出。</p>
                <span className="entry-go">进入工作台 →</span>
              </button>
            </div>
          )}
        </section>
      </section>

      {/* ===== 美术资产库二级弹窗 ===== */}
      {assetModal && project && (
        <Modal title="美术资产库" subtitle={`从全剧提取 · 共 ${b.characters.length + b.scenes.length + b.props.length} 项 · 已生成 ${assetGenCount}`} onClose={() => setAssetModal(false)}>
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
            <SelectField label="视觉风格" value={settings.visualStyle} options={['写实电影感 + 现代都市', '写实电影感 + 古装', '悬疑冷调电影感', '家庭生活质感', '3DCG 动画电影感']} onChange={(v) => setSettings({ ...settings, visualStyle: v })} />
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
          </div>

          <div className="asset-toolbar">
            <div className="asset-toolbar-left">
              <button className="link-btn" onClick={() => toggleAssetGroup(assetCat)} disabled={!bibleNames(assetCat).length}>
                {bibleNames(assetCat).length && assetSel[assetCat].length === bibleNames(assetCat).length ? '取消全选' : '全选本类'}
              </button>
              <span className="muted-cap">已选 {assetSel[assetCat].length}/{bibleNames(assetCat).length}</span>
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
              {assetView ? (
                <>
                  <div className="asset-detail-head">
                    <h3>{assetView.name}</h3>
                    <div className="actions">
                      {assetItems[assetKey(assetView.type, assetView.name)] && (
                        <button className="secondary" onClick={() => copyText(assetItems[assetKey(assetView.type, assetView.name)], '已复制该资产提示词。')}><Copy size={14} />复制</button>
                      )}
                      <button className="secondary" onClick={() => generateOne(assetView.type, assetView.name)} disabled={loading === `asset-${assetView.type}-${assetView.name}`}>
                        {loading === `asset-${assetView.type}-${assetView.name}` ? <RefreshCw className="spin" size={14} /> : <Sparkles size={14} />}
                        {assetItems[assetKey(assetView.type, assetView.name)] ? '重新生成' : '生成此项'}
                      </button>
                    </div>
                  </div>
                  {assetItems[assetKey(assetView.type, assetView.name)]
                    ? <pre className="markdown-view">{assetItems[assetKey(assetView.type, assetView.name)]}</pre>
                    : <div className="empty-state">该资产尚未生成。点「生成此项」单独生成，或在上方「生成选中」批量生成。</div>}
                </>
              ) : <div className="empty-state">点击左侧资产卡片，查看或生成它的文生图提示词。</div>}
            </div>
          </div>
        </Modal>
      )}

      {/* ===== 剧集提示词二级弹窗 ===== */}
      {episodeModal && project && (
        <Modal title="剧集提示词工作台" subtitle={`共 ${project.episodes.length} 集 · 已选 ${selectedIds.length} 集`} onClose={() => setEpisodeModal(false)}>
          <div className="modal-settings">
            <SelectField label="视频分镜 SKILL" value={videoSkillId}
              options={videoSkillOptions.map((t) => t.id)}
              optionLabels={Object.fromEntries(videoSkillOptions.map((t) => [t.id, t.name]))}
              onChange={setVideoSkillId} />
            <SelectField label="画幅" value={settings.aspectRatio} options={['9:16', '16:9', '21:9', '2.35:1']} onChange={(v) => setSettings({ ...settings, aspectRatio: v })} />
            <SelectField label="视觉风格" value={settings.visualStyle} options={['写实电影感 + 现代都市', '写实电影感 + 古装', '悬疑冷调电影感', '家庭生活质感', '3DCG 动画电影感']} onChange={(v) => setSettings({ ...settings, visualStyle: v })} />
            <SelectField label="文戏强度" value={settings.dramaIntensity} options={['低克制', '中等情绪', '高压对峙', '崩溃边缘']} onChange={(v) => setSettings({ ...settings, dramaIntensity: v })} />
          </div>

          <div className="selector-row">
            <button className="secondary" onClick={selectAllEpisodes}>
              {selectedIds.length === project.episodes.length ? <CheckSquare size={16} /> : <Square size={16} />}全选剧集
            </button>
            <span>{selectedIds.length} / {project.episodes.length} 已选择</span>
          </div>
          <div className="episode-list modal-eplist">
            {project.episodes.map((episode) => (
              <button key={episode.id} className={`episode-item ${selectedIds.includes(episode.id) ? 'selected' : ''}`} onClick={() => toggleEpisode(episode.id)}>
                <span className="episode-number">第 {episode.number} 集</span>
                <strong>{episode.title}</strong>
                <small>{episode.summary}</small>
              </button>
            ))}
          </div>

          <button className="primary" onClick={generatePrompts} disabled={loading === 'generate' || selectedIds.length === 0}>
            {loading === 'generate' ? <RefreshCw className="spin" size={18} /> : <Play size={18} />}
            生成选中剧集提示词
          </button>

          {outputs.length > 0 && (
            <div className="result-block">
              <div className="result-head">
                <h3>提示词输出 · 共 {outputs.length} 集</h3>
                <div className="actions">
                  <button className="secondary" onClick={selectAllCopy}>{allCopyChecked ? <CheckSquare size={15} /> : <Square size={15} />}全选</button>
                  <button className="secondary" onClick={() => copyText(chosenOutputs().map((o) => o.markdown).join('\n\n\n---\n\n\n'), `已复制 ${chosenOutputs().length} 集提示词。`)}><Copy size={15} />复制选中{copyIds.length ? ` (${copyIds.length})` : ''}</button>
                  <button className="secondary" onClick={() => exportDoc('docx', `漫剧提示词_共${chosenOutputs().length}集`, chosenOutputs().map((o) => o.markdown).join('\n\n\n---\n\n\n'))}><Download size={15} />Word</button>
                  <button className="secondary" onClick={() => exportDoc('txt', `漫剧提示词_共${chosenOutputs().length}集`, chosenOutputs().map((o) => o.markdown).join('\n\n\n---\n\n\n'))}><Download size={15} />TXT</button>
                </div>
              </div>
              <div className="output-body">
                <div className="episode-checklist">
                  {outputs.map((output) => (
                    <div key={output.episodeId} className={`epchip ${activeEpisodeId === output.episodeId ? 'active' : ''} ${copyIds.includes(output.episodeId) ? 'checked' : ''}`} onClick={() => setActiveEpisodeId(output.episodeId)}>
                      <span className="epchip-check" role="checkbox" aria-checked={copyIds.includes(output.episodeId)} onClick={(e) => { e.stopPropagation(); toggleCopy(output.episodeId); }}>
                        {copyIds.includes(output.episodeId) ? <CheckSquare size={16} /> : <Square size={16} />}
                      </span>
                      <span className="epchip-title">{output.title}</span>
                    </div>
                  ))}
                </div>
                <pre className="markdown-view">{selectedOutput ? selectedOutput.markdown : ''}</pre>
              </div>
            </div>
          )}
        </Modal>
      )}

      <section className="model-dock" style={dockPos ? { left: dockPos.x, top: dockPos.y, right: 'auto', bottom: 'auto' } : undefined}>
        <button type="button" className="model-dock-toggle" onPointerDown={onDockDown} onPointerMove={onDockMove} onPointerUp={onDockUp} title="拖动可移动，点击展开/收起">
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

function Modal({ title, subtitle, onClose, children }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
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
  const listId = `models-${idKey}`;
  return (
    <label className="field">
      <span>{label}</span>
      <input list={listId} value={value} placeholder="输入或选择模型名" onChange={(e) => onChange(e.target.value)} />
      <datalist id={listId}>{options.map((o) => <option key={o} value={o} />)}</datalist>
    </label>
  );
}

async function readJson(res) {
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
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
