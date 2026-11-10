// ==UserScript==
// @name         Portal Przeglądania Akt – pobieranie dokumentów (nieoficjalny)
// @namespace    https://github.com/Czekoloczek/prokuratura-akta
// @version      1.2.0
// @description  Nieoficjalny dodatek do Portalu Przeglądania Akt prokuratury: pobiera otwarty dokument albo całe akta – jako PDF lub obrazy (PNG, WebP, JPEG XL, JPEG), w archiwum ZIP, TAR, TAR.GZ, TAR.XZ albo TAR.ZST, ze spisem dokumentów.
// @author       Czekoloczek
// @license      GPL-3.0-or-later
// @homepageURL  https://github.com/Czekoloczek/prokuratura-akta
// @supportURL   https://github.com/Czekoloczek/prokuratura-akta/issues
// @match        https://przegladanieakt.prokuratura.gov.pl/*
// @grant        GM_getResourceText
// @grant        GM_getResourceURL
// @inject-into  page
// @resource     fflate    https://cdn.jsdelivr.net/npm/fflate@0.8.3/umd/index.js#sha256-Ri74BB/JcONhWiCp3SsuMEegc7Lacp708CtjS7qLe4M=
// @resource     lzma      https://cdn.jsdelivr.net/npm/lzma-wasm@1.0.7/dist/iife/index.js#sha256-eoXxGq2O53aID9xY/iN/HQ48FpXP1aHZInf5QJZJCnw=
// @resource     zstdJs    https://cdn.jsdelivr.net/npm/@bokuweb/zstd-wasm@0.0.27/dist/web/zstd.js#sha256-IuSbg9JnfDFyKq97+83HrmIxMlrZM7ZI0yyT/FZK/gI=
// @resource     zstdWasm  https://cdn.jsdelivr.net/npm/@bokuweb/zstd-wasm@0.0.27/dist/web/zstd.wasm#sha256-gCYO7leV7oByu1gh4gNzDHTco5CZOPWsESjaZ/liI98=
// @resource     webpJs    https://cdn.jsdelivr.net/npm/@jsquash/webp@1.5.0/codec/enc/webp_enc_simd.js#sha256-MDjmDrumJSuroIxpHjHR7+UDahhUNdqntK+u88ySc/k=
// @resource     webpWasm  https://cdn.jsdelivr.net/npm/@jsquash/webp@1.5.0/codec/enc/webp_enc_simd.wasm#sha256-OcJ5Jp7BFjuYe21pdJRY49WwO5WF9YtspUVbdrUEowU=
// @resource     jxlJs     https://cdn.jsdelivr.net/npm/@jsquash/jxl@1.3.0/codec/enc/jxl_enc.js#sha256-W7M9KiBPQwNb/KLFga/yhmlwau2ukxiDcsXVyBUy+Kg=
// @resource     jxlWasm   https://cdn.jsdelivr.net/npm/@jsquash/jxl@1.3.0/codec/enc/jxl_enc.wasm#sha256-PGwC30XA3t7asUaIh4nVQbI7mimcsW1Jfc5BKjpLx9M=
// @run-at       document-end
// @noframes
// ==/UserScript==

/*
 * Copyright (C) 2026 Czekoloczek
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * Nieoficjalny skrypt – nie jest związany z Prokuraturą Krajową ani z twórcami
 * systemu PROK-SYS. Działa wyłącznie w przeglądarce użytkownika i łączy się
 * tylko z portalem; niczego nigdzie nie wysyła.
 *
 * Kodeki (@resource) menedżer skryptów pobiera raz, przy instalacji, z jsDelivr
 * i sprawdza ich sumy SHA-256. Skrypt uruchamia je dopiero po wybraniu formatu,
 * który ich potrzebuje, w osobnym wątku (Web Worker):
 *   fflate 0.8.3 (MIT) – Deflate/gzip z poziomami kompresji,
 *   lzma-wasm 1.0.7 (MIT/Apache-2.0) – XZ,
 *   @bokuweb/zstd-wasm 0.0.27 (MIT) – Zstandard,
 *   @jsquash/webp 1.5.0 i @jsquash/jxl 1.3.0 (Apache-2.0; libwebp i libjxl – BSD) – WebP i JPEG XL.
 *
 * Jak to działa
 * -------------
 * Przeglądarka akt (PROK-SYS, moduł APR) pokazuje każdą stronę jako obrazek
 * z adresu  GetPage?shareId=…&pageKey=…,  a listę kart dokumentu bierze
 * z  GetDocumentCards?shareId=…&documentId=… . Skrypt pobiera dokładnie te
 * same obrazki, które przeglądarka i tak wyświetla, i składa z nich PDF.
 * JPEG i PNG trafiają do PDF-a bajt w bajt (bez ponownej kompresji), więc
 * jakość jest taka jak na ekranie.
 *
 * Żądania idą po kolei (2 naraz, z przerwą między nimi), żeby nie obciążać
 * portalu (regulamin, § 12). Nośniki (płyty, nagrania) portal pokazuje tylko
 * w czytelni prokuratury – skrypt ich nie pobiera, tylko wpisuje do spisu.
 */
