// Reads a sysdiagnose .tar.gz in the browser and pulls component info out of the ioreg dumps.

export const WANTED = ['IODeviceTree.txt', 'IOService.txt'];

const dec = new TextDecoder();
const str = (b) => dec.decode(b).replace(/\0.*$/s, '');

// Streams a tar (optionally gzipped) and returns { basename: text } for the wanted files.
// Stops reading as soon as all of them are found, so the rest of the (huge) archive is never decompressed.
// onProgress gets 0–1, measured on the compressed bytes read from disk.
export async function extract(file, names = WANTED, onProgress = () => {}) {
  const magic = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  let read = 0;
  let stream = file.stream().pipeThrough(new TransformStream({
    transform(chunk, ctl) {
      read += chunk.length;
      onProgress(read / file.size);
      ctl.enqueue(chunk);
    },
  }));
  if (magic[0] === 0x1f && magic[1] === 0x8b) stream = stream.pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader();

  let buf = new Uint8Array(0);
  const pull = async () => {
    const r = await reader.read();
    if (r.done) return false;
    buf = r.value;
    return true;
  };
  const take = async (n) => {
    const out = new Uint8Array(n);
    let got = 0;
    while (got < n) {
      if (!buf.length && !(await pull())) return null;
      const k = Math.min(n - got, buf.length);
      out.set(buf.subarray(0, k), got);
      buf = buf.subarray(k);
      got += k;
    }
    return out;
  };
  const skip = async (n) => {
    while (n > 0) {
      if (!buf.length && !(await pull())) return;
      const k = Math.min(n, buf.length);
      buf = buf.subarray(k);
      n -= k;
    }
  };

  const found = {};
  let longName = null;
  while (Object.keys(found).length < names.length) {
    const h = await take(512);
    if (!h || h.every((b) => b === 0)) break;
    // ponytail: octal size only; base-256 sizes (>8 GB entries) aren't in sysdiagnose
    const size = parseInt(str(h.subarray(124, 136)).trim(), 8) || 0;
    const type = String.fromCharCode(h[156]);
    const prefix = str(h.subarray(257, 262)) === 'ustar' ? str(h.subarray(345, 500)) : '';
    const name = longName ?? (prefix ? prefix + '/' : '') + str(h.subarray(0, 100));
    longName = null;
    const padded = Math.ceil(size / 512) * 512;
    const base = name.split('/').pop();

    if (type === 'x' || type === 'L') {
      const body = str((await take(padded)).subarray(0, size));
      longName = type === 'L' ? body : body.match(/\d+ path=([^\n]*)\n/)?.[1] ?? null;
    } else if ((type === '0' || type === '\0') && names.includes(base) && name.includes('ioreg/')) {
      found[base] = dec.decode((await take(padded)).subarray(0, size));
    } else {
      await skip(padded);
    }
  }
  reader.cancel().catch(() => {});
  return found;
}

// ioreg prints data blobs as <"text"> or <hex>.
function dataToText(v) {
  if (v.startsWith('"')) return v.replace(/^"|"$/g, '').replace(/\0/g, '');
  return (v.match(/../g) || []).map((h) => String.fromCharCode(parseInt(h, 16))).join('').replace(/\0/g, '');
}

const raw = (text, key) => text.match(new RegExp(`"${key}" = <([^>]*)>`))?.[1] ?? null;
const prop = (text, key) => {
  const v = raw(text, key);
  return v == null ? null : dataToText(v);
};
// Little-endian hex blob -> number, e.g. <0000000003000000> = 12 GiB.
const leNumber = (hex) => (hex ? Number(BigInt('0x' + (hex.match(/../g) || ['00']).reverse().join(''))) : null);
// "Key" = 123 (top level) or "Key"=123 (inside a dict).
const num = (text, key) => {
  const m = text.match(new RegExp(`"${key}" ?= ?(\\d+)`));
  return m ? Number(m[1]) : null;
};
const str1 = (text, key) => text.match(new RegExp(`"${key}" ?= ?"([^"]*)"`))?.[1]?.trim() || null;

const byPrefix = (serial, table) => (serial && table.prefixes[serial.slice(0, 3)]) || null;
// Vendor strings like "Toshiba   " -> the table entry whose key appears in them, else the raw name.
const byName = (name, table) => {
  if (!name) return null;
  const hit = Object.entries(table.names).find(([k]) => name.toLowerCase().includes(k));
  return hit ? hit[1] : { vendor: name, rank: null };
};

// ioreg property -> label for every camera / depth module AppleCamera reports.
const CAMERAS = [
  ['BackCameraModuleSerialNumString', '主鏡頭'],
  ['BackSuperWideCameraModuleSerialNumString', '超廣角'],
  ['BackTeleCameraModuleSerialNumString', '長焦'],
  ['FrontCameraModuleSerialNumString', '前鏡頭'],
  ['FrontIRCameraModuleSerialNumString', 'Face ID 紅外線鏡頭'],
  ['FrontIRStructuredLightProjectorSerialNumString', 'Face ID 點陣投射器'],
  ['JasperSNUM', 'LiDAR 光達'],
];
const CELL = ['', 'SLC', 'MLC', 'TLC', 'QLC'];

