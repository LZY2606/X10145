import type { AppState, SampleVerification } from '../../shared/types';

interface CrossSampleTableProps {
  state: AppState;
  onJump: (sampleId: string, offset: number) => void;
}

export function CrossSampleTable({ state, onJump }: CrossSampleTableProps) {
  const samples = state.sampleOrder.map((id) => state.samples[id]).filter(Boolean);
  const hypotheses = Object.values(state.hypotheses).filter((hypothesis) => !hypothesis.retired);

  const cellFor = (
    hypothesisId: string,
    sampleId: string,
  ): SampleVerification | undefined => {
    // Use the most recent verification that actually included this sample, so
    // samples proposed later get their own fresh result instead of appearing
    // missing from the hypothesis' first verification.
    const verifications = state.verifications
      .filter((item) => item.hypothesisId === hypothesisId && item.sampleIds.includes(sampleId))
      .reverse();
    return verifications[0]?.results.find((result) => result.sampleId === sampleId);
  };

  return (
    <div style={{ overflow: 'auto' }}>
      <table className="cross">
        <thead>
          <tr>
            <th>假设 / 样本</th>
            {samples.map((sample) => (
              <th key={sample.id} title={sample.note}>{sample.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {hypotheses.map((hypothesis) => (
            <tr key={hypothesis.id}>
              <td>
                <strong>{hypothesis.name}</strong>
                <div className="small muted">[{hypothesis.range.start},{hypothesis.range.end})</div>
              </td>
              {samples.map((sample) => {
                const result = cellFor(hypothesis.id, sample.id);
                const presentAtProposal = hypothesis.proposedWithSampleIds.includes(sample.id);
                if (!result) {
                  return (
                    <td key={sample.id} className="incon-cell small muted">
                      {presentAtProposal ? '无法判定' : '提出时不存在'}
                    </td>
                  );
                }
                const className =
                  result.status === 'hit'
                    ? 'hit-cell'
                    : result.status === 'counterexample'
                      ? 'counter-cell'
                      : 'incon-cell';
                return (
                  <td
                    key={sample.id}
                    className={`${className} small`}
                    title={result.detail}
                    onClick={() => {
                      if (result.status === 'counterexample' && result.jumpOffset !== undefined) {
                        onJump(sample.id, result.jumpOffset);
                      }
                    }}
                  >
                    <div>{result.observed}</div>
                    <div className="muted">
                      {result.status === 'hit' ? '✓ ' : result.status === 'counterexample' ? '✗ ' : '? '}
                      {result.detail}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {hypotheses.length === 0 && <div className="muted small" style={{ padding: 10 }}>尚无假设。</div>}
    </div>
  );
}
