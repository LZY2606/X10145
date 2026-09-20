import { useMemo, useState } from 'react';
import type {
  ByteRange,
  ByteUnit,
  ChecksumAlgorithm,
  Endianness,
  HypothesisConfig,
  HypothesisType,
  IntKind,
  OffsetBase,
  RegionSpec,
  StringEncoding,
} from '../../shared/types';

interface HypothesisFormProps {
  selection: ByteRange | null;
  sampleLength: number;
  hypothesisOptions: Array<{ id: string; name: string }>;
  onSubmit: (payload: {
    name: string;
    type: HypothesisType;
    range: ByteRange;
    config: HypothesisConfig;
  }) => Promise<void> | void;
}

const INT_KINDS: IntKind[] = ['u8', 'u16', 'u24', 'u32', 'u64', 'i8', 'i16', 'i24', 'i32', 'i64'];

export function HypothesisForm({ selection, sampleLength, hypothesisOptions, onSubmit }: HypothesisFormProps) {
  const [name, setName] = useState('');
  const [type, setType] = useState<HypothesisType>('integer');
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(1);
  const [endian, setEndian] = useState<Endianness>('little');
  const [intKind, setIntKind] = useState<IntKind>('u16');
  const [encoding, setEncoding] = useState<StringEncoding>('ascii');
  const [trimNul, setTrimNul] = useState(true);
  const [enumText, setEnumText] = useState('0=OK\n1=ERROR');
  const [unit, setUnit] = useState<ByteUnit>(1);
  const [base, setBase] = useState<OffsetBase>('document-start');
  const [anchorField, setAnchorField] = useState<string>('');
  const [entryKind, setEntryKind] = useState<IntKind>('u16');
  const [tableCount, setTableCount] = useState(2);
  const [countField, setCountField] = useState('');
  const [algorithm, setAlgorithm] = useState<ChecksumAlgorithm>('xor8');
  const [coveredField, setCoveredField] = useState('');
  const [error, setError] = useState('');

  useMemo(() => {
    if (selection) {
      setStart(selection.start);
      setEnd(selection.end);
    }
  }, [selection?.start, selection?.end]);

  const validRange = start >= 0 && end > start && end <= sampleLength;

  const buildRegion = (): RegionSpec | null => {
    if (coveredField) {
      return { kind: 'prefixTo', endField: coveredField };
    }
    return { kind: 'fixed', start: 0, end: start };
  };

  const handleSubmit = async () => {
    setError('');
    if (!name.trim()) {
      setError('请填写字段名称');
      return;
    }
    if (!validRange) {
      setError(`半开区间非法或超出样本长度 ${sampleLength}`);
      return;
    }
    const range: ByteRange = { start, end };
    let config: HypothesisConfig;
    try {
      switch (type) {
        case 'integer':
          config = { type, intKind, endian };
          break;
        case 'string':
          config = { type, encoding, trimNul };
          break;
        case 'enum': {
          const mapping: Record<string, string> = {};
          for (const line of enumText.split('\n')) {
            const eq = line.indexOf('=');
            if (eq <= 0) continue;
            mapping[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
          }
          config = { type, intKind, endian, mapping };
          break;
        }
        case 'offset':
          config = {
            type,
            intKind,
            endian,
            base,
            unit,
            anchorField: base === 'field-start' || base === 'field-end' ? anchorField || null : null,
          };
          break;
        case 'length':
          config = {
            type,
            intKind,
            endian,
            unit,
            region: coveredField
              ? { kind: 'between', startField: coveredField, endField: '__SELF__' }
              : { kind: 'fixed', start: 0, end: start },
          };
          break;
        case 'offsetTable':
          config = {
            type,
            entryKind,
            endian,
            unit,
            base,
            anchorField: base === 'field-start' || base === 'field-end' ? anchorField || null : null,
            count: countField ? { field: countField } : tableCount,
          };
          break;
        case 'checksum': {
          const region = buildRegion();
          if (!region) {
            setError('请选择校验覆盖区域');
            return;
          }
          config = { type, algorithm, covered: [region] };
          break;
        }
      }
      await onSubmit({ name: name.trim(), type, range, config });
      setName('');
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    }
  };

  return (
    <div>
      <label className="field">
        字段名称
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 magic / header_length" />
      </label>
      <label className="field">
        类型
        <select value={type} onChange={(event) => setType(event.target.value as HypothesisType)}>
          <option value="integer">整数</option>
          <option value="string">字符串</option>
          <option value="enum">枚举</option>
          <option value="offset">偏移字段</option>
          <option value="length">长度字段</option>
          <option value="offsetTable">偏移表</option>
          <option value="checksum">校验字段</option>
        </select>
      </label>
      <div className="row" style={{ marginBottom: 8 }}>
        <label className="field" style={{ flex: 1, marginBottom: 0 }}>
          起点（含）
          <input type="number" min={0} max={sampleLength} value={start} onChange={(e) => setStart(Number(e.target.value))} />
        </label>
        <label className="field" style={{ flex: 1, marginBottom: 0 }}>
          终点（不含）
          <input type="number" min={0} max={sampleLength} value={end} onChange={(e) => setEnd(Number(e.target.value))} />
        </label>
      </div>
      <div className="small muted" style={{ marginBottom: 8 }}>
        半开区间 [{start},{end}) · {end - start} 字节{selection ? '（已跟随十六进制选区）' : ''}
      </div>

      {(type === 'integer' || type === 'enum' || type === 'offset' || type === 'length') && (
        <div className="row" style={{ marginBottom: 8 }}>
          <label className="field" style={{ flex: 1, marginBottom: 0 }}>
            整数宽度
            <select value={intKind} onChange={(event) => setIntKind(event.target.value as IntKind)}>
              {INT_KINDS.map((kind) => (
                <option key={kind} value={kind}>{kind}</option>
              ))}
            </select>
          </label>
          <label className="field" style={{ flex: 1, marginBottom: 0 }}>
            端序
            <select value={endian} onChange={(event) => setEndian(event.target.value as Endianness)}>
              <option value="little">小端 little</option>
              <option value="big">大端 big</option>
            </select>
          </label>
        </div>
      )}

      {type === 'string' && (
        <div className="row" style={{ marginBottom: 8 }}>
          <label className="field" style={{ flex: 1, marginBottom: 0 }}>
            编码
            <select value={encoding} onChange={(event) => setEncoding(event.target.value as StringEncoding)}>
              <option value="ascii">ASCII</option>
              <option value="utf8">UTF-8</option>
              <option value="latin1">Latin-1</option>
              <option value="utf16le">UTF-16LE</option>
              <option value="utf16be">UTF-16BE</option>
            </select>
          </label>
          <label className="field small row" style={{ flex: 1, marginBottom: 0 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={trimNul} onChange={(event) => setTrimNul(event.target.checked)} />
            去除结尾 NUL
          </label>
        </div>
      )}

      {type === 'enum' && (
        <label className="field">
          枚举映射（每行 值=标签）
          <textarea rows={3} value={enumText} onChange={(event) => setEnumText(event.target.value)} />
        </label>
      )}

      {(type === 'offset' || type === 'length' || type === 'offsetTable') && (
        <label className="field">
          单位（乘倍数）
          <select value={unit} onChange={(event) => setUnit(Number(event.target.value) as ByteUnit)}>
            <option value={1}>1 字节</option>
            <option value={2}>2 字节</option>
            <option value={4}>4 字节</option>
          </select>
        </label>
      )}

      {(type === 'offset' || type === 'offsetTable') && (
        <>
          <label className="field">
            基准点
            <select value={base} onChange={(event) => setBase(event.target.value as OffsetBase)}>
              <option value="document-start">文档开头（绝对偏移）</option>
              <option value="document-end">文档末尾</option>
              <option value="field-start">字段开头</option>
              <option value="field-end">字段结尾</option>
            </select>
          </label>
          {(base === 'field-start' || base === 'field-end') && (
            <label className="field">
              锚点字段
              <select value={anchorField} onChange={(event) => setAnchorField(event.target.value)}>
                <option value="">（选择字段）</option>
                {hypothesisOptions.map((option) => (
                  <option key={option.id} value={option.id}>{option.name}</option>
                ))}
              </select>
            </label>
          )}
        </>
      )}

      {type === 'offsetTable' && (
        <>
          <label className="field">
            表项宽度
            <select value={entryKind} onChange={(event) => setEntryKind(event.target.value as IntKind)}>
              {(['u8', 'u16', 'u24', 'u32'] as IntKind[]).map((kind) => (
                <option key={kind} value={kind}>{kind}</option>
              ))}
            </select>
          </label>
          <div className="row" style={{ marginBottom: 8 }}>
            <label className="field" style={{ flex: 1, marginBottom: 0 }}>
              固定表项数
              <input type="number" min={0} value={tableCount} disabled={Boolean(countField)} onChange={(event) => setTableCount(Number(event.target.value))} />
            </label>
            <label className="field" style={{ flex: 1, marginBottom: 0 }}>
              或引用长度字段
              <select value={countField} onChange={(event) => setCountField(event.target.value)}>
                <option value="">（固定数量）</option>
                {hypothesisOptions.map((option) => (
                  <option key={option.id} value={option.id}>{option.name}</option>
                ))}
              </select>
            </label>
          </div>
        </>
      )}

      {type === 'length' && (
        <label className="field">
          被度量区域（字段之后到本字段，选字段；否则固定 [0, 起点)）
          <select value={coveredField} onChange={(event) => setCoveredField(event.target.value)}>
            <option value="">固定 [0, {start})</option>
            {hypothesisOptions.map((option) => (
              <option key={option.id} value={option.id}>{option.name} 之后 → 本字段</option>
            ))}
          </select>
        </label>
      )}

      {type === 'checksum' && (
        <>
          <label className="field">
            算法
            <select value={algorithm} onChange={(event) => setAlgorithm(event.target.value as ChecksumAlgorithm)}>
              <option value="xor8">XOR-8</option>
              <option value="sum8">SUM-8</option>
              <option value="sum16-le">SUM-16 LE</option>
              <option value="sum16-be">SUM-16 BE</option>
              <option value="crc32-le">CRC-32 LE</option>
              <option value="crc32-be">CRC-32 BE</option>
            </select>
          </label>
          <label className="field">
            覆盖区域（字段之后到本字段，选字段；否则固定 [0, 起点)）
            <select value={coveredField} onChange={(event) => setCoveredField(event.target.value)}>
              <option value="">固定 [0, {start})</option>
              {hypothesisOptions.map((option) => (
                <option key={option.id} value={option.id}>{option.name} 之后 → 本字段</option>
              ))}
            </select>
          </label>
        </>
      )}

      {error && <div className="error-box">{error}</div>}
      <button className="primary" onClick={handleSubmit}>提出假设</button>
    </div>
  );
}
