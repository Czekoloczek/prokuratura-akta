#!/usr/bin/env node
// Copyright (C) 2026 Czekoloczek
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Test rdzenia skryptu (PDF, archiwa, CRC, obrazy, wątek kodeków) bez przeglądarki.
// Użycie: node test-rdzen.cjs <katalog-roboczy>
// Wymaga: Node.js 22+, ImageMagick 7 (z WebP i JPEG XL), poppler (pdfinfo, pdfimages, pdftoppm), unzip,
// GNU tar, gzip, xz, zstd, 7z. Przy pierwszym uruchomieniu pobiera kodeki z @resource (jsDelivr)
// i sprawdza je sumami SHA-256 z nagłówka skryptu.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const core = require('../pobieranie-akt.user.js');

const work = process.argv[2];
if (!work) { console.error('Podaj katalog roboczy.'); process.exit(2); }
fs.mkdirSync(work, { recursive: true });
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });
// stdout i stderr razem – poppler pisze „Syntax Error” na stderr.
const runAll = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8' }); return `${r.stdout}\n${r.stderr}`; };
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'OK  ' : 'BŁĄD'} ${msg}`); if (!cond) failed++; };
const aeOf = (a, b, extra = []) => {
  try {
    return execFileSync('magick', ['compare', '-metric', 'AE', ...extra, a, b, 'null:'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) { return String(e.stderr || e.stdout || e.message).trim(); }
};
const aeZero = (ae) => /^0(\s|$|\.)/.test(ae) || ae === '';

// 1. CRC-32 – wektor wzorcowy i liczenie przyrostowe
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
ok(core.crc32(ascii('123456789')) === 0xcbf43926, 'crc32("123456789") = CBF43926');
ok(core.crc32(ascii('6789'), core.crc32(ascii('12345'))) === 0xcbf43926, 'crc32 przyrostowo');

// Własny zapis PNG (paleta z tRNS, dane po końcu strumienia zlib) – ImageMagick takich nie robi.
function makePng({ width, height, bitDepth, colorType, plte = null, trns = null, rows, junk = null }) {
  const chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
    dv.setUint32(0, data.length); out.set(ascii(type), 4); out.set(data, 8);
    dv.setUint32(8 + data.length, core.crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height); ihdr[8] = bitDepth; ihdr[9] = colorType;
  const raw = Buffer.concat(rows.map((r) => Buffer.concat([Buffer.from([0]), Buffer.from(r)])));
  let idat = new Uint8Array(zlib.deflateSync(raw));
  if (junk) idat = new Uint8Array([...idat, ...junk]);
  const parts = [Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
  if (plte) parts.push(chunk('PLTE', Uint8Array.from(plte)));
  if (trns) parts.push(chunk('tRNS', Uint8Array.from(trns)));
  parts.push(chunk('IDAT', idat), chunk('IEND', new Uint8Array(0)));
  return new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p))));
}

// Wątek kodeków ze skryptu (core.codecWorkerMain) w Node: osobny kontekst udający klasycznego workera
// (importScripts, self, postMessage) – testy sprawdzają dokładnie ten kod, który działa w przeglądarce.
function codecWorker() {
  const texts = new Map();
  let n = 0;
  class FakeBlob { constructor(parts) { this.text = parts.map(String).join(''); } }
  class FakeURL extends URL {}
  FakeURL.createObjectURL = (b) => { const id = `blob:https://localhost/${n++}`; texts.set(id, b.text); return id; };
  FakeURL.revokeObjectURL = (id) => texts.delete(id);
  const replies = new Map();
  const ctx = { console, setTimeout, clearTimeout, TextDecoder, TextEncoder, performance, crypto: globalThis.crypto, atob, btoa,
    Blob: FakeBlob, URL: FakeURL, location: { href: 'https://localhost/worker.js' } };
  ctx.self = ctx;
  vm.createContext(ctx);
  ctx.importScripts = (url) => vm.runInContext(texts.get(url), ctx, { filename: url });
  ctx.postMessage = (msg) => replies.set(msg.id, msg);
  vm.runInContext(`(${core.codecWorkerMain.toString()})();`, ctx);
  let seq = 0;
  return async (op, args, timeoutMs = 120000) => {
    const id = ++seq;
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${op}: brak odpowiedzi po ${timeoutMs} ms`)), timeoutMs); });
    try { await Promise.race([ctx.onmessage({ data: { id, op, args } }), timeout]); } finally { clearTimeout(timer); }
    const r = replies.get(id);
    if (!r.ok) throw new Error(r.error);
    return r.out;
  };
}

// 2. Obrazy testowe
const src = path.join(work, 'zrodla');
fs.mkdirSync(src, { recursive: true });
const base = path.join(src, 'baza.png');
run('magick', ['-size', '620x877', 'gradient:white-navy', '-font', 'DejaVu-Sans', '-pointsize', '40',
  '-fill', 'black', '-annotate', '+40+120', 'Karta testowa ąęłńóśźż', '-fill', 'red', '-draw', 'circle 300,500 300,600', base]);
const cases = [
  { f: 'szary-100dpi.jpg', a: ['-colorspace', 'Gray', '-units', 'PixelsPerInch', '-density', '100', '-quality', '85'], enc: 'jpeg', color: 'gray', bpc: 8 },
  { f: 'rgb-progresywny.jpg', a: ['-interlace', 'JPEG', '-units', 'PixelsPerInch', '-density', '75', '-quality', '80'], enc: 'jpeg', color: 'rgb', bpc: 8 },
  { f: 'cmyk.jpg', a: ['-colorspace', 'CMYK', '-quality', '90'], enc: 'jpeg', color: 'cmyk', bpc: 8 },
  { f: 'bez-dpi.jpg', a: ['-strip', '-quality', '80'], enc: 'jpeg', color: 'rgb', bpc: 8 },
  { f: 'czarnobialy-1bit.png', a: ['-colorspace', 'Gray', '-threshold', '50%', '-type', 'Bilevel', '-define', 'png:bit-depth=1', '-define', 'png:color-type=0'], enc: 'image', color: 'gray', bpc: 1, exact: true },
  { f: 'szary-8bit.png', a: ['-colorspace', 'Gray', '-define', 'png:color-type=0', '-define', 'png:bit-depth=8'], enc: 'image', color: 'gray', bpc: 8, exact: true },
  { f: 'rgb.png', a: ['-depth', '8', '-define', 'png:color-type=2', '-units', 'PixelsPerCentimeter', '-density', '78.74'], enc: 'image', color: 'rgb', bpc: 8, exact: true },
  { f: 'paleta-8bit.png', a: ['-colors', '200', '-define', 'png:color-type=3'], enc: 'image', color: 'index', bpc: 8, exact: true },
  { f: 'paleta-4bit.png', a: ['-colors', '16', '-define', 'png:color-type=3', '-define', 'png:bit-depth=4'], enc: 'image', color: 'index', bpc: 4, exact: true },
];
for (const c of cases) run('magick', [base, ...c.a, path.join(src, c.f)]);
const rgba = path.join(src, 'rgba.png');
run('magick', [base, '-alpha', 'set', '-channel', 'A', '-evaluate', 'set', '60%', '+channel', '-define', 'png:color-type=6', rgba]);

(async () => {
  // 3. PDF ze wszystkich obrazów
  const pdf = new core.PdfBuilder();
  for (const [i, c] of cases.entries()) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(src, c.f)));
    const img = await core.toPdfImage(bytes, null);
    pdf.addPage(img, i % 2 ? `k. ${10 + Math.floor(i / 2)}v` : `k. ${10 + i / 2}`);
  }
  let rgbaErr = null;
  try { await core.toPdfImage(new Uint8Array(fs.readFileSync(rgba)), null); } catch (e) { rgbaErr = e; }
  ok(rgbaErr && /Nieobsługiwany/.test(rgbaErr.message), 'PNG z kanałem alfa wymaga rasteryzacji (w Node: czytelny błąd)');
  let htmlErr = null;
  try { await core.toPdfImage(ascii('<html><head><title>Request Rejected</title>'), null); } catch (e) { htmlErr = e; }
  ok(htmlErr && /HTML/.test(htmlErr.message), 'odpowiedź HTML zamiast obrazu jest wykrywana');

  const out = pdf.finish({ title: '12. Protokół przesłuchania świadka (k. 10-14)', subject: 'PR 1 Ds. 123.2026' });
  const pdfPath = path.join(work, 'test.pdf');
  fs.writeFileSync(pdfPath, Buffer.concat(out.chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))));
  const file = new Uint8Array(fs.readFileSync(pdfPath));
  ok(file.length === out.size, `rozmiar PDF zgodny (${out.size} B)`);
  ok(core.crc32(file) === out.crc, 'CRC liczone w locie = CRC pliku');

  const info = runAll('pdfinfo', ['-isodates', '-f', '1', '-l', String(cases.length), pdfPath]);
  ok(/Pages:\s+9/.test(info), 'pdfinfo: 9 stron');
  ok(/Title:\s+12\. Protokół przesłuchania świadka \(k\. 10-14\)/.test(info), 'pdfinfo: tytuł z polskimi znakami');
  ok(/CreationDate:\s+\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(info), 'pdfinfo: data utworzenia czytelna');
  ok(!/Syntax (Error|Warning)/i.test(info), 'pdfinfo: bez błędów składni (także na stderr)');
  const sizes = [...info.matchAll(/Page\s+(\d+) size:\s+([\d.]+) x ([\d.]+)/g)].map((m) => [+m[2], +m[3]]);
  // szary 100 dpi: 620x877 px → 446.4 x 631.44 pt
  ok(Math.abs(sizes[0][0] - 446.4) < 0.1 && Math.abs(sizes[0][1] - 631.44) < 0.1, `strona 1 z JFIF 100 dpi: ${sizes[0].join(' x ')} pt`);
  // nierealnie mała strona (np. 300 dpi na 620 px = 5 cm) → dopasowanie do A4
  const tiny = core.pageSize({ width: 620, height: 877, dpi: [300, 300] });
  ok(Math.abs(tiny[1] - 841.89) < 0.01, `obraz 5 cm przy 300 dpi → A4 (${tiny.map((v) => v.toFixed(2)).join(' x ')} pt)`);
  // bez DPI → A4
  ok(Math.abs(sizes[3][1] - 841.89) < 0.1, `strona 4 bez DPI → wysokość A4: ${sizes[3].join(' x ')} pt`);
  // 200 dpi (78.74 px/cm) → 223.2 x 315.72 pt
  ok(Math.abs(sizes[6][0] - 223.2) < 0.2, `strona 7 z pHYs 200 dpi: ${sizes[6].join(' x ')} pt`);

  const list = run('pdfimages', ['-list', pdfPath]);
  const rows = list.trim().split('\n').slice(2).map((l) => l.trim().split(/\s+/));
  ok(rows.length === cases.length, `pdfimages: ${rows.length} obrazów`);
  rows.forEach((r, i) => {
    const c = cases[i];
    ok(r[2] === 'image' && +r[3] === 620 && +r[4] === 877 && r[5] === c.color && +r[7] === c.bpc && r[8] === c.enc,
      `obraz ${i + 1} (${c.f}): ${r[5]}/${r[7]} bit/${r[8]}`);
  });

  const ext = path.join(work, 'wyciete');
  fs.rmSync(ext, { recursive: true, force: true });
  fs.mkdirSync(ext, { recursive: true });
  run('pdfimages', ['-all', pdfPath, path.join(ext, 'img')]);
  const extracted = fs.readdirSync(ext).sort();
  for (const [i, c] of cases.entries()) {
    if (c.enc !== 'jpeg') continue;
    const got = path.join(ext, extracted[i]);
    ok(Buffer.compare(fs.readFileSync(got), fs.readFileSync(path.join(src, c.f))) === 0, `${c.f}: JPEG w PDF bajt w bajt jak oryginał`);
  }
  // dokładne porównanie pikseli PNG
  for (const [i, c] of cases.entries()) {
    if (!c.exact) continue;
    const ae = aeOf(path.join(src, c.f), path.join(ext, extracted[i]));
    ok(aeZero(ae), `${c.f}: piksele identyczne z oryginałem (AE=${ae || '0'})`);
  }

  // 4. ZIP
  const zip = new core.ZipBuilder();
  const when = new Date(2026, 10, 9, 14, 30, 22);
  await zip.add('PR 1 Ds. 123.2026/Tom I/012. Protokół przesłuchania świadka (k. 10-14).pdf',
    new Blob(out.chunks), out.size, out.crc, when);
  await zip.addBytes('PR 1 Ds. 123.2026/spis-dokumentow.csv',
    new TextEncoder().encode(core.csv([['Lp.', 'Dokument'], [1, 'Zażółć; "gęślą" jaźń']])), when);
  const zipPath = path.join(work, 'test.zip');
  fs.writeFileSync(zipPath, Buffer.from(await (await zip.finish()).arrayBuffer()));
  const t = run('unzip', ['-t', zipPath]);
  ok(/No errors detected/.test(t), 'unzip -t: bez błędów');
  const unz = path.join(work, 'rozpakowane');
  fs.rmSync(unz, { recursive: true, force: true });
  run('unzip', ['-q', zipPath, '-d', unz]);
  const pdfOut = path.join(unz, 'PR 1 Ds. 123.2026', 'Tom I', '012. Protokół przesłuchania świadka (k. 10-14).pdf');
  ok(fs.existsSync(pdfOut) && Buffer.compare(fs.readFileSync(pdfOut), fs.readFileSync(pdfPath)) === 0, 'ZIP: polska nazwa i zawartość PDF zgodne');
  const csvText = fs.readFileSync(path.join(unz, 'PR 1 Ds. 123.2026', 'spis-dokumentow.csv'), 'utf8');
  ok(csvText.includes('"Zażółć; ""gęślą"" jaźń"'), 'CSV: cudzysłowy i średniki poprawnie ujęte');

  // 5. Kodeki z @resource: pobranie z jsDelivr i kontrola sum SRI z nagłówka skryptu
  const header = fs.readFileSync(path.join(__dirname, '..', 'pobieranie-akt.user.js'), 'utf8');
  const resources = [...header.matchAll(/^\/\/ @resource\s+(\S+)\s+(\S+)#sha256-(\S+)$/gm)]
    .map((m) => ({ name: m[1], url: m[2], sri: m[3] }));
  ok(resources.length === 8, `nagłówek: ${resources.length} zasobów @resource z sumami SHA-256`);
  const resDir = path.join(work, 'zasoby');
  fs.mkdirSync(resDir, { recursive: true });
  const res = {};
  for (const r of resources) {
    const f = path.join(resDir, r.name);
    if (!fs.existsSync(f)) fs.writeFileSync(f, Buffer.from(await (await fetch(r.url)).arrayBuffer()));
    const buf = fs.readFileSync(f);
    ok(crypto.createHash('sha256').update(buf).digest('base64') === r.sri, `${r.name}: suma SHA-256 zgodna z nagłówkiem`);
    res[r.name] = buf;
  }
  const ab = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
  const js = (name) => res[name].toString('utf8');
  const CODECS = { fflate: ['fflate'], lzma: ['lzma'], zstd: ['zstdJs', 'zstdWasm'], webp: ['webpJs', 'webpWasm'], jxl: ['jxlJs', 'jxlWasm'] };
  const load = (call, name) => call('load', { name, js: js(CODECS[name][0]), wasm: CODECS[name][1] ? ab(res[CODECS[name][1]]) : null });
  const worker = codecWorker();
  for (const name of Object.keys(CODECS)) {
    let err = null;
    try { await load(worker, name); } catch (e) { err = e; }
    ok(!err, `wątek kodeków: wczytanie „${name}”${err ? ` – ${err.message}` : ''}`);
  }
  const op = (name) => async (b, level) => worker(name, { data: b.slice().buffer, level });
  const libCompressor = { deflateRaw: op('deflateRaw'), gzip: op('gzip'), zlib: op('zlib'), xz: op('xz'), zstd: op('zstd') };
  {
    const sample = new TextEncoder().encode('Lp.;Dokument;Karty\r\n'.repeat(3000));
    const checks = [
      ['deflateRaw', (x) => zlib.inflateRawSync(x)], ['zlib', (x) => zlib.inflateSync(x)], ['gzip', (x) => zlib.gunzipSync(x)],
      ['xz', (x) => execFileSync('xz', ['-dc'], { input: x })], ['zstd', (x) => execFileSync('zstd', ['-dcq'], { input: x })],
    ];
    for (const [name, unpack] of checks) {
      const packed = Buffer.from(await libCompressor[name](sample, 6));
      ok(packed.length < sample.length / 10 && Buffer.compare(unpack(packed), Buffer.from(sample)) === 0,
        `wątek kodeków: ${name} ${sample.length} → ${packed.length} B, rozpakowane bez zmian`);
    }
  }
  // zstd z uszkodzonym WASM: błąd zamiast zawieszenia
  {
    const bad = new Uint8Array(res.zstdWasm).slice();
    bad[100] ^= 0xff; bad[2000] ^= 0xff;
    const w = codecWorker();
    let err = null;
    try { await w('load', { name: 'zstd', js: js('zstdJs'), wasm: bad.buffer }, 10000); } catch (e) { err = e; }
    ok(err && !/brak odpowiedzi/.test(err.message), `zstd z uszkodzonym WASM: błąd, nie zawieszenie (${err ? err.message.slice(0, 60) : 'brak błędu'})`);
  }
  // lzma: nieudana inicjalizacja nie zostaje zapamiętana – kolejne wczytanie próbuje od nowa
  {
    const failOnce = `${js('lzma')}\n;(function () { self.__lzmaProba = (self.__lzmaProba || 0) + 1;
      if (self.__lzmaProba === 1) lzma_wasm.initWasm = function () { return Promise.reject(new Error('próba')); }; })();`;
    const w = codecWorker();
    let first = null;
    try { await w('load', { name: 'lzma', js: failOnce, wasm: null }); } catch (e) { first = e; }
    let packed = null;
    try {
      await w('load', { name: 'lzma', js: failOnce, wasm: null });
      packed = await w('xz', { data: new TextEncoder().encode('abc'.repeat(100)).buffer, level: 6 });
    } catch (e) { packed = e; }
    const works = !(packed instanceof Error) && packed && packed.length > 0 &&
      execFileSync('xz', ['-dc'], { input: Buffer.from(packed) }).toString() === 'abc'.repeat(100);
    ok(first && works, `lzma: po nieudanej inicjalizacji kolejne wczytanie działa (xz poprawny)${packed instanceof Error ? ` – ${packed.message}` : ''}`);
  }

  // 6. Archiwa: wszystkie formaty, długa polska ścieżka (PAX), kontrola narzędziami systemowymi
  const longName = 'PR 1 Ds. 123.2026/Wątek ogólny/Tom I (1)/006. Protokół przyjęcia ustnego zawiadomienia ' +
    'o przestępstwie – bardzo długa nazwa (k. 8-14).pdf';
  ok(Buffer.byteLength(longName) > 100, `długa ścieżka ma ${Buffer.byteLength(longName)} B (> 100 – wymaga PAX)`);
  const pdfBytes = new Uint8Array(fs.readFileSync(pdfPath));
  const textBytes = new TextEncoder().encode('Lp.;Dokument\r\n'.repeat(500));
  const files = [[longName, pdfBytes], ['PR 1 Ds. 123.2026/spis.csv', textBytes],
    ['PR 1 Ds. 123.2026/Tom I (1)/001. Zawiadomienie (k. 1-2)/k. 001v.png', new Uint8Array(fs.readFileSync(path.join(src, 'paleta-4bit.png')))]];
  const checkTool = { 'tar.gz': ['gzip', '-t'], 'tar.xz': ['xz', '-t'], 'tar.zst': ['zstd', '-tq'] };
  const checkArchive = (key, a, arPath, label) => {
    const outDir = path.join(work, `rozpakowane-${label}`);
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir);
    if (a.ext === '.zip') {
      ok(/No errors detected/.test(run('unzip', ['-t', arPath])), `${label}: unzip -t bez błędów`);
      run('unzip', ['-q', arPath, '-d', outDir]);
    } else {
      const listing = run('tar', ['-tf', arPath]).trim().split('\n');
      ok(JSON.stringify(listing) === JSON.stringify(files.map((f) => f[0])), `${label}: tar -t pokazuje dokładne nazwy (UTF-8, PAX)`);
      run('tar', ['-xf', arPath, '-C', outDir]);
      if (checkTool[key]) ok(execFileSync(checkTool[key][0], [checkTool[key][1], arPath]).length === 0, `${label}: ${checkTool[key].join(' ')} bez błędów`);
    }
    ok(/Everything is Ok/.test(run('7z', ['t', arPath])), `${label}: 7z t bez błędów`);
    const same = files.every(([name, bytes]) => Buffer.compare(fs.readFileSync(path.join(outDir, name)), Buffer.from(bytes)) === 0);
    ok(same, `${label}: rozpakowane pliki identyczne z wejściem (${fs.statSync(arPath).size} B)`);
  };
  // Dane jak w skrypcie: PDF jako Blob, strony jako Uint8Array.
  const build = async (ar) => {
    for (const [name, bytes] of files) {
      if (name.endsWith('.pdf')) await ar.add(name, new Blob([bytes]), bytes.length, core.crc32(bytes), when);
      else await ar.add(name, bytes, bytes.length, undefined, when);
    }
    return ar;
  };
  for (const [key, a] of Object.entries(core.ARCHIVES)) {
    const ar = await build(a.create({ level: a.levels ? a.levels.max : undefined, compressor: libCompressor }));
    const arPath = path.join(work, `test-${key}${a.ext}`);
    fs.writeFileSync(arPath, Buffer.from(await (await ar.finish()).arrayBuffer()));
    checkArchive(key, a, arPath, key);
    if (key === 'zip-deflate') {
      ok(/compression method:\s+deflated/.test(run('zipinfo', ['-v', arPath])), `${key}: pliki dające się skompresować są skompresowane (Deflate)`);
    }
  }
  // Bez kodeków (menedżer skryptów bez @resource): ZIP z kompresją i TAR.GZ przez CompressionStream.
  for (const key of ['zip-deflate', 'tar.gz']) {
    const a = core.ARCHIVES[key];
    const ar = await build(a.create({ level: 9, compressor: null }));
    const arPath = path.join(work, `test-bez-kodeka-${key}${a.ext}`);
    fs.writeFileSync(arPath, Buffer.from(await (await ar.finish()).arrayBuffer()));
    checkArchive(key, a, arPath, `${key} bez kodeka`);
  }
  // Wiele strumieni: małe porcje wymuszają kilka ramek gzip/xz/zstd w jednym pliku.
  for (const codec of ['gzip', 'xz', 'zstd']) {
    const key = { gzip: 'tar.gz', xz: 'tar.xz', zstd: 'tar.zst' }[codec];
    const ar = await build(new core.TarBuilder({ codec, level: 3, compressor: libCompressor, chunkSize: 64 * 1024 }));
    let chunks = 0;
    const blob = await ar.finish(undefined, () => { chunks++; });
    const arPath = path.join(work, `test-wiele-${key}`);
    fs.writeFileSync(arPath, Buffer.from(await blob.arrayBuffer()));
    ok(chunks > 2, `${key}: ${chunks} porcji (osobnych strumieni) w jednym pliku`);
    checkArchive(key, core.ARCHIVES[key], arPath, `${key} (wiele strumieni)`);
  }
  // Nieudana kompresja: archiwum zamknięte, ale bez kompresji (plain) da się zapisać w całości.
  {
    const broken = { xz: async () => { throw new Error('brak pamięci (test)'); } };
    const ar = await build(new core.TarBuilder({ codec: 'xz', level: 6, compressor: broken }));
    let err = null;
    try { await ar.finish(); } catch (e) { err = e; }
    const plainPath = path.join(work, 'test-zapas.tar');
    const plain = ar.plain();
    if (plain) fs.writeFileSync(plainPath, Buffer.from(await plain.arrayBuffer()));
    ok(err && ar.closed && plain, 'TAR.XZ: błąd kompresji → archiwum zamknięte, dostępny TAR bez kompresji');
    if (plain) checkArchive('tar', core.ARCHIVES.tar, plainPath, 'zapasowy TAR');
  }
  // Poziom kompresji ZIP faktycznie działa (1 vs 9 na dobrze kompresowalnym pliku).
  const zipSize = async (level) => {
    const z = core.ARCHIVES['zip-deflate'].create({ level, compressor: libCompressor });
    const big = new TextEncoder().encode(Array.from({ length: 4000 }, (_, i) => `wiersz ${i};${(i * 7919) % 1000}\r\n`).join(''));
    await z.add('a.csv', big, big.length, undefined, when);
    return (await z.finish()).size;
  };
  const z1 = await zipSize(1), z9 = await zipSize(9);
  ok(z9 < z1, `ZIP Deflate: poziom 9 (${z9} B) mniejszy niż poziom 1 (${z1} B)`);
  // ZIP sam liczy CRC, gdy go nie podano (pliki stron)
  const zipNoCrc = new core.ZipBuilder();
  await zipNoCrc.add('a/k. 001.png', new Blob([textBytes]), textBytes.length, undefined, when);
  const zipNoCrcPath = path.join(work, 'test-bez-crc.zip');
  fs.writeFileSync(zipNoCrcPath, Buffer.from(await (await zipNoCrc.finish()).arrayBuffer()));
  ok(/No errors detected/.test(run('unzip', ['-t', zipNoCrcPath])), 'ZIP bez podanego CRC: unzip -t bez błędów');
  // TAR: finish() można wołać wielokrotnie, a dopisywanie po zamknięciu jest blokowane
  const tarTwice = new core.TarBuilder();
  await tarTwice.add('a.txt', textBytes, textBytes.length, 0, when);
  const t1 = await tarTwice.finish(), t2 = await tarTwice.finish();
  let tarClosedErr = null;
  try { await tarTwice.add('b.txt', textBytes, textBytes.length, 0, when); } catch (e) { tarClosedErr = e; }
  ok(t1 === t2 && t1.size % 512 === 0 && tarClosedErr, 'TAR: finish() idempotentne, add() po zamknięciu odrzucone');

  // rekord PAX: długość liczy także swoje cyfry (np. 98 B treści → 101)
  const rec = core.paxRecord('path', 'x'.repeat(91));
  ok(Buffer.byteLength(rec) === Number(rec.split(' ')[0]), `paxRecord: długość ${rec.split(' ')[0]} zgodna`);
  ok(core.pageFileName('k. 12', 0, 3, '.png') === 'k. 012.png' && core.pageFileName('k. 12v', 1, 3, '.png') === 'k. 012v.png' &&
    core.pageFileName(null, 4, 3, '.jpg') === 'strona 005.jpg', 'pageFileName: k. 012.png / k. 012v.png / strona 005.jpg');

  // 7. Dekoder PNG (bez canvas) = ImageMagick, piksel w piksel
  for (const f of ['czarnobialy-1bit.png', 'szary-8bit.png', 'rgb.png', 'paleta-8bit.png', 'paleta-4bit.png', 'rgba.png']) {
    const f2 = path.join(src, f);
    const d = await core.decodePng(new Uint8Array(fs.readFileSync(f2)));
    const im = execFileSync('magick', [f2, '-depth', '8', 'rgba:-'], { maxBuffer: 64 * 1024 * 1024 });
    let maxDiff = 0;
    for (let i = 0; i < im.length; i++) maxDiff = Math.max(maxDiff, Math.abs(im[i] - d.rgba[i]));
    // 16-bitowe PNG: dekoder bierze starszy bajt, ImageMagick zaokrągla – różnica najwyżej 1.
    const limit = f === 'rgba.png' ? 1 : 0;
    ok(d.rgba.length === im.length && maxDiff <= limit, `decodePng ${f}: ${d.width}×${d.height}, maks. różnica ${maxDiff}`);
  }
  // Palety 1/2-bitowe z przezroczystością (tRNS) i szerokością niepodzielną przez 8 – wynik znany z góry.
  {
    const plte = [255, 255, 255, 0, 0, 0, 200, 30, 60, 10, 20, 30];
    const trns = [255, 0, 128];
    const w = 13, h = 3;
    const idx = Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => (x + y) % 4));
    for (const bd of [2, 1]) {
      const per = 8 / bd, stride = Math.ceil(w / per);
      const pl = plte.slice(0, 3 * (1 << bd)), tr = trns.slice(0, 1 << bd);
      const rowsBytes = idx.map((r) => {
        const out = new Uint8Array(stride);
        r.forEach((v, x) => { const vv = bd === 1 ? v & 1 : v; out[Math.floor(x / per)] |= vv << (8 - bd * ((x % per) + 1)); });
        return out;
      });
      const png = makePng({ width: w, height: h, bitDepth: bd, colorType: 3, plte: pl, trns: tr, rows: rowsBytes });
      const d = await core.decodePng(png);
      let good = true;
      idx.forEach((r, y) => r.forEach((v0, x) => {
        const v = bd === 1 ? v0 & 1 : v0, k = (y * w + x) * 4;
        const want = [pl[v * 3], pl[v * 3 + 1], pl[v * 3 + 2], v < tr.length ? tr[v] : 255];
        if (want.some((c, j) => d.rgba[k + j] !== c)) good = false;
      }));
      ok(good, `decodePng: paleta ${bd}-bitowa z tRNS, szerokość ${w} – piksele zgodne`);
    }
  }

  // 8. Kodery jsquash przez wątek kodeków skryptu: bezstratnie co do piksela, stratnie – poprawny plik
  const page = await core.decodePng(new Uint8Array(fs.readFileSync(path.join(src, 'paleta-4bit.png'))));
  const pageRgba = execFileSync('magick', [path.join(src, 'paleta-4bit.png'), '-depth', '8', 'rgba:-'], { maxBuffer: 64 * 1024 * 1024 });
  const roundTrip = (name, bytes) => {
    const f = path.join(work, name);
    fs.writeFileSync(f, bytes);
    return execFileSync('magick', [f, '-depth', '8', 'rgba:-'], { maxBuffer: 64 * 1024 * 1024 });
  };
  const encode = (codec, opts) => worker(codec, { rgba: page.rgba.slice().buffer, width: page.width, height: page.height, options: opts });
  for (const [name, codec, opts] of [
    ['bezstratny.webp', 'webp', core.webpOptions(true, 80, 6)],
    ['bezstratny-e9.webp', 'webp', core.webpOptions(true, 80, 9)],
    ['bezstratny.jxl', 'jxl', core.jxlOptions(true, 80, 7)],
  ]) {
    const o = await encode(codec, opts);
    ok(o && Buffer.compare(roundTrip(name, o), pageRgba) === 0, `${name}: ${o.length} B, piksele identyczne z PNG`);
  }
  for (const [name, codec, opts] of [['stratny.webp', 'webp', core.webpOptions(false, 80, 4)], ['stratny.jxl', 'jxl', core.jxlOptions(false, 80, 7)]]) {
    const o = await encode(codec, opts);
    ok(o && roundTrip(name, o).length === pageRgba.length, `${name}: ${o.length} B, poprawny plik`);
  }
  const w9 = core.webpOptions(true, 0, 9), w0 = core.webpOptions(true, 0, 0), j = core.jxlOptions(true, 50, 12);
  ok(w9.method === 6 && w9.quality === 100 && w9.lossless === 1 && w0.method === 0 && j.effort === 9 && j.quality === 100,
    'webpOptions/jxlOptions: effort 0–9 jak cwebp -z, JXL bezstratny z quality 100 i effort przycięty do 9');

  // 9. Bezstratna optymalizacja stron PDF: nigdy większa od oryginału, piksele identyczne (pdfimages)
  const optDir = path.join(work, 'optymalizacja');
  fs.rmSync(optDir, { recursive: true, force: true });
  fs.mkdirSync(optDir, { recursive: true });
  run('magick', [base, '-dither', 'None', '-colors', '4', '-define', 'png:bit-depth=4', '-define', 'png:color-type=3', path.join(src, 'cztery-kolory.png')]);
  run('magick', [base, '-depth', '8', '-alpha', 'set', '-channel', 'A', '-evaluate', 'set', '60%', '+channel', '-define', 'png:color-type=6', path.join(src, 'rgba-8bit.png')]);
  run('magick', [path.join(src, 'rgba-8bit.png'), '-background', 'white', '-alpha', 'remove', '-alpha', 'off', path.join(src, 'rgba-8bit-na-bieli.png')]);
  const optCases = ['cztery-kolory.png', 'paleta-4bit.png', 'paleta-8bit.png', 'czarnobialy-1bit.png', 'szary-8bit.png', 'rgb.png',
    'rgba-8bit.png', 'szary-100dpi.jpg'];
  const zlibLib = (b, level) => libCompressor.zlib(b, level);
  const optPdf = new core.PdfBuilder();
  for (const f of optCases) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(src, f)));
    const img = await core.optimizePdfImage(bytes, { zlib: zlibLib, level: 9 });
    optPdf.addPage(img, f);
    let orig = null;
    try { orig = await core.toPdfImage(bytes, null); } catch (e) { /* RGBA: oryginał wymagałby rasteryzacji */ }
    const size = img.data.reduce((a, c) => a + c.length, 0);
    const kindOfImg = img.filter === 'DCTDecode' ? 'JPEG bez zmian' : img.colorSpace.startsWith('[/Indexed') ? `paleta ${img.bpc}-bit` : `${img.colorSpace.slice(1)} ${img.bpc}-bit`;
    if (f.endsWith('.jpg')) ok(img.data[0] === bytes || Buffer.compare(Buffer.from(img.data[0]), Buffer.from(bytes)) === 0, `optymalizacja ${f}: JPEG zostaje bajt w bajt`);
    else if (orig) ok(size <= orig.data.reduce((a, c) => a + c.length, 0), `optymalizacja ${f}: ${size} B ≤ oryginał ${orig.data.reduce((a, c) => a + c.length, 0)} B (${kindOfImg})`);
    else ok(size > 0, `optymalizacja ${f}: ${size} B (${kindOfImg}, przezroczystość na białym tle)`);
    if (f === 'cztery-kolory.png') ok(img.bpc === 2 && !img.decodeParms, 'optymalizacja: 4 kolory → paleta 2-bit bez filtrów PNG (filtry przy 1/2/4 bitach nie pomagają)');
  }
  const optPath = path.join(optDir, 'zoptymalizowany.pdf');
  const optOut = optPdf.finish({ title: 'Optymalizacja' });
  fs.writeFileSync(optPath, Buffer.concat(optOut.chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))));
  ok(!/Syntax (Error|Warning)/i.test(runAll('pdfinfo', [optPath])), 'PDF zoptymalizowany: pdfinfo bez błędów (także na stderr)');
  run('pdfimages', ['-png', optPath, path.join(optDir, 'str')]);
  const optImgs = fs.readdirSync(optDir).filter((n) => n.startsWith('str')).sort();
  for (const [i, f] of optCases.entries()) {
    if (f.endsWith('.jpg')) continue;
    const ref = path.join(src, f === 'rgba-8bit.png' ? 'rgba-8bit-na-bieli.png' : f);
    const ae = aeOf(ref, path.join(optDir, optImgs[i]), f === 'rgba-8bit.png' ? ['-fuzz', '1%'] : []);
    ok(aeZero(ae), `optymalizacja ${f}: piksele z PDF-a = źródło (AE ${ae || 0})`);
  }

  // 10. Strony nietypowe: 16 bitów, dane po końcu strumienia zlib
  {
    const dir16 = path.join(work, '16bit');
    fs.rmSync(dir16, { recursive: true, force: true });
    fs.mkdirSync(dir16);
    const p16 = [['szary-16bit.png', 'gradient:white-black', '0', 'gray'], ['rgb-16bit.png', 'gradient:white-navy', '2', 'rgb']];
    const pdf16 = new core.PdfBuilder();
    for (const [f, grad, ct] of p16) {
      run('magick', ['-size', '300x420', grad, '-depth', '16', ...(ct === '0' ? ['-colorspace', 'Gray'] : []), '-define', `png:color-type=${ct}`, path.join(dir16, f)]);
      const bytes = new Uint8Array(fs.readFileSync(path.join(dir16, f)));
      const img = await core.toPdfImage(bytes, null);
      const idat = Buffer.concat(core.parsePng(bytes).idat.map((c) => Buffer.from(c)));
      ok(img.bpc === 16 && Buffer.compare(Buffer.concat(img.data.map((c) => Buffer.from(c))), idat) === 0, `${f}: osadzony w PDF bez zmian (16 bitów, IDAT bajt w bajt)`);
      const opt = await core.optimizePdfImage(bytes, { zlib: zlibLib, level: 9 });
      ok(opt.bpc === 16, `${f}: „PDF zoptymalizowany” zostawia 16-bitową stronę bez zmian`);
      pdf16.addPage(img, f);
    }
    const p16Path = path.join(dir16, 'strony-16bit.pdf');
    const o16 = pdf16.finish({ title: '16 bitów' });
    fs.writeFileSync(p16Path, Buffer.concat(o16.chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))));
    ok(!/Syntax (Error|Warning)/i.test(runAll('pdfinfo', [p16Path])), 'PDF z 16-bitowymi stronami: pdfinfo bez błędów');
    // poppler renderuje stronę tak jak źródło (do 8 bitów: różnica najwyżej 1 poziom)
    for (const [i, [f]] of p16.entries()) {
      run('pdftoppm', ['-r', '72', '-scale-to-x', '300', '-scale-to-y', '420', '-f', String(i + 1), '-l', String(i + 1), '-png', p16Path, path.join(dir16, `r${i}`)]);
      const rendered = fs.readdirSync(dir16).find((n) => n.startsWith(`r${i}`) && n.endsWith('.png'));
      run('magick', [path.join(dir16, f), '-depth', '8', path.join(dir16, `ref${i}.png`)]);
      const pae = aeOf(path.join(dir16, `ref${i}.png`), path.join(dir16, rendered), ['-metric', 'PAE']);
      ok(/\(0(\.00[0-4]\d*)?\)/.test(pae) || /^0/.test(pae), `${f}: strona z PDF-a = źródło (PAE ${pae})`);
    }
  }
  {
    // PNG z bajtami po końcu strumienia zlib: przeglądarki i czytniki PDF go pokazują, DecompressionStream odrzuca.
    const rowsGray = Array.from({ length: 40 }, (_, y) => Uint8Array.from({ length: 50 }, (_, x) => (x * 5 + y * 3) & 255));
    const odd = makePng({ width: 50, height: 40, bitDepth: 8, colorType: 0, rows: rowsGray, junk: [1, 2, 3, 4, 5, 6] });
    let decodeErr = null;
    try { await core.decodePng(odd); } catch (e) { decodeErr = e; }
    const opt = await core.optimizePdfImage(odd, { zlib: zlibLib, level: 9 });
    const orig = await core.toPdfImage(odd, null);
    const same = opt.decodeParms === orig.decodeParms && opt.data.length === orig.data.length &&
      opt.data.every((c, i) => Buffer.compare(Buffer.from(c), Buffer.from(orig.data[i])) === 0);
    ok(decodeErr && same, 'PNG z danymi po strumieniu zlib: „PDF zoptymalizowany” zostawia oryginał zamiast błędu');
  }

  // 11. Nazwy i plan kart
  ok(core.safeName('a/b:c*?"<>|  d. ') === 'a_b_c______ d', `safeName: ${core.safeName('a/b:c*?"<>|  d. ')}`);
  ok(core.padIndex('5', 3) === '005' && core.padIndex('5.1', 3) === '005.1', 'padIndex');
  const fmt = (pp) => pp.map((p) => `${p.key}:${p.label}`).join(',');
  // bez numberPart – numeracja z zakresu kart dokumentu
  const pages = core.cardPages([{ id: 1, twoPages: true, pages: [{ pageKey: 'a' }, { pageKey: 'b' }] },
    { id: -1, pages: [] }, { id: 2, twoPages: false, pages: [{ pageKey: 'c' }, { pageKey: 'd' }] }], '12', '13');
  ok(fmt(pages) === 'a:k. 12,b:k. 12v,c:k. 13', `cardPages z zakresu: ${fmt(pages)}`);
  // zakres niezgodny z liczbą kart → bez etykiet
  const noLabels = core.cardPages([{ id: 1, pages: [{ pageKey: 'a' }] }], '12', '14');
  ok(fmt(noLabels) === 'a:null', `cardPages przy niezgodnym zakresie: ${fmt(noLabels)}`);
  // jak w portalu: numberPart + isVerte
  const real = core.cardPages([
    { id: 7, numberPart: 5, twoPages: true, pages: [{ pageKey: 'p', isVerte: false }, { pageKey: 'q', isVerte: true }] },
    { id: 8, numberPart: 6, twoPages: false, pages: [{ pageKey: 'r', isVerte: false }] }], '1', '1');
  ok(fmt(real) === 'p:k. 5,q:k. 5v,r:k. 6', `cardPages z numberPart/isVerte: ${fmt(real)}`);
  // PNG z portalu: 1654x2324 px z fałszywym pHYs 96 dpi → A4
  const portal = core.pageSize({ width: 1654, height: 2324, dpi: [95.9866, 95.9866] });
  ok(Math.abs(portal[1] - 836.4) < 1 && Math.abs(portal[0] - 595.28) < 0.01, `PNG z portalu (96 dpi .NET) → A4: ${portal.map((v) => v.toFixed(1)).join(' x ')} pt`);
  // A5 (200 dpi) z tym samym fałszywym 96 dpi → też szerokość A4, nie strona większa od A4
  const a5 = core.pageSize({ width: 1165, height: 1654, dpi: [96.012, 96.012] });
  ok(a5[0] <= 595.3 && Math.abs(a5[1] - 841.89) < 0.01, `A5 z fałszywym 96 dpi → dopasowanie do A4: ${a5.map((v) => v.toFixed(1)).join(' x ')} pt`);

  console.log(failed ? `\n${failed} błędów` : '\nWszystko OK');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
