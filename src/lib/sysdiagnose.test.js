import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extract, analyze } from './sysdiagnose.js';

const vendors = JSON.parse(readFileSync(new URL('../data/vendors.json', import.meta.url)));

const TREE = `+-o Root  <class IORegistryEntry>
  | {
  |   "product-name" = <"iPhone 15 Pro">
  |   "model" = <"iPhone16,1">
  | }
  +-o disp0  <class IOPlatformDevice>
  |   "raw-panel-serial-number" = <47394e3132333435363738393031323334352b412b41>
  +-o baseband-pcie@0  <class IOPCIDevice>
  |   "vendor-id" = <cb170000>
`;
const SERVICE = `+-o AppleSmartBattery  <class AppleSmartBattery>
    {
      "Serial" = "F8Y12345ABCDEFGHIJ"
    }
+-o AppleWLANDriver  <class IOUserService>
      "CFBundleIdentifier" = "com.apple.driver.AppleBCMWLANCore"
`;

test('extracts ioreg files from a real tar.gz with long paths and analyzes them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sd-'));
  const root = 'sysdiagnose_2026.09.23_11-39-00+0800_iPhone-OS_iPhone_23A341_with_a_very_long_name_to_force_pax_headers';
  mkdirSync(join(dir, root, 'ioreg'), { recursive: true });
  writeFileSync(join(dir, root, 'big.bin'), Buffer.alloc(3_000_000, 7));
  writeFileSync(join(dir, root, 'ioreg', 'IODeviceTree.txt'), TREE);
  writeFileSync(join(dir, root, 'ioreg', 'IOService.txt'), SERVICE);
  execSync(`tar -czf out.tar.gz ${root}`, { cwd: dir });

  const file = new File([readFileSync(join(dir, 'out.tar.gz'))], 'out.tar.gz');
  const files = await extract(file);
  assert.equal(files['IODeviceTree.txt'], TREE);
  assert.equal(files['IOService.txt'], SERVICE);

  const { device, rows } = analyze(files, vendors);
  assert.equal(device, 'iPhone 15 Pro');
  const r = Object.fromEntries(rows.map((x) => [x.key, x]));
  assert.equal(r.display.vendor, 'Samsung Display');
  assert.equal(r.display.rank, '高');
  assert.equal(r.display.serial, 'G9N123456789012345');
  assert.equal(r.battery.vendor, 'Sunwoda 欣旺達');
  assert.equal(r.baseband.vendor, 'Qualcomm 高通');
  assert.equal(r.wifi.vendor, 'Broadcom 博通');
});

// Real ioreg dumps from an iPhone 18 Pro on iOS 27 (not committed; skipped when absent).
const real = new URL('../../test-data/', import.meta.url);
test('real iPhone 18 Pro ioreg dump', { skip: !existsSync(real) }, () => {
  const files = Object.fromEntries(['IODeviceTree.txt', 'IOService.txt'].map((n) => [n, readFileSync(new URL(n, real), 'utf8')]));
  const { device, rows } = analyze(files, vendors);
  assert.equal(device, 'iPhone 18 Pro');
  const r = Object.fromEntries(rows.map((x) => [x.key, x]));
  assert.equal(r.display.serial, 'G9NHVNW0WUL0000WH0');
  assert.equal(r.display.vendor, 'Samsung Display');
  assert.equal(r.battery.serial, 'FQ1HVE001N70001HZS');
  assert.equal(r.baseband.vendor, 'Apple（C 系列）');
  assert.equal(r.wifi.vendor, 'Apple N1（Proxima）');
  const { modelId, build, score } = analyze(files, vendors);
  assert.equal(modelId, 'iPhone19,2');
  assert.equal(build, '24A427');
  assert.equal(score, 100); // display, baseband, wifi all 高; battery unranked
  assert.equal(r.ram.vendor, 'Samsung 三星');
  assert.equal(r.ram.serial, 'LPDDR5 · 12 GB');
  assert.equal(r.storage.vendor, 'Kioxia 鎧俠（原 Toshiba）');
  assert.equal(r.storage.serial, 'TLC · 256 GB');
  const d = Object.fromEntries(analyze(files, vendors).details.flatMap((g) => g.items.map((i) => [i.k, i.v])));
  assert.equal(d['晶片'], 'Apple A20 Pro（T8160）');
  assert.equal(d['最大容量'], '100%');
  assert.equal(d['充電循環'], '1');
  assert.equal(d['設計容量'], '4013 mAh');
  assert.equal(d['主鏡頭'], 'DN8HVK07LSC0000Y2M');
  assert.equal(d['LiDAR 光達'], 'GCFHUT022E7000174Q');
  assert.equal(d['震動馬達'], 'LCSHV901AXA000185F');
});
