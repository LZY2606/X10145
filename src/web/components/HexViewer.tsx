import { useMemo } from 'react';
import type { Hypothesis, SampleResult } from '../../core/types.js';

interface Props {
  bytes: Uint8Array;
  highlightRange?: { start: number; end: number } | null;
  ranges: { start: number; end: number; color: number; missed?: boolean }[];
  activeOffset?: number | null;
  hypotheses: Hypothesis[];
  onByteClick: (offset: number) => void;
  selectedHypothesisId?: string | null;
  sampleResults?: SampleResult[];
}

const ROW = 16;

export function HexViewer(props: Props) {
  const { bytes, ranges, activeOffset, onByteClick } = props;

  const rangeClassAt = useMemo(() => {
    const map = new Map<number, { color: number; missed: boolean }>();
    for (const r of ranges) {
      for (let i = r.start; i < r.end; i++) {
        const existing = map.get(i);
        if (!existing || r.color < existing.color) map.set(i, { color: r.color, missed: !!r.missed });
      }
    }
    return map;
  }, [ranges]);

  const rows = [];
  for (let rowStart = 0; rowStart < bytes.length; rowStart += ROW) {
    const cells = [];
    for (let i = 0; i < ROW; i++) {
      const off = rowStart + i;
      if (off >= bytes.length) {
        cells.push(<td key={i} className="byte pad" style={{ visibility: 'hidden' }}>··</td>);
        continue;
      }
      const hit = rangeClassAt.get(off);
      const cls = ['byte'];
      if (hit) cls.push(`range-${hit.color}`);
      if (hit?.missed) cls.push('range-miss');
      if (off === activeOffset) cls.push('active');
      cells.push(
        <td
          key={i}
          className={cls.join(' ')}
          onClick={() => onByteClick(off)}
          title={`0x${off.toString(16)} (${off})`}
        >
          {bytes[off].toString(16).padStart(2, '0')}
        </td>,
      );
    }
    const ascii = Array.from(bytes.subarray(rowStart, Math.min(rowStart + ROW, bytes.length)))
      .map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '·'))
      .join('');

    const rowActive = activeOffset != null && activeOffset >= rowStart && activeOffset < rowStart + ROW;
    rows.push(
      <tr key={rowStart} className={`hexrow ${rowActive ? 'selected' : ''}`}>
        <td className="off">{rowStart.toString(16).padStart(8, '0')}</td>
        {cells}
        <td className="ascii">{ascii}</td>
      </tr>,
    );
  }

  return (
    <div className="hex-wrap">
      <table className="hex">
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
}
