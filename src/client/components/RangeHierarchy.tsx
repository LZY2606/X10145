import type { ByteRange, Hypothesis } from '../../shared/types';
import { overlaps } from '../../shared/bytes';

interface RangeHierarchyProps {
  bytesLength: number;
  hypotheses: Hypothesis[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const COLORS = ['#2c5a8f', '#4a7c3a', '#7a5a2c', '#6a3a7a', '#2c7a7a', '#8f3a3a', '#3a5a8f'];

export function RangeHierarchy({ bytesLength, hypotheses, selectedId, onSelect }: RangeHierarchyProps) {
  const ordered = [...hypotheses].sort((a, b) => a.range.start - b.range.start || a.range.end - b.range.end);
  return (
    <div>
      {bytesLength === 0 ? (
        <div className="muted small">无样本</div>
      ) : (
        <div>
          <div className="range-bar" title="0 到文档末尾">
            {ordered.map((hypothesis, index) => {
              const left = (hypothesis.range.start / bytesLength) * 100;
              const width = Math.max(((hypothesis.range.end - hypothesis.range.start) / bytesLength) * 100, 1.2);
              const overlappingOthers = ordered.some(
                (other) => other.id !== hypothesis.id && overlaps(other.range, hypothesis.range),
              );
              return (
                <div
                  key={hypothesis.id}
                  className="range-seg"
                  onClick={() => onSelect(hypothesis.id)}
                  title={`${hypothesis.name} [${hypothesis.range.start},${hypothesis.range.end})${overlappingOthers ? '（存在重叠解释）' : ''}`}
                  style={{
                    left: `${left}%`,
                    width: `${Math.min(width, 100 - left)}%`,
                    background: COLORS[index % COLORS.length],
                    outline: hypothesis.id === selectedId ? '2px solid #fff' : overlappingOthers ? '2px dashed #ffc857' : undefined,
                  }}
                >
                  {width > 8 ? hypothesis.name : ''}
                </div>
              );
            })}
          </div>
          <div className="small muted">0 … {bytesLength}（黄色虚线表示重叠解释，发布草案时必须裁决）</div>
          <div style={{ marginTop: 6 }}>
            {ordered.map((hypothesis) => (
              <RangeNode key={hypothesis.id} hypothesis={hypothesis} all={ordered} selected={selectedId === hypothesis.id} onSelect={onSelect} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function RangeNode({
  hypothesis,
  all,
  selected,
  onSelect,
}: {
  hypothesis: Hypothesis;
  all: Hypothesis[];
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const parents = all.filter(
    (other) =>
      other.id !== hypothesis.id &&
      other.range.start <= hypothesis.range.start &&
      other.range.end >= hypothesis.range.end &&
      (other.range.start !== hypothesis.range.start || other.range.end !== hypothesis.range.end || other.id < hypothesis.id),
  );
  const depth = parents.length;
  const overlapping = all.filter((other) => other.id !== hypothesis.id && overlaps(other.range, hypothesis.range));
  return (
    <div
      onClick={() => onSelect(hypothesis.id)}
      className={`small ${selected ? 'status-hit' : ''}`}
      style={{ paddingLeft: depth * 14 + 4, cursor: 'pointer', padding: `2px 4px 2px ${depth * 14 + 4}px` }}
      title={JSON.stringify(hypothesis.config, null, 0)}
    >
      {hypothesis.name} <span className="muted">[{hypothesis.range.start},{hypothesis.range.end})</span>
      {overlapping.length > 0 && (
        <span className="badge mixed" style={{ marginLeft: 6 }}>
          与 {overlapping.map((other) => other.name).join('、')} 重叠
        </span>
      )}
    </div>
  );
}

export function overlapPairs(hypotheses: Hypothesis[]): Array<[Hypothesis, Hypothesis, ByteRange]> {
  const pairs: Array<[Hypothesis, Hypothesis, ByteRange]> = [];
  for (let i = 0; i < hypotheses.length; i++) {
    for (let j = i + 1; j < hypotheses.length; j++) {
      const a = hypotheses[i];
      const b = hypotheses[j];
      if (overlaps(a.range, b.range)) {
        pairs.push([a, b, { start: Math.max(a.range.start, b.range.start), end: Math.min(a.range.end, b.range.end) }]);
      }
    }
  }
  return pairs;
}
