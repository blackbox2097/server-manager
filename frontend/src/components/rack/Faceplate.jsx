// src/components/rack/Faceplate.jsx
// Crta prednju (ili zadnju) plocu uredjaja iz JSON modela (biblioteka modela,
// backend/app/device_models). Nema koda po uredjaju -- sve dolazi iz definicije.
//
// SVG koristi MILIMETRE kao jedinice (viewBox u mm), pa je geometrija iz modela
// direktno upotrebljiva; velicinu na ekranu odredjuje roditelj (width 100%).
import React, { useMemo } from 'react';

export const RACK_WIDTH_MM = 482.6;   // 19"
export const U_MM = 44.45;

const PORT_MM = {
  rj45: [13, 11.5], console: [13, 11.5], mgmt: [13, 11.5],
  sfp: [14, 8.5], 'sfp+': [14, 8.5], sfp28: [14, 8.5], 'qsfp+': [18.5, 8.5],
  usb: [13, 5.5], power: [8, 8],
  lc: [12.5, 7], sc: [10, 9.5], outlet: [30, 30],
};
const PORT_GAP = 1.0, ROW_GAP = 2.2, GROUP_GAP = 4.5;

// Stanje porta -> boja (isti kod boja kao u prototipu koji je Ivan odobrio)
export const PORT_COLORS = {
  up:         '#639922',
  down:       '#5F5E5A',
  disabled:   '#A32D2D',   // admin down
  notPresent: 'none',      // prazan SFP / neiskoriscen
  unknown:    '#26282b',   // nema podatka -- "rupa" porta
};
const SELECTED = '#378ADD';

function blockNames(b) {
  if (b.from == null) return [b.name];
  const out = [];
  for (let n = b.from; n <= b.to; n++) out.push(b.name.replace('{n}', n));
  return out;
}

function cellOf(i, rows, cols, order) {
  if (rows === 2 && order === 'odd-top')  return [Math.floor(i / 2), i % 2];
  if (rows === 2 && order === 'even-top') return [Math.floor(i / 2), 1 - (i % 2)];
  return [i % cols, Math.floor(i / cols)];                 // row-major / 1 red
}

/** Geometrija cele ploce: okvir (rack ili samo kuciste) i polozaj kucista. */
export function faceGeometry(model) {
  const f = model.form;
  const inRack = f.mount !== 'none';
  const W = inRack ? RACK_WIDTH_MM : f.body_width_mm;
  const H = inRack ? Math.max(1, f.height_u) * U_MM : (f.body_height_mm || 30);
  const bw = f.body_width_mm;
  const bh = Math.min(f.body_height_mm || H, H);
  const bx = !inRack ? 0
    : f.body_align === 'left' ? (f.mount === 'rack' ? 0 : 20)
    : f.body_align === 'right' ? W - bw - (f.mount === 'rack' ? 0 : 20)
    : (W - bw) / 2;
  const by = (H - bh) / 2;
  return { W, H, bx, by, bw, bh, inRack };
}

/** Raspored portova jedne strane: [{name, type, x, y, w, h, row, rows, block}] */
export function layoutFace(face, geo) {
  if (!face) return [];
  const blocks = face.blocks || [];
  const blockH = b => {
    const [, ph] = PORT_MM[b.type] || PORT_MM.rj45;
    const rows = b.layout?.rows || 1;
    return rows * ph + (rows - 1) * ROW_GAP;
  };
  const maxH = blocks.reduce((m, b) => Math.max(m, blockH(b)), 0);
  const midY = geo.by + geo.bh / 2;
  const out = [];
  let x = geo.bx + (face.start_mm ?? 10);
  blocks.forEach((b, bi) => {
    if (bi > 0) x += b.gap_before_mm ?? 2;
    const names = blockNames(b);
    const [pw, ph] = PORT_MM[b.type] || PORT_MM.rj45;
    const rows = b.layout?.rows || 1;
    const cols = Math.ceil(names.length / rows);
    const gc = b.layout?.group_cols || 0;
    const bh = blockH(b);
    const y0 = b.valign === 'bottom' ? midY + maxH / 2 - bh : midY - bh / 2;
    names.forEach((name, i) => {
      const [c, r] = cellOf(i, rows, cols, b.layout?.order);
      out.push({
        name, type: b.type, speed: b.speed, combo: !!b.combo,
        poe: (b.poe_in || []).includes(name) ? 'in' : b.poe,
        x: x + c * (pw + PORT_GAP) + (gc ? Math.floor(c / gc) * GROUP_GAP : 0),
        y: y0 + r * (ph + ROW_GAP), w: pw, h: ph, row: r, rows, block: bi,
        key: `${bi}:${i}`,
      });
    });
    x += cols * (pw + PORT_GAP) - PORT_GAP + (gc ? Math.floor((cols - 1) / gc) * GROUP_GAP : 0);
  });
  return out;
}

