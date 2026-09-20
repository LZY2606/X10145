import { useMemo, useState } from 'react';
import { fieldsFromHypotheses, findOverlaps } from '../../shared/store';
import { downloadText } from '../helpers';
import { api } from '../api';
import type { AppState, DraftVersion } from '../../shared/types';

interface DraftsPanelProps {
  state: AppState;
  selectedSampleBytes: Uint8Array | null;
  onPublished: () => void;
  onJump?: (offset: number) => void;
}

export function DraftsPanel({ state, selectedSampleBytes, onPublished, onJump }: DraftsPanelProps) {
  const activeHypotheses = Object.values(state.hypotheses).filter((hypothesis) => !hypothesis.retired);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [label, setLabel] = useState('初版格式');
  const [notes, setNotes] = useState('');
  const [winners, setWinners] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [parserResult, setParserResult] = useState<null | {
    version: number;
    ok: boolean;
    errors: Array<{ path: string; offset: number; message: string }>;
  }>(null);

  const fields = useMemo(
    () => fieldsFromHypotheses(state.hypotheses, [...chosen].filter((id) => chosen.has(id))),
    [state.hypotheses, chosen],
  );
  const overlaps = useMemo(() => findOverlaps(fields), [fields]);

  const toggle = (id: string) => {
    const nextSet = new Set(chosen);
    if (nextSet.has(id)) nextSet.delete(id);
    else nextSet.add(id);
    setChosen(nextSet);
  };

  const publish = async () => {
    setError('');
    try {
      const draft = await api.publishDraft({
        hypothesisIds: [...chosen],
        label,
        notes,
        adjudications: overlaps.map((pair) => ({
          fieldAId: pair.fieldA.id,
          fieldBId: pair.fieldB.id,
          winnerFieldId: winners[`${pair.fieldA.id}|${pair.fieldB.id}`] ?? pair.fieldA.id,
        })),
      });
      onPublished();
      setChosen(new Set());
      return draft;
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : String(publishError));
    }
  };

  const tryParse = async (version: number) => {
    if (!selectedSampleBytes) return;
    const result = await api.parseLocally(version, selectedSampleBytes);
    setParserResult({ version, ok: result.ok, errors: result.errors });
  };

  return (
    <div>
      <div className="hyp-card">
        <label className="field">
          草案标签
          <input value={label} onChange={(event) => setLabel(event.target.value)} />
        </label>
        <label className="field">
          备注
          <textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </label>
        <div className="small muted" style={{ margin: '6px 0' }}>选择进入本版草案的字段（假设）：</div>
        <div style={{ maxHeight: 150, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 4 }}>
          {activeHypotheses.map((hypothesis) => (
            <label key={hypothesis.id} className="small row" style={{ display: 'flex', gap: 6, padding: '2px 0' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={chosen.has(hypothesis.id)} onChange={() => toggle(hypothesis.id)} />
              {hypothesis.name} <span className="muted">[{hypothesis.range.start},{hypothesis.range.end})</span>
            </label>
          ))}
        </div>

        {overlaps.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div className="small" style={{ color: 'var(--mixed)' }}>
              存在 {overlaps.length} 组重叠解释，发布前必须显式裁决：
            </div>
            {overlaps.map((pair) => {
              const key = `${pair.fieldA.id}|${pair.fieldB.id}`;
              return (
                <div key={key} className="history-item">
                  <div className="small muted">
                    重叠 [{pair.overlap.start},{pair.overlap.end})
                  </div>
                  <label className="small row">
                    <input
                      type="radio"
                      style={{ width: 'auto' }}
                      name={key}
                      checked={(winners[key] ?? pair.fieldA.id) === pair.fieldA.id}
                      onChange={() => setWinners({ ...winners, [key]: pair.fieldA.id })}
                    />
                    保留 {pair.fieldA.name}
                  </label>
                  <label className="small row">
                    <input
                      type="radio"
                      style={{ width: 'auto' }}
                      name={key}
                      checked={winners[key] === pair.fieldB.id}
                      onChange={() => setWinners({ ...winners, [key]: pair.fieldB.id })}
                    />
                    保留 {pair.fieldB.name}
                  </label>
                </div>
              );
            })}
          </div>
        )}

        {error && <div className="error-box">{error}</div>}
        <button
          className="primary"
          style={{ marginTop: 8 }}
          onClick={() => void publish()}
          disabled={chosen.size === 0}
        >
          发布新版本
        </button>
      </div>

      <div>
        {state.drafts
          .slice()
          .reverse()
          .map((draft) => (
            <DraftHistory
              key={draft.id}
              draft={draft}
              onTryParse={() => void tryParse(draft.version)}
              canTryParse={Boolean(selectedSampleBytes)}
            />
          ))}
      </div>

      {parserResult && (
        <div className="hyp-card">
          <div className="spread">
            <strong>生成器解析 v{parserResult.version}</strong>
            <span className={parserResult.ok ? 'status-hit' : 'status-counter'}>
              {parserResult.ok ? '成功' : `${parserResult.errors.length} 处错误`}
            </span>
          </div>
          {parserResult.errors.slice(0, 8).map((item, index) => (
            <div
              key={index}
              className="small"
              style={{ cursor: onJump ? 'pointer' : 'default' }}
              onClick={() => onJump?.(item.offset)}
              title="点击跳转到对应字节"
            >
              <span className="status-counter">✗</span> {item.path} @偏移 {item.offset}: {item.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DraftHistory({
  draft,
  onTryParse,
  canTryParse,
}: {
  draft: DraftVersion;
  onTryParse: () => void;
  canTryParse: boolean;
}) {
  return (
    <div className="draft-card">
      <div className="spread">
        <strong>v{draft.version} {draft.label}</strong>
        <span className="small muted">{new Date(draft.createdAt).toLocaleString('zh-CN')}</span>
      </div>
      <div className="small muted">{draft.fields.length} 个字段 · {draft.adjudications.length} 项重叠裁决</div>
      {draft.notes && <div className="small">{draft.notes}</div>}
      <div className="row" style={{ marginTop: 6 }}>
        <button
          className="tiny"
          onClick={() =>
            api
              .exportDraftText(draft.version)
              .then((text) => downloadText(`draft-v${draft.version}.json`, text, 'application/json'))
          }
        >
          导出稳定 JSON
        </button>
        <button
          className="tiny"
          onClick={() =>
            api
              .generatorText(draft.version)
              .then((text) => downloadText(`parser-v${draft.version}.mjs`, text, 'text/javascript'))
          }
        >
          下载解析生成器
        </button>
        <button className="tiny" disabled={!canTryParse} onClick={onTryParse}>
          用当前样本试解析
        </button>
      </div>
    </div>
  );
}
