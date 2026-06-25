import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CheckSquare, Copy, Download, FileText, Layers, Play, RefreshCw, Square, Upload } from 'lucide-react';
import './styles.css';

// 开发模式（vite 跑在 5173）直连后端 5174；生产模式由 Express 同源托管，用相对路径。
const DEV = typeof location !== 'undefined' && location.port === '5173';
const API = DEV ? 'http://127.0.0.1:5174/api' : '/api';
const FILE_ORIGIN = DEV ? 'http://127.0.0.1:5174' : '';
const LLM_STORAGE_KEY = 'ai-manga-agent.llm';

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
  } catch {
    return null;
  }
}

function App() {
  const [script, setScript] = useState(sampleScript);
  const [file, setFile] = useState(null);
  const [project, setProject] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [outputs, setOutputs] = useState([]);
  const [activeEpisodeId, setActiveEpisodeId] = useState(null);
  const [activeModule, setActiveModule] = useState('videoPrompts');
  const [loading, setLoading] = useState('');
  const [notice, setNotice] = useState('');
  const [showModelSettings, setShowModelSettings] = useState(false);
  const [providers, setProviders] = useState([]);
  const [skillTemplates, setSkillTemplates] = useState([]);
  const [skillTemplateId, setSkillTemplateId] = useState('template-1');
  const storedLlmRef = React.useRef(loadStoredLlm());
  const [llm, setLlm] = useState(() => storedLlmRef.current || defaultLlm);
  const [availableModels, setAvailableModels] = useState(null); // null = 未探测；[] = 探测到空
  const [settings, setSettings] = useState({
    aspectRatio: '9:16',
    visualStyle: '写实电影感 + 现代都市',
    dramaIntensity: '中等情绪'
  });

  const selectedOutput = useMemo(() => {
    return outputs.find((item) => item.episodeId === activeEpisodeId) || outputs[0];
  }, [outputs, activeEpisodeId]);

  const selectedProvider = useMemo(() => {
    return providers.find((provider) => provider.id === llm.providerId);
  }, [providers, llm.providerId]);

  // 探测成功后只显示可用模型；未探测则用供应商预设列表。始终保证当前选中模型在列表内。
  const modelOptions = useMemo(() => {
    const base = availableModels && availableModels.length
      ? availableModels
      : (selectedProvider?.models?.length ? selectedProvider.models : [llm.model]);
    return base.includes(llm.model) ? base : [llm.model, ...base];
  }, [availableModels, selectedProvider, llm.model]);

  async function testConnection() {
    setLoading('llm-test');
    try {
      const res = await fetch(`${API}/llm/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
    } catch (error) {
      setNotice(error.message);
    } finally {
      setLoading('');
    }
  }

  useEffect(() => {
    fetch(`${API}/llm/providers`)
      .then(readJson)
      .then((data) => {
        const nextProviders = data.providers || [];
        setProviders(nextProviders);
        // 已有本地持久化设置时，不用服务端默认值覆盖用户选择。
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
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(LLM_STORAGE_KEY, JSON.stringify(llm));
    } catch {
      // localStorage 不可用时静默忽略
    }
  }, [llm]);

  useEffect(() => {
    loadSkillTemplates();
  }, []);

  async function loadSkillTemplates() {
    try {
      const data = await readJson(await fetch(`${API}/skill-templates`));
      setSkillTemplates(data.templates || []);
      setSkillTemplateId((current) => current || data.defaultTemplateId || 'template-1');
    } catch {
      setSkillTemplates([]);
    }
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
      setProject(data.project);
      setSelectedIds(data.project.episodes.map((ep) => ep.id));
      setOutputs([]);
      setActiveEpisodeId(data.project.episodes[0]?.id || null);
      setNotice(`已解析 ${data.project.episodes.length} 集，并建立全剧连续性档案。`);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setLoading('');
    }
  }

  async function generatePrompts() {
    if (!project || selectedIds.length === 0) return;
    setLoading('generate');
    setNotice('');
    try {
      const res = await fetch(`${API}/projects/${project.id}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ episodeIds: selectedIds, settings, llm, skillTemplateId })
      });
      const data = await readJson(res);
      setOutputs(data.outputs);
      setActiveEpisodeId(data.outputs[0]?.episodeId || null);
      const keyInfo = data.apiKeySource ? `Key来源：${data.apiKeySource}${data.apiKeyHint ? `（${data.apiKeyHint}）` : ''}` : '';
      const errorMessage = mapLlmError(data.llmError);
      setNotice(data.usedFallback ? `模型调用失败：${errorMessage}。${keyInfo}。当前按 ${data.skillTemplate?.name || '所选模板'} 兜底生成。` : `已调用 ${data.provider} / ${data.model} 按 ${data.skillTemplate?.name || '所选模板'} 生成提示词。${keyInfo ? ` ${keyInfo}。` : ''}`);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setLoading('');
    }
  }

  async function uploadSkillTemplate(event) {
    const skillFile = event.target.files?.[0];
    if (!skillFile) return;
    setLoading('skill-upload');
    try {
      const form = new FormData();
      form.append('skillFile', skillFile);
      form.append('name', skillFile.name.replace(/\.[^.]+$/, ''));
      const data = await readJson(await fetch(`${API}/skill-templates/upload`, { method: 'POST', body: form }));
      await loadSkillTemplates();
      if (data.template?.id) setSkillTemplateId(data.template.id);
      setNotice('已上传并选中新 SKILL 模板。');
    } catch (error) {
      setNotice(error.message);
    } finally {
      event.target.value = '';
      setLoading('');
    }
  }

  async function copyCurrent() {
    const text = activeModule === 'all' ? selectedOutput?.markdown : selectedOutput?.modules?.[activeModule];
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setNotice('已复制当前内容。');
  }

  async function exportCurrent(format) {
    if (!selectedOutput?.markdown) return;
    setLoading(`export-${format}`);
    try {
      const res = await fetch(`${API}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          format,
          title: `${selectedOutput.title}_视频提示词_V1.9.3`,
          markdown: selectedOutput.markdown
        })
      });
      const data = await readJson(res);
      window.open(`${FILE_ORIGIN}${data.url}`, '_blank');
      setNotice(`已导出 ${format.toUpperCase()} 文件。`);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setLoading('');
    }
  }

  function toggleEpisode(id) {
    setSelectedIds((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]);
  }

  function selectAll() {
    if (!project) return;
    const allIds = project.episodes.map((ep) => ep.id);
    setSelectedIds(selectedIds.length === allIds.length ? [] : allIds);
  }

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">AI 漫剧提示词智能体</p>
          <h1>剧集级提示词生成工作台</h1>
        </div>
        <div className="status-pill">{project ? `${project.episodes.length} 集已解析` : '等待上传剧本'}</div>
      </section>

      <section className="workspace">
        <aside className="panel input-panel">
          <div className="panel-title">
            <FileText size={18} />
            <span>整剧输入</span>
          </div>
          <label className="upload-box">
            <Upload size={18} />
            <span>{file ? file.name : '上传 TXT / DOCX'}</span>
            <input
              type="file"
              accept=".txt,.md,.docx"
              onChange={(event) => setFile(event.target.files?.[0] || null)}
            />
          </label>
          <textarea value={script} onChange={(event) => setScript(event.target.value)} />
          <button className="primary" onClick={parseProject} disabled={loading === 'parse'}>
            {loading === 'parse' ? <RefreshCw className="spin" size={18} /> : <Layers size={18} />}
            解析剧集
          </button>
        </aside>

        <section className="panel center-panel">
          <div className="panel-title">
            <Layers size={18} />
            <span>剧集选择</span>
          </div>

          {!project ? (
            <div className="empty-state">上传或粘贴整部剧本后，系统会先拆分剧集并建立连续性档案。</div>
          ) : (
            <>
              <div className="selector-row">
                <button className="secondary" onClick={selectAll}>
                  {selectedIds.length === project.episodes.length ? <CheckSquare size={17} /> : <Square size={17} />}
                  全选剧集
                </button>
                <span>{selectedIds.length} / {project.episodes.length} 已选择</span>
              </div>

              <div className="episode-list">
                {project.episodes.map((episode) => (
                  <button
                    key={episode.id}
                    className={`episode-item ${selectedIds.includes(episode.id) ? 'selected' : ''}`}
                    onClick={() => toggleEpisode(episode.id)}
                  >
                    <span className="episode-number">第 {episode.number} 集</span>
                    <strong>{episode.title}</strong>
                    <small>{episode.summary}</small>
                  </button>
                ))}
              </div>

              <div className="settings-grid">
                <div className="skill-template-row">
                  <SelectField
                    label="提示词模板 / SKILL"
                    value={skillTemplateId}
                    options={skillTemplates.map((template) => template.id)}
                    optionLabels={Object.fromEntries(skillTemplates.map((template) => [template.id, `${template.name} - ${template.description || template.fileName}`]))}
                    onChange={setSkillTemplateId}
                  />
                  <label className="secondary upload-skill-button">
                    <Upload size={17} />
                    上传 SKILL
                    <input type="file" accept=".txt,.md" onChange={uploadSkillTemplate} />
                  </label>
                </div>
                <SelectField
                  label="画幅"
                  value={settings.aspectRatio}
                  options={['9:16', '16:9', '21:9', '2.35:1']}
                  onChange={(value) => setSettings({ ...settings, aspectRatio: value })}
                />
                <SelectField
                  label="视觉风格"
                  value={settings.visualStyle}
                  options={['写实电影感 + 现代都市', '写实电影感 + 古装', '悬疑冷调电影感', '家庭生活质感', '3DCG 动画电影感']}
                  onChange={(value) => setSettings({ ...settings, visualStyle: value })}
                />
                <SelectField
                  label="文戏强度"
                  value={settings.dramaIntensity}
                  options={['低克制', '中等情绪', '高压对峙', '崩溃边缘']}
                  onChange={(value) => setSettings({ ...settings, dramaIntensity: value })}
                />
              </div>

              <div className="model-panel inline-model-panel">
                <div className="panel-title compact">
                  <RefreshCw size={16} />
                  <span>LLM 模型接口</span>
                </div>
                <SelectField
                  label="供应商"
                  value={llm.providerId}
                  options={providers.map((provider) => provider.id)}
                  optionLabels={Object.fromEntries(providers.map((provider) => [provider.id, `${provider.name}${provider.configured ? '（已配置）' : ''}`]))}
                  onChange={(value) => {
                    const provider = providers.find((item) => item.id === value);
                    setAvailableModels(null);
                    setLlm({
                      ...llm,
                      providerId: value,
                      model: provider?.models?.[0] || '',
                      baseUrl: provider?.baseUrl || llm.baseUrl
                    });
                  }}
                />
                <ModelField
                  idKey="inline"
                  label="模型"
                  value={llm.model}
                  options={modelOptions}
                  onChange={(value) => setLlm({ ...llm, model: value })}
                />
                <label className="field">
                  <span>Base URL{selectedProvider && !selectedProvider.allowCustomBaseUrl ? '（该供应商固定）' : ''}</span>
                  <input value={llm.baseUrl} disabled={selectedProvider && !selectedProvider.allowCustomBaseUrl} onChange={(event) => setLlm({ ...llm, baseUrl: event.target.value })} />
                </label>
                <label className="field">
                  <span>本次 API Key（可选，留空使用后端 .env）</span>
                  <input
                    type="password"
                    value={llm.apiKey}
                    placeholder="sk-..."
                    onChange={(event) => setLlm({ ...llm, apiKey: event.target.value })}
                  />
                </label>
                <button className="secondary test-connection" onClick={testConnection} disabled={loading === 'llm-test'}>
                  {loading === 'llm-test' ? <RefreshCw className="spin" size={16} /> : <RefreshCw size={16} />}
                  测试连接
                </button>
              </div>

              <button className="primary generate" onClick={generatePrompts} disabled={loading === 'generate' || selectedIds.length === 0}>
                {loading === 'generate' ? <RefreshCw className="spin" size={18} /> : <Play size={18} />}
                生成选中剧集提示词
              </button>
            </>
          )}
        </section>

        <aside className="panel bible-panel">
          <div className="panel-title">
            <CheckSquare size={18} />
            <span>连续性档案</span>
          </div>
          {!project ? (
            <div className="empty-state">解析后会显示角色、场景、道具和上下集承接点。</div>
          ) : (
            <ContinuityBible project={project} />
          )}
        </aside>
      </section>

      <section className="panel output-panel">
        <div className="output-header">
          <div>
            <p className="eyebrow">生成结果</p>
            <h2>{selectedOutput ? selectedOutput.title : '暂无输出'}</h2>
          </div>
          <div className="actions">
            <button className="secondary" onClick={copyCurrent} disabled={!selectedOutput}>
              <Copy size={17} />
              复制
            </button>
            <button className="secondary" onClick={() => exportCurrent('md')} disabled={!selectedOutput}>
              <Download size={17} />
              MD
            </button>
            <button className="secondary" onClick={() => exportCurrent('docx')} disabled={!selectedOutput}>
              <Download size={17} />
              Word
            </button>
            <button className="secondary" onClick={() => exportCurrent('txt')} disabled={!selectedOutput}>
              <Download size={17} />
              TXT
            </button>
          </div>
        </div>

        {outputs.length > 0 && (
          <div className="result-tabs">
            {outputs.map((output) => (
              <button
                key={output.episodeId}
                className={activeEpisodeId === output.episodeId ? 'active' : ''}
                onClick={() => setActiveEpisodeId(output.episodeId)}
              >
                {output.title}
              </button>
            ))}
          </div>
        )}

        <div className="module-tabs">
          {moduleTabs.map((tab) => (
            <button
              key={tab.key}
              className={activeModule === tab.key ? 'active' : ''}
              onClick={() => setActiveModule(tab.key)}
              disabled={!selectedOutput}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <pre className="markdown-view">
          {selectedOutput ? (activeModule === 'all' ? selectedOutput.markdown : selectedOutput.modules?.[activeModule]) : '生成后会在这里展示角色、场景、道具、台词表、分镜视频提示词和自检表。'}
        </pre>
      </section>

      <section className="model-dock">
        <button
          type="button"
          className="model-dock-toggle"
          onClick={() => setShowModelSettings((value) => !value)}
        >
          <RefreshCw size={22} />
          <span>LLM</span>
        </button>

        {showModelSettings && (
          <div className="model-panel bottom-model-panel">
            <div className="panel-title compact">
              <RefreshCw size={16} />
              <span>LLM 模型接口</span>
            </div>
            <SelectField
              label="供应商"
              value={llm.providerId}
              options={providers.map((provider) => provider.id)}
              optionLabels={Object.fromEntries(providers.map((provider) => [provider.id, `${provider.name}${provider.configured ? '（已配置）' : ''}`]))}
              onChange={(value) => {
                const provider = providers.find((item) => item.id === value);
                setAvailableModels(null);
                setLlm({
                  ...llm,
                  providerId: value,
                  model: provider?.models?.[0] || '',
                  baseUrl: provider?.baseUrl || llm.baseUrl
                });
              }}
            />
            <ModelField
              idKey="dock"
              label="模型"
              value={llm.model}
              options={modelOptions}
              onChange={(value) => setLlm({ ...llm, model: value })}
            />
            <label className="field">
              <span>Base URL{selectedProvider && !selectedProvider.allowCustomBaseUrl ? '（该供应商固定）' : ''}</span>
              <input value={llm.baseUrl} disabled={selectedProvider && !selectedProvider.allowCustomBaseUrl} onChange={(event) => setLlm({ ...llm, baseUrl: event.target.value })} />
            </label>
            <label className="field">
              <span>本次 API Key（可选，留空使用后端 .env）</span>
              <input
                type="password"
                value={llm.apiKey}
                placeholder="sk-..."
                onChange={(event) => setLlm({ ...llm, apiKey: event.target.value })}
              />
            </label>
            <button className="secondary test-connection" onClick={testConnection} disabled={loading === 'llm-test'}>
              {loading === 'llm-test' ? <RefreshCw className="spin" size={16} /> : <RefreshCw size={16} />}
              测试连接
            </button>
          </div>
        )}
      </section>

      {notice && <div className="toast">{notice}</div>}
    </main>
  );
}

function SelectField({ label, value, options, optionLabels = {}, onChange }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => <option key={option} value={option}>{optionLabels[option] || option}</option>)}
      </select>
    </label>
  );
}

// 模型字段：可手动输入任意模型名（OpenRouter/自定义供应商需要），同时提供下拉建议。
function ModelField({ idKey, label, value, options, onChange }) {
  const listId = `models-${idKey}`;
  return (
    <label className="field">
      <span>{label}</span>
      <input list={listId} value={value} placeholder="输入或选择模型名" onChange={(event) => onChange(event.target.value)} />
      <datalist id={listId}>
        {options.map((option) => <option key={option} value={option} />)}
      </datalist>
    </label>
  );
}

function ContinuityBible({ project }) {
  return (
    <div className="bible-content">
      <h3>角色</h3>
      {project.bible.characters.length ? project.bible.characters.map((item) => <p key={item.name}><strong>{item.name}</strong>：{item.visual}</p>) : <p>未识别到明确角色名。</p>}
      <h3>场景</h3>
      {project.bible.scenes.map((item) => <p key={item.name}><strong>{item.name}</strong>：{item.description}</p>)}
      <h3>道具</h3>
      {project.bible.props.length ? project.bible.props.map((item) => <p key={item.name}><strong>{item.name}</strong>：{item.rule}</p>) : <p>未识别到关键道具。</p>}
      <h3>上下集承接</h3>
      {project.bible.episodeContinuity.map((item) => (
        <p key={item.episodeId}><strong>{item.title}</strong>：上一集 {item.previousEnding} / 下一集 {item.nextOpening}</p>
      ))}
    </div>
  );
}

async function readJson(res) {
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}

// 把后端 llmError 映射成对用户友好的中文提示。
function mapLlmError(llmError) {
  if (!llmError) return '模型未返回可用内容，已使用本地兜底生成';
  if (llmError.message) return llmError.message;
  const map = {
    missing_api_key: '请在 LLM 设置面板选择供应商并填写你自己的 API Key',
    timeout: '模型响应超时，请重试或换更快的模型',
    network_error: '无法连接到该供应商，请检查 Base URL 与网络',
    insufficient_user_quota: '该 Key 额度不足或不可用',
    invalid_api_key: 'API Key 无效，请检查后重试',
    model_not_found: '该供应商下未找到此模型，请换一个模型名'
  };
  return map[llmError.code] || '模型调用失败，已使用本地兜底生成';
}

const moduleTabs = [
  { key: 'videoPrompts', label: '分镜视频' },
  { key: 'characters', label: '角色' },
  { key: 'scenes', label: '场景' },
  { key: 'props', label: '道具' },
  { key: 'dialogues', label: '台词表' },
  { key: 'selfCheck', label: '自检' },
  { key: 'all', label: '完整文档' }
];

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
