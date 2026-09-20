import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { HexView } from './components/HexView';
import { HypothesisForm } from './components/HypothesisForm';
import { CrossSampleTable } from './components/CrossSampleTable';
import { RangeHierarchy } from './components/RangeHierarchy';
import { HypothesisPanel } from './components/HypothesisPanel';
import { CandidatesPanel } from './components/CandidatesPanel';
import { DraftsPanel } from './components/DraftsPanel';
import { bytesToBase64Browser, fileToBytes, sampleBytes } from './helpers';
import type { AppState, ByteRange } from '../shared/types';

type Tab = 'hex' | 'table' | 'hierarchy' | 'hypotheses' | 'candidates' | 'drafts';

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [activeSampleId, setActiveSampleId] = useState<string | null>(null);
  const [selection, setSelection] = useState<ByteRange | null>(null);
  const [activeHypothesisId, setActiveHypothesisId] = useState<string | null>(null);
  const [jumpOffset, setJumpOffset] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>('hex');
  const [toast, setToast] = useState('');
  const [uploadName, setUploadName] = useState('');
  const [uploadNote, setUploadNote] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);

  const refresh = useCallback(async () => {
    const next = await api.state();
    setState(next);
    setActiveSampleId((current) => current ?? next.sampleOrder[0] ?? null);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const showToast = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 2600);
  };

  const activeSample = activeSampleId ? state?.samples[activeSampleId] : undefined;
  const bytes = useMemo(() => (state && activeSample ? sampleBytes(state, activeSample) : new Uint8Array()), [state, activeSample]);
  const activeHypotheses = useMemo(
    () => Object.values(state?.hypotheses ?? {}).filter((hypothesis) => !hypothesis.retired),
    [state],
  );

  const uploadFiles = async (files: File[]) => {
    for (const file of files) {
      const data = await fileToBytes(file);
      await api.addSample(
        bytesToBase64Browser(data),
        uploadName.trim() || file.name,
        uploadNote.trim(),
      );
      const nextState = await api.state();
      setState(nextState);
      setActiveSampleId(nextState.sampleOrder[nextState.sampleOrder.length - 1]);
      showToast(`已上传${' '}（${data.length} 字节）：${uploadName.trim() || file.name}`);
    }
    setUploadName('');
    setUploadNote('');
    setPendingFiles([]);
    setPendingCount(0);
    if (fileRef.current) fileRef.current.value = '';
  };

  const selectSample = (id: string) => {
    setActiveSampleId(id);
    setSelection(null);
    setJumpOffset(null);
  };

  const jumpInSample = (sampleId: string, offset: number) => {
    setActiveSampleId(sampleId);
    setJumpOffset(offset);
    setSelection({ start: offset, end: Math.min(offset + 1, state?.samples[sampleId] ? sampleBytes(state!, state.samples[sampleId]).length : offset + 1) });
    setTab('hex');
  };

  const submitHypothesis = async (payload: Parameters<typeof api.addHypothesis>[0]) => {
    const result = await api.addHypothesis(payload);
    await refresh();
    setActiveHypothesisId(result.hypothesis.id);
    showToast(`假设已提出并在全部样本上验证：${result.hypothesis.name}`);
  };

  if (!state) {
    return (
      <div>
        <Header />
        <div style={{ padding: 24 }}>加载中…</div>
      </div>
    );
  }

  return (
    <div>
      <Header />
      <div className="app-shell">
        <div className="column">
          <section className="panel" style={{ flex: '0 0 auto' }}>
            <div className="panel-title">上传样本</div>
            <div className="panel-body">
              <input
                ref={fileRef}
                type="file"
                multiple
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  setPendingFiles(files);
                  setPendingCount(files.length);
                  if (files[0]) setUploadName(files[0].name);
                }}
              />
              <label className="field" style={{ marginTop: 8 }}>
                名称（可留空使用文件名；批量上传时统一使用）
                <input value={uploadName} onChange={(event) => setUploadName(event.target.value)} />
              </label>
              <label className="field">
                来源备注
                <input value={uploadNote} onChange={(event) => setUploadNote(event.target.value)} placeholder="来源 / 版本 / 获取渠道" />
              </label>
              <button
                className="primary"
                disabled={pendingCount === 0}
                onClick={() => void uploadFiles(pendingFiles)}
              >
                添加并验证全部假设
              </button>
            </div>
          </section>

          <section className="panel" style={{ flex: 1 }}>
            <div className="panel-title">样本（{state.sampleOrder.length}）</div>
            <div className="panel-body no-pad">
              {state.sampleOrder.map((id) => {
                const sample = state.samples[id];
                const blob = state.blobs[sample.blobSha256];
                return (
                  <div
                    key={id}
                    className={`sample-item ${id === activeSampleId ? 'active' : ''}`}
                    onClick={() => selectSample(id)}
                  >
                    <div className="name">{sample.name}</div>
                    <div className="meta">
                      {blob.size} B · sha256 {blob.sha256.slice(0, 12)}…
                    </div>
                    {sample.note && <div className="note">📝 {sample.note}</div>}
                  </div>
                );
              })}
              {state.sampleOrder.length === 0 && <div className="muted small" style={{ padding: 10 }}>尚未上传样本。</div>}
            </div>
          </section>
        </div>

        <div className="column">
          <section className="panel" style={{ flex: 1 }}>
            <div className="panel-title">
              <span>
                {activeSample ? activeSample.name : '未选择样本'}
                {activeSample && <span className="muted small"> · {bytes.length} 字节</span>}
              </span>
              <div className="tabs" style={{ borderBottom: 'none', padding: 0 }}>
                <button className={tab === 'hex' ? 'active' : ''} onClick={() => setTab('hex')}>十六进制</button>
                <button className={tab === 'hierarchy' ? 'active' : ''} onClick={() => setTab('hierarchy')}>区间层级</button>
                <button className={tab === 'table' ? 'active' : ''} onClick={() => setTab('table')}>跨样本值表</button>
              </div>
            </div>
            <div className="panel-body no-pad" style={{ flex: 1 }}>
              {tab === 'hex' && (
                <HexView
                  bytes={bytes}
                  selection={selection}
                  jumpOffset={jumpOffset}
                  hypotheses={activeHypotheses}
                  activeHypothesisId={activeHypothesisId}
                  onSelectRange={setSelection}
                />
              )}
              {tab === 'hierarchy' && (
                <div style={{ padding: 10 }}>
                  <RangeHierarchy
                    bytesLength={bytes.length}
                    hypotheses={activeHypotheses}
                    selectedId={activeHypothesisId}
                    onSelect={(id) => {
                      setActiveHypothesisId(id);
                      const hypothesis = state.hypotheses[id];
                      if (hypothesis) {
                        setSelection({ ...hypothesis.range });
                        setJumpOffset(hypothesis.range.start);
                      }
                    }}
                  />
                </div>
              )}
              {tab === 'table' && <CrossSampleTable state={state} onJump={jumpInSample} />}
            </div>
          </section>

          <section className="panel" style={{ flex: '0 0 auto', maxHeight: 300 }}>
            <div className="panel-title">声明假设（区间半开，拖选十六进制可联动）</div>
            <div className="panel-body" style={{ overflow: 'auto' }}>
              {activeSample ? (
                <HypothesisForm
                  selection={selection}
                  sampleLength={bytes.length}
                  hypothesisOptions={activeHypotheses.map((hypothesis) => ({ id: hypothesis.id, name: hypothesis.name }))}
                  onSubmit={submitHypothesis}
                />
              ) : (
                <div className="muted small">请先上传并选择样本。</div>
              )}
            </div>
          </section>
        </div>

        <div className="column">
          <section className="panel" style={{ flex: 1 }}>
            <div className="tabs">
              <button className={tab === 'hypotheses' ? 'active' : ''} onClick={() => setTab('hypotheses')}>假设状态</button>
              <button className={tab === 'candidates' ? 'active' : ''} onClick={() => setTab('candidates')}>候选关系</button>
              <button className={tab === 'drafts' ? 'active' : ''} onClick={() => setTab('drafts')}>格式草案</button>
            </div>
            <div className="panel-body" style={{ flex: 1 }}>
              {(tab === 'hypotheses' || tab === 'hex' || tab === 'hierarchy' || tab === 'table') && (
                <div>
                  <div className="spread" style={{ marginBottom: 8 }}>
                    <span className="small muted">新样本加入后自动产生一次新验证；旧验证结果保留。</span>
                    <button
                      className="tiny"
                      onClick={async () => {
                        await api.verify();
                        await refresh();
                        showToast('已在当前全部样本上重新验证');
                      }}
                    >
                      重新验证全部
                    </button>
                  </div>
                  <HypothesisPanel
                  state={state}
                  activeId={activeHypothesisId}
                  onSelect={(id) => {
                    setActiveHypothesisId(id);
                    const hypothesis = state.hypotheses[id];
                    if (hypothesis && activeSampleId) {
                      setSelection({ ...hypothesis.range });
                      setJumpOffset(hypothesis.range.start);
                      setTab('hex');
                    }
                  }}
                  onRetire={async (id) => {
                    await api.retire(id);
                    await refresh();
                  }}
                  />
                </div>
              )}
              {tab === 'candidates' && (
                <CandidatesPanel
                  state={state}
                  onRefresh={async () => {
                    await api.refreshCandidates();
                    await refresh();
                  }}
                  onConfirm={async (id, name) => {
                    await api.confirmCandidate(id, name);
                    await refresh();
                    showToast('候选已确认为假设并完成全样本验证');
                    setTab('hypotheses');
                  }}
                  onDismiss={async (id) => {
                    await api.dismissCandidate(id);
                    await refresh();
                  }}
                />
              )}
              {tab === 'drafts' && (
                <DraftsPanel
                  state={state}
                  selectedSampleBytes={activeSample ? bytes : null}
                  onPublished={refresh}
                  onJump={(offset) => {
                    setJumpOffset(offset);
                    setSelection({ start: offset, end: Math.min(offset + 1, bytes.length) });
                    setTab('hex');
                  }}
                />
              )}
            </div>
          </section>
        </div>
      </div>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function Header() {
  return (
    <header className="app-header">
      <h1>二进制格式推断台</h1>
      <span className="sub">多样本结构假设 · 命中与反例验证 · 版本化草案 · 稳定 JSON 与解析生成器</span>
    </header>
  );
}