function Ears({ geo, mount }) {
  // Rack usi (ili plocice nosaca) -- od ivice racka do kucista
  const { W, H, bx, bw, by, bh } = geo;
  const plate = mount === 'rack' ? '#8f9092' : '#a9aaac';
  const holes = [];
  const units = Math.round(H / U_MM);
  for (let u = 0; u < units; u++) {
    const cy = u * U_MM + U_MM / 2;
    holes.push(<circle key={`l${u}`} cx={7} cy={cy} r={2.6} fill="#2C2C2A" />);
    holes.push(<circle key={`r${u}`} cx={W - 7} cy={cy} r={2.6} fill="#2C2C2A" />);
  }
  return (
    <g>
      {bx > 0.5 && <rect x={0} y={mount === 'rack' ? by : 0} width={bx} height={mount === 'rack' ? bh : H} fill={plate} />}
      {W - bx - bw > 0.5 && <rect x={bx + bw} y={mount === 'rack' ? by : 0} width={W - bx - bw} height={mount === 'rack' ? bh : H} fill={plate} />}
      {holes}
    </g>
  );
}

function PortShape({ p, fill, selected, notPresent, textColor, showNumber, onClick, title }) {
  const stroke = selected ? SELECTED : notPresent ? '#888780' : '#1a1b1d';
  const common = { onClick, style: onClick ? { cursor: 'pointer' } : undefined };
  const num = (p.name.match(/\d+$/) || [''])[0];
  const numY = p.rows === 2 && p.row === 0 ? p.y - 0.9 : p.y + p.h + 2.6;
  if (p.type === 'power') {
    return (
      <g {...common}><title>{title}</title>
        <circle cx={p.x + p.w / 2} cy={p.y + p.h / 2} r={p.w / 2} fill="#1a1b1d" stroke="#5F5E5A" strokeWidth={0.4} />
        <circle cx={p.x + p.w / 2} cy={p.y + p.h / 2} r={1.2} fill="#888780" />
      </g>
    );
  }
  if (p.type === 'outlet') {
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    return (
      <g {...common}><title>{title}</title>
        <circle cx={cx} cy={cy} r={p.w / 2 - 0.5} fill="#1a1b1d" stroke={selected ? SELECTED : '#5F5E5A'} strokeWidth={0.6} />
        <circle cx={cx} cy={cy} r={p.w / 2 - 4} fill="#26282b" />
        <circle cx={cx - 4.5} cy={cy} r={1.6} fill="#0b0b0b" />
        <circle cx={cx + 4.5} cy={cy} r={1.6} fill="#0b0b0b" />
      </g>
    );
  }
  if (p.type === 'lc' || p.type === 'sc') {
    return (
      <g {...common}><title>{title}</title>
        <rect x={p.x} y={p.y} width={p.w} height={p.h} rx={0.8}
          fill={selected ? SELECTED : fill} stroke={selected ? SELECTED : '#1a1b1d'} strokeWidth={selected ? 0.9 : 0.45} />
        {p.type === 'lc' ? (<>
          <rect x={p.x + 1.6} y={p.y + 1.6} width={p.w / 2 - 2.4} height={p.h - 3.2} fill="#1a1b1d" />
          <rect x={p.x + p.w / 2 + 0.8} y={p.y + 1.6} width={p.w / 2 - 2.4} height={p.h - 3.2} fill="#1a1b1d" />
        </>) : (
          <rect x={p.x + 2} y={p.y + 2} width={p.w - 4} height={p.h - 4} fill="#1a1b1d" />
        )}
        {showNumber && (
          <text x={p.x + p.w / 2} y={p.y + p.h + 2.6} fontSize={2.3} textAnchor="middle" fill={textColor}
            style={{ pointerEvents: 'none', fontFamily: 'Inter, system-ui, sans-serif' }}>{num}</text>
        )}
      </g>
    );
  }
  if (p.type === 'usb') {
    return (
      <g {...common}><title>{title}</title>
        <rect x={p.x} y={p.y} width={p.w} height={p.h} rx={0.6} fill="#1a1b1d" stroke={selected ? SELECTED : '#5F5E5A'} strokeWidth={0.4} />
        <rect x={p.x + 1.5} y={p.y + p.h / 2 - 0.8} width={p.w - 3} height={1.6} fill="#378ADD" opacity={0.8} />
      </g>
    );
  }
  const isRj = p.type === 'rj45' || p.type === 'console' || p.type === 'mgmt';
  return (
    <g {...common}><title>{title}</title>
      <rect x={p.x} y={p.y} width={p.w} height={p.h} rx={0.8}
        fill={selected ? SELECTED : fill} stroke={stroke} strokeWidth={selected ? 0.9 : 0.45}
        strokeDasharray={notPresent && !selected ? '1.4 1' : undefined} />
      {isRj && (
        <rect x={p.x + p.w / 2 - 2.4} y={p.rows === 2 && p.row === 0 ? p.y + p.h - 2.6 : p.y}
          width={4.8} height={2.6} fill="#1a1b1d" />
      )}
      {!isRj && (
        <rect x={p.x + 1.2} y={p.y + p.h / 2 - 0.5} width={p.w - 2.4} height={1} fill="#1a1b1d" opacity={0.6} />
      )}
      {showNumber && num && (
        <text x={p.x + p.w / 2} y={numY} fontSize={2.3} textAnchor="middle" fill={textColor}
          style={{ pointerEvents: 'none', fontFamily: 'Inter, system-ui, sans-serif' }}>{num}</text>
      )}
    </g>
  );
}