// Returns { device, …, rows: vendor cards, details: [{ title, items: [{ k, v, sub? }] }] }.
export function analyze(files, vendors) {
  const tree = files['IODeviceTree.txt'] || '';
  const service = files['IOService.txt'] || '';
  const rows = [];

  const device = prop(tree, 'product-name') || prop(tree, 'model');
  const modelId = prop(tree, 'model');
  const build = str1(tree, 'OS Build Version');
  const soc = tree.match(/RELEASE_ARM64_(T\d{4})/)?.[1] ?? null;

  // Both hold "<module serial>+<more fields>…"; only the first field is the panel serial.
  const panel = (prop(tree, 'raw-panel-serial-number') || service.match(/"Panel_ID" = "([^"]+)/)?.[1])?.split('+')[0] || null;
  rows.push({ key: 'display', serial: panel, ...byPrefix(panel, vendors.display) });

  // Only look inside the AppleSmartBattery node, up to its first child.
  const battIdx = service.indexOf('AppleSmartBattery ');
  const batt = battIdx < 0 ? '' : service.slice(battIdx, service.indexOf('+-o ', battIdx + 20) >>> 0);
  const battery = batt.match(/"Serial" = "([^"]+)"|<key>Serial<\/key>\s*<string>([^<]+)/)?.slice(1).find(Boolean) ?? null;
  rows.push({ key: 'battery', serial: battery, ...byPrefix(battery, vendors.battery) });

  // The modem sits on PCIe; its device-tree node carries a little-endian vendor-id, e.g. <cb170000> = 0x17cb.
  let modem = null;
  for (const block of tree.split('+-o ').slice(1)) {
    const vid = /^baseband/.test(block) && block.match(/"vendor-id" = <([0-9a-f]{4})/)?.[1];
    if (vid) { modem = vid.slice(2, 4) + vid.slice(0, 2); break; }
  }
  rows.push({ key: 'baseband', serial: modem && `PCI vendor 0x${modem}`, ...(modem && vendors.baseband.pciVendors[modem]) });

  // Wi-Fi isn't on PCIe on newer phones; the driver bundle name tells whose chip it is.
  const wifi = Object.keys(vendors.wifi.drivers).find((d) => service.includes(d));
  rows.push({ key: 'wifi', serial: wifi && `driver ${wifi}`, ...(wifi && vendors.wifi.drivers[wifi]) });

  // RAM: the device tree names the DRAM vendor outright.
  const ramGB = leNumber(raw(tree, 'dram-size')) / 2 ** 30 || null;
  const ramType = prop(tree, 'dram-type');
  rows.push({ key: 'ram', serial: [ramType, ramGB && `${ramGB} GB`].filter(Boolean).join(' · ') || null, ...byName(prop(tree, 'dram-vendor'), vendors.ram) });

  // NAND: the storage controller's "Controller Characteristics" dict carries the flash vendor.
  const nand = service.match(/"Controller Characteristics" = \{[^\n]*/)?.[0] ?? '';
  const nandGB = num(nand, 'capacity') && Math.round(num(nand, 'capacity') / 1e9);
  const cell = CELL[num(nand, 'default-bits-per-cell')] || null;
  rows.push({ key: 'storage', serial: [cell, nandGB && `${nandGB} GB`].filter(Boolean).join(' · ') || null, ...byName(str1(nand, 'vendor-name'), vendors.storage) });

  // Overall score: average of ranked parts (高 100 / 中 60 / 低 30); unranked parts don't count.
  const points = rows.map((r) => ({ 高: 100, 中: 60, 低: 30 })[r.rank]).filter(Boolean);
  const score = points.length ? Math.round(points.reduce((a, b) => a + b) / points.length) : null;

  const health = num(batt, 'MaxCapacity');
  const design = num(batt, 'DesignCapacity');
  const full = num(batt, 'FullChargeCapacity') ?? num(batt, 'AppleRawMaxCapacity');
  const details = [
    { title: '裝置', items: [
      { k: '型號', v: device },
      { k: '型號代碼', v: modelId },
      { k: '晶片', v: soc && (vendors.soc[soc] ? `${vendors.soc[soc]}（${soc}）` : soc) },
      { k: 'iOS Build', v: build },
    ] },
    { title: '電池健康度', items: [
      { k: '最大容量', v: health != null ? `${health}%` : null },
      { k: '充電循環', v: num(batt, 'CycleCount')?.toString() },
      { k: '設計容量', v: design && `${design} mAh` },
      { k: '目前滿充容量', v: full && `${full} mAh` },
      { k: '電池序號', v: battery, mono: true },
    ] },
    { title: '記憶體與儲存空間', items: [
      { k: 'RAM', v: [ramGB && `${ramGB} GB`, ramType].filter(Boolean).join(' ') || null },
      { k: '儲存容量', v: nandGB && `${nandGB} GB` },
      { k: 'NAND 類型', v: str1(nand, 'nand-marketing-name')?.split('_').slice(0, 2).join(' ').toUpperCase() ?? cell },
      { k: '儲存控制器', v: str1(service, 'Model Number') },
    ] },
    { title: '相機與感測模組', note: vendors.camera.rankNote, items: CAMERAS.map(([key, k]) => {
      const serial = str1(service, key);
      return { k, v: serial, mono: true, sub: serial && (byPrefix(serial, vendors.camera)?.vendor ?? null) };
    }) },
    { title: '其他零件序號', items: [
      { k: '螢幕面板', v: panel, mono: true },
      { k: '螢幕玻璃', v: prop(tree, 'coverglass-serial-number')?.split('+')[0], mono: true },
      { k: '震動馬達', v: str1(service, 'ModuleSerial')?.split('+')[0], mono: true },
    ] },
  ]
    .map((g) => ({ ...g, items: g.items.filter((i) => i.v) }))
    .filter((g) => g.items.length);

  return {
    device,
    modelId,
    build,
    score,
    details,
    rows: rows.map((r) => ({ ...r, label: vendors[r.key].label, short: vendors[r.key].short, note: vendors[r.key].rankNote })),
  };
}
