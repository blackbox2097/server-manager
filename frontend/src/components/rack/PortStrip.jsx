// src/components/rack/PortStrip.jsx
// Traka portova uredjaja u uvecanom prikazu racka (InfraLoom stil): jedan
// kvadrat po portu, boja = stanje, oznaka dole = kabl spreda, ugao = kabl
// pozadi (paneli). Port se identifikuje KLJUCEM (combo SFP: "ime@sfp").
import React from 'react';
import { cableHex, portKey } from './Faceplate';

export const STATE_LABEL = {
  up: 'gore', down: 'dole', disabled: 'isključen (admin)', notPresent: 'prazan / nije prisutan', unknown: 'nema podatka',
};
export const STRIP_HIDDEN = new Set(['power', 'usb', 'outlet']);
export const STRIP_CLS = {
  up:         'bg-green-600 border-green-500 text-white',
  down:       'bg-gray-700 border-gray-600 text-gray-200',
  disabled:   'bg-red-700 border-red-600 text-white',
  notPresent: 'bg-transparent border-dashed border-gray-500 text-gray-400',
  unknown:    'bg-gray-900 border-gray-600 text-gray-300',
};
const CELL_W = 30, CELL_H = 28, CELL_GAP = 4, GROUP_GAP = 10;

function cellOfStrip(i, rows, cols, order) {
  if (rows === 2 && order === 'odd-top')  return [Math.floor(i / 2), i % 2];
  if (rows === 2 && order === 'even-top') return [Math.floor(i / 2), 1 - (i % 2)];
  return [i % cols, Math.floor(i / cols)];
}
const portNum = (name, type) => type === 'console' ? 'C' : ((name.match(/\d+$/) || [])[0] || name.slice(0, 2).toUpperCase());

/**
 * props:
 *  model     -- pun model
 *  states    -- { kljuc: stanje } (vidi portStates u deviceModels.js)
 *  info      -- { imePorta: tekst } dodatak za tooltip (SNMP)
 *  selected  -- kljuc izabranog porta
 *  onPick    -- (kljuc) => void
 *  cables    -- { kljuc: { front: boja|true, rear: boja|true } }
 *  highlight -- Set kljuceva (drugi kraj / trace)
 *  disabled  -- Set kljuceva koji se ne mogu izabrati (npr. zauzeti)
 *  labels    -- { kljuc: oznaka porta }
 */
export default function PortStrip({ model, states, info, selected, onPick, cables, highlight, disabled, labels }) {
  const blocks = (model.front?.blocks || []).filter(b => !STRIP_HIDDEN.has(b.type));
  if (!blocks.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-4">
      {blocks.map((b, bi) => {
        const names = b.from == null ? [b.name] : Array.from({ length: b.to - b.from + 1 }, (_, k) => b.name.replace('{n}', b.from + k));
        const rows = b.layout?.rows || 1, cols = Math.ceil(names.length / rows), gc = b.layout?.group_cols || 0;
        const sfp = b.type.startsWith('sfp') || b.type === 'qsfp+';
        // RACK_NIC_V1: port servera (eno1, iLO...) -- celica sa celim imenom
        const w = b.nic ? Math.max(CELL_W, 10 + 7 * String(b.name).length) : sfp ? CELL_W + 6 : CELL_W;
        const height = rows * (CELL_H + CELL_GAP) - CELL_GAP;
        // STRIP_WRAP_V1: grupe kolona (group_cols) su zasebni elementi koji se
        // prelamaju u novi red kad nema mesta -- bez horizontalnog skrola
        const gsize = gc || cols, ngroups = Math.ceil(cols / gsize);
        const cells = names.map((n, i) => ({ n, i, cr: cellOfStrip(i, rows, cols, b.layout?.order) }));
        return (
          <div key={bi} className="flex flex-wrap min-w-0" style={{ columnGap: GROUP_GAP, rowGap: CELL_GAP + 4 }}>
          {Array.from({ length: ngroups }, (_, g) => {
            const gcols = Math.min(gsize, cols - g * gsize);
            return (
          <div key={g} className="relative flex-shrink-0" style={{ width: gcols * (w + CELL_GAP) - CELL_GAP, height }}>
            {cells.filter(x => Math.floor(x.cr[0] / gsize) === g).map(({ n, cr }) => {
              const key = portKey(n, !!b.combo);
              const [c0, r] = cr, c = c0 - g * gsize;
              const st = states?.[key] || 'unknown';
              const sel = selected === key;
              const hl = highlight?.has(key);
              const off = disabled?.has(key);
              const cab = cables?.[key];
              const title = [
                `${n}${b.combo ? ' (SFP)' : ''}`, `${b.type.toUpperCase()}${b.speed ? ' ' + b.speed : ''}`,
                states ? STATE_LABEL[st] || st : null, info?.[n], labels?.[key] ? `oznaka: ${labels[key]}` : null,
                cab?.front ? 'kabl spreda' : null, cab?.rear ? 'kabl pozadi' : null, off ? 'zauzet' : null,
              ].filter(Boolean).join(' · ');
              return (
                <button key={key} type="button" disabled={off} onClick={() => onPick?.(key)} title={title}
                  className={`absolute border text-[11px] font-mono flex items-center justify-center ${sfp ? 'rounded-sm' : 'rounded'} ${STRIP_CLS[st] || STRIP_CLS.unknown}
                    ${sel ? 'ring-2 ring-white z-[2]' : hl ? 'ring-2 ring-yellow-400 z-[1]' : off ? 'opacity-30 cursor-not-allowed' : 'hover:brightness-125'}`}
                  style={{ left: c * (w + CELL_GAP), top: r * (CELL_H + CELL_GAP), width: w, height: CELL_H }}>
                  {b.nic ? n : portNum(n, b.type)}
                  {cab?.front && <span className="absolute left-1 right-1 bottom-0.5 h-1 rounded-sm border border-black/40"
                    style={{ background: cab.front === true ? '#C9C9C4' : cableHex(cab.front) }} />}
                  {cab?.rear && <span className="absolute right-0.5 top-0.5 w-1.5 h-1.5 rounded-sm border border-black/40"
                    style={{ background: cab.rear === true ? '#C9C9C4' : cableHex(cab.rear) }} />}
                </button>
              );
            })}
          </div>
            );
          })}
          </div>
        );
      })}
    </div>
  );
}
