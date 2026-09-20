import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type StateResponse } from './api.js';
import type { Draft, Hypothesis, SampleResult, ValidationRun } from '../core/types.js';
import { HexViewer } from './components/HexViewer.js';
import { HypothesisForm } from './components/HypothesisForm.js';
import { RegionTree } from './components/RegionTree.js';
import { ValueTable } from './components/ValueTable.js';
import { CandidatePanel } from './components/CandidatePanel.js';
import { DraftPanel } from './components/DraftPanel.js';

const COLORS = [1, 2, 3, 4, 5];

export interface Toast {
  text: string;
  error?: boolean;
}

export function App() {
  const [state, setState] = useState<StateResponse | null>(null);
  const [selectedSample, setSelectedSample] = useState<string | null>(null);
  const [bytes, setBytes] = useState<Uint8Array>(new Uint8Array());
  const [selStart, setSelStart] = useState<number | null>(null);
  const [selEnd, setSelEnd] = useState<number | null>(null);
  const [activeOffset, setActiveOffset] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [selectedHyp, setSelectedHyp] = useState<string | null>(null);
  const [tab, setTab] = useState<'candidates' | 'drafts'>('candidates');
  const [toast, setToast] = useState<Toast | null>(null);
  const [bottomDraft, setBottomDraft] = useState<Draft | null>(null);

  const refresh = useCallback(async () => {
    const s = await api.state();
    setState(s);
    const ids = Object.keys(s.samples).sort();
    setSelectedSample((cur) => (cur && s.samples[cur] ? cur : ids[0] ?? null));
    return s;
  }, []);

  useEffect(() => {
    refresh().catch((e) => setToast({ text: String(e), error: true }));
  }, [refresh]);

  useEffect(() => {
    if (!selectedSample) {
      setBytes(new Uint8Array());
      return;
    }
    api.sampleBytes(selectedSample).then((buf) => setBytes(new Uint8Array(buf)));
    setSelStart(null);
    setSelEnd(null);
    setActiveOffset(null);
  }, [selectedSample]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3800);
    return () => clearTimeout(t);
  }, [toast]);

  const hypotheses = useMemo(
    () => (state ? Object.values(state.hypotheses).sort((a, b) => a.start - b.start || a.end - b.end) : []),
    [state],
  );

  const latestRun = useCallback(
    (hypId: string): ValidationRun | null => {
      if (!state) return null;
      const h = state.hypotheses[hypId];
      if (!h || h.runIds.length === 0) return null;
      return state.runs[h.runIds[h.runIds.length - 1]] ?? null;
    },
    [state],
  );

  const currentResult = useCallback(
    (hypId: string): SampleResult | null => {
      const run = latestRun(hypId);
      if (!run || !selectedSample) return null;
      return run.results.find((r) => r.sampleId === selectedSample) ?? null;
    },
    [latestRun, selectedSample],
  );

  const ranges = useMemo(() => {
    return hypotheses.map((h, i) => {
      const result = currentResult(h.id);
      return {
        start: h.start,
        end: h.end,
        color: COLORS[i % COLORS.length],
        missed: result?.verdict === 'counterexample' || result?.verdict === 'out_of_bounds',
      };
    });
  }, [hypotheses, currentResult]);

  const onByteClick = (offset: number) => {
    if (selStart === null) {
      setSelStart(offset);
      setSelEnd(null);
    } else if (selEnd === null) {
      const lo = Math.min(selStart, offset + 1);
      const hi = Math.max(selStart, offset + 1);
      setSelStart(lo);
      setSelEnd(hi);
    } else {
      setSelStart(offset);
      setSelEnd(null);
    }
    setActiveOffset(offset);
  };

  const jumpTo = (offset: number) => {
    setActiveOffset(offset);
    const el = document.querySelector(`td.byte[title="0x${offset.toString(16)} (${offset})"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  const upload = async (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      const buf = new Uint8Array(await file.arrayBuffer());
      try {
        const r = await api.upload(buf, file.name);
        setToast({ text: r.deduped ? `已上传 ${file.name}（内容去重，复用已有 blob）` : `已上传 ${file.name}` });
      } catch (e) {
        setToast({ text: String((e as Error).message), error: true });
      }
    }
    await refresh();
  };

  if (!state) return <div style={{ padding: 24 }}>加载中…</div>;

  const selectedHypObj = selectedHyp ? state.hypotheses[selectedHyp] : null;
  const overlapPairs = state.overlapPairs ?? [];

  return (
    <>
      <header className="app-header">
        <h1>二进制格式推断台</h1>
        <span className="sub">
          半开区间 · 全样本验证 · 证据留痕 · 版本化草案 {Object.keys(state.samples).length} 个样本 /{' '}
          {Object.keys(state.hypotheses).length} 条假设 / {Object.keys(state.drafts).length} 份草案
        </span>
      </header>

      <div className="layout">
        {/* LEFT: samples */}
        <section className="panel left">
          <h2>
            <span>样本集</span>
            <label className="primary" style={{ padding: '3px 10px', borderRadius: 5, cursor: 'pointer', background: 'var(--accent)', color: '#07131f', fontWeight: 600 }}>
              上传样本
              <input type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
            </label>
          </h2>
          <div className="section-body">
            {Object.values(state.samples).length === 0 && <p className="muted">还没有样本，先上传一个或多个二进制文件。</p>}
            {Object.values(state.samples)
              .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
              .map((sample) => {
                const blob = state.blobs[sample.blobId];
                return (
                  <div
                    key={sample.id}
                    className={`sample-item ${sample.id === selectedSample ? 'active' : ''}`}
                    onClick={() => setSelectedSample(sample.id)}
                  >
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <span className="note">{sample.note}</span>
                      <button
                        className="ghost danger"
                        onClick={(e) => {
                          e.stopPropagation();
                          api.deleteSample(sample.id).then(refresh);
                        }}
                      >
                        删除
                      </button>
                    </div>
                    <div className="muted mono" style={{ fontSize: 11, marginTop: 3 }}>
                      {blob?.size ?? 0} B · {blob?.sha256.slice(0, 12)}…
                    </div>
                  </div>
                );
              })}
          </div>
        </section>

        {/* CENTER: hex + hierarchy */}
        <section className="panel center">
          <h2>
            <span>
              十六进制 {selectedSample ? `· ${state.samples[selectedSample]?.note ?? ''}` : ''}
            </span>
            <span className="row">
              <span className="mono muted">
                {selStart !== null ? `[${selStart}, ${selEnd ?? '?'})` : '点击字节选择区间'}
              </span>
              <button disabled={selStart === null} onClick={() => { setShowForm(true); }}>
                声明假设
              </button>
            </span>
          </h2>
          <div className="legend">
            {hypotheses.map((h, i) => (
              <span key={h.id}>
                <i className={`swatch range-${COLORS[i % COLORS.length]}`} style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2 }} />
                {h.label}
                {(() => {
                  const r = currentResult(h.id);
                  if (!r) return null;
                  return <span className={`pill ${r.verdict}`} style={{ marginLeft: 4 }}>{verdictLabel(r.verdict)}</span>;
                })()}
              </span>
            ))}
          </div>
          <HexViewer
            bytes={bytes}
            ranges={ranges}
            activeOffset={activeOffset}
            hypotheses={hypotheses}
            onByteClick={onByteClick}
            selectedHypothesisId={selectedHyp}
          />
          <div style={{ borderTop: '1px solid var(--border)', maxHeight: 210, overflow: 'auto' }}>
            <RegionTree
              hypotheses={hypotheses}
              currentResult={currentResult}
              selectedHyp={selectedHyp}
              onSelect={(id) => setSelectedHyp(id)}
              onJump={jumpTo}
            />
          </div>
        </section>

        {/* RIGHT: value table + hypothesis status */}
        <section className="panel right">
          <h2><span>跨样本值表 / 假设状态</span></h2>
          <ValueTable
            state={state}
            hypotheses={hypotheses}
            selectedSample={selectedSample}
            latestRun={latestRun}
            onSelectHyp={(id) => setSelectedHyp(id)}
            onJumpSample={(sampleId, offset) => {
              setSelectedSample(sampleId);
              setTimeout(() => jumpTo(offset), 120);
            }}
            onRerun={async (id) => { await api.rerun(id); await refresh(); }}
          />
          {selectedHypObj && (
            <HypothesisDetail
              key={selectedHypObj.id}
              state={state}
              hypothesis={selectedHypObj}
              onClose={() => setSelectedHyp(null)}
            />
          )}
        </section>

        {/* BOTTOM: candidates / drafts */}
        <section className="panel bottom">
          <h2>
            <span className="row">
              <button className={tab === 'candidates' ? 'primary' : ''} onClick={() => setTab('candidates')}>候选关系</button>
              <button className={tab === 'drafts' ? 'primary' : ''} onClick={() => setTab('drafts')}>格式草案</button>
            </span>
            <span>
              {tab === 'candidates' && (
                <button onClick={async () => { await api.discover(); await refresh(); setToast({ text: '已按当前样本重新计算候选与支持数' }); }}>
                  重新发现候选
                </button>
              )}
            </span>
          </h2>
          <div className="section-body">
            {tab === 'candidates' ? (
              <CandidatePanel
                state={state}
                onConfirm={async (id) => {
                  await api.confirmCandidate(id);
                  await refresh();
                  setToast({ text: '候选已确认并提升为假设（需另行加入草案）' });
                }}
                onDismiss={async (id) => { await api.dismissCandidate(id); await refresh(); }}
              />
            ) : (
              <DraftPanel
                state={state}
                overlapPairs={overlapPairs}
                onCreate={async (name) => { await api.createDraft(name); await refresh(); }}
                onPublish={async (draftId, ids, note) => {
                  try {
                    const d = (await api.publishDraft(draftId, ids, note)) as { name: string; publishedVersion: number | null };
                    await refresh();
                    setToast({ text: `已发布 ${d.name} v${d.publishedVersion}` });
                  } catch (e) {
                    setToast({ text: (e as Error).message, error: true });
                    throw e;
                  }
                }}
                onAdjudicate={async (payload) => { await api.adjudicate(payload); await refresh(); }}
                expanded={bottomDraft}
                setExpanded={setBottomDraft}
              />
            )}
          </div>
        </section>
      </div>

      {showForm && (
        <HypothesisForm
          start={selStart ?? 0}
          end={selEnd}
          hypothesisOptions={hypotheses.map((h) => ({ id: h.id, label: h.label, start: h.start, end: h.end }))}
          onClose={() => setShowForm(false)}
          onSubmit={async (payload) => {
            await api.addHypothesis(payload);
            await refresh();
            setToast({ text: '假设已记录，并在全部样本上产生一次验证结果' });
          }}
        />
      )}
      {toast && <div className={`toast ${toast.error ? 'error' : ''}`}>{toast.text}</div>}
    </>
  );
}

function verdictLabel(v: SampleResult['verdict']): string {
  return v === 'hit' ? '命中' : v === 'counterexample' ? '反例' : '越界';
}

function HypothesisDetail({
  state,
  hypothesis,
  onClose,
}: {
  state: StateResponse;
  hypothesis: Hypothesis;
  onClose: () => void;
}) {
  const runs = hypothesis.runIds.map((id) => state.runs[id]).filter(Boolean) as ValidationRun[];
  return (
    <div style={{ borderTop: '1px solid var(--border)', padding: '8px 12px' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>验证历史 · {hypothesis.label}</strong>
        <button className="ghost" onClick={onClose}>关闭</button>
      </div>
      <div className="muted" style={{ margin: '4px 0' }}>
        提出时样本集：{hypothesis.proposedWithSamples.length} 个 · 区间 [{hypothesis.start},{hypothesis.end})
      </div>
      <table className="grid">
        <thead>
          <tr><th>时间/触发</th><th>样本集</th><th>命中</th><th>反例</th><th>越界</th></tr>
        </thead>
        <tbody>
          {runs
            .slice()
            .reverse()
            .map((run) => (
              <tr key={run.id}>
                <td>
                  {new Date(run.at).toLocaleString()}
                  <div className="muted">{triggerLabel(run.trigger)}</div>
                </td>
                <td className="mono">{run.sampleSet.length}</td>
                <td><span className="pill hit">{run.hits}</span></td>
                <td><span className="pill counterexample">{run.counterexamples}</span></td>
                <td><span className="pill out_of_bounds">{run.outOfBounds}</span></td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

function triggerLabel(t: ValidationRun['trigger']): string {
  switch (t) {
    case 'proposal': return '提出假设';
    case 'sample_added': return '追加样本';
    case 'sample_removed': return '移除样本';
    case 'manual': return '手动重验';
  }
}
