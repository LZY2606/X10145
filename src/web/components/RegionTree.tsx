import type { Hypothesis, SampleResult } from '../../core/types.js';

interface Props {
  hypotheses: Hypothesis[];
  currentResult: (id: string) => SampleResult | null;
  selectedHyp: string | null;
  onSelect: (id: string) => void;
  onJump: (offset: number) => void;
}

export function RegionTree({ hypotheses, currentResult, selectedHyp, onSelect, onJump }: Props) {
  // Build a containment tree from half-open intervals.
  const roots: Hypothesis[] = [];
  const children = new Map<string, Hypothesis[]>();

  const sorted = [...hypotheses].sort((a, b) => a.start - b.start || b.end - a.end);
  const stack: Hypothesis[] = [];
  for (const h of sorted) {
    while (stack.length && !(stack[stack.length - 1].start <= h.start && h.end <= stack[stack.length - 1].end)) {
      stack.pop();
    }
    if (stack.length === 0) roots.push(h);
    else {
      const parent = stack[stack.length - 1];
      const list = children.get(parent.id) ?? [];
      list.push(h);
      children.set(parent.id, list);
    }
    stack.push(h);
  }

  const renderNode = (h: Hypothesis, depth: number) => {
    const result = currentResult(h.id);
    return (
      <div key={h.id}>
        <div
          className={`tree-region ${depth > 0 ? 'nest' : ''}`}
          style={{
            marginLeft: depth * 12 + 6,
            outline: selectedHyp === h.id ? '1px solid var(--accent)' : undefined,
            borderRadius: 4,
            cursor: 'pointer',
          }}
          onClick={() => onSelect(h.id)}
        >
          <span className="row" style={{ justifyContent: 'space-between' }}>
            <span>
              <strong>{h.label}</strong>{' '}
              <span className="muted mono">
                [{h.start},{h.end}) {kindLabel(h.spec.kind)}
              </span>
            </span>
            <span className="row">
              {result && (
                <span
                  className={`pill ${result.verdict}`}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    if (result.atOffset != null) onJump(result.atOffset);
                  }}
                  title={result.detail ?? ''}
                >
                  {result.verdict === 'hit' ? '命中' : result.verdict === 'counterexample' ? '反例→跳转' : '越界→跳转'}
                </span>
              )}
            </span>
          </span>
          {result && result.verdict !== 'hit' && (
            <div className="muted" style={{ fontSize: 11 }}>{result.detail}</div>
          )}
        </div>
        {(children.get(h.id) ?? []).map((c) => renderNode(c, depth + 1))}
      </div>
    );
  };

  return (
    <div style={{ padding: '6px 4px' }}>
      {roots.length === 0 && <div className="muted" style={{ padding: 8 }}>区间层级将在这里显示（支持嵌套包含关系）。</div>}
      {roots.map((h) => renderNode(h, 0))}
    </div>
  );
}

function kindLabel(k: string): string {
  return (
    {
      integer: '整数',
      string: '字符串',
      enum: '枚举',
      offset_table: '偏移表',
      length: '长度',
      checksum: '校验',
    } as Record<string, string>
  )[k] ?? k;
}
