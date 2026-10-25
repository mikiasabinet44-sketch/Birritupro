// Self-contained QR Code encoder (ISO/IEC 18004): byte mode, error-correction level M,
// versions 1-10 (up to 213 bytes). No dependencies, so e-invoice QR codes render offline.
// Usage: qrSvg("text", 3) -> "<svg ...>"; throws if the text is too long for version 10.
(function (root) {
  // [dataCodewords, ecCodewordsPerBlock, [[blockCount, dataPerBlock], ...]] for level M
  const VERS = [null,
    [16, 10, [[1, 16]]], [28, 16, [[1, 28]]], [44, 26, [[1, 44]]], [64, 18, [[2, 32]]], [86, 24, [[2, 43]]],
    [108, 16, [[4, 27]]], [124, 18, [[4, 31]]], [154, 22, [[2, 38], [2, 39]]], [182, 22, [[3, 36], [2, 37]]], [216, 26, [[4, 43], [1, 44]]],
  ];
  const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

  // GF(256) tables, primitive polynomial 0x11D
  const EXP = new Array(512), LOG = new Array(256);
  for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const gmul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

  function rsEncode(data, ecLen) {
    let gen = [1];
    for (let i = 0; i < ecLen; i++) {
      const next = new Array(gen.length + 1).fill(0);
      for (let j = 0; j < gen.length; j++) { next[j] ^= gen[j]; next[j + 1] ^= gmul(gen[j], EXP[i]); }
      gen = next;
    }
    const res = new Array(ecLen).fill(0);
    for (const d of data) {
      const factor = d ^ res[0];
      res.shift(); res.push(0);
      for (let j = 0; j < ecLen; j++) res[j] ^= gmul(gen[j + 1], factor);
    }
    return res;
  }

  function bch(value, gen, bits, genBits) { // remainder of value << bits divided by gen
    let v = value << bits;
    for (let i = genBits; i >= 0; i--) if (v & (1 << (i + bits))) v ^= gen << i;
    return v;
  }

  const MASKS = [
    (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  function utf8(text) {
    if (typeof TextEncoder !== "undefined") return Array.from(new TextEncoder().encode(text));
    return Array.from(Buffer.from(text, "utf8"));
  }

  function buildCodewords(bytes, ver) {
    const [dataCw, ecLen, groups] = VERS[ver];
    const bits = [];
    const push = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
    push(4, 4); push(bytes.length, ver < 10 ? 8 : 16);
    bytes.forEach((b) => push(b, 8));
    const cap = dataCw * 8;
    for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0);
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
    for (let pad = 0xec; data.length < dataCw; pad ^= 0xec ^ 0x11) data.push(pad);

    const blocks = []; let pos = 0;
    for (const [count, size] of groups) for (let i = 0; i < count; i++) { blocks.push({ d: data.slice(pos, pos + size) }); pos += size; }
    blocks.forEach((b) => { b.e = rsEncode(b.d, ecLen); });
    const out = [];
    const maxD = Math.max(...blocks.map((b) => b.d.length));
    for (let i = 0; i < maxD; i++) blocks.forEach((b) => { if (i < b.d.length) out.push(b.d[i]); });
    for (let i = 0; i < ecLen; i++) blocks.forEach((b) => out.push(b.e[i]));
    return out;
  }

  function penalty(m) {
    const n = m.length; let p = 0;
    const runs = (get) => {
      for (let a = 0; a < n; a++) {
        let run = 1;
        for (let b = 1; b < n; b++) {
          if (get(a, b) === get(a, b - 1)) run++; else { if (run >= 5) p += run - 2; run = 1; }
        }
        if (run >= 5) p += run - 2;
      }
    };
    runs((r, c) => m[r][c]); runs((c, r) => m[r][c]);
    for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) {
      const v = m[r][c]; if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) p += 3;
    }
    const pat = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], rev = pat.slice().reverse();
    const match = (get, a, b, q) => q.every((v, k) => get(a, b + k) === v);
    for (let a = 0; a < n; a++) for (let b = 0; b <= n - 11; b++) {
      if (match((r, c) => m[r][c], a, b, pat) || match((r, c) => m[r][c], a, b, rev)) p += 40;
      if (match((c, r) => m[r][c], a, b, pat) || match((c, r) => m[r][c], a, b, rev)) p += 40;
    }
    let dark = 0; m.forEach((row) => row.forEach((v) => { if (v) dark++; }));
    p += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
    return p;
  }

  function qrMatrix(text, forceMask) {
    const bytes = utf8(text);
    let ver = 1;
    while (ver <= 10 && bytes.length + (ver < 10 ? 2 : 3) > VERS[ver][0]) ver++;
    if (ver > 10) throw new Error("QR payload too long");
    const n = 17 + 4 * ver;
    const mod = Array.from({ length: n }, () => new Array(n).fill(0));
    const fn = Array.from({ length: n }, () => new Array(n).fill(false)); // function-pattern cells
    const set = (r, c, v) => { if (r >= 0 && r < n && c >= 0 && c < n) { mod[r][c] = v ? 1 : 0; fn[r][c] = true; } };

    const finder = (r0, c0) => {
      for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
        const inside = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const dark = inside && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        set(r0 + dr, c0 + dc, dark);
      }
    };
    finder(0, 0); finder(0, n - 7); finder(n - 7, 0);
    for (let i = 8; i < n - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    const ac = ALIGN[ver];
    for (const r of ac) for (const c of ac) {
      if ((r === 6 && c === 6) || (r === 6 && c === ac[ac.length - 1]) || (r === ac[ac.length - 1] && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
    }
    for (let i = 0; i < 9; i++) { if (i !== 6) { set(8, i, 0); set(i, 8, 0); } }
    for (let i = 0; i < 8; i++) { set(8, n - 1 - i, 0); set(n - 1 - i, 8, 0); }
    set(n - 8, 8, 1); // dark module
    if (ver >= 7) {
      const v = (ver << 12) | bch(ver, 0x1f25, 12, 6);
      for (let i = 0; i < 18; i++) { const bit = (v >> i) & 1; set(Math.floor(i / 3), n - 11 + (i % 3), bit); set(n - 11 + (i % 3), Math.floor(i / 3), bit); }
    }

    // data placement (zig-zag from bottom-right, skipping the timing column)
    const cw = buildCodewords(bytes, ver);
    const bitsArr = []; cw.forEach((b) => { for (let i = 7; i >= 0; i--) bitsArr.push((b >> i) & 1); });
    let k = 0, up = true;
    for (let c = n - 1; c > 0; c -= 2) {
      if (c === 6) c--;
      for (let i = 0; i < n; i++) {
        const r = up ? n - 1 - i : i;
        for (let d = 0; d < 2; d++) { const cc = c - d; if (!fn[r][cc]) { mod[r][cc] = k < bitsArr.length ? bitsArr[k] : 0; k++; } }
      }
      up = !up;
    }

    const apply = (mask) => {
      const m = mod.map((row) => row.slice());
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (!fn[r][c] && MASKS[mask](r, c)) m[r][c] ^= 1;
      const fmt = (((0 << 3) | mask) << 10 | bch((0 << 3) | mask, 0x537, 10, 4)) ^ 0x5412; // level M = 00
      const bit = (i) => (fmt >> i) & 1;
      for (let i = 0; i <= 5; i++) m[i][8] = bit(i);
      m[7][8] = bit(6); m[8][8] = bit(7); m[8][7] = bit(8);
      for (let i = 9; i < 15; i++) m[8][14 - i] = bit(i);
      for (let i = 0; i < 8; i++) m[8][n - 1 - i] = bit(i);
      for (let i = 8; i < 15; i++) m[n - 15 + i][8] = bit(i);
      m[n - 8][8] = 1;
      return m;
    };
    if (forceMask !== undefined) return apply(forceMask);
    let best = null, bestP = Infinity;
    for (let mk = 0; mk < 8; mk++) { const m = apply(mk); const p = penalty(m); if (p < bestP) { bestP = p; best = m; } }
    return best;
  }

  function qrSvg(text, scale = 3, quiet = 4) {
    const m = qrMatrix(text), n = m.length, size = (n + quiet * 2) * scale;
    let path = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m[r][c]) path += `M${(c + quiet) * scale},${(r + quiet) * scale}h${scale}v${scale}h-${scale}z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="QR code"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
  }

  root.qrSvg = qrSvg; root.qrMatrix = qrMatrix;
  if (typeof module !== "undefined") module.exports = { qrSvg, qrMatrix };
})(typeof window !== "undefined" ? window : globalThis);
