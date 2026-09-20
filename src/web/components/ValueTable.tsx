import type { Hypothesis, SampleResult, ValidationRun } from '../../core/types.js';
import type { StateResponse } from '../api.js';

interface Props {
  state: StateResponse;
  hypotheses: Hypothesis[];
  selectedSample: string | null;
  latestRun: (id: string) => ValidationRun | null;
  onSelectHyp: (id: string) => void;
  onJumpSample: (sampleId: string, offset: number) => void;
  onRerun: (id: string) => void;
}

export function ValueTable({ state, hypotheses, selectedSample, latestRun, onSelectHyp, onJumpSample, onRerun }: Props) {
  const samples = Object.values(state.samples).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return (
    <div className="section-body" style={{ padding: 0, flex: 1, overflow: 'auto' }}>
      {hypotheses.length === 0 && <p className="muted" style={{ padding: 12 }}>尚无假设。在十六进制区域框选字节后点“声明假设”。</p>}
      <table className="grid">
        <thead>
          <tr>
            <th>假设 / 样本</th>
            {samples.map((s) => (
              <th
                key={s.id}
                style={{ maxWidth: 150, fontWeight: s.id === selectedSample ? 800 : 600 }}
                title={s.note}
              >
                {s.note}
                <div className="muted mono" style={{ fontSize: 10 }}>{state.blobs[s.blobId]?.size}B</div>
              </th>
            ))}
            <th></th>
          </tr>
        </thead>
        <tbody>
          {hypotheses.map((h) => {
            const run = latestRun(h.id);
            return (
              <tr key={h.id} className="clickable" onClick={() => onSelectHyp(h.id)}>
                <td>
                  <strong>{h.label}</strong>
                  <div className="muted mono" style={{ fontSize: 10 }}>
                    [{h.start},{h.end}) · {kindLabel(h.spec.kind)}
                  </div>
                </td>
                {samples.map((sample) => {
                  const result: SampleResult | undefined = run?.results.find((r) => r.sampleId === sample.id);
                  if (!result) return <td key={sample.id} className="muted">—</td>;
                  return (
                    <td key={sample.id} style={{ background: sample.id === selectedSample ? 'rgba(78,161,255,.06)' : undefined }}>
                      <span className={`pill ${result.verdict}`}>
                        {result.verdict === 'hit' ? '✓' : result.verdict === 'counterexample' ? '✗' : '⛔'}
                      </span>{' '}
                      <span className="mono" title={result.detail}>
                        {result.verdict === 'hit' ? truncate(result.value) : result.numeric !== undefined ? truncate(result.value) || '反例' : '反例'}
                      </span>
                      {result.verdict !== 'hit' && result.atOffset != null && (
                        <button
                          className="ghost"
                          style={{ marginLeft: 4, padding: '0 5px' }}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            onJumpSample(sample.id, result.atOffset!);
                          }}
                          title={`跳到 0x${result.atOffset.toString(16)}`}
                        >
                          →0x{result.atOffset.toString(16)}
                        </button>
                      )}
                    </td>
                  );
                })}
                <td>
                  <button
                    className="ghost"
                    onClick={(ev) => { ev.stopPropagation(); onRerun(h.id); }}
                    title="对当前全部样本重新验证（产生新的验证记录）"
                  >
                    重验
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function truncate(s: string, n = 22): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function kindLabel(k: string): string {
  return ({ integer: '整数', string: '字符串', enum: '枚举', offset_table: '偏移表', length: '长度', checksum: '校验' } as Record<string, string>)[k] ?? k;
}
