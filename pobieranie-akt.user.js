// ==UserScript==
// @name         Portal Przeglądania Akt – pobieranie dokumentów (nieoficjalny)
// @namespace    https://github.com/Czekoloczek/prokuratura-akta
// @version      1.1.0
// @description  Nieoficjalny dodatek do Portalu Przeglądania Akt prokuratury: pobiera otwarty dokument albo całe akta – jako PDF lub obrazy (PNG, JPEG, WebP), w archiwum ZIP, TAR albo TAR.GZ, ze spisem dokumentów.
// @author       Czekoloczek
// @license      GPL-3.0-or-later
// @homepageURL  https://github.com/Czekoloczek/prokuratura-akta
// @supportURL   https://github.com/Czekoloczek/prokuratura-akta/issues
// @match        https://przegladanieakt.prokuratura.gov.pl/*
// @grant        none
// @inject-into  page
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
    const r = { idat: [], plte: null, trns: false, dpi: null };
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
      else if (type === 'tRNS') r.trns = true;
      else if (type === 'pHYs' && len >= 9 && b[d + 8] === 1) r.dpi = [dv.getUint32(d) * 0.0254, dv.getUint32(d + 4) * 0.0254];
      else if (type === 'IDAT') r.idat.push(b.subarray(d, d + len));
      else if (type === 'IEND') break;
      p = d + len + 4;
    }
    return r;
  }

  /** PNG bez przezroczystości i przeplotu → obraz PDF (FlateDecode + predyktor PNG). */
  function pngToPdfImage(p) {
    if (!p || !p.width || !p.height || p.interlace !== 0 || p.trns || !p.idat.length) return null;
    let colors, cs;
    if (p.colorType === 0 && [1, 2, 4, 8].includes(p.bitDepth)) { colors = 1; cs = '/DeviceGray'; }
    else if (p.colorType === 2 && p.bitDepth === 8) { colors = 3; cs = '/DeviceRGB'; }
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

  /**
   * Rozmiar strony PDF w punktach: z DPI obrazu, a gdy go brak lub wychodzi format
   * spoza A7–A3 – dopasowanie do A4. (Portal zapisuje w PNG domyślne 96 DPI z .NET,
   * choć skany mają 200 DPI – wtedy strona wyszłaby 17×24 cale.)
   */
  function pageSize(img) {
    const { width: w, height: h, dpi } = img;
    if (dpi && dpi[0] >= 50 && dpi[1] >= 50 && dpi[0] <= 2400 && dpi[1] <= 2400) {
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
        ` /CreationDate ${pdfText(pdfDate())} >>\nendobj\n`);
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

  /** Kompresja „deflate-raw” (dla ZIP-a); null, gdy środowisko jej nie obsługuje. */
  async function deflateRaw(data) {
    let cs;
    try { cs = new CompressionStream('deflate-raw'); } catch (e) { return null; }
    const blob = data instanceof Blob ? data : new Blob([data]);
    return new Response(blob.stream().pipeThrough(cs)).blob();
  }

  async function gzipBlob(blob) {
    return new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob();
  }

  const byteSize = (x) => (x instanceof Blob ? x.size : x.length);

  /** ZIP z nazwami w UTF-8; z kompresją Deflate albo bez (PDF-y i PNG i tak są już skompresowane). */
  class ZipBuilder {
    constructor({ deflate = false } = {}) {
      this.deflate = deflate; this.parts = []; this.central = []; this.size = 0; this.count = 0;
    }

    /** data: Blob | Uint8Array; size i crc dotyczą danych przed kompresją. */
    async add(name, data, size, crc, date = new Date()) {
      let payload = data, stored = size, method = 0;
      if (this.deflate && size > 0) {
        const packed = await deflateRaw(data);
        if (packed && packed.size < size) { payload = packed; stored = packed.size; method = 8; }
      }
      const nameBytes = utf8.encode(name);
      const [time, day] = dosDateTime(date);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
      h.setUint16(8, method, true); h.setUint16(10, time, true); h.setUint16(12, day, true);
      h.setUint32(14, crc, true); h.setUint32(18, stored, true); h.setUint32(22, size, true);
      h.setUint16(26, nameBytes.length, true); h.setUint16(28, 0, true);
      this.parts.push(new Uint8Array(h.buffer), nameBytes, payload);
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

    addBytes(name, bytes, date) { return this.add(name, bytes, bytes.length, crc32(bytes), date); }

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

  /** TAR (ustar); długie albo nie-ASCII nazwy przez nagłówek PAX. Z gzip = TAR.GZ. */
  class TarBuilder {
    constructor({ gzip = false } = {}) { this.gzip = gzip; this.parts = []; this.size = 0; this.count = 0; }

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
      this.push(data);
      this.padTo512(size);
      this.count++;
    }

    addBytes(name, bytes, date) { return this.add(name, bytes, bytes.length, 0, date); }

    async finish() {
      this.push(new Uint8Array(1024));
      const tar = new Blob(this.parts, { type: 'application/x-tar' });
      return this.gzip ? new Blob([await gzipBlob(tar)], { type: 'application/gzip' }) : tar;
    }
  }

  /** Formaty archiwum do wyboru w ustawieniach. */
  const ARCHIVES = {
    zip: { label: 'ZIP', ext: '.zip', create: () => new ZipBuilder() },
    'zip-deflate': { label: 'ZIP z kompresją', ext: '.zip', packs: true, create: () => new ZipBuilder({ deflate: true }) },
    tar: { label: 'TAR', ext: '.tar', create: () => new TarBuilder() },
    'tar.gz': { label: 'TAR.GZ', ext: '.tar.gz', packs: true, create: () => new TarBuilder({ gzip: true }) },
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

  const core = {
    crc32, sniff, parseJpeg, parsePng, pngToPdfImage, toPdfImage, pageSize, pdfText, PdfBuilder,
    ZipBuilder, TarBuilder, ARCHIVES, paxRecord, pageFileName, safeName, padIndex, cardRange, stripHtml, csv,
    cardPages, deflate,
  };

  // W Node (testy) eksportujemy rdzeń i kończymy.
  if (typeof window === 'undefined') {
    if (typeof module === 'object' && module.exports) module.exports = core;
    return;
  }

  /* =====================================================================
   *  CZĘŚĆ PRZEGLĄDARKOWA
   * ===================================================================== */

  const W = window;
  if (W.__aktaPobieranie) return;
  W.__aktaPobieranie = true;

  const CFG = {
    concurrency: 2,                     // ile stron pobierać naraz
    gapMs: 150,                         // minimalny odstęp między żądaniami
    retries: 3,                         // próby przy błędach przejściowych
    zipPartBytes: 1536 * 1024 * 1024,   // ZIP dzielony na części po ok. 1,5 GB
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

  /** Ogranicza liczbę równoczesnych żądań i ich tempo. */
  class Pacer {
    constructor(concurrency, gapMs) {
      this.concurrency = concurrency; this.gapMs = gapMs;
      this.active = 0; this.queue = []; this.last = 0; this.timer = null;
    }
    run(fn) {
      return new Promise((resolve, reject) => { this.queue.push({ fn, resolve, reject }); this.pump(); });
    }
    pump() {
      while (this.active < this.concurrency && this.queue.length && !this.timer) {
        const wait = this.last + this.gapMs - Date.now();
        if (wait > 0) {
          this.timer = setTimeout(() => { this.timer = null; this.pump(); }, wait);
          return;
        }
        const { fn, resolve, reject } = this.queue.shift();
        this.active++; this.last = Date.now();
        Promise.resolve().then(fn).then(resolve, reject).finally(() => { this.active--; this.pump(); });
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
      const res = await pacer.run(() => request(method, url, { body, json: true, signal }));
      checkStatus(res);
      if (/json/i.test(res.type)) return JSON.parse(new TextDecoder().decode(res.bytes));
      if (sniff(res.bytes) === 'html') throw problemFromHtml(res);
      throw new Error('Nieoczekiwana odpowiedź serwera.');
    }, signal);
  }

  function fetchBinary(url, signal) {
    return withRetry(async () => {
      const res = await pacer.run(() => request('GET', url, { signal }));
      checkStatus(res);
      if (sniff(res.bytes) === 'html' && /html/i.test(res.type)) throw problemFromHtml(res);
      return res;
    }, signal);
  }

  /** Obraz (dowolny format obsługiwany przez przeglądarkę) → canvas na białym tle. */
  async function drawToCanvas(bytes, kind) {
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

  /** Obraz nietypowego formatu → surowe piksele → Flate (do PDF-a, bez strat). */
  async function rasterize(bytes, kind) {
    const canvas = await drawToCanvas(bytes, kind);
    const w = canvas.width, h = canvas.height;
    const px = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    canvas.width = canvas.height = 0;
    let gray = true;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] !== px[i + 1] || px[i] !== px[i + 2]) { gray = false; break; }
    }
    const raw = new Uint8Array(w * h * (gray ? 1 : 3));
    for (let i = 0, j = 0; i < px.length; i += 4) {
      raw[j++] = px[i];
      if (!gray) { raw[j++] = px[i + 1]; raw[j++] = px[i + 2]; }
    }
    return {
      width: w, height: h, bpc: 8, colorSpace: gray ? '/DeviceGray' : '/DeviceRGB',
      filter: 'FlateDecode', data: [await deflate(raw)], dpi: null,
    };
  }

  let canvasOk = null;

  /**
   * Czy odczyt pikseli z canvas jest wierny. Firefox z ochroną przed fingerprintingiem
   * (np. privacy.resistFingerprinting) blokuje go albo dodaje szum – konwersja dałaby wtedy
   * puste lub zaszumione strony.
   */
  function canvasReadbackOk() {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 8;
      const ctx = c.getContext('2d');
      ctx.fillStyle = 'rgb(200, 30, 60)';
      ctx.fillRect(0, 0, 8, 8);
      const d = ctx.getImageData(0, 0, 8, 8).data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] !== 200 || d[i + 1] !== 30 || d[i + 2] !== 60 || d[i + 3] !== 255) return false;
      }
      return true;
    } catch (e) { return false; }
  }

  /** Konwersja strony do JPEG/WebP przez canvas przeglądarki. quality: 30–100. */
  async function convertImage(bytes, kind, mime, quality) {
    if (canvasOk === null) canvasOk = canvasReadbackOk();
    if (!canvasOk) {
      throw new Fatal('Przeglądarka blokuje albo zaszumia odczyt obrazów z canvas (ochrona przed śledzeniem), ' +
        'więc konwersja zepsułaby strony. Wybierz format „oryginalne skany” (PDF albo PNG).');
    }
    const canvas = await drawToCanvas(bytes, kind);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, quality / 100));
    canvas.width = canvas.height = 0;
    if (!blob || blob.type !== mime) {
      throw new Fatal(`Ta przeglądarka nie potrafi zapisywać obrazów ${mime.replace('image/', '').toUpperCase()}.`);
    }
    return new Uint8Array(await blob.arrayBuffer());
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

  const FORMATS = {
    pdf: { label: 'PDF – oryginalne skany (zalecane)', short: 'PDF', pdf: true,
      hint: 'Bez strat i zwykle najmniejszy: strony z portalu trafiają do PDF-a bajt w bajt.' },
    png: { label: 'PNG – oryginalne skany, plik na stronę', short: 'PNG',
      hint: 'Bez strat: dokładnie te pliki, które wysyła portal.' },
    'pdf-jpeg': { label: 'PDF ze stronami w JPEG (stratnie)', short: 'PDF', pdf: true, mime: 'image/jpeg' },
    jpeg: { label: 'JPEG – plik na stronę (stratnie)', short: 'JPEG', mime: 'image/jpeg', ext: '.jpg' },
    webp: { label: 'WebP – plik na stronę (stratnie)', short: 'WebP', mime: 'image/webp', ext: '.webp' },
  };
  const LOSSY_HINT = 'Skany z portalu to PNG z 16 kolorami – JPEG i WebP wychodzą z nich 2–3 razy większe ' +
    '(np. WebP 80 ok. 2×, JPEG 80 ok. 3×), a przy niskiej jakości tracą ostrość. Wybierz je tylko, gdy program nie czyta PNG.';
  const PACK_HINT = 'PDF-y i obrazy są już skompresowane, więc kompresja archiwum zmniejszy je najwyżej o kilka procent.';
  const SETTINGS_KEY = 'akta-pobieranie-ustawienia';
  const DEFAULTS = { format: 'pdf', quality: 80, archive: 'zip' };

  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      return {
        format: FORMATS[s.format] ? s.format : DEFAULTS.format,
        quality: Number.isFinite(s.quality) ? Math.min(100, Math.max(30, s.quality)) : DEFAULTS.quality,
        archive: ARCHIVES[s.archive] ? s.archive : DEFAULTS.archive,
      };
    } catch (e) { return { ...DEFAULTS }; }
  }

  function saveSettings(s) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* nic */ }
  }

  /** Opis wyniku przy przyciskach, np. „→ plik PDF”, „→ TAR.GZ: folder na dokument, PNG na stronę”. */
  function describeOutput(s, whole) {
    const f = FORMATS[s.format], a = ARCHIVES[s.archive];
    if (!whole) return f.pdf ? '→ plik PDF' : `→ ${a.label} z plikami ${f.short}`;
    return f.pdf ? `→ ${a.label}: PDF na dokument i spis` : `→ ${a.label}: folder na dokument, ${f.short} na stronę, spis`;
  }

  /* -------------------- budowa dokumentu w wybranym formacie -------------------- */

  /**
   * Pobiera strony dokumentu i składa wynik w wybranym formacie. Strony idą równolegle
   * (wg Pacera), ale do wyniku trafiają w kolejności kart.
   * Zwraca { pdf, pages, size, exclusions } albo { files: [{ name, bytes, crc }], pages, size, exclusions }.
   */
  async function buildDocumentOutput(cards, meta, settings, signal, onPage) {
    const fmt = FORMATS[settings.format];
    const pages = cardPages(cards, meta.firstCard, meta.lastCard);
    if (!pages.length) throw new Error('Dokument nie ma stron do pobrania.');
    const pdf = fmt.pdf ? new PdfBuilder() : null;
    const maxNo = Math.max(0, ...pages.map((p) => Number((/\d+/.exec(p.label || '') || [0])[0])));
    const width = Math.max(3, String(maxNo).length, String(pages.length).length);
    const files = [];
    const ready = new Array(pages.length);
    let next = 0, done = 0;
    const inner = new AbortController();
    const onOuter = () => inner.abort();
    signal.addEventListener('abort', onOuter, { once: true });
    try {
      await Promise.all(pages.map((pg, i) => (async () => {
        const res = await fetchBinary(pageUrl(pg.key), inner.signal);
        const kind = sniff(res.bytes);
        if (kind === 'html') throw new HtmlInsteadOfImage('Serwer zwrócił stronę HTML zamiast obrazu.');
        let bytes = res.bytes, ext = EXT_OF[kind] || '.bin';
        if (fmt.mime) {
          bytes = await convertImage(res.bytes, kind, fmt.mime, settings.quality);
          ext = fmt.ext || '.jpg';
        }
        ready[i] = pdf ? await toPdfImage(bytes, rasterize) : { name: pageFileName(pg.label, i, width, ext), bytes };
        while (next < pages.length && ready[next]) {
          if (pdf) pdf.addPage(ready[next], pages[next].label);
          else files.push(Object.assign(ready[next], { crc: crc32(ready[next].bytes) }));
          ready[next] = null;
          next++;
        }
        done++;
        onPage && onPage(done, pages.length);
      })().catch((e) => {
        inner.abort();
        throw e instanceof HtmlInsteadOfImage ? new Fatal(e.message) : e;
      })));
    } finally {
      signal.removeEventListener('abort', onOuter);
    }
    const exclusions = [...new Set(pages.map((p) => p.card.exclusionInfo).filter(Boolean).map(stripHtml))];
    if (pdf) {
      const out = pdf.finish(meta);
      return { pdf: out, pages: out.pages, size: out.size, exclusions };
    }
    return { files, pages: files.length, size: files.reduce((a, f) => a + f.bytes.length, 0), exclusions };
  }

  /** Dokłada wynik dokumentu do archiwum; zwraca ścieżkę (plik PDF albo folder ze stronami). */
  async function addToArchive(archive, base, out, date) {
    if (out.pdf) {
      await archive.add(`${base}.pdf`, new Blob(out.pdf.chunks, { type: 'application/pdf' }), out.pdf.size, out.pdf.crc, date);
      return `${base}.pdf`;
    }
    for (const f of out.files) await archive.add(`${base}/${f.name}`, f.bytes, f.bytes.length, f.crc, date);
    return `${base}/`;
  }

  /* -------------------- interfejs -------------------- */

  const CSS = `
    :host { all: initial; }
    .pop { box-sizing: border-box; width: 340px; max-width: calc(100vw - 16px); padding: 10px 12px 12px;
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
    let settings = loadSettings();
    let anchor = null, side = 'below', controller = null, keepAlive = null, triggerText = IDLE_TEXT;
    let tbFailures = 0;
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
          <label>Archiwum <select class="f-archive"></select></label>
          <p class="hint"></p>
        </div>
        <progress class="prog" max="1" value="0" hidden></progress>
        <div class="status" role="status" aria-live="polite"></div>
        <button class="b-stop secondary" type="button" hidden>Przerwij</button>
      </div>`;
    document.body.appendChild(host);
    const $ = (s) => root.querySelector(s);
    const pop = $('.pop'), bDoc = $('.b-doc'), bAll = $('.b-all'), bStop = $('.b-stop');
    const fFormat = $('.f-format'), fQuality = $('.f-quality'), fArchive = $('.f-archive');
    const prog = $('.prog'), status = $('.status');
    for (const [k, f] of Object.entries(FORMATS)) fFormat.add(new Option(f.label, k));
    for (const [k, a] of Object.entries(ARCHIVES)) fArchive.add(new Option(a.label, k));
    if (!routeUrl('loadTreeNodes')) { bAll.hidden = true; $('.o-all').hidden = true; }

    const render = () => {
      const f = FORMATS[settings.format];
      fFormat.value = settings.format;
      fArchive.value = settings.archive;
      fQuality.value = settings.quality;
      $('.q-val').textContent = settings.quality;
      $('.q-row').hidden = !f.mime;
      $('.hint').textContent = [f.mime ? LOSSY_HINT : f.hint, ARCHIVES[settings.archive].packs ? PACK_HINT : '']
        .filter(Boolean).join(' ');
      $('.o-doc').textContent = describeOutput(settings, false);
      $('.o-all').textContent = describeOutput(settings, true);
    };
    const update = () => {
      settings = { format: fFormat.value, quality: Number(fQuality.value), archive: fArchive.value };
      saveSettings(settings);
      render();
    };
    fFormat.addEventListener('change', update);
    fArchive.addEventListener('change', update);
    fQuality.addEventListener('input', update);
    render();

    const isOpen = () => host.style.display !== 'none';
    const place = () => {
      if (!isOpen()) return;
      const vw = document.documentElement.clientWidth, vh = window.innerHeight;
      const w = pop.offsetWidth, h = pop.offsetHeight;
      const a = anchor && anchor.isConnected ? anchor.getBoundingClientRect() : null;
      let x, y;
      if (!a) { x = vw - w - 16; y = vh - h - 16; }
      else if (side === 'left') { x = a.left - w - 8; y = a.top + a.height / 2 - h / 2; }
      else {
        x = Math.min(a.left, vw - w - 8);
        y = a.bottom + 6;
        if (y + h > vh - 8 && a.top - 6 - h >= 8) y = a.top - 6 - h;
      }
      host.style.left = `${Math.round(Math.max(8, Math.min(x, vw - w - 8)))}px`;
      host.style.top = `${Math.round(Math.max(8, Math.min(y, vh - h - 8)))}px`;
    };
    const open = (el, where = 'below') => {
      if (el) { anchor = el; side = where; }
      host.style.display = 'block';
      place();
    };
    const close = () => { host.style.display = 'none'; };
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
            elementAttr: { id: TB_ID, 'aria-haspopup': 'dialog' },
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
    edgeRoot.innerHTML = `<style>${EDGE_CSS}</style><button type="button" aria-haspopup="dialog"></button>`;
    const edgeBtn = edgeRoot.querySelector('button');
    edgeBtn.addEventListener('click', () => toggle(edgeHost, 'left'));
    document.body.appendChild(edgeHost);

    const ui = {
      get busy() { return !!controller; },
      get settings() { return { ...settings }; },
      open,
      begin(text) {
        controller = new AbortController();
        bDoc.disabled = bAll.disabled = fFormat.disabled = fQuality.disabled = fArchive.disabled = true;
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
        bDoc.disabled = bAll.disabled = fFormat.disabled = fQuality.disabled = fArchive.disabled = false;
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
        place();
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
        const a = ARCHIVES[settings.archive], archive = a.create();
        ui.say('Pakowanie…');
        await addToArchive(archive, stem, out, new Date());
        file = `${safeName(`${sprawa} – ${stem}`, 180)}${a.ext}`;
        saveBlob(await archive.finish(), file);
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
    let archive = A.create(), part = 1, top = 'akta';
    const savedParts = [];
    const rows = [['Lp.', 'Miejsce w aktach', 'Dokument', 'Karty', 'Stron', 'Plik', 'Uwagi']];
    const warnings = [];
    let pagesTotal = 0, okDocs = 0, bytesTotal = 0;

    const saveArchive = async (suffix) => {
      ui.say('Pakowanie…');
      await archive.addBytes(`${top}/spis-dokumentow.csv`, utf8.encode(csv(rows)), startedAt);
      const name = `${top}${suffix || ''}${A.ext}`;
      saveBlob(await archive.finish(), name);
      savedParts.push(name);
    };

    try {
      const tree = await loadTree(signal, (n) => ui.say(`Wczytywanie spisu akt… (${n} pozycji)`));
      const plan = planFromTree(tree);
      top = caseName(plan.caseNode);
      if (!plan.docs.length) throw new Error('Nie znaleziono żadnych dokumentów w drzewie akt.');
      log('plan', plan);

      for (let i = 0; i < plan.docs.length; i++) {
        const item = plan.docs[i], n = item.node;
        const where = item.crumbs.join(' › ');
        const base = [top, ...item.folder, item.stem].join('/');
        ui.progress(i, plan.docs.length);
        ui.say(`Dokument ${i + 1} z ${plan.docs.length}: ${item.label}`);
        try {
          const cards = await fetchCards({ id: idOf(n.key) }, signal);
          const out = await buildDocumentOutput(cards,
            { title: item.label, subject: top, firstCard: n.firstCard, lastCard: n.lastCard }, settings, signal,
            (d, t) => ui.say(`Dokument ${i + 1} z ${plan.docs.length}: ${item.label}\nStrona ${d} z ${t}`));
          if (archive.count && archive.size + out.size > CFG.zipPartBytes) {
            await saveArchive(` (część ${part})`);
            archive = A.create();
            part++;
          }
          const path = await addToArchive(archive, base, out, startedAt);
          pagesTotal += out.pages; bytesTotal += out.size; okDocs++;
          rows.push([i + 1, where, item.label, cardRange(n), out.pages, path.slice(top.length + 1),
            out.exclusions.length ? `Wyłączenia: ${out.exclusions.join(' | ')}` : '']);
        } catch (e) {
          if (e instanceof Fatal || e instanceof Aborted) throw e;
          log('błąd dokumentu', item.label, e);
          warnings.push(`${item.label}: ${describeError(e)}`);
          rows.push([i + 1, where, item.label, cardRange(n), '', '', `NIE POBRANO: ${describeError(e)}`]);
        }
      }

      for (const b of plan.bins) {
        rows.push(['', b.crumbs.join(' › '), b.label, cardRange(b.node), '', '',
          'Nośnik (np. płyta) – portal udostępnia go tylko w czytelni prokuratury.']);
      }

      ui.progress(plan.docs.length, plan.docs.length);
      await saveArchive(part > 1 ? ` (część ${part})` : '');
      const lines = [`Gotowe: ${okDocs} z ${plan.docs.length} dok., ${pagesTotal} str., ${fmtBytes(bytesTotal)}.`];
      lines.push(savedParts.length > 1 ? `Pliki: ${savedParts.join(', ')}` : `Plik: ${savedParts[0]}`);
      if (plan.bins.length) lines.push(`Nośniki (tylko w czytelni): ${plan.bins.length} – wpisane do spisu.`);
      ui.sayWithWarnings(lines.join('\n'), warnings);
    } catch (e) {
      log(e);
      if (e instanceof Fatal && archive.count) {
        rows.push(['', '', '', '', '', '', `PRZERWANO: ${describeError(e)}`]);
        try { await saveArchive(' – NIEKOMPLETNE'); } catch (err) { log(err); }
        ui.sayWithWarnings(`Pobieranie przerwane. Zapisano to, co już było: ${savedParts.join(', ')}.`,
          [describeError(e), ...warnings]);
      } else {
        ui.say(savedParts.length ? `Zapisane wcześniej części: ${savedParts.join(', ')}.` : '');
        ui.warn(describeError(e));
      }
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
    }
  }, 500);
})();
