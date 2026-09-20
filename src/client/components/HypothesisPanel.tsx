import type { AppState } from '../../shared/types';
import { latestVerification } from '../../shared/semantics';
import { statusLabel, typeLabel } from '../helpers';

interface HypothesisPanelProps {
  state: AppState;
  activeId: string | null;
  onSelect: (id: string) => void;
  onRetire: (id: string) => void;
}

export function HypothesisPanel({ state, activeId, onSelect, onRetire }: HypothesisPanelProps) {
  const hypotheses = Object.values(state.hypotheses)
    .filter((hypothesis) => !hypothesis.retired)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return (
    <div>
      {hypotheses.map((hypothesis) => {
        const status = statusLabel(state, hypothesis.id);
        const verification = latestVerification(state, hypothesis.id);
        const history = state.verifications.filter((item) => item.hypothesisId === hypothesis.id);
        return (
          <div
            key={hypothesis.id}
            className={`hyp-card ${hypothesis.id === activeId ? 'active' : ''}`}
            onClick={() => onSelect(hypothesis.id)}
          >
            <div className="hyp-head">
              <span className="hyp-name">{hypothesis.name}</span>
              <span className={`badge ${status.className.replace('status-', '')}`}>{status.label}</span>
            </div>
            <div className="config-summary">
              {typeLabel(hypothesis)} · [{hypothesis.range.start}, {hypothesis.range.end}) ·{' '}
              提出时样本 {hypothesis.proposedWithSampleIds.length} 份
            </div>
            <div className="config-summary">{summarizeConfig(hypothesis.config)}</div>
            {verification && (
              <div className="small">
                命中 {verification.hitSampleIds.length} / {verification.sampleIds.length}
                {verification.counterexampleSampleIds.length > 0 && (
                  <span className="status-counter">
                    {' '}· 反例 {verification.counterexampleSampleIds.length}
                  </span>
                )}
              </div>
            )}
            <details className="small" onClick={(event) => event.stopPropagation()}>
              <summary className="muted">验证历史（{history.length} 次）</summary>
              {history
                .slice()
                .reverse()
                .map((item) => (
                  <div key={item.id} className="history-item">
                    {new Date(item.createdAt).toLocaleString('zh-CN')} — 样本集{' '}
                    {item.sampleIds.length} 份：命中 {item.hitSampleIds.length}、反例{' '}
                    {item.counterexampleSampleIds.length}、无法判定 {item.inconclusiveSampleIds.length}
                  </div>
                ))}
            </details>
            <div style={{ marginTop: 6 }}>
              <button className="tiny danger" onClick={(event) => { event.stopPropagation(); onRetire(hypothesis.id); }}>
                停用
              </button>
            </div>
          </div>
        );
      })}
      {hypotheses.length === 0 && <div className="muted small">在十六进制区拖选字节后提出第一条假设。</div>}
    </div>
  );
}

function summarizeConfig(config: AppState['hypotheses'][string]['config']): string {
  switch (config.type) {
    case 'integer':
      return `${config.intKind} / ${config.endian}`;
    case 'string':
      return `${config.encoding}${config.trimNul ? ' / 去NUL' : ''}`;
    case 'enum':
      return `enum ${config.intKind}，${Object.keys(config.mapping).length} 项`;
    case 'offset':
      return `${config.intKind} / ${config.endian} / base=${config.base} / unit=${config.unit}`;
    case 'length':
      return `${config.intKind} / ${config.endian} / unit=${config.unit} / region=${config.region.kind}`;
    case 'offsetTable':
      return `${config.entryKind} / ${config.endian} / count=${typeof config.count === 'number' ? config.count : '字段'} / base=${config.base}`;
    case 'checksum':
      return `${config.algorithm}，覆盖 ${config.covered.length} 段`;
  }
}
