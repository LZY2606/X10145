import { useEffect, useMemo, useRef } from 'react';
import type { ByteRange, Hypothesis } from '../../shared/types';

interface HexViewProps {
  bytes: Uint8Array;
  bytesPerRow?: number;
  selection: ByteRange | null;
  jumpOffset?: number | null;
  hypotheses: Hypothesis[];
  activeHypothesisId?: string | null;
  onSelectRange: (range: ByteRange) => void;
  onByteClick?: (offset: number) => void;
}

const HYP_COLORS = ['#2c5a8f', '#4a7c3a', '#7a5a2c', '#6a3a7a', '#2c7a7a', '#8f3a3a'];

export function HexView({
  bytes,
  bytesPerRow = 16,
  selection,
  jumpOffset,
  hypotheses,
  activeHypothesisId,
  onSelectRange,
  onByteClick,
}: HexViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<number | null>(null);

  useEffect(() => {
    if (jumpOffset === null || jumpOffset === undefined) return;
    const el = containerRef.current?.querySelector(`[data-offset="${jumpOffset}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [jumpOffset, bytes]);

  const rows = useMemo(() => {
    const out: number[][] = [];
    for (let i = 0; i < bytes.length; i += bytesPerRow) {
      out.push(Array.from({ length: Math.min(bytesPerRow, bytes.length - i) }, (_, k) => i + k));
    }
    return out;
  }, [bytes, bytesPerRow]);

  const hypColor = (hypothesisId: string) => {
    const index = hypotheses.findIndex((hypothesis) => hypothesis.id === hypothesisId);
    return HYP_COLORS[((index % HYP_COLORS.length) + HYP_COLORS.length) % HYP_COLORS.length];
  };

  const byteClass = (offset: number): string => {
    const classes: string[] = [];
    if (selection && offset >= selection.start && offset < selection.end) classes.push('hex-select');
    if (offset === jumpOffset) classes.push('hex-jump');
    return classes.join(' ');
  };

  const hypAt = (offset: number): Hypothesis | undefined =>
    hypotheses.find((hypothesis) => offset >= hypothesis.range.start && offset < hypothesis.range.end);

  const handleMouseDown = (offset: number) => {
    dragStart.current = offset;
    onSelectRange({ start: offset, end: offset + 1 });
  };
  const handleMouseEnter = (offset: number) => {
    if (dragStart.current === null) return;
    const start = Math.min(dragStart.current, offset);
    const end = Math.max(dragStart.current, offset) + 1;
    onSelectRange({ start, end });
  };
  const handleUp = () => {
    dragStart.current = null;
  };

  return (
    <div className="hex-wrap" ref={containerRef} onMouseUp={handleUp} onMouseLeave={handleUp}>
      {rows.length === 0 && <div className="muted" style={{ padding: 10 }}>（空样本）</div>}
      {rows.map((row, rowIndex) => (
        <div className="hex-row" key={rowIndex}>
          <span className="hex-offset">{row[0].toString(16).padStart(8, '0')}</span>
          <span className="hex-bytes">
            {row.map((offset) => {
              const hyp = hypAt(offset);
              const style = hyp
                ? {
                    background: hypColor(hyp.id),
                    outline: hyp.id === activeHypothesisId ? '2px solid #fff' : undefined,
                  }
                : undefined;
              return (
                <span
                  key={offset}
                  data-offset={offset}
                  className={byteClass(offset)}
                  style={style}
                  title={hyp ? `${hyp.name} [${hyp.range.start},${hyp.range.end})` : undefined}
                  onMouseDown={() => handleMouseDown(offset)}
                  onMouseEnter={() => handleMouseEnter(offset)}
                  onClick={() => onByteClick?.(offset)}
                >
                  {bytes[offset].toString(16).padStart(2, '0')}
                </span>
              );
            })}
          </span>
          <span className="hex-ascii">
            {row
              .map((offset) => {
                const byte = bytes[offset];
                return byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '·';
              })
              .join('')}
          </span>
        </div>
      ))}
    </div>
  );
}