(function () {
  'use strict';

  /* =====================================================================
   *  RDZEŃ: CRC32, rozpoznawanie obrazów, PDF, ZIP (bez zależności)
   * ===================================================================== */

  const utf8 = new TextEncoder();

  /** Ciąg ASCII (składnia PDF) → bajty. */
  function ascii(str) {
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
    return out;
  }

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  /** CRC-32 (ZIP); można liczyć przyrostowo: crc32(b, crc32(a)). */
  function crc32(bytes, crc = 0) {
    let c = (crc ^ 0xffffffff) >>> 0;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /** Rodzaj danych po sygnaturze bajtowej. */
  function sniff(b) {
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
    if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
    if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
    if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
    if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
    if (b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) ||
        (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a))) return 'tiff';
    let i = 0;
    while (i < b.length && i < 64 && (b[i] <= 0x20 || b[i] === 0xef || b[i] === 0xbb || b[i] === 0xbf)) i++;
    if (b[i] === 0x3c) return 'html';
    return 'unknown';
  }

  /** Nagłówek JPEG: wymiary, liczba składowych, DPI (JFIF), znacznik Adobe. */
  function parseJpeg(b) {
    let i = 2, dpi = null, adobe = false;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      if (m === 0xd9 || m === 0xda) return null;
      const len = (b[i + 2] << 8) | b[i + 3];
      const s = i + 4;
      if (m === 0xe0 && len >= 14 && b[s] === 0x4a && b[s + 1] === 0x46 && b[s + 2] === 0x49 &&
          b[s + 3] === 0x46 && b[s + 4] === 0) {
        const units = b[s + 7], xd = (b[s + 8] << 8) | b[s + 9], yd = (b[s + 10] << 8) | b[s + 11];
        if (xd && yd) {
          if (units === 1) dpi = [xd, yd];
          else if (units === 2) dpi = [xd * 2.54, yd * 2.54];
        }
      } else if (m === 0xee && len >= 12 && b[s] === 0x41 && b[s + 1] === 0x64 && b[s + 2] === 0x6f &&
                 b[s + 3] === 0x62 && b[s + 4] === 0x65) {
        adobe = true;
      } else if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return {
          sof: m, bpc: b[s], height: (b[s + 1] << 8) | b[s + 2], width: (b[s + 3] << 8) | b[s + 4],
          comps: b[s + 5], dpi, adobe,
        };
      }
      i += 2 + len;
    }
    return null;
  }

  /** Bloki PNG potrzebne do osadzenia w PDF bez dekodowania. */
  function parsePng(b) {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (b.length < 8 || sig.some((v, k) => b[k] !== v)) return null;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const r = { idat: [], plte: null, trns: false, trnsData: null, dpi: null };
    let p = 8;
    while (p + 12 <= b.length) {
      const len = dv.getUint32(p);
      const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
      const d = p + 8;
      if (d + len > b.length) return null;
      if (type === 'IHDR') {
        r.width = dv.getUint32(d); r.height = dv.getUint32(d + 4);
        r.bitDepth = b[d + 8]; r.colorType = b[d + 9]; r.interlace = b[d + 12];
      } else if (type === 'PLTE') r.plte = b.subarray(d, d + len);
      else if (type === 'tRNS') { r.trns = true; r.trnsData = b.subarray(d, d + len); }
      else if (type === 'pHYs' && len >= 9 && b[d + 8] === 1) r.dpi = [dv.getUint32(d) * 0.0254, dv.getUint32(d + 4) * 0.0254];
      else if (type === 'IDAT') r.idat.push(b.subarray(d, d + len));
      else if (type === 'IEND') break;
      p = d + len + 4;
    }
    return r;
  }

  /** PNG bez przezroczystości i przeplotu → obraz PDF (FlateDecode + predyktor PNG; 16 bitów od PDF 1.5). */
  function pngToPdfImage(p) {
    if (!p || !p.width || !p.height || p.interlace !== 0 || p.trns || !p.idat.length) return null;
    let colors, cs;
    if (p.colorType === 0 && [1, 2, 4, 8, 16].includes(p.bitDepth)) { colors = 1; cs = '/DeviceGray'; }
    else if (p.colorType === 2 && (p.bitDepth === 8 || p.bitDepth === 16)) { colors = 3; cs = '/DeviceRGB'; }
    else if (p.colorType === 3 && [1, 2, 4, 8].includes(p.bitDepth) && p.plte && p.plte.length >= 3) {
      colors = 1;
      const n = Math.min(256, Math.floor(p.plte.length / 3));
      let hex = '';
      for (let k = 0; k < n * 3; k++) hex += p.plte[k].toString(16).padStart(2, '0');
      cs = `[/Indexed /DeviceRGB ${n - 1} <${hex}>]`;
    } else return null;
    return {
      width: p.width, height: p.height, bpc: p.bitDepth, colorSpace: cs, filter: 'FlateDecode',
      decodeParms: `<< /Predictor 15 /Colors ${colors} /BitsPerComponent ${p.bitDepth} /Columns ${p.width} >>`,
      data: p.idat, dpi: p.dpi,
    };
  }

  async function deflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  class HtmlInsteadOfImage extends Error {}

  /**
   * Bajty obrazu strony → opis obrazu dla PdfBuilder.
   * JPEG/PNG osadzane bezpośrednio; inne formaty przez `rasterize` (przeglądarka).
   */
  async function toPdfImage(bytes, rasterize) {
    const kind = sniff(bytes);
    if (kind === 'jpeg') {
      const j = parseJpeg(bytes);
      if (j && j.width && j.height && j.bpc === 8 && [0xc0, 0xc1, 0xc2].includes(j.sof) && [1, 3, 4].includes(j.comps)) {
        return {
          width: j.width, height: j.height, bpc: 8, filter: 'DCTDecode', data: [bytes], dpi: j.dpi,
          colorSpace: j.comps === 1 ? '/DeviceGray' : j.comps === 3 ? '/DeviceRGB' : '/DeviceCMYK',
          decode: j.comps === 4 && j.adobe ? '[1 0 1 0 1 0 1 0]' : null,
        };
      }
    } else if (kind === 'png') {
      const img = pngToPdfImage(parsePng(bytes));
      if (img) return img;
    } else if (kind === 'html') {
      throw new HtmlInsteadOfImage('Serwer zwrócił stronę HTML zamiast obrazu.');
    }
    if (!rasterize) throw new Error(`Nieobsługiwany format obrazu strony (${kind}).`);
    return rasterize(bytes, kind);
  }

  const A4 = [595.28, 841.89];
  // Gęstości wpisywane domyślnie, gdy prawdziwej nikt nie zna (portal zapisuje w PNG 96 DPI z .NET,
  // choć skany mają 200 DPI) – nie mówią nic o rozmiarze kartki.
  const isPlaceholderDpi = (d) => Math.abs(d - 96) < 0.5 || Math.abs(d - 72) < 0.5;

  /**
   * Rozmiar strony PDF w punktach: z DPI obrazu, a gdy go brak, jest zastępczy (96/72)
   * albo wychodzi format spoza A7–A3 – dopasowanie do A4. Dzięki temu mniejsze kartki
   * z fałszywym 96 DPI nie wychodzą w PDF-ie większe od sąsiednich stron A4.
   */
  function pageSize(img) {
    const { width: w, height: h, dpi } = img;
    if (dpi && !dpi.some(isPlaceholderDpi) && dpi[0] >= 50 && dpi[1] >= 50 && dpi[0] <= 2400 && dpi[1] <= 2400) {
      const pw = (w / dpi[0]) * 72, ph = (h / dpi[1]) * 72;
      const longInch = Math.max(pw, ph) / 72;
      if (longInch >= 3 && longInch <= 17.5) return [pw, ph];
    }
    const [bw, bh] = w > h ? [A4[1], A4[0]] : A4;
    const s = Math.min(bw / w, bh / h);
    return [w * s, h * s];
  }

  const num = (x) => String(Math.round(x * 100) / 100);

  /** Napis tekstowy PDF (UTF-16BE z BOM) – polskie znaki w tytułach i etykietach. */
  function pdfText(s) {
    s = String(s);
    let hex = 'FEFF';
    for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, '0');
    return `<${hex.toUpperCase()}>`;
  }

  function pdfDate(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    const off = -d.getTimezoneOffset(), a = Math.abs(off);
    return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}` +
      `${p(d.getSeconds())}${off >= 0 ? '+' : '-'}${p(Math.floor(a / 60))}'${p(a % 60)}'`;
  }

  function randomHex(n) {
    const b = new Uint8Array(n);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Minimalny zapis PDF: jedna strona = jeden obraz na całą stronę.
   * Liczy na bieżąco rozmiar i CRC-32 (do ZIP-a) bez kopiowania danych.
   */
  class PdfBuilder {
    constructor() {
      this.chunks = []; this.size = 0; this.crc = 0;
      this.offsets = []; this.pages = []; this.labels = []; this.nextId = 3; // 1 = katalog, 2 = drzewo stron
      this.write('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
    }

    write(x) {
      const u8 = typeof x === 'string' ? ascii(x) : x;
      this.chunks.push(u8); this.size += u8.length; this.crc = crc32(u8, this.crc);
    }

    obj(id) { this.offsets[id] = this.size; this.write(`${id} 0 obj\n`); }

    addPage(img, label) {
      const imgId = this.nextId++, contentId = this.nextId++, pageId = this.nextId++;
      const [pw, ph] = pageSize(img);
      const len = img.data.reduce((a, c) => a + c.length, 0);
      this.obj(imgId);
      this.write(`<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height}` +
        ` /ColorSpace ${img.colorSpace} /BitsPerComponent ${img.bpc} /Filter /${img.filter}` +
        (img.decodeParms ? ` /DecodeParms ${img.decodeParms}` : '') +
        (img.decode ? ` /Decode ${img.decode}` : '') + ` /Length ${len} >>\nstream\n`);
      for (const c of img.data) this.write(c);
      this.write('\nendstream\nendobj\n');
      const content = `q ${num(pw)} 0 0 ${num(ph)} 0 0 cm /Im0 Do Q\n`;
      this.obj(contentId);
      this.write(`<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);
      this.obj(pageId);
      this.write(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(pw)} ${num(ph)}]` +
        ` /Resources << /XObject << /Im0 ${imgId} 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`);
      this.pages.push(pageId);
      this.labels.push(label || null);
    }

    /** Zamyka plik. meta: { title, subject, author }. */
    finish(meta = {}) {
      this.obj(2);
      this.write(`<< /Type /Pages /Count ${this.pages.length} /Kids [${this.pages.map((id) => `${id} 0 R`).join(' ')}] >>\nendobj\n`);
      let extra = '';
      if (this.labels.some(Boolean)) {
        const nums = this.labels.map((l, i) => `${i} << /P ${pdfText(l || String(i + 1))} >>`).join(' ');
        extra = ` /PageLabels << /Nums [${nums}] >>`;
      }
      this.obj(1);
      this.write(`<< /Type /Catalog /Pages 2 0 R${extra} >>\nendobj\n`);
      const infoId = this.nextId++;
      this.obj(infoId);
      this.write('<<' + (meta.title ? ` /Title ${pdfText(meta.title)}` : '') +
        (meta.subject ? ` /Subject ${pdfText(meta.subject)}` : '') +
        (meta.author ? ` /Author ${pdfText(meta.author)}` : '') +
        ` /Producer ${pdfText('Nieoficjalny skrypt pobierania z Portalu Przeglądania Akt')}` +
        ` /CreationDate (${pdfDate()}) >>\nendobj\n`); // data jako zwykły napis ASCII – czytają ją wszystkie narzędzia
      const xrefAt = this.size;
      let xref = `xref\n0 ${this.nextId}\n0000000000 65535 f \n`;
      for (let id = 1; id < this.nextId; id++) xref += `${String(this.offsets[id]).padStart(10, '0')} 00000 n \n`;
      const fileId = randomHex(16);
      this.write(xref);
      this.write(`trailer\n<< /Size ${this.nextId} /Root 1 0 R /Info ${infoId} 0 R /ID [<${fileId}> <${fileId}>] >>\n` +
        `startxref\n${xrefAt}\n%%EOF\n`);
      return { chunks: this.chunks, size: this.size, crc: this.crc, pages: this.pages.length };
    }
  }

  function dosDateTime(d) {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return [time, date];
  }

  /** Kompresja „deflate-raw” wbudowana w przeglądarkę (bez wyboru poziomu); null, gdy jej brak. */
  async function deflateRaw(data) {
    let cs;
    try { cs = new CompressionStream('deflate-raw'); } catch (e) { return null; }
    const blob = data instanceof Blob ? data : new Blob([data]);
    return new Response(blob.stream().pipeThrough(cs)).blob();
  }

  async function gzipBlob(blob) {
    return new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob();
  }

  async function inflateZlib(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  const byteSize = (x) => (x instanceof Blob ? x.size : x.length);

  /**
   * PNG → piksele RGBA bez canvas, więc dokładnie i bez wpływu ochrony przed fingerprintingiem.
   * Wszystkie typy kolorów i głębie bitowe bez przeplotu; dla PNG z przeplotem zwraca null.
   */
  async function decodePng(bytes) {
    const p = parsePng(bytes);
    if (!p || !p.width || !p.height || p.interlace !== 0 || !p.idat.length) return null;
    const { width: w, height: h, bitDepth: bd, colorType: ct } = p;
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
    if (!channels || ![1, 2, 4, 8, 16].includes(bd) || (ct === 3 && !p.plte)) return null;
    const bpp = Math.max(1, (channels * bd) >> 3);
    const stride = Math.ceil((w * channels * bd) / 8);
    const zdata = new Uint8Array(p.idat.reduce((a, c) => a + c.length, 0));
    let o = 0;
    for (const c of p.idat) { zdata.set(c, o); o += c.length; }
    const raw = await inflateZlib(zdata);
    if (raw.length < h * (stride + 1)) throw new Error('Uszkodzony PNG (za mało danych obrazu).');
    // Odfiltrowanie wierszy (filtry PNG 0–4).
    const px = new Uint8Array(h * stride);
    for (let y = 0; y < h; y++) {
      const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride, prev = dst - stride;
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? px[dst + x - bpp] : 0;
        const b = y > 0 ? px[prev + x] : 0;
        const c = x >= bpp && y > 0 ? px[prev + x - bpp] : 0;
        let v = raw[src + x];
        if (f === 1) v += a;
        else if (f === 2) v += b;
        else if (f === 3) v += (a + b) >> 1;
        else if (f === 4) {
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        } else if (f !== 0) throw new Error(`Nieznany filtr PNG (${f}).`);
        px[dst + x] = v & 0xff;
      }
    }
    // Próbka i (w kolejności kanałów) w wierszu: wartość w oryginalnej głębi (16 bit → starszy bajt).
    const sample = (row, i) => {
      if (bd === 8) return px[row + i];
      if (bd === 16) return px[row + 2 * i];
      const per = 8 / bd, byte = px[row + Math.floor(i / per)];
      return (byte >> (8 - bd * ((i % per) + 1))) & ((1 << bd) - 1);
    };
    const raw16 = (row, i) => (px[row + 2 * i] << 8) | px[row + 2 * i + 1];
    const scale = (v) => (bd < 8 ? Math.round((v * 255) / ((1 << bd) - 1)) : v);
    const t = p.trnsData;
    const rgba = new Uint8Array(w * h * 4);
    if (ct === 3) {
      // Paleta (tak zapisuje portal): gotowe kolory RGBA z tablicy – kilka razy szybciej niż piksel po pikselu.
      const lut8 = new Uint8Array(256 * 4);
      for (let i = 0; i < 256; i++) {
        lut8[i * 4] = p.plte[i * 3] || 0; lut8[i * 4 + 1] = p.plte[i * 3 + 1] || 0; lut8[i * 4 + 2] = p.plte[i * 3 + 2] || 0;
        lut8[i * 4 + 3] = t && i < t.length ? t[i] : 255;
      }
      const lut = new Uint32Array(lut8.buffer), out = new Uint32Array(rgba.buffer);
      const per = 8 / bd, mask = (1 << bd) - 1;
      for (let y = 0, k = 0; y < h; y++) {
        const row = y * stride;
        if (bd === 8) for (let x = 0; x < w; x++) out[k++] = lut[px[row + x]];
        else for (let x = 0; x < w; x++) out[k++] = lut[(px[row + ((x / per) | 0)] >> (8 - bd * ((x % per) + 1))) & mask];
      }
      return { width: w, height: h, rgba };
    }
    for (let y = 0; y < h; y++) {
      const row = y * stride;
      for (let x = 0; x < w; x++) {
        const k = (y * w + x) * 4;
        let r, g, bl, al = 255;
        if (ct === 0 || ct === 4) {
          const v = sample(row, x * channels);
          r = g = bl = scale(v);
          if (ct === 4) al = sample(row, x * 2 + 1);
          else if (t && t.length >= 2 && (bd === 16 ? raw16(row, x) : v) === ((t[0] << 8) | t[1])) al = 0;
        } else {
          r = sample(row, x * channels); g = sample(row, x * channels + 1); bl = sample(row, x * channels + 2);
          if (ct === 6) al = sample(row, x * 4 + 3);
          else if (t && t.length >= 6) {
            const vals = bd === 16 ? [raw16(row, x * 3), raw16(row, x * 3 + 1), raw16(row, x * 3 + 2)] : [r, g, bl];
            if (vals[0] === ((t[0] << 8) | t[1]) && vals[1] === ((t[2] << 8) | t[3]) && vals[2] === ((t[4] << 8) | t[5])) al = 0;
          }
        }
        rgba[k] = r; rgba[k + 1] = g; rgba[k + 2] = bl; rgba[k + 3] = al;
      }
    }
    return { width: w, height: h, rgba };
  }

  /* Opcje koderów jsquash (pełne struktury, bo koder wymaga wszystkich pól). */
  const WEBP_DEFAULTS = {
    quality: 75, target_size: 0, target_PSNR: 0, method: 4, sns_strength: 50, filter_strength: 60,
    filter_sharpness: 0, filter_type: 1, partitions: 0, segments: 4, pass: 1, show_compressed: 0,
    preprocessing: 0, autofilter: 0, partition_limit: 0, alpha_compression: 1, alpha_filtering: 1,
    alpha_quality: 100, lossless: 0, exact: 0, image_hint: 0, emulate_jpeg_size: 0, thread_level: 0,
    low_memory: 0, near_lossless: 100, use_delta_palette: 0, use_sharp_yuv: 0,
  };
  // Poziomy 0–9 bezstratnego WebP jak „cwebp -z” (WebPConfigLosslessPreset): [method, quality].
  const WEBP_LOSSLESS_PRESETS = [[0, 0], [1, 20], [2, 25], [3, 30], [3, 50], [4, 50], [4, 75], [4, 90], [5, 90], [6, 100]];
  const JXL_DEFAULTS = {
    effort: 7, quality: 75, progressive: false, epf: -1, lossyPalette: false, decodingSpeedTier: 0,
    photonNoiseIso: 0, lossyModular: false, lossless: false,
  };
  const clamp = (v, min, max) => Math.min(max, Math.max(min, Math.round(Number(v))));

  function webpOptions(lossless, quality, effort) {
    if (lossless) {
      const [method, q] = WEBP_LOSSLESS_PRESETS[clamp(effort, 0, 9)];
      return { ...WEBP_DEFAULTS, lossless: 1, exact: 1, method, quality: q };
    }
    return { ...WEBP_DEFAULTS, quality: clamp(quality, 0, 100), method: clamp(effort, 0, 6) };
  }

  function jxlOptions(lossless, quality, effort) {
    return lossless
      ? { ...JXL_DEFAULTS, lossless: true, quality: 100, effort: clamp(effort, 1, 9) }
      : { ...JXL_DEFAULTS, quality: clamp(quality, 0, 99), effort: clamp(effort, 1, 9) };
  }

  /* -------------------- bezstratna optymalizacja stron PDF -------------------- */

  /**
   * Filtry PNG (0–4) wybierane osobno dla każdego wiersza – jak w libpng: wygrywa filtr
   * o najmniejszej sumie |wartości|. Wynik: wiersze poprzedzone bajtem filtra (predyktor PNG w PDF).
   */
  function pngFilterRows(rows, h, stride, bpp) {
    const out = new Uint8Array(h * (stride + 1));
    const cand = Array.from({ length: 5 }, () => new Uint8Array(stride));
    for (let y = 0; y < h; y++) {
      const cur = y * stride, prev = cur - stride;
      let best = 0, bestSum = Infinity;
      for (let f = 0; f < 5; f++) {
        const c = cand[f];
        let sum = 0;
        for (let x = 0; x < stride; x++) {
          const a = x >= bpp ? rows[cur + x - bpp] : 0;
          const b = y > 0 ? rows[prev + x] : 0;
          const d = x >= bpp && y > 0 ? rows[prev + x - bpp] : 0;
          let p = 0;
          if (f === 1) p = a;
          else if (f === 2) p = b;
          else if (f === 3) p = (a + b) >> 1;
          else if (f === 4) {
            const pa = Math.abs(b - d), pb = Math.abs(a - d), pc = Math.abs(a + b - 2 * d);
            p = pa <= pb && pa <= pc ? a : pb <= pc ? b : d;
          }
          const r = (rows[cur + x] - p) & 0xff;
          c[x] = r;
          sum += r < 128 ? r : 256 - r;
        }
        if (sum < bestSum) { bestSum = sum; best = f; }
      }
      out[y * (stride + 1)] = best;
      out.set(cand[best], y * (stride + 1) + 1);
    }
    return out;
  }

  const luminance = (c) => 299 * ((c >> 16) & 255) + 587 * ((c >> 8) & 255) + 114 * (c & 255);

  /**
   * Strona jako paleta o najmniejszej możliwej głębi (1/2/4/8 bitów na piksel), gdy ma
   * najwyżej 256 kolorów; null przy większej liczbie. Kolory palety posortowane jasnością,
   * żeby filtry PNG lepiej przewidywały sąsiednie piksele.
   */
  function buildIndexed(rgba, w, h) {
    const map = new Map();
    let last = -1;
    for (let i = 0; i < w * h; i++) {
      const k = (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
      if (k !== last && !map.has(k)) {
        if (map.size === 256) return null;
        map.set(k, 0);
      }
      last = k;
    }
    const colors = [...map.keys()].sort((p, q) => luminance(p) - luminance(q));
    colors.forEach((c, i) => map.set(c, i));
    const bits = colors.length <= 2 ? 1 : colors.length <= 4 ? 2 : colors.length <= 16 ? 4 : 8;
    const stride = Math.ceil((w * bits) / 8);
    const rows = new Uint8Array(h * stride);
    let lastKey = -1, lastIdx = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const k = (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
        if (k !== lastKey) { lastKey = k; lastIdx = map.get(k); }
        const bit = x * bits;
        rows[y * stride + (bit >> 3)] |= lastIdx << (8 - bits - (bit & 7));
      }
    }
    let hex = '';
    for (const c of colors) hex += c.toString(16).padStart(6, '0');
    return { bits, stride, rows, count: colors.length, colorSpace: `[/Indexed /DeviceRGB ${colors.length - 1} <${hex}>]` };
  }

  /** Przezroczystość nałożona na białe tło (strona PDF i tak jest biała). */
  function flattenOnWhite(rgba) {
    for (let i = 0; i < rgba.length; i += 4) {
      const a = rgba[i + 3];
      if (a === 255) continue;
      for (let c = 0; c < 3; c++) rgba[i + c] = Math.round((rgba[i + c] * a + 255 * (255 - a)) / 255);
      rgba[i + 3] = 255;
    }
  }

  /** Nieprzezroczyste RGBA → wiersze szarości (1 bajt na piksel), gdy wszystkie piksele są szare, inaczej RGB. */
  function grayOrRgbRows(rgba) {
    let gray = true;
    for (let i = 0; i < rgba.length && gray; i += 4) gray = rgba[i] === rgba[i + 1] && rgba[i] === rgba[i + 2];
    const channels = gray ? 1 : 3;
    const rows = new Uint8Array((rgba.length / 4) * channels);
    for (let i = 0, j = 0; i < rgba.length; i += 4) {
      rows[j++] = rgba[i];
      if (!gray) { rows[j++] = rgba[i + 1]; rows[j++] = rgba[i + 2]; }
    }
    return { rows, channels, colorSpace: gray ? '/DeviceGray' : '/DeviceRGB' };
  }

  /**
   * Strona do PDF-a zapisana możliwie oszczędnie, ale bez żadnej straty: skrypt sam sprawdza,
   * co da się zastosować na tej konkretnej stronie, i wybiera najmniejszy wariant – łącznie
   * z oryginałem, więc wynik nigdy nie jest większy niż w „PDF z oryginalnymi PNG”.
   * JPEG i 16-bitowe PNG bez przezroczystości zostają bez zmian (bez straty nie da się ich zmniejszyć).
   * opts: zlib(bytes, level) → Promise<Uint8Array>, level 1–9, decodeRgba / rasterize (przeglądarka).
   */
  async function optimizePdfImage(bytes, { zlib, level = 9, decodeRgba = null, rasterize = null } = {}) {
    const kind = sniff(bytes);
    if (kind === 'html') throw new HtmlInsteadOfImage('Serwer zwrócił stronę HTML zamiast obrazu.');
    let original = null;
    try { original = await toPdfImage(bytes, null); } catch (e) { /* format wymagający dekodowania */ }
    if (kind === 'jpeg' && original) return original;
    let px = null, dpi = original ? original.dpi : null;
    const p = kind === 'png' ? parsePng(bytes) : null;
    if (p) {
      if (p.bitDepth === 16 && original) return original;
      dpi = p.dpi;
      // Nietypowy, ale czytelny PNG (np. bajty po końcu strumienia): zostaje oryginał albo dekoder przeglądarki.
      try { px = await decodePng(bytes); } catch (e) { if (original) return original; }
    }
    if (!px && decodeRgba) px = await decodeRgba(bytes, kind);
    if (!px) return original || toPdfImage(bytes, rasterize);
    const { width: w, height: h, rgba } = px;
    flattenOnWhite(rgba);

    const candidates = [];
    const idx = buildIndexed(rgba, w, h);
    if (idx) {
      candidates.push({ raw: idx.rows, bpc: idx.bits, colorSpace: idx.colorSpace, parms: null });
      // Filtry PNG pomagają tylko palecie 8-bitowej o płynnych przejściach (zmierzone: ok. 8% mniej).
      // Przy 1/2/4 bitach na piksel (skany z portalu) zawsze wychodzą większe, a gdy źródło już jest
      // 8-bitową paletą, dają ~1% kosztem dużo dłuższej kompresji – wtedy ich nie próbujemy.
      if (idx.bits === 8 && !(p && p.colorType === 3 && p.bitDepth === 8)) {
        candidates.push({ raw: pngFilterRows(idx.rows, h, idx.stride, 1), bpc: 8, colorSpace: idx.colorSpace,
          parms: `<< /Predictor 15 /Colors 1 /BitsPerComponent 8 /Columns ${w} >>` });
      }
    } else {
      const { rows, channels: ch, colorSpace } = grayOrRgbRows(rgba);
      candidates.push({ raw: pngFilterRows(rows, h, w * ch, ch), bpc: 8, colorSpace,
        parms: `<< /Predictor 15 /Colors ${ch} /BitsPerComponent 8 /Columns ${w} >>` });
    }
    let best = original ? { size: original.data.reduce((a, c) => a + c.length, 0), img: original } : null;
    for (const c of candidates) {
      const z = await zlib(c.raw, level);
      if (!best || z.length < best.size) {
        best = { size: z.length, img: { width: w, height: h, bpc: c.bpc, colorSpace: c.colorSpace, filter: 'FlateDecode',
          decodeParms: c.parms, data: [z], dpi } };
      }
    }
    return best.img;
  }

  /**
   * ZIP z nazwami w UTF-8; bez kompresji albo z Deflate. Poziom Deflate działa, gdy podano
   * compressor.deflateRaw (w przeglądarce: fflate w wątku kodeków); bez niego – kompresja
   * wbudowana w przeglądarkę z domyślnym poziomem.
   */
  class ZipBuilder {
    constructor({ deflate = false, level = 6, compressor = null } = {}) {
      this.deflate = deflate; this.level = level; this.compressor = compressor;
      this.parts = []; this.central = []; this.size = 0; this.count = 0;
      this.maxEntries = 0xffff; // bez ZIP64 – więcej plików trzeba dać do kolejnej części
    }

    /** data: Blob | Uint8Array; size i crc dotyczą danych przed kompresją (crc liczone tu, gdy go brak). */
    async add(name, data, size, crc, date = new Date(), signal) {
      let bytes = data instanceof Blob ? null : data;
      const getBytes = async () => bytes || (bytes = new Uint8Array(await data.arrayBuffer()));
      if (crc == null) crc = crc32(await getBytes());
      let payload = data, stored = size, method = 0;
      if (this.deflate && size > 0) {
        const packed = this.compressor && this.compressor.deflateRaw
          ? await this.compressor.deflateRaw(await getBytes(), this.level, signal)
          : await deflateRaw(data);
        if (packed && byteSize(packed) < size) { payload = packed; stored = byteSize(packed); method = 8; }
      }
      const nameBytes = utf8.encode(name);
      const [time, day] = dosDateTime(date);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
      h.setUint16(8, method, true); h.setUint16(10, time, true); h.setUint16(12, day, true);
      h.setUint32(14, crc, true); h.setUint32(18, stored, true); h.setUint32(22, size, true);
      h.setUint16(26, nameBytes.length, true); h.setUint16(28, 0, true);
      // Dane jako Blob: finish() je tylko składa (bez kopii), a tablice stron może zwolnić odśmiecacz.
      this.parts.push(new Uint8Array(h.buffer), nameBytes, payload instanceof Blob ? payload : new Blob([payload]));
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 0x0314, true); c.setUint16(6, 20, true);
      c.setUint16(8, 0x0800, true); c.setUint16(10, method, true); c.setUint16(12, time, true);
      c.setUint16(14, day, true); c.setUint32(16, crc, true); c.setUint32(20, stored, true);
      c.setUint32(24, size, true); c.setUint16(28, nameBytes.length, true);
      c.setUint32(38, (0o100644 << 16) >>> 0, true);
      c.setUint32(42, this.size, true);
      this.central.push(new Uint8Array(c.buffer), nameBytes);
      this.size += 30 + nameBytes.length + stored;
      this.count++;
    }

    addBytes(name, bytes, date, signal) { return this.add(name, bytes, bytes.length, crc32(bytes), date, signal); }

    async finish() {
      const cdSize = this.central.reduce((a, b) => a + b.length, 0);
      const e = new DataView(new ArrayBuffer(22));
      e.setUint32(0, 0x06054b50, true); e.setUint16(8, this.count, true); e.setUint16(10, this.count, true);
      e.setUint32(12, cdSize, true); e.setUint32(16, this.size, true);
      return new Blob([...this.parts, ...this.central, new Uint8Array(e.buffer)], { type: 'application/zip' });
    }
  }

  /** Rekord rozszerzonego nagłówka PAX: „<długość> klucz=wartość\n” (długość liczy także samą siebie). */
  function paxRecord(key, value) {
    const body = utf8.encode(` ${key}=${value}\n`).length;
    let len = body + 1;
    while (String(len).length + body !== len) len = String(len).length + body;
    return `${len} ${key}=${value}\n`;
  }

  const TAR_CHUNK = 32 * 1024 * 1024;
  const TAR_MIME = { gzip: 'application/gzip', xz: 'application/x-xz', zstd: 'application/zstd' };

  /**
   * TAR (ustar); długie albo nie-ASCII nazwy przez nagłówek PAX. Z codec = gzip/xz/zstd
   * kompresuje porcjami po 32 MB: każda porcja to osobny strumień, a złączone strumienie są
   * poprawnym plikiem (RFC 1952, specyfikacje .xz i Zstandard) – kodek nie potrzebuje pamięci
   * na całe archiwum. Dane trzymane są jako Bloby, więc archiwum zajmuje w pamięci ok. raz
   * swój rozmiar (plus skompresowana kopia przy kompresji); rozmiar ogranicza podział na części.
   */
  class TarBuilder {
    constructor({ codec = null, level = 6, compressor = null, chunkSize = TAR_CHUNK } = {}) {
      this.codec = codec; this.level = level; this.compressor = compressor; this.chunkSize = chunkSize;
      this.parts = []; this.size = 0; this.count = 0;
    }

    push(x) { this.parts.push(x); this.size += byteSize(x); }

    padTo512(n) { const r = n % 512; if (r) this.push(new Uint8Array(512 - r)); }

    header(name, size, mtime, type) {
      const h = new Uint8Array(512);
      const put = (bytes, off, len) => h.set(bytes.subarray(0, len), off);
      const oct = (n, off, len) => put(ascii(`${n.toString(8).padStart(len - 1, '0')}\0`), off, len);
      put(utf8.encode(name), 0, 100);
      oct(0o644, 100, 8); oct(0, 108, 8); oct(0, 116, 8);
      oct(size, 124, 12); oct(Math.floor(mtime / 1000), 136, 12);
      h.fill(0x20, 148, 156);
      h[156] = type.charCodeAt(0);
      put(ascii('ustar\0'), 257, 6); put(ascii('00'), 263, 2);
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += h[i];
      put(ascii(`${sum.toString(8).padStart(6, '0')}\0 `), 148, 8);
      return h;
    }

    async add(name, data, size, crc, date = new Date()) {
      if (this.result) throw new Error('Archiwum TAR jest już zamknięte.');
      const mtime = date.getTime();
      let headerName = name;
      if (!/^[\x20-\x7e]*$/.test(name) || utf8.encode(name).length > 100) {
        const pax = utf8.encode(paxRecord('path', name));
        const base = name.split('/').pop().replace(/[^\x20-\x7e]/g, '_').slice(0, 80);
        this.push(this.header(`PaxHeader/${base}`, pax.length, mtime, 'x'));
        this.push(pax);
        this.padTo512(pax.length);
        headerName = name.replace(/[^\x20-\x7e]/g, '_');
        if (headerName.length > 100) headerName = headerName.slice(-100);
      }
      this.push(this.header(headerName, size, mtime, '0'));
      // Dane jako Blob: finish() je tylko składa (bez kopii), a tablice stron może zwolnić odśmiecacz.
      this.push(data instanceof Blob ? data : new Blob([data]));
      this.padTo512(size);
      this.count++;
    }

    addBytes(name, bytes, date) { return this.add(name, bytes, bytes.length, 0, date); }

    get closed() { return !!this.result; }

    /** Zamyka archiwum (znacznik końca dopisywany raz); kolejne wywołania zwracają ten sam wynik. */
    finish(signal, onProgress) {
      if (!this.result) {
        this.push(new Uint8Array(1024));
        this.tar = new Blob(this.parts, { type: 'application/x-tar' });
        this.parts = []; // dane trzyma już Blob
        this.result = this.codec ? this.compress(this.tar, signal, onProgress) : Promise.resolve(this.tar);
        // Nieskompresowana kopia potrzebna jest tylko wtedy, gdy kompresja się nie uda (zob. plain()).
        if (this.codec) this.result.then(() => { this.tar = null; }, () => {});
      }
      return this.result;
    }

    /** Archiwum bez kompresji – zapas, gdy kompresja zamkniętego archiwum się nie powiodła. */
    plain() { return this.tar || null; }

    async compress(tar, signal, onProgress) {
      const type = TAR_MIME[this.codec];
      const fn = this.compressor && this.compressor[this.codec];
      if (!fn) {
        if (this.codec === 'gzip') return new Blob([await gzipBlob(tar)], { type });
        throw new Error(`Brak kodeka „${this.codec}” – archiwum nie da się skompresować.`);
      }
      const out = [];
      for (let off = 0; off < tar.size; off += this.chunkSize) {
        const chunk = new Uint8Array(await tar.slice(off, off + this.chunkSize).arrayBuffer());
        out.push(new Blob([await fn(chunk, this.level, signal)])); // Blob: skompresowana porcja bez dalszych kopii
        onProgress && onProgress(Math.min(tar.size, off + this.chunkSize), tar.size);
      }
      return new Blob(out, { type });
    }
  }

  /**
   * Formaty archiwum. codec/needs – kodek z wątku kodeków (needs: zasób do wczytania),
   * levels – zakres i domyślny poziom kompresji.
   */
  const ARCHIVES = {
    zip: { label: 'ZIP – bez kompresji', ext: '.zip', create: () => new ZipBuilder() },
    'zip-deflate': {
      label: 'ZIP z kompresją (Deflate)', ext: '.zip', codec: 'deflateRaw', needs: 'fflate', levels: { min: 1, max: 9, def: 6 },
      create: (o = {}) => new ZipBuilder({ deflate: true, level: o.level, compressor: o.compressor }),
    },
    tar: { label: 'TAR – bez kompresji', ext: '.tar', create: () => new TarBuilder() },
    'tar.gz': {
      label: 'TAR.GZ (gzip)', ext: '.tar.gz', codec: 'gzip', needs: 'fflate', levels: { min: 1, max: 9, def: 6 },
      create: (o = {}) => new TarBuilder({ codec: 'gzip', level: o.level, compressor: o.compressor }),
    },
    'tar.xz': {
      label: 'TAR.XZ (xz)', ext: '.tar.xz', codec: 'xz', needs: 'lzma', levels: { min: 0, max: 9, def: 6 },
      create: (o = {}) => new TarBuilder({ codec: 'xz', level: o.level, compressor: o.compressor }),
    },
    'tar.zst': {
      label: 'TAR.ZST (Zstandard)', ext: '.tar.zst', codec: 'zstd', needs: 'zstd', levels: { min: 1, max: 19, def: 3 },
      create: (o = {}) => new TarBuilder({ codec: 'zstd', level: o.level, compressor: o.compressor }),
    },
  };

  const MIME_OF = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
  const EXT_OF = { png: '.png', jpeg: '.jpg', gif: '.gif', webp: '.webp', bmp: '.bmp', tiff: '.tif' };

  /** Nazwa pliku strony: „k. 012.png”, „k. 012v.png”; bez numerów kart – „strona 001.png”. */
  function pageFileName(label, index, width, ext) {
    const m = label && /^k\. (\d+)(v?)$/.exec(label);
    return m ? `k. ${m[1].padStart(width, '0')}${m[2]}${ext}` : `strona ${String(index + 1).padStart(width, '0')}${ext}`;
  }

  /* -------------------- nazwy plików i spis -------------------- */

  /** Bezpieczna nazwa pliku/katalogu (Linux, Windows, macOS). */
  function safeName(s, max = 100) {
    s = String(s == null ? '' : s).normalize('NFC')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ').trim()
      .replace(/^\.+/, '').replace(/[. ]+$/, '');
    if (s.length > max) s = s.slice(0, max).replace(/[. ]+$/, '');
    return s || 'bez nazwy';
  }

  /** „5” → „005”, „5.1” → „005.1” – żeby menedżer plików sortował w kolejności akt. */
  function padIndex(idx, width) {
    return String(idx).replace(/^\d+/, (d) => d.padStart(width, '0'));
  }

  function cardRange(n) {
    if (!n || n.firstCard == null || n.lastCard == null || n.firstCard === '' || n.lastCard === '') return '';
    return String(n.firstCard) === String(n.lastCard) ? `k. ${n.firstCard}` : `k. ${n.firstCard}-${n.lastCard}`;
  }

  function stripHtml(s) {
    return String(s == null ? '' : s).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  }

  function csv(rows) {
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return '\ufeff' + rows.map((r) => r.map(esc).join(';')).join('\r\n') + '\r\n';
  }

  /**
   * Strony do pobrania z listy kart – jak w przeglądarce akt: awers, a przy twoPages
   * także rewers. Etykieta strony: „k. 12” / „k. 12v” z pól numberPart i isVerte;
   * gdy ich brak – z zakresu kart dokumentu (o ile liczba kart się zgadza).
   */
  function cardPages(cards, firstCard, lastCard) {
    const real = (cards || []).filter((c) => c && c.id > 0 && Array.isArray(c.pages) && c.pages.length && c.pages[0].pageKey);
    const first = Number.parseInt(firstCard, 10), last = Number.parseInt(lastCard, 10);
    const sequential = Number.isFinite(first) && Number.isFinite(last) && last - first + 1 === real.length;
    const out = [];
    real.forEach((c, i) => {
      const no = Number.isFinite(c.numberPart) && c.numberPart > 0 ? c.numberPart : sequential ? first + i : null;
      const sides = c.twoPages && c.pages[1] && c.pages[1].pageKey ? [c.pages[0], c.pages[1]] : [c.pages[0]];
      sides.forEach((p, s) => {
        const verso = typeof p.isVerte === 'boolean' ? p.isVerte : s === 1;
        out.push({ card: c, key: p.pageKey, label: no != null ? `k. ${no}${verso ? 'v' : ''}` : null });
      });
    });
    return out;
  }

  /**
   * Kod wątku kodeków. Serializowany przez toString(), więc nie może korzystać z niczego spoza
   * siebie. Worker jest klasyczny (z importScripts), bo po nim kod Emscripten rozpoznaje workera.
   */
  function codecWorkerMain() {
    'use strict';
    const mods = {};
    const run = (text) => {
      const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
      try { importScripts(url); } finally { URL.revokeObjectURL(url); }
    };
    // Moduł ES z Emscripten → zwykły skrypt w osobnej funkcji (bez konfliktu zmiennej „Module”).
    const asClassic = (text, key) => `(function () {\nvar __importMeta = { url: 'https://localhost/${key}.js' };\n${
      text.replace(/import\.meta/g, '__importMeta')
        .replace(/export\s+default\s+Module\s*;?/, `self.__codec_${key} = Module;`)
        .replace(/export\s*\{\s*Module\s*\}\s*;?/, `self.__codec_${key} = Module;`)
    }\n})();`;
    const loaders = {
      async fflate({ js }) { run(js); mods.fflate = self.fflate; },
      async lzma({ js }) {
        self.window = self; // plik kończy się instrukcją „window.LzmaWasm = …”
        try { run(js); } finally { delete self.window; }
        const lzma = self.lzma_wasm;
        await lzma.initWasm();
        mods.lzma = lzma; // dopiero po udanej inicjalizacji – inaczej kolejne „load” udawałoby sukces
      },
      async zstd({ js, wasm }) {
        run(asClassic(js, 'zstd'));
        const M = self.__codec_zstd;
        // zstd.js przy błędzie kompilacji WASM tylko to loguje i nigdy nie kończy startu, więc moduł WASM
        // tworzymy sami (instantiateWasm): błąd odrzuca wczytywanie zamiast je zawiesić.
        await new Promise((resolve, reject) => {
          M.onRuntimeInitialized = resolve;
          M.onAbort = (what) => reject(new Error(`zstd: ${what}`));
          M.instantiateWasm = (imports, receive) => {
            WebAssembly.instantiate(wasm, imports).then((r) => receive(r.instance)).catch(reject);
            return {};
          };
          M.init(wasm);
        });
        mods.zstd = M;
      },
      async webp({ js, wasm }) {
        run(asClassic(js, 'webp'));
        mods.webp = await self.__codec_webp({ wasmBinary: wasm, noInitialRun: true });
      },
      async jxl({ js, wasm }) {
        run(asClassic(js, 'jxl'));
        mods.jxl = await self.__codec_jxl({ wasmBinary: wasm, noInitialRun: true });
      },
    };
    const zstdCompress = (buf, level) => {
      const M = mods.zstd;
      const bound = M._ZSTD_compressBound(buf.byteLength);
      const dst = M._malloc(bound), src = M._malloc(buf.byteLength);
      try {
        M.HEAPU8.set(buf, src);
        const n = M._ZSTD_compress(dst, bound, src, buf.byteLength, level);
        if (M._ZSTD_isError(n)) throw new Error(`zstd: błąd kompresji (${n}).`);
        return M.HEAPU8.slice(dst, dst + n);
      } finally { M._free(dst); M._free(src); }
    };
    const encode = (mod, { rgba, width, height, options }) => {
      const out = mod.encode(new Uint8Array(rgba), width, height, options);
      if (!out) throw new Error('Kodowanie obrazu nie powiodło się.');
      return out;
    };
    const ops = {
      async load(a) { if (!mods[a.name]) await loaders[a.name](a); return null; },
      deflateRaw: ({ data, level }) => mods.fflate.deflateSync(new Uint8Array(data), { level }),
      gzip: ({ data, level }) => mods.fflate.gzipSync(new Uint8Array(data), { level, mtime: 0 }),
      zlib: ({ data, level }) => mods.fflate.zlibSync(new Uint8Array(data), { level }),
      xz: ({ data, level }) => mods.lzma.compress(new Uint8Array(data), { format: 'xz', level }),
      zstd: ({ data, level }) => zstdCompress(new Uint8Array(data), level),
      webp: (a) => encode(mods.webp, a),
      jxl: (a) => encode(mods.jxl, a),
    };
    self.onmessage = async (e) => {
      const { id, op, args } = e.data;
      try {
        let out = await ops[op](args);
        if (out == null) { self.postMessage({ id, ok: true, out: null }); return; }
        if (!(out instanceof Uint8Array)) out = new Uint8Array(out);
        // Przekazujemy tylko własny bufor – nigdy widoku na pamięć WASM.
        const own = out.byteOffset === 0 && out.byteLength === out.buffer.byteLength ? out : out.slice();
        self.postMessage({ id, ok: true, out: own }, [own.buffer]);
      } catch (err) {
        self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
      }
    };
  }

  const core = {
    crc32, sniff, parseJpeg, parsePng, pngToPdfImage, toPdfImage, pageSize, pdfText, PdfBuilder,
    ZipBuilder, TarBuilder, ARCHIVES, paxRecord, pageFileName, safeName, padIndex, cardRange, stripHtml, csv,
    cardPages, deflate, decodePng, webpOptions, jxlOptions, WEBP_DEFAULTS, JXL_DEFAULTS, optimizePdfImage,
    buildIndexed, pngFilterRows, codecWorkerMain,
  };

  // W Node (testy) eksportujemy rdzeń i kończymy.
  if (typeof window === 'undefined') {
    if (typeof module === 'object' && module.exports) module.exports = core;
    return;
  }

  /* =====================================================================
   *  CZĘŚĆ PRZEGLĄDARKOWA
   * ===================================================================== */

  // Obiekty strony (routing, documentViewer, jQuery…): w Tampermonkeyu z @grant skrypt działa w piaskownicy.
  /* global unsafeWindow */
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  if (W.__aktaPobieranie) return;
  W.__aktaPobieranie = true;

  const CFG = {
    concurrency: 2,                     // ile żądań do portalu naraz
    gapMs: 150,                         // minimalny odstęp między żądaniami
    pagesInFlight: 4,                   // ile stron naraz od pobrania do zakodowania (ogranicza pamięć)
    retries: 5,                         // próby przy błędach przejściowych (odstępy 2, 5, 12,5 i 31 s)
    outagePauseMs: 60 * 1000,           // przerwa przed ponowieniem dokumentu, gdy portal nie odpowiada
    outageStreak: 3,                    // tyle dokumentów z rzędu bez odpowiedzi portalu przerywa pobieranie
    partBytes: 1536 * 1024 * 1024,      // archiwum dzielone na części po ok. 1,5 GB
  };

  const log = (...a) => console.log('[pobieranie akt]', ...a);

  class Fatal extends Error {}
  class Transient extends Error {}
  class Aborted extends Error { constructor() { super('Przerwano.'); } }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(new Aborted());
      const t = setTimeout(() => { signal && signal.removeEventListener('abort', onAbort); resolve(); }, ms);
      const onAbort = () => { clearTimeout(t); reject(new Aborted()); };
      signal && signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function routeUrl(name) {
    try {
      const r = W.routing && typeof W.routing.getRoute === 'function' ? W.routing.getRoute(name) : null;
      return r && r.url ? r.url : null;
    } catch (e) { return null; }
  }

  function needRoute(name) {
    const u = routeUrl(name);
    if (!u) throw new Fatal(`Portal nie udostępnia na tej stronie trasy „${name}”.`);
    return u;
  }

  function shareId() {
    const dv = W.documentViewer;
    if (dv && dv.caseId != null && dv.caseId !== '') return dv.caseId;
    const u = routeUrl('loadTreeNodes') || routeUrl('getBinaryAttachment') || '';
    const m = u.match(/[?&]shareId=([^&#]+)/i);
    return m ? decodeURIComponent(m[1]) : null;
  }

  /** Żądanie przez XMLHttpRequest – tak jak robi to sam portal (jQuery). */
  function request(method, url, { body, json = false, signal, timeout = 120000 } = {}) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(new Aborted());
      const x = new XMLHttpRequest();
      x.open(method, url, true);
      x.responseType = 'arraybuffer';
      x.timeout = timeout;
      if (json) {
        x.setRequestHeader('Accept', 'application/json, text/javascript, */*; q=0.01');
        x.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
      }
      if (body !== undefined) x.setRequestHeader('Content-Type', 'application/json; charset=utf-8');
      const onAbort = () => x.abort();
      const done = () => signal && signal.removeEventListener('abort', onAbort);
      signal && signal.addEventListener('abort', onAbort, { once: true });
      x.onload = () => {
        done();
        resolve({
          status: x.status, url: x.responseURL || url,
          type: x.getResponseHeader('Content-Type') || '',
          disposition: x.getResponseHeader('Content-Disposition') || '',
          bytes: new Uint8Array(x.response || new ArrayBuffer(0)),
        });
      };
      x.onerror = () => { done(); reject(new Transient('Błąd sieci.')); };
      x.ontimeout = () => { done(); reject(new Transient('Serwer nie odpowiedział w czasie.')); };
      x.onabort = () => { done(); reject(new Aborted()); };
      x.send(body === undefined ? null : body);
    });
  }

  /** Ogranicza liczbę równoczesnych żądań i ich tempo. Przerwane czekające żądania od razu wypadają z kolejki. */
  class Pacer {
    constructor(concurrency, gapMs) {
      this.concurrency = concurrency; this.gapMs = gapMs;
      this.active = 0; this.queue = []; this.last = 0; this.timer = null;
    }
    run(fn, signal) {
      return new Promise((resolve, reject) => {
        if (signal && signal.aborted) { reject(new Aborted()); return; }
        const job = { fn, resolve, reject, off: null };
        if (signal) {
          const onAbort = () => {
            const k = this.queue.indexOf(job);
            if (k >= 0) { this.queue.splice(k, 1); reject(new Aborted()); }
          };
          signal.addEventListener('abort', onAbort, { once: true });
          job.off = () => signal.removeEventListener('abort', onAbort);
        }
        this.queue.push(job);
        this.pump();
      });
    }
    pump() {
      while (this.active < this.concurrency && this.queue.length && !this.timer) {
        const wait = this.last + this.gapMs - Date.now();
        if (wait > 0) {
          this.timer = setTimeout(() => { this.timer = null; this.pump(); }, wait);
          return;
        }
        const job = this.queue.shift();
        if (job.off) job.off();
        this.active++; this.last = Date.now();
        Promise.resolve().then(job.fn).then(job.resolve, job.reject).finally(() => { this.active--; this.pump(); });
      }
    }
  }

  const pacer = new Pacer(CFG.concurrency, CFG.gapMs);

  async function withRetry(fn, signal) {
    let delay = 2000;
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof Transient) || attempt >= CFG.retries) throw e;
        log(`ponawiam za ${delay} ms:`, e.message);
        await sleep(delay, signal);
        delay = Math.round(delay * 2.5);
      }
    }
  }

  function problemFromHtml(res) {
    const head = new TextDecoder().decode(res.bytes.subarray(0, 4096));
    if (/Request Rejected/i.test(head)) {
      const m = head.match(/support ID is:\s*(?:&lt;|<)?\s*(\d+)/i);
      return new Fatal(`Zapora portalu odrzuciła żądanie${m ? ` (Support ID ${m[1]})` : ''}. ` +
        'Odczekaj kilka minut i spróbuj ponownie.');
    }
    if (/\/Account\/Login/i.test(res.url) || /Strona logowania/i.test(head)) {
      return new Fatal('Sesja wygasła – zaloguj się ponownie i ponów pobieranie.');
    }
    return new Fatal('Serwer zwrócił stronę HTML zamiast danych.');
  }

  function checkStatus(res) {
    if (res.status === 401 || res.status === 403) {
      throw new Fatal(`Portal odmówił dostępu (HTTP ${res.status}) – sesja mogła wygasnąć.`);
    }
    if (res.status === 429 || res.status >= 500) throw new Transient(`HTTP ${res.status}`);
    if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
  }

  function fetchJson(method, url, body, signal) {
    return withRetry(async () => {
      const res = await pacer.run(() => request(method, url, { body, json: true, signal }), signal);
      checkStatus(res);
      if (/json/i.test(res.type)) return JSON.parse(new TextDecoder().decode(res.bytes));
      if (sniff(res.bytes) === 'html') throw problemFromHtml(res);
      throw new Error('Nieoczekiwana odpowiedź serwera.');
    }, signal);
  }

  function fetchBinary(url, signal) {
    return withRetry(async () => {
      const res = await pacer.run(() => request('GET', url, { signal }), signal);
      checkStatus(res);
      // HTML zamiast obrazu to strona logowania albo zapory – niezależnie od nagłówka Content-Type.
      if (sniff(res.bytes) === 'html') throw problemFromHtml(res);
      return res;
    }, signal);
  }

  /**
   * Obraz (dowolny format obsługiwany przez przeglądarkę) → canvas na białym tle.
   * Odmawia, gdy przeglądarka fałszuje odczyt z canvas – wynik (PDF lub JPEG/WebP)
   * miałby wtedy puste albo zaszumione strony.
   */
  async function drawToCanvas(bytes, kind) {
    if (!canvasOk) canvasOk = canvasReadbackOk();
    if (!canvasOk) {
      throw new Fatal('Przeglądarka blokuje albo zaszumia odczyt obrazów z canvas (ochrona przed śledzeniem), ' +
        'więc przetworzenie strony by ją zepsuło. Wybierz „PNG – oryginalne skany” albo zezwól stronie na odczyt canvas.');
    }
    const blob = new Blob([bytes], { type: MIME_OF[kind] || '' });
    let source, cleanup = () => {};
    try {
      source = await createImageBitmap(blob);
      cleanup = () => source.close && source.close();
    } catch (e) {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.src = url;
      try {
        await img.decode();
      } catch (err) {
        URL.revokeObjectURL(url);
        throw new Error(`Nie da się odczytać obrazu strony (format: ${kind}).`);
      }
      source = img;
      cleanup = () => URL.revokeObjectURL(url);
    }
    const w = source.naturalWidth || source.width, h = source.naturalHeight || source.height;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(source, 0, 0);
    cleanup();
    return canvas;
  }

  /**
   * Obraz, którego nie da się osadzić w PDF-ie wprost (PNG z przezroczystością lub przeplotem,
   * GIF, BMP…) → piksele na białym tle → Flate, bez strat. PNG dekoduje skrypt (bez canvas,
   * więc działa też przy ochronie przed fingerprintingiem); canvas tylko dla innych formatów.
   */
  async function rasterize(bytes, kind) {
    const { width, height, rgba } = await decodeToRgba(bytes, kind);
    flattenOnWhite(rgba);
    const { rows, colorSpace } = grayOrRgbRows(rgba);
    return { width, height, bpc: 8, colorSpace, filter: 'FlateDecode', data: [await deflate(rows)], dpi: null };
  }

  // Zapamiętujemy tylko sukces: po zezwoleniu na odczyt canvas kolejna próba ma szansę przejść.
  let canvasOk = false;

  /**
   * Czy odczyt pikseli z canvas jest wierny. Firefox z ochroną przed fingerprintingiem blokuje go
   * albo dodaje szum, Brave też szumi. Próbka 64×64 z wzorem, nie jednolita: Firefox nie zaszumia
   * płócien w jednym kolorze, a część implementacji pomija bardzo małe płótna.
   */
  function canvasReadbackOk() {
    try {
      const n = 64, c = document.createElement('canvas');
      c.width = c.height = n;
      const ctx = c.getContext('2d');
      const probe = ctx.createImageData(n, n);
      for (let i = 0; i < probe.data.length; i += 4) {
        probe.data[i] = i & 255; probe.data[i + 1] = (i * 7) & 255; probe.data[i + 2] = (i * 13) & 255; probe.data[i + 3] = 255;
      }
      ctx.putImageData(probe, 0, 0);
      const d = ctx.getImageData(0, 0, n, n).data;
      for (let i = 0; i < d.length; i++) if (d[i] !== probe.data[i]) return false;
      return true;
    } catch (e) { return false; }
  }

  /** Konwersja strony do JPEG przez canvas przeglądarki. quality: 30–100. */
  async function convertImage(bytes, kind, mime, quality) {
    const canvas = await drawToCanvas(bytes, kind);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, quality / 100));
    canvas.width = canvas.height = 0;
    // Brak wyniku dotyczy tej jednej strony (np. zabrakło pamięci) – to nie powód, by przerywać całe akta.
    if (!blob) throw new Error('Nie udało się zapisać strony jako JPEG (za mało pamięci?).');
    if (blob.type !== mime) {
      throw new Fatal(`Ta przeglądarka nie potrafi zapisywać obrazów ${mime.replace('image/', '').toUpperCase()}.`);
    }
    return new Uint8Array(await blob.arrayBuffer());
  }

  /* -------------------- wątek kodeków (WebP, JPEG XL, Deflate/gzip, XZ, zstd) -------------------- */

  /** Zasoby @resource kodeków: kod JS i ewentualnie WASM. */
  const CODEC_RESOURCES = {
    fflate: { js: 'fflate' },
    lzma: { js: 'lzma' },
    zstd: { js: 'zstdJs', wasm: 'zstdWasm' },
    webp: { js: 'webpJs', wasm: 'webpWasm' },
    jxl: { js: 'jxlJs', wasm: 'jxlWasm' },
  };

  /* global GM_getResourceText, GM_getResourceURL */
  const gmText = typeof GM_getResourceText === 'function' ? GM_getResourceText : null;
  const gmUrl = typeof GM_getResourceURL === 'function' ? GM_getResourceURL : null;
  const codecChecked = {};

  /** Czy menedżer skryptów udostępnił zasoby danego kodeka. */
  function codecAvailable(name) {
    if (!name) return true;
    if (!(name in codecChecked)) {
      try {
        codecChecked[name] = !!(gmText && gmUrl && CODEC_RESOURCES[name] && gmText(CODEC_RESOURCES[name].js));
      } catch (e) { codecChecked[name] = false; }
    }
    return codecChecked[name];
  }

  async function resourceBytes(name) {
    const r = await fetch(gmUrl(name, false)); // data: URL – działa niezależnie od kontekstu skryptu
    if (!r.ok) throw new Error(`Nie da się wczytać zasobu „${name}”.`);
    return r.arrayBuffer();
  }

  /** Strona główna ↔ wątek kodeków (kod wątku: codecWorkerMain w rdzeniu); przerwanie = zabicie wątku. */
  class CodecWorker {
    constructor() { this.worker = null; this.seq = 0; this.pending = new Map(); this.loading = new Map(); }

    start() {
      if (this.worker) return;
      const url = URL.createObjectURL(new Blob([`(${codecWorkerMain.toString()})();`], { type: 'text/javascript' }));
      this.worker = new Worker(url);
      setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
      this.worker.onmessage = (e) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        if (e.data.ok) p.resolve(e.data.out);
        else p.reject(new Error(e.data.error));
      };
      this.worker.onerror = (e) => {
        if (e.preventDefault) e.preventDefault();
        this.reset(new Error(`Błąd wątku kodeków: ${e.message || 'nieznany'}.`));
      };
    }

    reset(err) {
      if (this.worker) this.worker.terminate();
      this.worker = null;
      this.loading.clear();
      const pending = [...this.pending.values()];
      this.pending.clear();
      pending.forEach((p) => p.reject(err));
    }

    call(op, args, transfer, signal) {
      return new Promise((resolve, reject) => {
        if (signal && signal.aborted) { reject(new Aborted()); return; }
        this.start();
        const id = ++this.seq;
        const onAbort = () => this.reset(new Aborted());
        const done = () => signal && signal.removeEventListener('abort', onAbort);
        signal && signal.addEventListener('abort', onAbort, { once: true });
        this.pending.set(id, { resolve: (v) => { done(); resolve(v); }, reject: (e) => { done(); reject(e); } });
        this.worker.postMessage({ id, op, args }, transfer || []);
      });
    }

    /** Wczytuje kodek do wątku (raz; równoległe wywołania czekają na to samo). */
    ensure(name, signal) {
      // Zadanie już przerwane nie może zacząć wspólnego wczytywania, na które czekałyby inne.
      if (signal && signal.aborted) return Promise.reject(new Aborted());
      if (!this.loading.has(name)) {
        const res = CODEC_RESOURCES[name];
        const p = (async () => {
          if (!codecAvailable(name)) {
            throw new Fatal(`Brak kodeka „${name}”: menedżer skryptów nie udostępnił jego plików. ` +
              'Zainstaluj skrypt ponownie (np. z Greasy Fork) albo wybierz inny format.');
          }
          try {
            const wasm = res.wasm ? await resourceBytes(res.wasm) : null;
            await this.call('load', { name, js: gmText(res.js), wasm }, wasm ? [wasm] : [], signal);
          } catch (e) {
            if (e instanceof Aborted || e instanceof Fatal) throw e;
            // Np. wyłączony WebAssembly albo zablokowany wątek – przy kolejnych dokumentach byłoby tak samo.
            throw new Fatal(`Nie udało się uruchomić kodeka „${name}” (${describeError(e)}). ` +
              'Wybierz inny format albo archiwum.');
          }
        })();
        this.loading.set(name, p);
        p.catch(() => { if (this.loading.get(name) === p) this.loading.delete(name); });
      }
      return this.loading.get(name);
    }

    /** Zamyka bezczynny wątek: pamięć WASM koderów (nawet ponad 1 GB) wraca do systemu. */
    release() {
      if (this.worker && !this.pending.size) this.reset(new Aborted());
    }
  }

  const codecs = new CodecWorker();

  /** Kompresja archiwów w wątku kodeków (kopia danych – oryginał bywa jeszcze potrzebny). */
  async function codecCompress(codec, op, bytes, level, signal) {
    await codecs.ensure(codec, signal);
    const copy = bytes.slice();
    return codecs.call(op, { data: copy.buffer, level }, [copy.buffer], signal);
  }

  const compressor = {
    deflateRaw: (bytes, level, signal) => codecCompress('fflate', 'deflateRaw', bytes, level, signal),
    gzip: (bytes, level, signal) => codecCompress('fflate', 'gzip', bytes, level, signal),
    zlib: (bytes, level, signal) => codecCompress('fflate', 'zlib', bytes, level, signal),
    xz: (bytes, level, signal) => codecCompress('lzma', 'xz', bytes, level, signal),
    zstd: (bytes, level, signal) => codecCompress('zstd', 'zstd', bytes, level, signal),
  };

  /** Strona → piksele RGBA: PNG dekodujemy sami (dokładnie), inne formaty (i PNG z przeplotem) przez canvas. */
  async function decodeToRgba(bytes, kind) {
    if (kind === 'png') {
      try {
        const d = await decodePng(bytes);
        if (d) return d;
      } catch (e) { log('nietypowy PNG – dekoduje przeglądarka:', e.message); }
    }
    const canvas = await drawToCanvas(bytes, kind);
    const { width, height } = canvas;
    const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    canvas.width = canvas.height = 0;
    return { width, height, rgba: new Uint8Array(data.buffer) };
  }

  /** Kodowanie strony do WebP / JPEG XL w wątku kodeków. */
  async function encodeWithCodec(fmt, formatKey, bytes, kind, settings, signal) {
    const img = await decodeToRgba(bytes, kind);
    const effort = effortOf(settings, formatKey);
    const options = fmt.codec === 'webp'
      ? webpOptions(fmt.lossless, settings.quality, effort)
      : jxlOptions(fmt.lossless, settings.quality, effort);
    await codecs.ensure(fmt.codec, signal);
    return codecs.call(fmt.codec, { rgba: img.rgba.buffer, width: img.width, height: img.height, options },
      [img.rgba.buffer], signal);
  }

  /**
   * Przed pobieraniem wczytuje kodeki wybranego formatu i archiwum: błąd (np. wyłączony WebAssembly)
   * wychodzi od razu, zanim skrypt zacznie pobierać strony z portalu.
   */
  async function prepareCodecs(settings, withArchive, signal) {
    const f = FORMATS[settings.format], a = ARCHIVES[settings.archive];
    const names = new Set();
    if (f.codec && f.codec !== 'jpeg') names.add(f.codec);
    if (f.optimize && codecAvailable('fflate')) names.add('fflate');
    if (withArchive && a.needs && codecAvailable(a.needs)) names.add(a.needs);
    for (const name of names) await codecs.ensure(name, signal);
  }

  /* -------------------- dane z portalu -------------------- */

  function fetchCards(doc, signal) {
    let url = `${needRoute('getDocumentCards')}?shareId=${shareId()}&documentId=${doc.id}`;
    if (doc.version && doc.version.id) url += `&documentVersionId=${doc.version.id}`;
    return fetchJson('GET', url, undefined, signal);
  }

  function pageUrl(pageKey) {
    return `${needRoute('getPage')}?shareId=${shareId()}&pageKey=${pageKey}`;
  }

  /** Całe drzewo akt (tomy, dokumenty, załączniki, nośniki) – tak jak doczytuje je drzewo na stronie. */
  async function loadTree(signal, onProgress) {
    const base = needRoute('loadTreeNodes');
    const nodes = new Map(), order = [], asked = new Set();
    const queue = [''];
    while (queue.length) {
      const parent = queue.shift();
      asked.add(parent);
      const resp = await fetchJson('POST', `${base}&parentIds=${parent}`, 'null', signal);
      const data = Array.isArray(resp) ? resp : resp && Array.isArray(resp.data) ? resp.data : [];
      for (const n of data) {
        if (!n || typeof n.key !== 'string') continue;
        if (!nodes.has(n.key)) { nodes.set(n.key, n); order.push(n.key); }
        if (n.hasChildren && !asked.has(n.key) && !queue.includes(n.key)) queue.push(n.key);
      }
      onProgress && onProgress(nodes.size);
    }
    return { nodes, order };
  }

  const kindOf = (key) => String(key).split(':')[0];
  const idOf = (key) => Number.parseInt(String(key).split(':')[1], 10);

  /** Czy portal pokazuje temu udostępnieniu pola „przedmiot/obiekt” (jak drzewo akt). */
  function subjectAccess() {
    try {
      const a = W.APR && W.APR.AuthorizationService;
      return !!(a && typeof a.hasSubjectObjectAccess === 'function' && a.hasSubjectObjectAccess());
    } catch (e) { return false; }
  }

  function nodeLabel(n) {
    const idx = kindOf(n.key) === 'ba' ? n.attachmentIndex : n.index;
    const extra = subjectAccess() ? [n.subject, n.object].filter(Boolean).join(' / ') : '';
    return [idx != null && idx !== '' ? `${idx}.` : '', n.name || '', extra ? `– ${extra}` : '']
      .filter(Boolean).join(' ');
  }

  /** Plan pobierania: dokumenty w kolejności drzewa, z katalogami tomów. */
  function planFromTree({ nodes, order }) {
    const children = new Map(), roots = [];
    for (const key of order) {
      const p = nodes.get(key).parent;
      if (p != null && p !== '' && nodes.has(p)) {
        if (!children.has(p)) children.set(p, []);
        children.get(p).push(key);
      } else roots.push(key);
    }
    const caseRoot = roots.length === 1 && !['d', 'ba'].includes(kindOf(roots[0])) ? roots[0] : null;
    const width = Math.max(3, ...[...nodes.values()].map((n) => String(n.index == null ? '' : n.index).match(/^\d*/)[0].length));
    const used = new Map();
    const unique = (folder, stem, ext) => {
      const k = folder.join('/');
      if (!used.has(k)) used.set(k, new Set());
      const set = used.get(k);
      let name = stem + ext, i = 2;
      while (set.has(name.toLowerCase())) name = `${stem} (${i++})${ext}`;
      set.add(name.toLowerCase());
      return name;
    };
    const docs = [], bins = [];
    const walk = (key, folder, crumbs) => {
      const n = nodes.get(key), kids = children.get(key) || [];
      const kind = kindOf(key);
      if (kind === 'd') {
        const range = cardRange(n);
        const idx = n.index != null && n.index !== '' ? `${padIndex(n.index, width)}. ` : '';
        const stem = safeName(`${idx}${n.name || 'dokument'}${range ? ` (${range})` : ''}`, 140);
        // Nazwa bez rozszerzenia: dokument to „<nazwa>.pdf” albo folder „<nazwa>/” ze stronami.
        const name = unique(folder, stem, '');
        docs.push({ node: n, folder, stem: name, crumbs, label: nodeLabel(n) });
        if (kids.length) {
          const sub = folder.concat(safeName(`${name} – załączniki`, 140));
          kids.forEach((k) => walk(k, sub, crumbs.concat(nodeLabel(n))));
        }
      } else if (kind === 'ba') {
        bins.push({ node: n, folder, crumbs, label: nodeLabel(n) });
      } else {
        const isRoot = key === caseRoot;
        // „v:” to tom – portal nazywa go np. „I (1)”, więc dopisujemy „Tom”.
        const name = kind === 'v' && n.name && !/^tom\b/i.test(n.name) ? `Tom ${n.name}` : n.name || key;
        const sub = isRoot ? folder : folder.concat(safeName(name));
        kids.forEach((k) => walk(k, sub, isRoot ? crumbs : crumbs.concat(name)));
      }
    };
    roots.forEach((k) => walk(k, [], []));
    return { docs, bins, caseNode: caseRoot ? nodes.get(caseRoot) : null };
  }

  function treeInstance() {
    try {
      const $ = W.jQuery;
      const el = $ && $('#shareDocumentsTree');
      return el && el.length && el.data('dxTreeList') ? el.dxTreeList('instance') : null;
    } catch (e) { return null; }
  }

  function treeNodeData(key) {
    try {
      const tl = treeInstance();
      const node = tl && tl.getNodeByKey(key);
      return node && node.data ? node.data : null;
    } catch (e) { return null; }
  }

  /** Sygnatura / nazwa sprawy do nazw plików. */
  function caseName(caseNode) {
    let name = W.wizard && typeof W.wizard.caseSignature === 'string' ? W.wizard.caseSignature : null;
    if (!name && caseNode) name = caseNode.name;
    if (!name) {
      const m = document.title.match(/^Akta sprawy\s+(.+?)\s+-\s+Portal/);
      if (m) name = m[1];
    }
    if (!name) {
      try {
        const tl = treeInstance();
        const root = tl && tl.getRootNode && tl.getRootNode();
        const first = root && root.children && root.children[0];
        if (first && first.data && !['d', 'ba'].includes(kindOf(first.data.key))) name = first.data.name;
      } catch (e) { /* nic */ }
    }
    return safeName(name || `akta ${shareId() || ''}`.trim(), 80);
  }

  /** Ważność sesji z ciasteczka portalu (base64 daty ISO). */
  function sessionMsLeft() {
    const m = document.cookie.match(/(?:^|;\s*)APR-SessionExpirationTimeCookie=([^;]*)/);
    if (!m) return null;
    try {
      const t = new Date(atob(decodeURIComponent(m[1]))).getTime();
      return Number.isFinite(t) ? t - Date.now() : null;
    } catch (e) { return null; }
  }

  async function keepSessionAlive() {
    const left = sessionMsLeft();
    if (left != null && left > 5 * 60 * 1000) return;
    const url = routeUrl('refreshSession');
    if (!url) return;
    try { await request('GET', url, { json: true }); log('sesja przedłużona'); } catch (e) { /* nic */ }
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
  }

  function fmtBytes(n) {
    if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2).replace('.', ',')} GB`;
    if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1).replace('.', ',')} MB`;
    return `${Math.max(1, Math.round(n / 1024))} kB`;
  }

  /* -------------------- formaty i ustawienia -------------------- */

  const LOSSY_HINT = 'Skany z portalu to PNG z 16 kolorami – formaty stratne wychodzą z nich zwykle 1,5–3 razy ' +
    'WIĘKSZE od oryginału, a przy niskiej jakości tracą ostrość. Żeby zmniejszyć pliki, wybierz WebP albo JPEG XL bezstratny.';
  // Czasy zmierzone na stronie 1654×2324 (WebAssembly, jeden wątek).
  const EFFORT_HINT = {
    webp: 'Effort 6: ułamek sekundy na stronę; 9: zwykle 1–2% mniej, ale kilka–kilkanaście sekund. Najniższe dają pliki większe od PNG.',
    jxl: 'Effort 7: ok. 1,5 s na stronę; 9: o 10–30% mniej, ale 10–20 s na stronę. Najniższe dają pliki większe od PNG.',
    lossy: 'Effort: wyżej = zwykle mniejszy plik przy tej samej jakości, ale wolniej.',
    optimize: 'Effort to poziom kompresji Deflate (1–9): wyżej = mniejszy plik, ale wolniej.',
  };
  const PACK_HINT = 'Kompresja archiwum (i jej poziom) zmniejsza PDF-y i obrazy najwyżej o kilka procent.';

  /**
   * Formaty plików. codec: 'jpeg' (canvas przeglądarki) albo kodek z wątku kodeków ('webp', 'jxl');
   * effort – zakres i domyślna wartość suwaka „effort”.
   */
  const FORMATS = {
    pdf: { group: 'PDF', label: 'PDF z oryginalnymi PNG (bez strat)', short: 'PDF', pdf: true,
      hint: 'Strony z portalu trafiają do PDF-a bajt w bajt.' },
    'pdf-opt': { group: 'PDF', label: 'PDF zoptymalizowany (bez strat) – mniejszy', short: 'PDF', pdf: true, optimize: true,
      effort: { min: 1, max: 9, def: 9 },
      hint: 'Bez strat: dla każdej strony skrypt sprawdza, ile kolorów naprawdę zawiera, i zapisuje ją możliwie ' +
        'oszczędnie (paleta 1/2/4/8-bitowa albo RGB, filtry PNG, Deflate). Gdy to nie zmniejsza strony, zostawia ' +
        'oryginał. Strony JPEG i 16-bitowe (bez przezroczystości) zostają bez zmian. Otworzy go każdy czytnik PDF.' },
    'pdf-jpeg': { group: 'PDF', label: 'PDF ze stronami w JPEG (stratnie)', short: 'PDF', pdf: true, codec: 'jpeg', lossy: true },
    png: { group: 'Obrazy bez strat', label: 'PNG – oryginalne skany', short: 'PNG',
      hint: 'Bez strat: dokładnie te pliki, które wysyła portal.' },
    'webp-lossless': { group: 'Obrazy bez strat', label: 'WebP bezstratny – mniejsze pliki', short: 'WebP', codec: 'webp',
      lossless: true, ext: '.webp', effort: { min: 0, max: 9, def: 6 },
      hint: 'Bez strat; na prawdziwych aktach ok. 77% rozmiaru PNG (czyste skany nawet 22%). Otworzy go każda przeglądarka.' },
    'jxl-lossless': { group: 'Obrazy bez strat', label: 'JPEG XL bezstratny – najmniejsze pliki', short: 'JXL', codec: 'jxl',
      lossless: true, ext: '.jxl', effort: { min: 1, max: 9, def: 7 },
      hint: 'Bez strat; na prawdziwych aktach ok. 55% rozmiaru PNG. Otworzy go niewiele programów ' +
        '(np. Safari, GIMP, przeglądarki zdjęć na Linuksie; Chrome i Firefox – nie).' },
    webp: { group: 'Obrazy stratne', label: 'WebP stratny', short: 'WebP', codec: 'webp', lossy: true, ext: '.webp',
      effort: { min: 0, max: 6, def: 4 } },
    jxl: { group: 'Obrazy stratne', label: 'JPEG XL stratny', short: 'JXL', codec: 'jxl', lossy: true, ext: '.jxl',
      effort: { min: 1, max: 9, def: 7 } },
    jpeg: { group: 'Obrazy stratne', label: 'JPEG', short: 'JPEG', codec: 'jpeg', lossy: true, ext: '.jpg' },
  };
  const SETTINGS_KEY = 'akta-pobieranie-ustawienia';
  const DEFAULTS = { format: 'pdf', quality: 80, archive: 'zip' };
  const own = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);

  function loadSettings() {
    const fresh = () => ({ ...DEFAULTS, effort: {}, level: {} });
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      const ranges = (obj, table, field) => {
        const out = {};
        if (obj && typeof obj === 'object') {
          for (const k of Object.keys(obj)) {
            const r = own(table, k) && table[k][field];
            if (r && Number.isFinite(obj[k])) out[k] = clamp(obj[k], r.min, r.max);
          }
        }
        return out;
      };
      return {
        format: own(FORMATS, s.format) ? s.format : DEFAULTS.format,
        quality: Number.isFinite(s.quality) ? clamp(s.quality, 30, 100) : DEFAULTS.quality,
        archive: own(ARCHIVES, s.archive) ? s.archive : DEFAULTS.archive,
        effort: ranges(s.effort, FORMATS, 'effort'),
        level: ranges(s.level, ARCHIVES, 'levels'),
      };
    } catch (e) { return fresh(); }
  }

  function saveSettings(s) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* nic */ }
  }

  function effortOf(s, key) {
    const r = FORMATS[key].effort;
    return r ? (own(s.effort, key) ? s.effort[key] : r.def) : null;
  }

  function levelOf(s, key) {
    const r = ARCHIVES[key].levels;
    return r ? (own(s.level, key) ? s.level[key] : r.def) : null;
  }

  /** Format da się użyć: istnieje i nie potrzebuje kodeka albo menedżer skryptów udostępnił jego pliki. */
  const formatUsable = (key) => own(FORMATS, key) &&
    (!FORMATS[key].codec || FORMATS[key].codec === 'jpeg' || codecAvailable(FORMATS[key].codec));
  /** ZIP z kompresją i TAR.GZ działają też bez fflate (kompresja przeglądarki, bez wyboru poziomu). */
  const archiveUsable = (key) => own(ARCHIVES, key) &&
    (!ARCHIVES[key].needs || codecAvailable(ARCHIVES[key].needs) || key === 'zip-deflate' || key === 'tar.gz');

  /** Opis wyniku przy przyciskach, np. „→ plik PDF”, „→ TAR.XZ: folder na dokument, WebP na stronę”. */
  function describeOutput(s, whole) {
    const f = FORMATS[s.format], a = ARCHIVES[s.archive];
    if (!whole) return f.pdf ? '→ plik PDF' : `→ ${a.label.split(' – ')[0]} z plikami ${f.short}`;
    const name = a.label.split(' – ')[0];
    return f.pdf ? `→ ${name}: PDF na dokument i spis` : `→ ${name}: folder na dokument, ${f.short} na stronę, spis`;
  }

  /* -------------------- budowa dokumentu w wybranym formacie -------------------- */

  /**
   * Pobiera strony dokumentu i składa wynik w wybranym formacie. Kilka stron naraz (pobieranie
   * wg Pacera, potem konwersja), ale do wyniku trafiają w kolejności kart. Zwraca dopiero, gdy
   * żadna strona nie jest już w toku – także po błędzie albo przerwaniu.
   * Zwraca { pdf, pages, size, exclusions } albo { files: [{ name, bytes }], pages, size, exclusions }.
   */
  async function buildDocumentOutput(cards, meta, settings, signal, onPage) {
    const fmt = FORMATS[settings.format];
    const pages = cardPages(cards, meta.firstCard, meta.lastCard);
    if (!pages.length) throw new Error('Dokument nie ma stron do pobrania.');
    const pdf = fmt.pdf ? new PdfBuilder() : null;
    const maxNo = Math.max(0, ...pages.map((p) => Number((/\d+/.exec(p.label || '') || [0])[0])));
    const width = Math.max(3, String(maxNo).length, String(pages.length).length);
    // Nazwy plików stron, unikalne w folderze dokumentu: dwie karty o tym samym numerze się nie nadpiszą.
    const stems = [], seen = new Set();
    pages.forEach((pg, i) => {
      const base = pageFileName(pg.label, i, width, '');
      let stem = base;
      for (let k = 2; seen.has(stem.toLowerCase()); k++) stem = `${base} (${k})`;
      seen.add(stem.toLowerCase());
      stems.push(stem);
    });
    const files = [];
    const ready = new Array(pages.length);
    let next = 0, done = 0, cursor = 0, failure = null;
    const inner = new AbortController();
    const onOuter = () => inner.abort();
    signal.addEventListener('abort', onOuter, { once: true });
    if (signal.aborted) inner.abort();
    // Po błędzie innej strony albo „Przerwij” strona w toku nie dokłada się do wyniku ani postępu.
    const check = () => { if (inner.signal.aborted) throw failure || new Aborted(); };

    const processPage = async (i) => {
      const pg = pages[i];
      const res = await fetchBinary(pageUrl(pg.key), inner.signal);
      check();
      const kind = sniff(res.bytes);
      if (kind === 'unknown') throw new Error(`Portal nie zwrócił obrazu strony ${pg.label || i + 1}.`);
      let item;
      if (fmt.optimize) {
        // Bez strat: wariant zapisu dobierany dla każdej strony osobno (fflate z poziomem albo Deflate przeglądarki).
        const zlib = codecAvailable('fflate') ? (b, level) => compressor.zlib(b, level, inner.signal) : (b) => deflate(b);
        item = await optimizePdfImage(res.bytes,
          { zlib, level: effortOf(settings, settings.format), decodeRgba: decodeToRgba, rasterize });
      } else {
        let bytes = res.bytes, ext = EXT_OF[kind] || '.bin';
        if (fmt.codec === 'jpeg') {
          bytes = await convertImage(res.bytes, kind, 'image/jpeg', settings.quality);
          ext = '.jpg';
        } else if (fmt.codec) {
          bytes = await encodeWithCodec(fmt, settings.format, res.bytes, kind, settings, inner.signal);
          ext = fmt.ext;
        }
        item = pdf ? await toPdfImage(bytes, rasterize) : { name: stems[i] + ext, bytes };
      }
      check();
      ready[i] = item;
      while (next < pages.length && ready[next]) {
        if (pdf) pdf.addPage(ready[next], pages[next].label);
        else files.push(ready[next]); // CRC policzy ZipBuilder – TAR go nie potrzebuje
        ready[next] = null;
        next++;
      }
      done++;
      onPage && onPage(done, pages.length);
    };

    // Najwyżej CFG.pagesInFlight stron naraz od pobrania do zakodowania: koder w osobnym wątku bywa
    // dużo wolniejszy niż pobieranie, a każda zdekodowana strona to ok. 15 MB pamięci.
    const lane = async () => {
      while (!inner.signal.aborted && cursor < pages.length) {
        const i = cursor++;
        try {
          await processPage(i);
        } catch (e) {
          if (!failure) failure = e instanceof HtmlInsteadOfImage ? new Fatal(e.message) : e;
          inner.abort();
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(CFG.pagesInFlight, pages.length) }, lane));
    } finally {
      signal.removeEventListener('abort', onOuter);
    }
    if (failure) throw failure;
    if (inner.signal.aborted) throw new Aborted();
    const exclusions = [...new Set(pages.map((p) => p.card.exclusionInfo).filter(Boolean).map(stripHtml))];
    if (pdf) {
      const out = pdf.finish(meta);
      return { pdf: out, pages: out.pages, size: out.size, exclusions };
    }
    return { files, pages: files.length, size: files.reduce((a, f) => a + f.bytes.length, 0), exclusions };
  }

  /** Dokłada wynik dokumentu do archiwum; zwraca ścieżkę (plik PDF albo folder ze stronami). */
  async function addToArchive(archive, base, out, date, signal) {
    if (out.pdf) {
      await archive.add(`${base}.pdf`, new Blob(out.pdf.chunks, { type: 'application/pdf' }), out.pdf.size, out.pdf.crc,
        date, signal);
      return `${base}.pdf`;
    }
    for (const f of out.files) await archive.add(`${base}/${f.name}`, f.bytes, f.bytes.length, undefined, date, signal);
    return `${base}/`;
  }

  /**
   * Nowe archiwum wybranego rodzaju z wybranym poziomem kompresji. Bez plików kodeka (menedżer skryptów
   * bez @resource) ZIP z kompresją i TAR.GZ kompresuje przeglądarka – bez wyboru poziomu.
   */
  function createArchive(settings) {
    const a = ARCHIVES[settings.archive];
    const withCodec = !a.needs || codecAvailable(a.needs);
    return a.create({ level: levelOf(settings, settings.archive), compressor: withCodec ? compressor : null });
  }

  /* -------------------- interfejs -------------------- */

  const CSS = `
    :host { all: initial; }
    .pop { box-sizing: border-box; width: 340px; max-width: calc(100vw - 16px); padding: 10px 12px 12px;
      max-height: calc(100vh - 16px); overflow: auto;
      display: grid; gap: 6px; font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
      color: #17212b; background: #fff; border: 1px solid #9fb0c2; border-radius: 8px;
      box-shadow: 0 8px 28px rgba(0, 0, 0, .22); }
    .top { display: flex; align-items: center; gap: 8px; }
    .title { flex: 1; font-weight: 600; color: #123f73; }
    .x { font: inherit; font-size: 16px; line-height: 1; border: 0; background: none; color: #4a5866;
      padding: 4px 6px; border-radius: 4px; cursor: pointer; }
    .x:hover { background: #e8eef5; }
    button.main { font: inherit; text-align: left; padding: 7px 10px; border-radius: 6px; cursor: pointer;
      border: 1px solid #123f73; background: #123f73; color: #fff; }
    button.main:hover:not(:disabled) { background: #0b2c52; }
    button.secondary { font: inherit; padding: 6px 10px; border-radius: 6px; cursor: pointer;
      border: 1px solid #123f73; background: #fff; color: #123f73; }
    button.secondary:hover { background: #e8eef5; }
    button:focus-visible, select:focus-visible, input:focus-visible { outline: 3px solid #ffbf47; outline-offset: 1px; }
    button:disabled { opacity: .45; cursor: default; }
    .sub { font-size: 12px; color: #4a5866; margin: -3px 0 2px; }
    .sub span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .opts { display: grid; gap: 6px; border-top: 1px solid #dde4ec; padding-top: 8px; margin-top: 2px; }
    .opts label { display: grid; gap: 2px; font-size: 12px; color: #4a5866; }
    .opts small { font-size: 11px; }
    select { font: inherit; font-size: 13px; color: #17212b; background: #fff; padding: 4px 6px;
      border: 1px solid #9fb0c2; border-radius: 4px; }
    input[type=range] { width: 100%; margin: 0; accent-color: #123f73; }
    .hint { margin: 0; font-size: 12px; color: #4a5866; }
    .hint:empty { display: none; }
    progress { width: 100%; height: 10px; accent-color: #123f73; }
    .status { font-size: 13px; white-space: pre-wrap; word-break: break-word; max-height: 160px; overflow: auto; }
    .status:empty { display: none; }
    .status .warn { color: #7a3b00; font-weight: 600; }
    [hidden] { display: none !important; }
  `;

  const EDGE_CSS = `
    :host { all: initial; }
    :host([hidden]) { display: none !important; } /* „all: initial” wygrywa z [hidden] przeglądarki */
    button { position: fixed; right: 0; top: 40%; writing-mode: vertical-rl; transform: rotate(180deg);
      font: 600 12px/1 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #fff;
      background: #123f73; border: 0; border-radius: 0 6px 6px 0; padding: 10px 5px; cursor: pointer; opacity: .8; }
    button:hover, button:focus-visible { opacity: 1; }
    button:focus-visible { outline: 3px solid #ffbf47; }
  `;

  const TB_ID = 'akta-pobieranie-przycisk';
  const DV_ID = 'akta-pobieranie-dokument';
  const IDLE_TEXT = 'Pobierz akta';

  function createUi() {
    const settings = loadSettings();
    let anchor = null, side = 'below', controller = null, keepAlive = null, triggerText = IDLE_TEXT;
    let tbFailures = 0, populated = false;
    const startedAt = Date.now();

    /* dymek */
    const host = document.createElement('div');
    host.setAttribute('data-akta-pobieranie', '');
    host.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483000;display:none;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style>
      <div class="pop" role="dialog" aria-label="Pobieranie akt">
        <div class="top"><span class="title">Pobieranie akt</span>
          <button class="x" type="button" aria-label="Zamknij" title="Zamknij (Esc)">✕</button></div>
        <button class="b-doc main" type="button">Pobierz otwarty dokument</button>
        <div class="sub"><span class="cur"></span><span class="o-doc"></span></div>
        <button class="b-all main" type="button">Pobierz całe akta</button>
        <div class="sub"><span class="o-all"></span></div>
        <div class="opts">
          <label>Format plików <select class="f-format"></select></label>
          <label class="q-row"><span>Jakość: <b class="q-val"></b></span>
            <input class="f-quality" type="range" min="30" max="100" step="5"></label>
          <label class="e-row"><span>Effort: <b class="e-val"></b> <small>(więcej = mniejsze pliki, wolniej)</small></span>
            <input class="f-effort" type="range" step="1"></label>
          <label>Archiwum <select class="f-archive"></select></label>
          <label class="l-row"><span>Poziom kompresji archiwum: <b class="l-val"></b> <small>(więcej = wolniej)</small></span>
            <input class="f-level" type="range" step="1"></label>
          <p class="hint"></p>
        </div>
        <progress class="prog" max="1" value="0" hidden></progress>
        <div class="status" role="status" aria-live="polite"></div>
        <button class="b-stop secondary" type="button" hidden>Przerwij</button>
      </div>`;
    document.body.appendChild(host);
    const $ = (s) => root.querySelector(s);
    const pop = $('.pop'), bDoc = $('.b-doc'), bAll = $('.b-all'), bStop = $('.b-stop');
    const fFormat = $('.f-format'), fQuality = $('.f-quality'), fEffort = $('.f-effort');
    const fArchive = $('.f-archive'), fLevel = $('.f-level');
    const controls = [bDoc, bAll, fFormat, fQuality, fEffort, fArchive, fLevel];
    const prog = $('.prog'), status = $('.status');
    if (!routeUrl('loadTreeNodes')) { bAll.hidden = true; $('.o-all').hidden = true; }

    // Listy wypełniamy przy pierwszym otwarciu: dopiero wtedy pytamy menedżer skryptów o kodeki.
    const populate = () => {
      if (populated) return;
      populated = true;
      const groups = {};
      for (const [k, f] of Object.entries(FORMATS)) {
        if (!groups[f.group]) {
          groups[f.group] = document.createElement('optgroup');
          groups[f.group].label = f.group;
          fFormat.appendChild(groups[f.group]);
        }
        const o = new Option(formatUsable(k) ? f.label : `${f.label} – brak kodeka`, k);
        o.disabled = !formatUsable(k);
        groups[f.group].appendChild(o);
      }
      for (const [k, a] of Object.entries(ARCHIVES)) {
        const o = new Option(archiveUsable(k) ? a.label : `${a.label} – brak kodeka`, k);
        o.disabled = !archiveUsable(k);
        fArchive.add(o);
      }
    };

    const render = () => {
      populate();
      if (!formatUsable(settings.format)) settings.format = DEFAULTS.format;
      if (!archiveUsable(settings.archive)) settings.archive = DEFAULTS.archive;
      const f = FORMATS[settings.format], a = ARCHIVES[settings.archive];
      fFormat.value = settings.format;
      fArchive.value = settings.archive;
      fQuality.value = settings.quality;
      $('.q-val').textContent = settings.quality;
      $('.q-row').hidden = !f.lossy;
      const effort = f.optimize && !codecAvailable('fflate') ? null : effortOf(settings, settings.format);
      $('.e-row').hidden = effort == null;
      if (effort != null) {
        fEffort.min = f.effort.min; fEffort.max = f.effort.max; fEffort.value = effort;
        $('.e-val').textContent = effort;
      }
      const level = levelOf(settings, settings.archive);
      const levelWorks = level != null && codecAvailable(a.needs);
      $('.l-row').hidden = !levelWorks;
      if (levelWorks) {
        fLevel.min = a.levels.min; fLevel.max = a.levels.max; fLevel.value = level;
        $('.l-val').textContent = level;
      }
      const effortHint = EFFORT_HINT[f.optimize ? 'optimize' : f.lossy ? 'lossy' : f.codec];
      $('.hint').textContent = [f.hint || (f.lossy ? LOSSY_HINT : ''), effort != null ? effortHint : '',
        a.codec ? PACK_HINT : ''].filter(Boolean).join(' ');
      $('.o-doc').textContent = describeOutput(settings, false);
      $('.o-all').textContent = describeOutput(settings, true);
    };
    const changed = (apply) => () => { apply(); saveSettings(settings); render(); place(); };
    // Tylko znane wartości (np. pusta lista przed pierwszym otwarciem dymku nie może zepsuć ustawień).
    fFormat.addEventListener('change', changed(() => { if (formatUsable(fFormat.value)) settings.format = fFormat.value; }));
    fArchive.addEventListener('change', changed(() => { if (archiveUsable(fArchive.value)) settings.archive = fArchive.value; }));
    fQuality.addEventListener('input', changed(() => { settings.quality = Number(fQuality.value); }));
    fEffort.addEventListener('input', changed(() => { settings.effort[settings.format] = Number(fEffort.value); }));
    fLevel.addEventListener('input', changed(() => { settings.level[settings.archive] = Number(fLevel.value); }));

    const isOpen = () => host.style.display !== 'none';
    const place = () => {
      if (!isOpen()) return;
      // Portal przebudowuje pasek (refreshToolbar) – wtedy przycisk to nowy element o tym samym id.
      if (anchor && !anchor.isConnected && anchor.id) anchor = document.getElementById(anchor.id) || anchor;
      const vw = document.documentElement.clientWidth, vh = window.innerHeight;
      pop.style.maxHeight = ''; // naturalna wysokość (CSS ogranicza ją do wysokości okna)
      const w = pop.offsetWidth;
      let h = pop.offsetHeight;
      const a = anchor && anchor.isConnected ? anchor.getBoundingClientRect() : null;
      let x, y;
      if (!a) { x = vw - w - 16; y = vh - h - 16; }
      else if (side === 'left') { x = a.left - w - 8; y = a.top + a.height / 2 - h / 2; }
      else {
        // Pod przyciskiem albo nad nim – tam, gdzie więcej miejsca. Nigdy na przycisku:
        // gdy dymek się nie mieści, dostaje mniejszą wysokość i własne przewijanie.
        x = Math.min(a.left, vw - w - 8);
        const below = vh - a.bottom - 14, above = a.top - 14;
        if (h <= below || below >= above) { h = Math.min(h, Math.max(120, below)); y = a.bottom + 6; }
        else { h = Math.min(h, Math.max(120, above)); y = a.top - 6 - h; }
        pop.style.maxHeight = `${Math.floor(h)}px`;
      }
      host.style.left = `${Math.round(Math.max(8, Math.min(x, vw - w - 8)))}px`;
      host.style.top = `${Math.round(Math.max(8, Math.min(y, vh - h - 8)))}px`;
    };
    const setExpanded = (value) => {
      for (const el of [document.getElementById(TB_ID), edgeBtn]) if (el) el.setAttribute('aria-expanded', String(value));
    };
    const open = (el, where = 'below') => {
      if (el) { anchor = el; side = where; }
      const wasOpen = isOpen();
      if (!populated) render();
      host.style.display = 'block';
      setExpanded(true);
      place();
      if (!wasOpen) $('.x').focus({ preventScroll: true });
    };
    const close = () => { host.style.display = 'none'; setExpanded(false); };
    const toggle = (el, where) => (isOpen() && anchor === el ? close() : open(el, where));

    $('.x').addEventListener('click', () => { close(); anchor && anchor.focus && anchor.focus(); });
    document.addEventListener('pointerdown', (e) => {
      if (!isOpen()) return;
      const path = e.composedPath();
      if (path.includes(host) || (anchor && path.includes(anchor))) return;
      close();
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen()) { close(); anchor && anchor.focus && anchor.focus(); }
    }, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', () => requestAnimationFrame(place), { passive: true, capture: true });

    /* przyciski wbudowane w portal */
    const setTriggerText = (text) => {
      triggerText = text;
      try {
        const el = document.getElementById(TB_ID);
        const btn = el && W.DevExpress && W.DevExpress.ui.dxButton.getInstance(el);
        if (btn && btn.option('text') !== text) btn.option('text', text);
      } catch (e) { /* nic */ }
      edgeBtn.textContent = text === IDLE_TEXT ? '⬇ Pobierz akta' : `⬇ ${text}`;
    };

    /** Przycisk w pasku nad drzewem akt (dxToolbar portalu), zaraz po „Przejdź do wniosku”. */
    const ensureToolbarButton = () => {
      if (document.getElementById(TB_ID)) { tbFailures = 0; return true; }
      if (tbFailures >= 3) return false;
      try {
        const el = W.jQuery && W.jQuery('#toolbar');
        if (!el || !el.length || el.attr('hidden') != null || !el.is(':visible')) return false;
        const tb = W.DevExpress.ui.dxToolbar.getInstance(el[0]);
        if (!tb) return false;
        const items = (tb.option('items') || []).filter((it) => !(it && it.akta));
        items.splice(Math.min(1, items.length), 0, {
          akta: true, location: 'before', widget: 'dxButton',
          options: {
            type: 'default', stylingMode: 'outlined', icon: 'download', text: triggerText,
            hint: 'Pobierz otwarty dokument albo całe akta',
            elementAttr: { id: TB_ID, 'aria-haspopup': 'dialog', 'aria-expanded': String(isOpen()) },
            onClick: () => toggle(document.getElementById(TB_ID), 'below'),
          },
        });
        tb.option('items', items);
      } catch (e) { log('pasek narzędzi', e); }
      if (document.getElementById(TB_ID)) return true;
      tbFailures++;
      return false;
    };

    /** Ikona w pasku przeglądarki dokumentu, obok trybu pełnoekranowego: od razu pobiera otwarty dokument. */
    const ensureViewerButton = () => {
      if (document.getElementById(DV_ID)) return;
      const fs = document.querySelector('.btn-fullscreen-mode');
      if (!fs || !fs.parentNode || !W.jQuery || !W.jQuery.fn.dxButton) return;
      const el = document.createElement('div');
      el.id = DV_ID;
      fs.parentNode.insertBefore(el, fs);
      W.jQuery(el).dxButton({
        icon: 'download', stylingMode: 'text', hint: 'Pobierz ten dokument',
        elementAttr: { 'aria-label': 'Pobierz ten dokument' },
        onClick: () => { open(el, 'below'); downloadCurrent(ui); },
      });
    };

    /** Zapas: wąska zakładka przy prawej krawędzi, gdy portal nie pokazuje paska nad drzewem. */
    const edgeHost = document.createElement('div');
    edgeHost.setAttribute('data-akta-pobieranie-krawedz', '');
    edgeHost.hidden = true;
    const edgeRoot = edgeHost.attachShadow({ mode: 'open' });
    edgeRoot.innerHTML = `<style>${EDGE_CSS}</style><button type="button" aria-haspopup="dialog" aria-expanded="false"></button>`;
    const edgeBtn = edgeRoot.querySelector('button');
    // Kotwicą jest sam przycisk (position: fixed), nie jego host o zerowej wysokości na końcu <body>.
    edgeBtn.addEventListener('click', () => toggle(edgeBtn, 'left'));
    document.body.appendChild(edgeHost);

    const ui = {
      get busy() { return !!controller; },
      get settings() { return { ...settings, effort: { ...settings.effort }, level: { ...settings.level } }; },
      open,
      begin(text) {
        controller = new AbortController();
        controls.forEach((c) => { c.disabled = true; });
        bStop.hidden = false;
        prog.hidden = false;
        prog.removeAttribute('value');
        status.textContent = text || '';
        setTriggerText('Pobieranie…');
        keepAlive = setInterval(keepSessionAlive, 60 * 1000);
        place();
        return controller.signal;
      },
      end() {
        controller = null;
        clearInterval(keepAlive);
        codecs.release(); // pamięć WASM koderów nie maleje sama – zamykamy wątek do następnego pobierania
        controls.forEach((c) => { c.disabled = false; });
        bStop.hidden = true;
        prog.hidden = true;
        setTriggerText(IDLE_TEXT);
        place();
      },
      progress(value, max) {
        prog.max = Math.max(1, max);
        prog.value = value;
        setTriggerText(`Pobieranie ${Math.floor((100 * value) / Math.max(1, max))}%`);
      },
      say(text) { status.textContent = text; place(); },
      warn(text) {
        const p = document.createElement('div');
        p.className = 'warn';
        p.textContent = `⚠ ${text}`;
        status.appendChild(p);
        status.scrollTop = status.scrollHeight;
        // Ostrzeżenia i błędy muszą być widoczne, nawet gdy dymek zamknięto w trakcie pobierania.
        if (!isOpen()) open(); else place();
      },
      sayWithWarnings(text, warnings) {
        status.textContent = text;
        warnings.forEach((w) => ui.warn(w));
        place();
      },
    };

    bStop.addEventListener('click', () => controller && controller.abort());
    bDoc.addEventListener('click', () => downloadCurrent(ui));
    bAll.addEventListener('click', () => downloadAll(ui));
    W.addEventListener('beforeunload', (e) => {
      if (ui.busy) { e.preventDefault(); e.returnValue = ''; }
    });

    let lastDocKey;
    const tick = () => {
      const doc = W.documentViewer && W.documentViewer.currentDocument;
      const key = doc ? `${doc.key || doc.id}|${doc.version ? doc.version.id : ''}` : null;
      if (key !== lastDocKey) {
        lastDocKey = key;
        const cur = $('.cur');
        cur.textContent = doc ? `Otwarty: ${nodeLabel(Object.assign({ key: doc.key || `d:${doc.id}` }, doc))}`
          : 'Żaden dokument nie jest otwarty.';
        cur.title = cur.textContent;
      }
      const inToolbar = ensureToolbarButton();
      if (inToolbar) setTriggerText(triggerText); // przycisk odtworzony przez portal ma tekst z chwili wstawienia
      ensureViewerButton();
      edgeHost.hidden = inToolbar || Date.now() - startedAt < 3000;
    };
    setTriggerText(IDLE_TEXT);
    tick();
    setInterval(tick, 1000);
    return ui;
  }

  function describeError(e) {
    if (e instanceof Aborted) return 'Przerwano.';
    return e && e.message ? e.message : String(e);
  }

  async function downloadCurrent(ui) {
    if (ui.busy) return;
    const dv = W.documentViewer, doc = dv && dv.currentDocument;
    if (!doc || !(doc.id > 0)) {
      ui.say('Najpierw otwórz dokument (dwuklik w drzewie akt).');
      return;
    }
    const settings = ui.settings;
    const signal = ui.begin('Pobieranie listy kart…');
    try {
      await prepareCodecs(settings, !FORMATS[settings.format].pdf, signal);
      const info = Object.assign({ key: doc.key || `d:${doc.id}` }, treeNodeData(doc.key) || {}, doc);
      const cards = Array.isArray(doc.cards) && doc.cards.length ? doc.cards : await fetchCards(doc, signal);
      const range = cardRange(info);
      const sprawa = caseName(null);
      const stem = safeName(`${info.index != null && info.index !== '' ? `${info.index}. ` : ''}` +
        `${info.name || 'dokument'}${range ? ` (${range})` : ''}`, 140);
      const out = await buildDocumentOutput(cards,
        { title: nodeLabel(info), subject: sprawa, firstCard: info.firstCard, lastCard: info.lastCard }, settings, signal,
        (d, t) => { ui.progress(d, t); ui.say(`Strona ${d} z ${t}…`); });
      let file;
      if (out.pdf) {
        file = `${safeName(`${sprawa} – ${stem}`, 180)}.pdf`;
        saveBlob(new Blob(out.pdf.chunks, { type: 'application/pdf' }), file);
      } else {
        const archive = createArchive(settings);
        ui.say('Pakowanie…');
        await addToArchive(archive, stem, out, new Date(), signal);
        file = `${safeName(`${sprawa} – ${stem}`, 180)}${ARCHIVES[settings.archive].ext}`;
        const blob = await archive.finish(signal, (d, t) => ui.say(`Kompresja… ${Math.floor((100 * d) / t)}%`));
        if (signal.aborted) throw new Aborted(); // „Przerwij” w trakcie pakowania – bez zapisu
        saveBlob(blob, file);
      }
      ui.sayWithWarnings(`Gotowe: ${out.pages} str., ${fmtBytes(out.size)}.\nPlik: ${file}`,
        out.exclusions.map((x) => `Wyłączenia w dokumencie: ${x}`));
    } catch (e) {
      log(e);
      ui.say('');
      ui.warn(describeError(e));
    } finally {
      ui.end();
    }
  }

  async function downloadAll(ui) {
    if (ui.busy) return;
    const settings = ui.settings;
    const A = ARCHIVES[settings.archive];
    const signal = ui.begin('Wczytywanie spisu akt…');
    const startedAt = new Date();
    let archive = createArchive(settings), part = 1, top = 'akta';
    const savedParts = [];
    const rows = [['Lp.', 'Miejsce w aktach', 'Dokument', 'Karty', 'Stron', 'Plik', 'Uwagi']];
    const warnings = [];
    let pagesTotal = 0, okDocs = 0, bytesTotal = 0;

    /**
     * Zamyka bieżące archiwum ze spisem i je zapisuje. Gdy kompresja TAR.* się nie uda, zapisuje to samo
     * archiwum bez kompresji (.tar) – pobrane dokumenty nie przepadają.
     */
    const saveArchive = async (suffix) => {
      ui.say('Pakowanie…');
      if (!archive.closed) await archive.addBytes(`${top}/spis-dokumentow.csv`, utf8.encode(csv(rows)), startedAt, signal);
      let name = `${top}${suffix || ''}${A.ext}`, blob;
      try {
        blob = await archive.finish(signal, (d, t) => ui.say(`Kompresja archiwum… ${Math.floor((100 * d) / t)}%`));
      } catch (e) {
        const plain = !(e instanceof Aborted) && archive.plain ? archive.plain() : null;
        if (!plain) throw e;
        log('kompresja archiwum', e);
        name = `${top}${suffix || ''}.tar`;
        blob = plain;
        warnings.push(`Nie udało się skompresować archiwum (${describeError(e)}) – zapisano je bez kompresji: ${name}`);
      }
      if (signal.aborted) throw new Aborted();
      saveBlob(blob, name);
      savedParts.push(name);
    };

    try {
      await prepareCodecs(settings, true, signal);
      const tree = await loadTree(signal, (n) => ui.say(`Wczytywanie spisu akt… (${n} pozycji)`));
      const plan = planFromTree(tree);
      top = caseName(plan.caseNode);
      if (!plan.docs.length) throw new Error('Nie znaleziono żadnych dokumentów w drzewie akt.');
      log('plan', plan);

      let outageStreak = 0; // dokumenty z rzędu nieudane, bo portal nie odpowiadał
      for (let i = 0; i < plan.docs.length; i++) {
        const item = plan.docs[i], n = item.node;
        const where = item.crumbs.join(' › ');
        const base = [top, ...item.folder, item.stem].join('/');
        const failed = (e) => {
          log('błąd dokumentu', item.label, e);
          warnings.push(`${item.label}: ${describeError(e)}`);
          rows.push([i + 1, where, item.label, cardRange(n), '', '', `NIE POBRANO: ${describeError(e)}`]);
        };
        ui.progress(i, plan.docs.length);
        ui.say(`Dokument ${i + 1} z ${plan.docs.length}: ${item.label}`);
        let out = null, error = null;
        // Gdy portal chwilowo nie odpowiada (sieć, 503, 429), jedna ponowna próba po przerwie.
        for (let attempt = 1; attempt <= 2 && !out; attempt++) {
          try {
            if (attempt > 1) {
              ui.say(`Portal nie odpowiada – ponowna próba za ${Math.round(CFG.outagePauseMs / 1000)} s…\n${item.label}`);
              await sleep(CFG.outagePauseMs, signal);
            }
            const cards = await fetchCards({ id: idOf(n.key) }, signal);
            out = await buildDocumentOutput(cards,
              { title: item.label, subject: top, firstCard: n.firstCard, lastCard: n.lastCard }, settings, signal,
              (d, t) => ui.say(`Dokument ${i + 1} z ${plan.docs.length}: ${item.label}\nStrona ${d} z ${t}`));
          } catch (e) {
            if (e instanceof Fatal || e instanceof Aborted) throw e;
            error = e;
            if (!(e instanceof Transient)) break;
          }
        }
        if (!out) {
          failed(error);
          if (error instanceof Transient && ++outageStreak >= CFG.outageStreak) {
            throw new Fatal(`Portal nie odpowiada (${outageStreak} dokumenty z rzędu) – pobieranie przerwane. ` +
              'Spróbuj ponownie później.');
          }
          continue;
        }
        outageStreak = 0;
        // Nowa część archiwum (rozmiar albo limit plików ZIP). Błąd zapisu dotyczy całego pobierania,
        // nie tego dokumentu – dlatego poza obsługą błędów pojedynczego dokumentu.
        const entries = (out.files ? out.files.length : 1) + 1; // + spis
        if (archive.count && (archive.size + out.size > CFG.partBytes ||
            (archive.maxEntries && archive.count + entries > archive.maxEntries))) {
          await saveArchive(` (część ${part})`);
          archive = createArchive(settings);
          part++;
        }
        let path;
        try {
          path = await addToArchive(archive, base, out, startedAt, signal);
        } catch (e) {
          if (e instanceof Fatal || e instanceof Aborted) throw e;
          failed(e);
          continue;
        }
        pagesTotal += out.pages; bytesTotal += out.size; okDocs++;
        rows.push([i + 1, where, item.label, cardRange(n), out.pages, path.slice(top.length + 1),
          out.exclusions.length ? `Wyłączenia: ${out.exclusions.join(' | ')}` : '']);
      }

      for (const b of plan.bins) {
        rows.push(['', b.crumbs.join(' › '), b.label, cardRange(b.node), '', '',
          'Nośnik (np. płyta) – portal udostępnia go tylko w czytelni prokuratury.']);
      }

      ui.progress(plan.docs.length, plan.docs.length);
      await saveArchive(part > 1 ? ` (część ${part})` : '');
      const lines = [`Gotowe: ${okDocs} z ${plan.docs.length} dok., ${pagesTotal} str., ${fmtBytes(bytesTotal)}.`];
      lines.push(savedParts.length > 1 ? `Pliki: ${savedParts.join(', ')}` : `Plik: ${savedParts[0]}`);
      if (savedParts.length > 1) {
        lines.push('Jeśli przeglądarka zapytała o zgodę na pobieranie wielu plików, zezwól – inaczej zapisze tylko pierwszą część.');
      }
      if (plan.bins.length) lines.push(`Nośniki (tylko w czytelni): ${plan.bins.length} – wpisane do spisu.`);
      ui.sayWithWarnings(lines.join('\n'), warnings);
    } catch (e) {
      log(e);
      if (e instanceof Fatal && archive.count && !signal.aborted) {
        rows.push(['', '', '', '', '', '', `PRZERWANO: ${describeError(e)}`]);
        try {
          await saveArchive(' – NIEKOMPLETNE');
        } catch (err) {
          log(err);
          warnings.push(`Nie udało się zapisać pobranych dokumentów: ${describeError(err)}`);
        }
      }
      ui.sayWithWarnings(savedParts.length ? `Pobieranie przerwane. Zapisane pliki: ${savedParts.join(', ')}.`
        : 'Pobieranie przerwane – nic nie zapisano.', [describeError(e), ...warnings]);
    } finally {
      ui.end();
    }
  }

  /* -------------------- start -------------------- */

  let tries = 0;
  const waitTimer = setInterval(() => {
    tries++;
    if (routeUrl('getPage') && routeUrl('getDocumentCards') && W.documentViewer && document.body) {
      clearInterval(waitTimer);
      createUi();
      log('gotowe – przyciski pobierania dodane');
    } else if (tries > 240) {
      clearInterval(waitTimer);
      // Skrypt działa na całym portalu; ślad w konsoli tylko tam, gdzie jest aplikacja akt, a czegoś brak.
      if (W.routing) log('brak przeglądarki akt na tej stronie (getPage, getDocumentCards, documentViewer) – bez przycisków');
    }
  }, 500);
})();