// Status iz monitoringa -> boja status LED-a na uredjaju
export const STATUS_LED = {
  online: '#639922', offline: '#E24B4A', warning: '#EF9F27', on_battery: '#EF9F27', low_battery: '#E24B4A',
};

function Decor({ d, geo, statusColor }) {
  const { bx, by, bw, bh } = geo;
  const cy = by + bh / 2;
  const x = bx + (d.x_mm || 0);
  switch (d.kind) {
    case 'handles':
      return (<g>
        <rect x={bx + 2.5} y={by + 4} width={4} height={bh - 8} rx={2} fill="#5F5E5A" />
        <rect x={bx + bw - 6.5} y={by + 4} width={4} height={bh - 8} rx={2} fill="#5F5E5A" />
      </g>);
    case 'status_led':
      return <circle cx={x} cy={cy} r={1.8} fill={statusColor || '#444441'} stroke="#1a1b1d" strokeWidth={0.3} />;
    case 'button':
      return (<g>
        <circle cx={x} cy={cy} r={2.8} fill="#1a1b1d" stroke="#888780" strokeWidth={0.5} />
        <circle cx={x} cy={cy} r={1.1} fill="#5F5E5A" />
      </g>);
    case 'leds': {
      const n = d.count || 1, step = 3.2, y0 = cy - ((n - 1) * step) / 2;
      return <g>{Array.from({ length: n }, (_, i) => <circle key={i} cx={x} cy={y0 + i * step} r={0.9} fill="#3B6D11" />)}</g>;
    }
    case 'lcd':
      return (<g>
        <rect x={x} y={cy - d.h_mm / 2} width={d.w_mm} height={d.h_mm} rx={1} fill="#0f2a35" stroke="#5F5E5A" strokeWidth={0.5} />
        <rect x={x + 2} y={cy - d.h_mm / 2 + 2} width={d.w_mm - 4} height={d.h_mm - 4} fill="#185FA5" opacity={0.35} />
      </g>);
    case 'vent': {
      const h = bh * 0.62, y = cy - h / 2, slots = [];
      for (let sx = x; sx < x + d.w_mm - 1; sx += 3) slots.push(<rect key={sx} x={sx} y={y} width={1.3} height={h} rx={0.6} fill="#1a1b1d" />);
      return <g>{slots}</g>;
    }
    case 'bays': {
      const cols = d.cols || 1, rows = d.rows || 1, w = d.w_mm, h = d.h_mm, g = d.gap_mm ?? 1.5;
      const tot = rows * h + (rows - 1) * g, y0 = cy - tot / 2, out = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const bx2 = x + c * (w + g), by2 = y0 + r * (h + g), tall = h > w;
        out.push(<g key={`${r}:${c}`}>
          <rect x={bx2} y={by2} width={w} height={h} rx={0.8} fill="#3a3d42" stroke="#1a1b1d" strokeWidth={0.4} />
          {tall
            ? <rect x={bx2 + w / 2 - 0.6} y={by2 + 3} width={1.2} height={h - 12} fill="#26282b" />
            : <rect x={bx2 + 3} y={by2 + h / 2 - 0.6} width={w - 12} height={1.2} fill="#26282b" />}
          <circle cx={tall ? bx2 + w / 2 : bx2 + w - 3.5} cy={tall ? by2 + h - 4 : by2 + h / 2} r={0.9} fill="#3B6D11" />
        </g>);
      }
      return <g>{out}</g>;
    }
    default: return null;
  }
}

