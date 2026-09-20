import { useState } from 'react';
import type { AppState, Candidate } from '../../shared/types';

interface CandidatesPanelProps {
  state: AppState;
  onRefresh: () => void;
  onConfirm: (candidateId: string, name: string) => void;
  onDismiss: (candidateId: string) => void;
}

export function CandidatesPanel({ state, onRefresh, onConfirm, onDismiss }: CandidatesPanelProps) {
  const candidates = Object.values(state.candidates)
    .filter((candidate) => candidate.status === 'proposed')
    .sort((a, b) => b.supportSampleIds.length - a.supportSampleIds.length || a.createdAt.localeCompare(b.createdAt));
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');

  const kindLabel: Record<Candidate['kind'], string> = {
    length: '长度关系',
    offset: '偏移关系',
    checksum: '校验关系',
  };

  return (
    <div>
      <div className="spread" style={{ marginBottom: 8 }}>
        <span className="small muted">候选仅为系统建议，必须人工确认后才成为假设</span>
        <button className="tiny primary" onClick={onRefresh}>重新扫描相关性</button>
      </div>
      {candidates.map((candidate) => (
        <div key={candidate.id} className="cand-card">
          <div className="spread">
            <span className="badge candidate">{kindLabel[candidate.kind]}</span>
            <span className="small muted">[{candidate.fieldRange.start},{candidate.fieldRange.end})</span>
          </div>
          <div style={{ margin: '5px 0' }}>{candidate.summary}</div>
          <div className="small">
            <span className="status-hit">支持 {candidate.supportSampleIds.length} 份</span>
            {candidate.opposingSampleIds.length > 0 && (
              <span className="status-counter"> · 反例 {candidate.opposingSampleIds.length} 份</span>
            )}
            <span className="muted">（{candidate.supportSampleIds.map((id) => state.samples[id]?.name ?? id).join('、')}）</span>
          </div>
          {editing === candidate.id ? (
            <div className="row" style={{ marginTop: 6 }}>
              <input
                value={name}
                placeholder="字段名称"
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && name.trim()) {
                    onConfirm(candidate.id, name.trim());
                    setEditing(null);
                  }
                }}
              />
              <button className="tiny primary" onClick={() => { if (name.trim()) { onConfirm(candidate.id, name.trim()); setEditing(null); } }}>
                确认
              </button>
            </div>
          ) : (
            <div className="row" style={{ marginTop: 6 }}>
              <button
                className="tiny"
                onClick={() => {
                  setEditing(candidate.id);
                  setName(defaultName(candidate));
                }}
              >
                确认为假设
              </button>
              <button className="tiny danger" onClick={() => onDismiss(candidate.id)}>忽略</button>
            </div>
          )}
        </div>
      ))}
      {candidates.length === 0 && (
        <div className="muted small">至少上传两份样本并提出整数类假设后，系统会扫描长度/偏移/校验相关性。</div>
      )}
    </div>
  );
}

function defaultName(candidate: Candidate): string {
  if (candidate.kind === 'length') return 'length_field';
  if (candidate.kind === 'offset') return 'offset_field';
  return 'checksum_field';
}
