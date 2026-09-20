import { useState } from 'react';
import type { Spec, IntSize, Endian } from '../../core/types.js';

interface Props {
  start: number;
  end: number | null;
  hypothesisOptions: { id: string; label: string; start: number; end: number }[];
  onClose: () => void;
  onSubmit: (payload: { label: string; start: number; end: number; spec: Spec }) => Promise<void>;
}

const KIND_LABELS: Record<Spec['kind'], string> = {
  integer: '整数',
  string: '字符串',
  enum: '枚举',
  offset_table: '偏移表',
  length: '长度字段',
  checksum: '校验字段',
};

export function HypothesisForm({ start, end, hypothesisOptions, onClose, onSubmit }: Props) {
  const [label, setLabel] = useState('');
  const [s, setS] = useState(start);
  const [e, setE] = useState(end ?? start + 1);
  const [kind, setKind] = useState<Spec['kind']>('integer');
  const [endian, setEndian] = useState<Endian>('le');
  const [size, setSize] = useState<IntSize>(4);
  const [signed, setSigned] = useState(false);
  const [encoding, setEncoding] = useState<'ascii' | 'utf8'>('ascii');
  const [nullTerm, setNullTerm] = useState(true);
  const [printable, setPrintable] = useState(true);
  const [members, setMembers] = useState('OK=0\nERR=1');
  const [entrySize, setEntrySize] = useState<2 | 4 | 8>(4);
  const [count, setCount] = useState(1);
  const [base, setBase] = useState<'start' | 'end' | 'field_start' | 'region'>('start');
  const [baseRegion, setBaseRegion] = useState(hypothesisOptions[0]?.id ?? '');
  const [unit, setUnit] = useState<1 | 2 | 4>(1);
  const [target, setTarget] = useState<'file' | 'eof_remaining' | 'region'>('file');
  const [targetRegion, setTargetRegion] = useState(hypothesisOptions[0]?.id ?? '');
  const [eofFrom, setEofFrom] = useState(e);
  const [algorithm, setAlgorithm] = useState<'sum8' | 'sum16' | 'xor8'>('sum8');
  const [checksumRangeKind, setChecksumRangeKind] = useState<'absolute' | 'region'>('absolute');
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(start);
  const [rangeRegion, setRangeRegion] = useState(hypothesisOptions[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setError('');
    try {
      let spec: Spec;
      if (kind === 'integer') spec = { kind, endian, size, signed };
      else if (kind === 'string') spec = { kind, encoding, requireNullTerminator: nullTerm, allowPrintableOnly: printable };
      else if (kind === 'enum') {
        const parsed = members
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const [name, raw] = line.split('=');
            const value = Number(raw);
            if (!name || !Number.isFinite(value)) throw new Error(`枚举成员格式错误：${line}`);
            return { name: name.trim(), value };
          });
        spec = { kind, endian, size, signed, members: parsed };
      } else if (kind === 'offset_table') {
        spec = {
          kind,
          endian,
          entrySize,
          count: Math.max(0, Math.floor(count)),
          base:
            base === 'region'
              ? { kind: 'region', hypothesisId: baseRegion }
              : { kind: base },
          unit,
        };
      } else if (kind === 'length') {
        spec = {
          kind,
          endian,
          size,
          signed,
          unit,
          target:
            target === 'region'
              ? { kind: 'region', hypothesisId: targetRegion }
              : target === 'eof_remaining'
                ? { kind: 'eof_remaining', from: eofFrom }
                : { kind: 'file' },
        };
      } else {
        spec = {
          kind,
          endian,
          size,
          algorithm,
          ranges: [
            checksumRangeKind === 'absolute'
              ? { kind: 'absolute', start: rangeStart, end: rangeEnd }
              : { kind: 'region', hypothesisId: rangeRegion },
          ],
        };
      }
      setBusy(true);
      await onSubmit({ label, start: Math.floor(s), end: Math.floor(e), spec });
      onClose();
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(ev) => ev.stopPropagation()}>
        <h3>声明区间假设（半开区间 [start, end)）</h3>
        <div className="form-grid">
          <label className="field wide">
            名称
            <input value={label} onChange={(ev) => setLabel(ev.target.value)} placeholder="例如 magic / payload_len" />
          </label>
          <label className="field">
            起始 start
            <input type="number" value={s} onChange={(ev) => setS(Number(ev.target.value))} />
          </label>
          <label className="field">
            结束 end（不含）
            <input type="number" value={e} onChange={(ev) => setE(Number(ev.target.value))} />
          </label>
          <label className="field">
            类型
            <select value={kind} onChange={(ev) => setKind(ev.target.value as Spec['kind'])}>
              {Object.entries(KIND_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </label>

          {(kind === 'integer' || kind === 'enum' || kind === 'length' || kind === 'checksum') && (
            <>
              <label className="field">
                端序
                <select value={endian} onChange={(ev) => setEndian(ev.target.value as Endian)}>
                  <option value="le">小端 LE</option>
                  <option value="be">大端 BE</option>
                </select>
              </label>
              {kind !== 'checksum' && (
                <label className="field">
                  宽度
                  <select value={size} onChange={(ev) => setSize(Number(ev.target.value) as IntSize)}>
                    {[1, 2, 4, 8].map((n) => <option key={n} value={n}>{n} 字节</option>)}
                  </select>
                </label>
              )}
              {kind === 'checksum' && (
                <label className="field">
                  宽度
                  <select value={size} onChange={(ev) => setSize(Number(ev.target.value) as IntSize)}>
                    {[1, 2].map((n) => <option key={n} value={n}>{n} 字节</option>)}
                  </select>
                </label>
              )}
              {kind !== 'checksum' && (
                <label className="field">
                  符号
                  <select value={String(signed)} onChange={(ev) => setSigned(ev.target.value === 'true')}>
                    <option value="false">无符号</option>
                    <option value="true">有符号</option>
                  </select>
                </label>
              )}
            </>
          )}

          {kind === 'string' && (
            <>
              <label className="field">
                编码
                <select value={encoding} onChange={(ev) => setEncoding(ev.target.value as 'ascii' | 'utf8')}>
                  <option value="ascii">ASCII</option>
                  <option value="utf8">UTF-8</option>
                </select>
              </label>
              <label className="field">
                NUL 终止
                <select value={String(nullTerm)} onChange={(ev) => setNullTerm(ev.target.value === 'true')}>
                  <option value="true">要求</option>
                  <option value="false">不要求</option>
                </select>
              </label>
              <label className="field wide">
                仅可打印字符
                <select value={String(printable)} onChange={(ev) => setPrintable(ev.target.value === 'true')}>
                  <option value="true">是</option>
                  <option value="false">否</option>
                </select>
              </label>
            </>
          )}

          {kind === 'enum' && (
            <label className="field wide">
              成员（每行 名称=数值）
              <textarea rows={4} value={members} onChange={(ev) => setMembers(ev.target.value)} />
            </label>
          )}

          {kind === 'offset_table' && (
            <>
              <label className="field">
                项宽
                <select value={entrySize} onChange={(ev) => setEntrySize(Number(ev.target.value) as 2 | 4 | 8)}>
                  {[2, 4, 8].map((n) => <option key={n} value={n}>{n} 字节</option>)}
                </select>
              </label>
              <label className="field">
                项数
                <input type="number" min={0} value={count} onChange={(ev) => setCount(Number(ev.target.value))} />
              </label>
              <label className="field">
                基准点
                <select value={base} onChange={(ev) => setBase(ev.target.value as typeof base)}>
                  <option value="start">文件起点</option>
                  <option value="field_start">本表起点（相对偏移）</option>
                  <option value="end">文件末尾</option>
                  <option value="region">另一区域起点</option>
                </select>
              </label>
              <label className="field">
                单位
                <select value={unit} onChange={(ev) => setUnit(Number(ev.target.value) as 1 | 2 | 4)}>
                  {[1, 2, 4].map((n) => <option key={n} value={n}>×{n} 字节</option>)}
                </select>
              </label>
              {base === 'region' && (
                <label className="field wide">
                  基准区域
                  <select value={baseRegion} onChange={(ev) => setBaseRegion(ev.target.value)}>
                    {hypothesisOptions.map((h) => <option key={h.id} value={h.id}>{h.label} [{h.start},{h.end})</option>)}
                  </select>
                </label>
              )}
            </>
          )}

          {kind === 'length' && (
            <>
              <label className="field">
                单位
                <select value={unit} onChange={(ev) => setUnit(Number(ev.target.value) as 1 | 2 | 4)}>
                  {[1, 2, 4].map((n) => <option key={n} value={n}>×{n} 字节</option>)}
                </select>
              </label>
              <label className="field">
                目标
                <select value={target} onChange={(ev) => setTarget(ev.target.value as typeof target)}>
                  <option value="file">整个文件长度</option>
                  <option value="eof_remaining">到文件尾的剩余长度</option>
                  <option value="region">另一区域长度</option>
                </select>
              </label>
              {target === 'region' && (
                <label className="field wide">
                  目标区域
                  <select value={targetRegion} onChange={(ev) => setTargetRegion(ev.target.value)}>
                    {hypothesisOptions.map((h) => <option key={h.id} value={h.id}>{h.label} [{h.start},{h.end})</option>)}
                  </select>
                </label>
              )}
              {target === 'eof_remaining' && (
                <label className="field wide">
                  剩余起点 from
                  <input type="number" value={eofFrom} onChange={(ev) => setEofFrom(Number(ev.target.value))} />
                </label>
              )}
            </>
          )}

          {kind === 'checksum' && (
            <>
              <label className="field wide">
                算法
                <select value={algorithm} onChange={(ev) => setAlgorithm(ev.target.value as typeof algorithm)}>
                  <option value="sum8">8 位累加和 sum8</option>
                  <option value="sum16">16 位累加和 sum16</option>
                  <option value="xor8">8 位异或 xor8</option>
                </select>
              </label>
              <label className="field">
                覆盖范围
                <select value={checksumRangeKind} onChange={(ev) => setChecksumRangeKind(ev.target.value as 'absolute' | 'region')}>
                  <option value="absolute">绝对区间</option>
                  <option value="region">引用区域</option>
                </select>
              </label>
              {checksumRangeKind === 'absolute' ? (
                <>
                  <label className="field">
                    覆盖 start
                    <input type="number" value={rangeStart} onChange={(ev) => setRangeStart(Number(ev.target.value))} />
                  </label>
                  <label className="field">
                    覆盖 end
                    <input type="number" value={rangeEnd} onChange={(ev) => setRangeEnd(Number(ev.target.value))} />
                  </label>
                </>
              ) : (
                <label className="field wide">
                  覆盖区域
                  <select value={rangeRegion} onChange={(ev) => setRangeRegion(ev.target.value)}>
                    {hypothesisOptions.map((h) => <option key={h.id} value={h.id}>{h.label} [{h.start},{h.end})</option>)}
                  </select>
                </label>
              )}
            </>
          )}
        </div>

        {error && <p style={{ color: 'var(--miss)' }}>{error}</p>}
        <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
          <button onClick={onClose}>取消</button>
          <button className="primary" disabled={busy} onClick={submit}>提交假设并全样本验证</button>
        </div>
      </div>
    </div>
  );
}
