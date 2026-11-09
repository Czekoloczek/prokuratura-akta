#!/usr/bin/env node
// Copyright (C) 2026 Czekoloczek
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Test rdzenia skryptu (PDF, ZIP, CRC, obrazy) bez przeglądarki.
// Użycie: node test-rdzen.cjs <katalog-roboczy>
// Wymaga: ImageMagick (magick), poppler (pdfinfo, pdfimages), unzip.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const core = require('../pobieranie-akt.user.js');

const work = process.argv[2];
if (!work) { console.error('Podaj katalog roboczy.'); process.exit(2); }
fs.mkdirSync(work, { recursive: true });
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'OK  ' : 'BŁĄD'} ${msg}`); if (!cond) failed++; };

// 1. CRC-32 – wektor wzorcowy i liczenie przyrostowe
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
ok(core.crc32(ascii('123456789')) === 0xcbf43926, 'crc32("123456789") = CBF43926');
ok(core.crc32(ascii('6789'), core.crc32(ascii('12345'))) === 0xcbf43926, 'crc32 przyrostowo');

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

  const info = run('pdfinfo', ['-f', '1', '-l', String(cases.length), pdfPath]);
  ok(/Pages:\s+9/.test(info), 'pdfinfo: 9 stron');
  ok(/Title:\s+12\. Protokół przesłuchania świadka \(k\. 10-14\)/.test(info), 'pdfinfo: tytuł z polskimi znakami');
  ok(!/Syntax (Error|Warning)/i.test(info), 'pdfinfo: bez błędów składni');
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
  fs.mkdirSync(ext, { recursive: true });
  run('pdfimages', ['-all', pdfPath, path.join(ext, 'img')]);
  const extracted = fs.readdirSync(ext).sort();
  for (const [i, c] of cases.entries()) {
    if (c.enc !== 'jpeg') continue;
    const got = path.join(ext, extracted[i]);
    ok(Buffer.compare(fs.readFileSync(got), fs.readFileSync(path.join(src, c.f))) === 0, `${c.f}: JPEG w PDF bajt w bajt jak oryginał`);
  }
  // dokładne porównanie pikseli PNG (compare zwraca kod 1 przy różnicy, więc łapiemy wyjście z stderr)
  for (const [i, c] of cases.entries()) {
    if (!c.exact) continue;
    const got = path.join(ext, extracted[i]);
    let diff;
    try {
      diff = execFileSync('magick', ['compare', '-metric', 'AE', path.join(src, c.f), got, 'null:'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { diff = String(e.stderr || e.stdout || e.message); }
    ok(/^0(\s|$|\.)/.test(String(diff).trim()) || String(diff).trim() === '', `${c.f}: piksele identyczne z oryginałem (AE=${String(diff).trim() || '0'})`);
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

  // 5. Pozostałe archiwa: ZIP z kompresją, TAR, TAR.GZ (długa polska ścieżka → nagłówek PAX)
  const longName = 'PR 1 Ds. 123.2026/Wątek ogólny/Tom I (1)/006. Protokół przyjęcia ustnego zawiadomienia ' +
    'o przestępstwie – bardzo długa nazwa (k. 8-14).pdf';
  ok(Buffer.byteLength(longName) > 100, `długa ścieżka ma ${Buffer.byteLength(longName)} B (> 100 – wymaga PAX)`);
  const pdfBytes = new Uint8Array(fs.readFileSync(pdfPath));
  const textBytes = new TextEncoder().encode('Lp.;Dokument\r\n'.repeat(500));
  const files = [[longName, pdfBytes], ['PR 1 Ds. 123.2026/spis.csv', textBytes],
    ['PR 1 Ds. 123.2026/Tom I (1)/001. Zawiadomienie (k. 1-2)/k. 001v.png', fs.readFileSync(path.join(src, 'paleta-4bit.png'))]];
  for (const [key, a] of Object.entries(core.ARCHIVES)) {
    const ar = a.create();
    for (const [name, bytes] of files) await ar.add(name, new Blob([bytes]), bytes.length, core.crc32(bytes), when);
    const arPath = path.join(work, `test-${key}${a.ext}`);
    fs.writeFileSync(arPath, Buffer.from(await (await ar.finish()).arrayBuffer()));
    const outDir = path.join(work, `rozpakowane-${key}`);
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir);
    if (a.ext === '.zip') {
      ok(/No errors detected/.test(run('unzip', ['-t', arPath])), `${key}: unzip -t bez błędów`);
      run('unzip', ['-q', arPath, '-d', outDir]);
      if (key === 'zip-deflate') {
        const info = run('zipinfo', ['-v', arPath]);
        ok(/compression method:\s+deflated/.test(info), `${key}: pliki dające się skompresować są skompresowane (Deflate)`);
      }
    } else {
      const list = run('tar', [key === 'tar.gz' ? '-tzf' : '-tf', arPath]).trim().split('\n');
      ok(JSON.stringify(list) === JSON.stringify(files.map((f) => f[0])), `${key}: tar -t pokazuje dokładne nazwy (UTF-8, PAX)`);
      run('tar', [key === 'tar.gz' ? '-xzf' : '-xf', arPath, '-C', outDir]);
      if (key === 'tar.gz') ok(execFileSync('gzip', ['-t', arPath]).length === 0, `${key}: gzip -t bez błędów`);
    }
    const same = files.every(([name, bytes]) => Buffer.compare(fs.readFileSync(path.join(outDir, name)), Buffer.from(bytes)) === 0);
    ok(same, `${key}: rozpakowane pliki identyczne z wejściem (${fs.statSync(arPath).size} B)`);
  }
  // rekord PAX: długość liczy także swoje cyfry (np. 98 B treści → 101)
  const rec = core.paxRecord('path', 'x'.repeat(91));
  ok(Buffer.byteLength(rec) === Number(rec.split(' ')[0]), `paxRecord: długość ${rec.split(' ')[0]} zgodna`);
  ok(core.pageFileName('k. 12', 0, 3, '.png') === 'k. 012.png' && core.pageFileName('k. 12v', 1, 3, '.png') === 'k. 012v.png' &&
    core.pageFileName(null, 4, 3, '.jpg') === 'strona 005.jpg', 'pageFileName: k. 012.png / k. 012v.png / strona 005.jpg');

  // 6. Nazwy i plan kart
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

  console.log(failed ? `\n${failed} błędów` : '\nWszystko OK');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
