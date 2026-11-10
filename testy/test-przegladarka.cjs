#!/usr/bin/env node
// Copyright (C) 2026 Czekoloczek
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Test części przeglądarkowej (pobieranie stron, archiwa, błędy, przerwanie) bez przeglądarki:
// cały skrypt działa w osobnym kontekście Node z atrapami portalu (XMLHttpRequest), wątku kodeków
// (Worker) i strony (document). Zmienia tylko przerwy w kodzie (ponowienia, odstępy), żeby test był szybki.
// Użycie: node test-przegladarka.cjs <katalog-roboczy>      Wymaga: Node.js 22+, GNU tar, gzip, xz, unzip.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const core = require('../pobieranie-akt.user.js');

const work = process.argv[2];
if (!work) { console.error('Podaj katalog roboczy.'); process.exit(2); }
fs.mkdirSync(work, { recursive: true });
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'OK  ' : 'BŁĄD'} ${msg}`); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'pobieranie-akt.user.js'), 'utf8');

// Mała strona PNG (szarość 8 bitów) – jak obraz z portalu, tylko mniejsza.
function pagePng(seed) {
  const w = 24, h = 16;
  const raw = Buffer.alloc(h * (w + 1));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = (x * 7 + y * 13 + seed * 31) & 255;
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8);
    out.writeUInt32BE(core.crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

/**
 * Świeży skrypt w nowym kontekście. opts: docs (liczba dokumentów), pages (stron na dokument),
 * gm (czy menedżer udostępnia zasoby kodeków), ops (nadpisane operacje wątku), opDelay, partBytes,
 * route (nadpisanie odpowiedzi portalu), cards (nadpisanie kart dokumentu).
 */
function boot(opts = {}) {
  const env = { saved: [], blobs: new Map(), inflight: {}, maxInflight: {}, posted: {}, terminated: 0, requests: [], log: [] };
  const docs = opts.docs || 3, pagesPer = opts.pages || 3;
  const json = (o) => ({ type: 'application/json; charset=utf-8', bytes: new TextEncoder().encode(JSON.stringify(o)) });
  const defaultRoute = (method, url) => {
    const u = new URL(url, 'https://portal.test');
    if (u.pathname === '/api/tree') {
      const parent = u.searchParams.get('parentIds');
      if (!parent) return json({ data: [{ key: 'cs:1', parent: null, hasChildren: true, name: 'PR 1 Ds. 1.2026' }] });
      if (parent === 'cs:1') return json({ data: [{ key: 'v:1', parent: 'cs:1', hasChildren: true, name: 'I (1)' }] });
      if (parent === 'v:1') {
        return json({ data: Array.from({ length: docs }, (_, i) => ({ key: `d:${i + 1}`, parent: 'v:1', hasChildren: false,
          name: `Dokument ${i + 1}`, index: i + 1, firstCard: String(i * pagesPer + 1), lastCard: String((i + 1) * pagesPer) })) });
      }
      return json({ data: [] });
    }
    if (u.pathname === '/api/cards') {
      const d = Number(u.searchParams.get('documentId'));
      const cards = opts.cards ? opts.cards(d) : Array.from({ length: pagesPer }, (_, j) => ({
        id: d * 1000 + j + 1, numberPart: (d - 1) * pagesPer + j + 1, twoPages: false, pages: [{ pageKey: `p${d}-${j}`, isVerte: false }] }));
      return json(cards);
    }
    if (u.pathname === '/api/page') {
      const key = u.searchParams.get('pageKey');
      return { type: 'image/png', bytes: pagePng(key.length + key.charCodeAt(key.length - 1)) };
    }
    return { status: 404, type: 'text/plain', bytes: new Uint8Array(0) };
  };
  class FakeXHR {
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader() {}
    getResponseHeader(h) { return h.toLowerCase() === 'content-type' ? this.type : null; }
    abort() { if (this.done) return; this.done = true; clearTimeout(this.timer); if (this.onabort) this.onabort(); }
    send(body) {
      env.requests.push({ t: Date.now(), url: this.url });
      const r = (opts.route && opts.route(this.method, this.url, env)) || defaultRoute(this.method, this.url);
      this.timer = setTimeout(() => {
        if (this.done) return;
        this.done = true;
        if (r.error) { if (this.onerror) this.onerror(); return; }
        this.status = r.status || 200; this.type = r.type || ''; this.responseURL = this.url;
        this.response = r.bytes.buffer.slice(r.bytes.byteOffset, r.bytes.byteOffset + r.bytes.byteLength);
        if (this.onload) this.onload();
      }, r.delay == null ? 2 : r.delay);
    }
  }
  const ops = {
    load: async () => null,
    deflateRaw: async ({ data, level }) => zlib.deflateRawSync(Buffer.from(data), { level }),
    zlib: async ({ data, level }) => zlib.deflateSync(Buffer.from(data), { level }),
    gzip: async ({ data, level }) => zlib.gzipSync(Buffer.from(data), { level }),
    xz: async ({ data, level }) => execFileSync('xz', ['-c', `-${level}`], { input: Buffer.from(data) }),
    zstd: async () => { throw new Error('zstd: brak w teście'); },
    webp: async ({ rgba }) => new Uint8Array(Buffer.concat([Buffer.from('RIFF....WEBPVP8L'), Buffer.from(new Uint8Array(rgba).subarray(0, 64))])),
    jxl: async () => new Uint8Array([0xff, 0x0a, 1, 2, 3]),
    ...(opts.ops || {}),
  };
  class FakeWorker {
    constructor() { this.queue = Promise.resolve(); env.workers = (env.workers || 0) + 1; }
    postMessage({ id, op, args }) {
      env.posted[op] = (env.posted[op] || 0) + 1;
      env.inflight[op] = (env.inflight[op] || 0) + 1;
      env.maxInflight[op] = Math.max(env.maxInflight[op] || 0, env.inflight[op]);
      this.queue = this.queue.then(async () => { // jak prawdziwy wątek: po jednym zadaniu
        if (this.dead) return;
        await sleep((opts.opDelay && opts.opDelay[op]) || 0);
        env.inflight[op]--;
        if (this.dead) return;
        let msg;
        try { msg = { id, ok: true, out: await ops[op](args, env) }; } catch (e) { msg = { id, ok: false, error: e.message }; }
        if (!this.dead && this.onmessage) this.onmessage({ data: msg });
      });
    }
    terminate() { this.dead = true; env.terminated++; }
  }
  class TestURL extends URL {
    static createObjectURL(blob) { const id = `blob:test/${env.blobs.size}`; env.blobs.set(id, blob); return id; }
    static revokeObjectURL() {}
  }
  const document = {
    title: 'Akta sprawy PR 1 Ds. 1.2026 - Portal Przeglądania Akt', cookie: '', body: { appendChild() {} },
    createElement: (tag) => ({ tagName: tag, style: {}, setAttribute() {}, remove() {},
      click() { if (tag === 'a') env.saved.push({ name: this.download, blob: env.blobs.get(this.href) }); } }),
    getElementById: () => null, querySelector: () => null,
  };
  const ctx = {
    console: { log: (...a) => env.log.push(a.map(String).join(' ')), warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    TextEncoder, TextDecoder, Blob, Response, CompressionStream, DecompressionStream, AbortController, fetch, atob, btoa,
    crypto: globalThis.crypto, URL: TestURL, XMLHttpRequest: FakeXHR, Worker: FakeWorker, document,
    localStorage: { getItem: () => null, setItem() {} },
    routing: { getRoute: (name) => ({ getPage: { url: '/api/page' }, getDocumentCards: { url: '/api/cards' },
      loadTreeNodes: { url: '/api/tree?shareId=abc' } })[name] || null },
    documentViewer: { caseId: 'abc' },
  };
  if (opts.gm !== false) {
    ctx.GM_getResourceText = () => '/* kod kodeka (atrapa) */';
    ctx.GM_getResourceURL = () => 'data:application/octet-stream;base64,AA==';
  }
  ctx.window = ctx;
  vm.createContext(ctx);
  // Szybsze przerwy + dostęp do wewnętrznych funkcji (tylko w teście).
  const src = SRC
    .replace('let delay = 2000;', 'let delay = 5;')
    .replace(/gapMs: 150,/, `gapMs: ${opts.gapMs == null ? 2 : opts.gapMs},`)
    .replace(/outagePauseMs: [^,]+,/, 'outagePauseMs: 20,')
    .replace(/partBytes: [^,]+,/, `partBytes: ${opts.partBytes || 1536 * 1024 * 1024},`)
    .replace('  /* -------------------- start -------------------- */',
      '  W.__test = { buildDocumentOutput, downloadAll, Pacer, codecs, CFG, Fatal, Aborted, Transient, FORMATS };\n' +
      '  /* -------------------- start -------------------- */');
  vm.runInContext(src, ctx, { filename: 'pobieranie-akt.user.js' });
  return { T: ctx.__test, env, ctx };
}

function fakeUi(settings) {
  const log = [];
  return {
    log, busy: false, settings: { format: 'pdf', quality: 80, archive: 'zip', effort: {}, level: {}, ...settings },
    begin() { this.ctrl = new AbortController(); return this.ctrl.signal; },
    end() { this.ended = true; }, progress() {},
    say(t) { log.push(['say', t]); }, warn(t) { log.push(['warn', t]); },
    sayWithWarnings(t, w) { log.push(['final', t, w]); },
    get final() { const f = log.filter((x) => x[0] === 'final').pop(); return f ? { text: f[1], warnings: f[2] } : null; },
  };
}
const saveTo = async (entry, dir) => {
  const f = path.join(dir, entry.name.replace(/\//g, '_'));
  fs.writeFileSync(f, Buffer.from(await entry.blob.arrayBuffer()));
  return f;
};

(async () => {
  const dir = path.join(work, 'przegladarka');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  // 1. Ograniczona liczba stron w toku: wolny koder nie gromadzi zdekodowanych stron w kolejce wątku.
  {
    const { T, env } = boot({ opDelay: { webp: 15 } });
    const cards = Array.from({ length: 40 }, (_, j) => ({ id: j + 1, numberPart: j + 1, twoPages: false, pages: [{ pageKey: `k${j}` }] }));
    const ctrl = new AbortController();
    let pagesDone = 0;
    const out = await T.buildDocumentOutput(cards, { firstCard: '1', lastCard: '40' }, { format: 'webp-lossless', quality: 80, effort: {}, level: {} },
      ctrl.signal, () => { pagesDone++; });
    ok(out.files.length === 40 && pagesDone === 40, `WebP: 40 stron, wszystkie w wyniku (${out.files.length})`);
    ok(env.maxInflight.webp <= T.CFG.pagesInFlight, `najwyżej ${T.CFG.pagesInFlight} stron naraz w kolejce kodera (było ${env.maxInflight.webp})`);
    ok(out.files.map((f) => f.name).join() === cards.map((c) => `k. ${String(c.numberPart).padStart(3, '0')}.webp`).join(), 'strony w kolejności kart');
  }

  // 2. „Przerwij”: po zwróceniu nie ma już postępu ani zadań w tle.
  {
    const { T } = boot({ opDelay: { webp: 20 } });
    const cards = Array.from({ length: 30 }, (_, j) => ({ id: j + 1, numberPart: j + 1, pages: [{ pageKey: `k${j}` }] }));
    const ctrl = new AbortController();
    let calls = 0, err = null;
    setTimeout(() => ctrl.abort(), 80);
    try {
      await T.buildDocumentOutput(cards, {}, { format: 'webp-lossless', quality: 80, effort: {}, level: {} }, ctrl.signal, () => { calls++; });
    } catch (e) { err = e; }
    const atReturn = calls;
    await sleep(300);
    ok(err instanceof T.Aborted, `przerwanie: błąd Aborted (${err && err.constructor.name})`);
    ok(calls === atReturn, `po przerwaniu brak postępu z zadań w tle (${atReturn} → ${calls})`);
  }

  // 3. Błąd jednej strony zatrzymuje dokument, a pozostałe strony nie dopisują postępu po zwróceniu.
  {
    const { T } = boot({ route: (m, url) => (url.includes('pageKey=k5') ? { status: 404, type: 'text/plain', bytes: new Uint8Array(0) } : null) });
    const cards = Array.from({ length: 20 }, (_, j) => ({ id: j + 1, numberPart: j + 1, pages: [{ pageKey: `k${j}` }] }));
    let calls = 0, err = null;
    try {
      await T.buildDocumentOutput(cards, {}, { format: 'png', quality: 80, effort: {}, level: {} }, new AbortController().signal, () => { calls++; });
    } catch (e) { err = e; }
    const atReturn = calls;
    await sleep(200);
    ok(err && /HTTP 404/.test(err.message), `błąd strony: pierwszy błąd zgłoszony (${err && err.message})`);
    ok(calls === atReturn, 'po błędzie strony brak postępu z zadań w tle');
  }

  // 4. Powtórzony numer karty: unikalne nazwy plików stron; odpowiedź, która nie jest obrazem – błąd.
  {
    const { T } = boot();
    const cards = [{ id: 1, numberPart: 12, pages: [{ pageKey: 'a' }] }, { id: 2, numberPart: 12, pages: [{ pageKey: 'b' }] },
      { id: 3, numberPart: 13, twoPages: true, pages: [{ pageKey: 'c', isVerte: false }, { pageKey: 'd', isVerte: false }] }];
    const out = await T.buildDocumentOutput(cards, {}, { format: 'png', quality: 80, effort: {}, level: {} }, new AbortController().signal);
    const names = out.files.map((f) => f.name);
    ok(new Set(names.map((n) => n.toLowerCase())).size === names.length, `nazwy stron unikalne: ${names.join(', ')}`);
    const { T: T2 } = boot({ route: (m, url) => (url.includes('/api/page') ? { type: 'application/json', bytes: new TextEncoder().encode('{"error":1}') } : null) });
    let err = null;
    try { await T2.buildDocumentOutput(cards, {}, { format: 'png', quality: 80, effort: {}, level: {} }, new AbortController().signal); } catch (e) { err = e; }
    ok(err && /nie zwrócił obrazu/.test(err.message), `odpowiedź bez obrazu → błąd dokumentu (${err && err.message})`);
  }

  // 5. Kolejka żądań: po przerwaniu czekające żądania wypadają od razu (bez 150 ms na każde).
  {
    const { T } = boot();
    const pacer = new T.Pacer(2, 150);
    const ctrl = new AbortController();
    const dead = Array.from({ length: 30 }, () => pacer.run(() => sleep(10), ctrl.signal).catch(() => 'przerwane'));
    await sleep(20);
    ctrl.abort();
    const t0 = Date.now();
    await pacer.run(() => sleep(1));
    const waited = Date.now() - t0;
    const results = await Promise.all(dead);
    ok(waited < 600, `nowe żądanie po przerwaniu 30 czekających: ${waited} ms (bez poprawki ok. 4 s)`);
    ok(results.filter((r) => r === 'przerwane').length >= 27, 'przerwane żądania odrzucone');
  }

  // 6. TAR.GZ i ZIP z kompresją bez kodeków (menedżer bez @resource): kompresja przeglądarki.
  for (const archive of ['tar.gz', 'zip-deflate']) {
    const { T, env } = boot({ gm: false });
    const ui = fakeUi({ archive });
    await T.downloadAll(ui);
    const f = env.saved.length === 1 ? await saveTo(env.saved[0], dir) : null;
    let valid = false;
    try {
      if (archive === 'tar.gz') valid = execFileSync('tar', ['-tzf', f], { encoding: 'utf8' }).split('\n').filter(Boolean).length === 4;
      else valid = /No errors detected/.test(execFileSync('unzip', ['-t', f], { encoding: 'utf8' }));
    } catch (e) { valid = false; }
    ok(valid && ui.final && /Gotowe: 3 z 3/.test(ui.final.text), `${archive} bez kodeka: ${env.saved.map((s) => s.name).join()} – ${ui.final && ui.final.text.split('\n')[0]}`);
  }

  // 7. Nieudana kompresja części archiwum: zapis bez kompresji (.tar), pobieranie trwa dalej.
  {
    let xzCalls = 0;
    const { T, env } = boot({ docs: 4, pages: 2, partBytes: 2500,
      ops: { xz: async ({ data, level }) => { if (++xzCalls === 1) throw new Error('brak pamięci (test)'); return execFileSync('xz', ['-c', `-${level}`], { input: Buffer.from(data) }); } } });
    const ui = fakeUi({ archive: 'tar.xz' });
    await T.downloadAll(ui);
    const names = env.saved.map((s) => s.name);
    const plain = env.saved.find((s) => s.name.endsWith('.tar'));
    let plainOk = false;
    if (plain) plainOk = execFileSync('tar', ['-tf', await saveTo(plain, dir)], { encoding: 'utf8' }).includes('spis-dokumentow.csv');
    ok(ui.final && /Gotowe: 4 z 4/.test(ui.final.text), `części: ${names.join(', ')} – ${ui.final && ui.final.text.split('\n')[0]}`);
    ok(plainOk && names.some((n) => n.endsWith('.tar.xz')), 'pierwsza część zapisana jako .tar (kompresja się nie udała), kolejne normalnie');
    ok(ui.final && ui.final.warnings.some((w) => /bez kompresji/.test(w)), 'ostrzeżenie o zapisie bez kompresji');
  }

  // 8. Portal przestaje odpowiadać: ponowienie, potem przerwanie i zapis tego, co już pobrane.
  {
    const { T, env } = boot({ docs: 8, pages: 2,
      route: (m, url) => (/documentId=([4-8])\b/.test(url) ? { error: true } : null) });
    const ui = fakeUi({ archive: 'zip' });
    await T.downloadAll(ui);
    const cardsAsked = env.requests.filter((r) => /documentId=4\b/.test(r.url)).length;
    ok(ui.final && /Pobieranie przerwane\. Zapisane pliki: .*NIEKOMPLETNE/.test(ui.final.text), `awaria portalu: ${ui.final && ui.final.text}`);
    ok(ui.final && ui.final.warnings.some((w) => /Portal nie odpowiada \(3 dokumenty/.test(w)), 'przerwane po 3 dokumentach z rzędu');
    ok(cardsAsked >= 2 * T.CFG.retries, `dokument ponowiony po przerwie (${cardsAsked} żądań kart dokumentu 4)`);
    const zipF = env.saved.length ? await saveTo(env.saved[0], dir) : null;
    const listing = zipF ? execFileSync('unzip', ['-Z1', zipF], { encoding: 'utf8' }) : '';
    ok((listing.match(/\.pdf/g) || []).length === 3 && listing.includes('spis-dokumentow.csv'), 'w archiwum NIEKOMPLETNE: 3 pobrane dokumenty i spis');
  }

  // 9. Kodek, który nie startuje: błąd od razu, przed pobieraniem stron; wątek zamknięty.
  {
    const { T, env } = boot({ ops: { load: async () => { throw new Error('WebAssembly wyłączony (test)'); } } });
    const ui = fakeUi({ format: 'webp-lossless', archive: 'zip' });
    await T.downloadAll(ui);
    const pagesAsked = env.requests.filter((r) => r.url.includes('/api/page')).length;
    ok(ui.final && ui.final.warnings.some((w) => /Nie udało się uruchomić kodeka „webp”/.test(w)) && pagesAsked === 0,
      `kodek nie startuje: ${ui.final && ui.final.warnings[0]} (żądań stron: ${pagesAsked})`);
  }

  // 10. Po udanym pobieraniu wątek kodeków jest zamykany (pamięć WASM wraca do systemu).
  {
    const { T, env } = boot();
    const ui = fakeUi({ format: 'webp-lossless', archive: 'tar' });
    await T.downloadAll(ui);
    T.codecs.release(); // to robi ui.end() w prawdziwym interfejsie
    ok(ui.final && /Gotowe: 3 z 3/.test(ui.final.text) && env.terminated === 1, `wątek zamknięty po pobieraniu (zamknięć: ${env.terminated})`);
  }

  console.log(failed ? `\n${failed} błędów` : '\nWszystko OK');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
