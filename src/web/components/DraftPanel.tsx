import { useMemo, useState } from 'react';
import type { Draft, Hypothesis, OverlapPair } from '../../core/types.js';
import type { StateResponse } from '../api.js';
import { api } from '../api.js';

interface Props {
  state: StateResponse;
  overlapPairs: OverlapPair[];
  onCreate: (name: string) => Promise<void>;
  onPublish: (draftId: string, ids: string[], note: string) => Promise<void>;
  onAdjudicate: (payload: { a: string; b: string; winner: string; reason: string }) => Promise<void>;
  expanded: Draft | null;
  setExpanded: (d: Draft | null) => void;
}

export function DraftPanel(props: Props) {
  const { state, onCreate, onPublish, onAdjudicate, expanded, setExpanded } = props;
  const [newName, setNewName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [showExport, setShowExport] = useState<number | null>(null);
  const [exportText, setExportText] = useState('');

  const hypotheses = useMemo(
    () => Object.values(state.hypotheses).sort((a, b) => a.start - b.start),
    [state.hypotheses],
  );

  const selectedOverlaps = useMemo(() => {
    return props.overlapPairs.filter((p) => selected.has(p.a) && selected.has(p.b));
  }, [props.overlapPairs, selected]);

  const unresolved = selectedOverlaps.filter((p) => !p.adjudicated);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const openExport = async (draftId: string, version: number) => {
    const text = await fetch(api.exportUrl(draftId, version)).then((r) => r.text());
    setExportText(text);
    setShowExport(version);
  };

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <div style={{ flex: '0 0 300px' }}>
        <div className="row" style={{ marginBottom: 8 }}>
          <input placeholder="新草案名称" value={newName} onChange={(e) => setNewName(e.target.value)} style={{ flex: 1 }} />
          <button
            className="primary"
            onClick={async () => {
              await onCreate(newName);
              setNewName('');
            }}
          >
            新建
          </button>
        </div>
        {Object.values(state.drafts)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .map((draft) => (
            <div key={draft.id} className={`draft-item ${expanded?.id === draft.id ? 'active' : ''}`} style={{ cursor: 'pointer' }}
              onClick={() => setExpanded(expanded?.id === draft.id ? null : draft)}>
              <strong>{draft.name}</strong>
              <div className="muted">已发布版本：{draft.publishedVersion ?? '未发布'}</div>
            </div>
          ))}
      </div>

      {expanded && (
        <div style={{ flex: 1 }}>
          <div className="muted" style={{ marginBottom: 6 }}>
            勾选进入 <strong>{expanded.name}</strong> 的假设。重叠解释可以暂存，但发布时必须对每对重叠显式裁决。
          </div>
          <div style={{ maxHeight: 110, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 6 }}>
            {hypotheses.map((h: Hypothesis) => (
              <label key={h.id} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: 2 }}>
                <input type="checkbox" checked={selected.has(h.id)} onChange={() => toggle(h.id)} />
                <span>{h.label}</span>
                <span className="mono muted">[{h.start},{h.end}) {h.spec.kind}</span>
              </label>
            ))}
          </div>

          {selectedOverlaps.length > 0 && (
            <div style={{ margin: '8px 0' }}>
              <strong>重叠裁决（{selectedOverlaps.length} 对，{unresolved.length} 对未裁决）</strong>
              {selectedOverlaps.map((p) => (
                <OverlapRow key={`${p.a}|${p.b}`} pair={p} hypotheses={hypotheses} state={state} onAdjudicate={onAdjudicate} />
              ))}
            </div>
          )}

          <div className="row" style={{ marginTop: 8 }}>
            <input placeholder="版本说明" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1 }} />
            <button
              className="primary"
              disabled={selected.size === 0 || unresolved.length > 0}
              title={unresolved.length > 0 ? '仍有重叠未裁决' : ''}
              onClick={async () => {
                try {
                  await onPublish(expanded.id, Array.from(selected), note);
                  setNote('');
                } catch {
                  // surfaced via toast
                }
              }}
            >
              {unresolved.length > 0 ? `先裁决 ${unresolved.length} 对重叠` : '发布新版本'}
            </button>
          </div>

          <div style={{ marginTop: 10 }}>
            {expanded.versions.map((v) => (
              <div key={v.version} className="row" style={{ borderBottom: '1px solid var(--border)', padding: '5px 0' }}>
                <span className="pill hit">v{v.version}</span>
                <span>{v.note}</span>
                <span className="muted">{new Date(v.createdAt).toLocaleString()}</span>
                <span className="mono muted" title={v.canonicalHash}>{v.canonicalHash.slice(0, 18)}…</span>
                <button onClick={() => openExport(expanded.id, v.version)}>稳定 JSON</button>
                <a href={api.parserUrl(expanded.id, v.version)} target="_blank" rel="noreferrer">
                  <button>下载解析器</button>
                </a>
              </div>
            ))}
          </div>
        </div>
      )}

      {showExport !== null && (
        <div className="modal-backdrop" onClick={() => setShowExport(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>稳定 JSON 导出（键排序、可重复哈希）</h3>
            <pre className="export">{exportText}</pre>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button onClick={() => navigator.clipboard.writeText(exportText)}>复制</button>
              <button className="primary" onClick={() => setShowExport(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function OverlapRow({
  pair,
  hypotheses,
  state,
  onAdjudicate,
}: {
  pair: OverlapPair;
  hypotheses: Hypothesis[];
  state: StateResponse;
  onAdjudicate: Props['onAdjudicate'];
}) {
  const a = hypotheses.find((h) => h.id === pair.a) ?? state.hypotheses[pair.a];
  const b = hypotheses.find((h) => h.id === pair.b) ?? state.hypotheses[pair.b];
  const [reason, setReason] = useState('');
  if (!a || !b) return null;
  const adj = state.adjudications[pairKeyOf(a.id, b.id)];

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 6, margin: '5px 0', background: 'var(--panel-2)' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="mono">
          {a.label} [{pair.aStart},{pair.aEnd}) ↔ {b.label} [{pair.bStart},{pair.bEnd})
        </span>
        {pair.adjudicated ? (
          <span className="pill confirmed">
            已裁决：{adj?.winner === a.id ? a.label : b.label}
          </span>
        ) : (
          <span className="pill counterexample">未裁决</span>
        )}
      </div>
      {!pair.adjudicated && (
        <div className="row" style={{ marginTop: 5 }}>
          <button className="primary" onClick={() => onAdjudicate({ a: a.id, b: b.id, winner: a.id, reason })}>采用「{a.label}」</button>
          <button className="primary" onClick={() => onAdjudicate({ a: a.id, b: b.id, winner: b.id, reason })}>采用「{b.label}」</button>
          <input placeholder="裁决理由（可选）" value={reason} onChange={(e) => setReason(e.target.value)} style={{ flex: 1 }} />
        </div>
      )}
      {pair.adjudicated && adj?.reason && <div className="muted" style={{ fontSize: 11 }}>{adj.reason}</div>}
    </div>
  );
}

function pairKeyOf(x: string, y: string): string {
  return [x, y].sort().join('|');
}