/**
 * props:
 *  model        -- pun model sa /api/device-models/{id}
 *  side         -- 'front' | 'rear'
 *  portState    -- { [imePorta]: 'up'|'down'|'disabled'|'notPresent'|'unknown' }
 *  portInfo     -- { [imePorta]: string } dodatni tekst za tooltip (npr. SNMP ime)
 *  selected     -- ime izabranog porta
 *  onPortClick  -- (port) => void
 *  showNumbers  -- brojevi iznad/ispod portova (iskljuci u malom rack prikazu)
 *  statusColor  -- boja status LED-a (iz monitoringa), vidi STATUS_LED
 *  className
 */
export default function Faceplate({
  model, side = 'front', portState, portInfo, selected, onPortClick,
  showNumbers = true, className, statusColor,
}) {
  const geo = useMemo(() => faceGeometry(model), [model]);
  const face = side === 'rear' ? model.rear : model.front;
  const ports = useMemo(() => layoutFace(face, geo), [face, geo]);
  const look = model.look || {};
  const { W, H, bx, by, bw, bh, inRack } = geo;

  const leds = [];
  if (face?.leds_mm) {
    const [a, b] = face.leds_mm;
    for (let x = bx + a, i = 0; x < bx + b; x += 4.2, i++) {
      leds.push(<rect key={`a${i}`} x={x} y={by + bh / 2 - 3} width={2.2} height={1.6} fill="#888780" />);
      leds.push(<rect key={`b${i}`} x={x} y={by + bh / 2 + 1.6} width={2.2} height={1.6} fill="#888780" />);
    }
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" className={className} role="img"
      aria-label={`${model.vendor} ${model.model}`} style={{ display: 'block' }}>
      {inRack && <Ears geo={geo} mount={model.form.mount} />}
      <rect x={bx} y={by} width={bw} height={bh} rx={1.2} fill={look.chassis || '#e9e8e4'}
        stroke="#5F5E5A" strokeWidth={0.4} />
      {leds}
      {(face?.decor || []).map((d, i) => <Decor key={`d${i}`} d={d} geo={geo} statusColor={statusColor} />)}
      {face?.label && (
        <text x={bx + face.label.x * bw} y={by + face.label.y * bh + 2.5} fontSize={3.4}
          fill={look.text || '#444441'} style={{ fontFamily: 'Inter, system-ui, sans-serif', pointerEvents: 'none' }}>
          {face.label.text}
        </text>
      )}
      {ports.map(p => {
        const st = portState?.[p.name] || 'unknown';
        const info = portInfo?.[p.name];
        const title = [
          p.name,
          [p.type.toUpperCase(), p.speed, p.poe ? `PoE-${p.poe}` : null, p.combo ? 'combo' : null].filter(Boolean).join(' '),
          portState ? `stanje: ${st}` : null,
          info,
        ].filter(Boolean).join(' · ');
        return (
          <PortShape key={p.key} p={p} title={title}
            fill={PORT_COLORS[st] ?? PORT_COLORS.unknown}
            notPresent={st === 'notPresent'}
            selected={selected === p.name}
            textColor={look.text || '#444441'}
            showNumber={showNumbers && !['usb', 'power', 'console', 'outlet'].includes(p.type)}
            onClick={onPortClick ? e => { e.stopPropagation(); onPortClick(p); } : undefined} />
        );
      })}
    </svg>
  );
}
