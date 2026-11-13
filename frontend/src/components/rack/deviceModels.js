// src/components/rack/deviceModels.js
// Kes biblioteke modela (modeli se ne menjaju tokom sesije) + mapiranje
// SNMP interfejsa uredjaja na portove modela.
import api from '../../services/api';

let listPromise = null;
const modelPromises = new Map();

export function loadModelList() {
  if (!listPromise) {
    listPromise = api.get('/device-models').then(r => r.data)
      .catch(e => { listPromise = null; throw e; });
  }
  return listPromise;
}

export function loadModel(id) {
  if (!modelPromises.has(id)) {
    modelPromises.set(id, api.get(`/device-models/${id}`).then(r => r.data)
      .catch(e => { modelPromises.delete(id); throw e; }));
  }
  return modelPromises.get(id);
}

// IANA ifType: ethernetCsmacd(6), gigabitEthernet(117), fastEther(62)
const ETHERNET_TYPES = new Set(['6', '117', '62']);
const NETWORK_PORT = t => !['usb', 'power', 'console'].includes(t);

function stateOf(iface) {
  if (!iface) return 'unknown';
  if (iface.oper_status === 'notPresent') return 'notPresent';
  if (iface.admin_status === 'down') return 'disabled';
  return iface.oper_status === 'up' ? 'up' : 'down';
}

/**
 * Povezuje portove modela sa SNMP interfejsima uredjaja.
 *  1) po imenu (snmp_name iz modela == if_name)
 *  2) ako model kaze snmp.map = 'ethernet-order': preostali portovi se uparuju
 *     sa preostalim ethernet interfejsima po ifIndex redosledu -- SAMO ako im
 *     je broj isti (inace bi uparivanje bilo nagadjanje). Tako se hvataju
 *     preimenovani portovi na MikroTiku (ether1 -> "WAN").
 * Vraca { state: {port: stanje}, info: {port: tekst}, byPort: {port: iface},
 *         unmatched: [portovi bez interfejsa] }
 */
export function mapInterfaces(model, interfaces) {
  const ifaces = [...(interfaces || [])].sort((a, b) => a.if_index - b.if_index);
  // ime -> interfejs; kad se ime ponavlja (npr. port "10" i VLAN "10" na Arubi),
  // prednost ima ethernet interfejs
  const byName = new Map();
  for (const i of ifaces) {
    const cur = byName.get(i.if_name);
    if (!cur || (!ETHERNET_TYPES.has(String(cur.if_type)) && ETHERNET_TYPES.has(String(i.if_type)))) byName.set(i.if_name, i);
  }
  const ports = (model.ports || []).filter(p => p.snmp_name && NETWORK_PORT(p.type));
  const byPort = {};
  const used = new Set();

  for (const p of ports) {
    const i = byName.get(p.snmp_name);
    if (i) { byPort[p.name] = { iface: i, how: 'ime' }; used.add(i.if_index); }
  }

  const left = ports.filter(p => !byPort[p.name] && !p.combo);
  if (model.snmp?.map === 'ethernet-order' && left.length) {
    const cands = ifaces.filter(i => !used.has(i.if_index) && ETHERNET_TYPES.has(String(i.if_type)));
    if (cands.length === left.length) {
      left.forEach((p, k) => { byPort[p.name] = { iface: cands[k], how: 'redosled' }; used.add(cands[k].if_index); });
    }
  }

  // combo SFP deli interfejs sa RJ45 parom istog imena
  for (const p of ports) {
    if (p.combo && !byPort[p.name]) {
      const twin = ports.find(q => !q.combo && q.name === p.name);
      if (twin && byPort[twin.name]) byPort[p.name] = byPort[twin.name];
    }
  }

  const state = {}, info = {};
  for (const p of ports) {
    const m = byPort[p.name];
    state[p.name] = stateOf(m?.iface);
    info[p.name] = m
      ? `SNMP: ${m.iface.if_name}${m.how === 'redosled' ? ' (po redosledu)' : ''}${m.iface.if_alias ? ` · ${m.iface.if_alias}` : ''}`
      : 'SNMP: nije povezan';
  }
  return { state, info, byPort, unmatched: ports.filter(p => !byPort[p.name]).map(p => p.name) };
}

// Modul u SFP slotu (dokumentacija) dopunjuje SNMP: Aruba/HPE/Allied ne
// javljaju da li je modul ubacen, pa prazan slot izgleda kao "link dole".
// 'none' = korisnik je zapisao da je slot prazan.
export const MODULE_TYPES = new Set(['sfp', 'sfp+', 'sfp28', 'qsfp+']);
export function effectiveState(st, module) {
  if (module === 'none' && (!st || st === 'down' || st === 'unknown')) return 'notPresent';
  return st || 'unknown';
}

/** Stanje po kljucu porta (combo SFP odvojeno od RJ45 para), uz modul. */
export function portStates(model, mapping, modules) {
  if (!model) return undefined;
  if (!mapping && !modules) return undefined;
  const out = {};
  for (const p of model.ports || []) {
    // combo: SNMP stanje deli sa RJ45 parom -- prazan SFP je prazan bez obzira na RJ45
    out[p.key] = p.combo && modules?.[p.key] === 'none' ? 'notPresent'
      : effectiveState(mapping?.state?.[p.name], modules?.[p.key]);
  }
  return out;
}
