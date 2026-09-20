import type { StateResponse } from '../api.js';

interface Props {
  state: StateResponse;
  onConfirm: (id: string) => Promise<void>;
  onDismiss: (id: string) => Promise<void>;
}

export function CandidatePanel({ state, onConfirm, onDismiss }: Props) {
  const candidates = Object.values(state.candidates).sort((a, b) => {
    const rank = { proposed: 0, confirmed: 1, dismissed: 2 } as const;
    return rank[a.status] - rank[b.status] || b.supportCount - a.supportCount;
  });

  if (candidates.length === 0) {
    return <p className="muted">暂无候选。至少有一个整数假设和两个样本后，点“重新发现候选”会按变化相关性给出建议；候选始终标明支持样本数，未确认不会进入草案。</p>;
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 8 }}>
      {candidates.map((c) => (
        <div key={c.id} className="cand-item" style={{ cursor: 'default', opacity: c.status === 'dismissed' ? 0.55 : 1 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className={`pill candidate ${c.status}`}>
              {c.status === 'proposed' ? '候选' : c.status === 'confirmed' ? '已确认' : '已忽略'}
            </span>
            <span className="mono muted">[{c.start},{c.end})</span>
          </div>
          <div style={{ margin: '6px 0' }}>{c.description}</div>
          <div className="muted" style={{ fontSize: 11 }}>
            支持样本 <strong style={{ color: c.supportCount === c.totalSamples ? 'var(--hit)' : 'var(--warn)' }}>
              {c.supportCount}/{c.totalSamples}
            </strong>
            {' '}· 类型 {kindLabel(c.kind)} · 更新 {new Date(c.updatedAt).toLocaleString()}
          </div>
          {c.status === 'proposed' && (
            <div className="row" style={{ marginTop: 6 }}>
              <button className="primary" onClick={() => onConfirm(c.id)}>确认并提升为假设</button>
              <button onClick={() => onDismiss(c.id)}>忽略</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function kindLabel(k: string): string {
  return ({ length_relation: '长度关系', checksum_relation: '校验关系', constant: '常量' } as Record<string, string>)[k] ?? k;
}
