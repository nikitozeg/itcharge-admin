// Минимальное извлечение текста из PDF без библиотек — под счета ТНС энерго (iText/BIRT):
// объекты и object streams, сжатие FlateDecode, шрифты Type0/Identity-H с картами ToUnicode.
// inflate(bytes) → Promise<Uint8Array> передаётся снаружи (в воркере — DecompressionStream,
// в тестах — zlib). Возвращает строки страницы сверху вниз, слева направо.

const latin1 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return s;
};

// Все объекты: обычные «N 0 obj … endobj» и упакованные в /ObjStm.
async function readObjects(bytes, inflate) {
  const src = latin1(bytes);
  const objs = new Map(); // номер → { dict, stream (Uint8Array | null) }
  const re = /(\d+)\s+0\s+obj\b/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    const end = src.indexOf('endobj', start);
    if (end < 0) break;
    const body = src.slice(start, end);
    const si = body.indexOf('stream');
    let dict = body;
    let stream = null;
    if (si >= 0 && /^\s*<</.test(body)) {
      dict = body.slice(0, si);
      let ds = start + si + 6;
      if (src[ds] === '\r') ds++;
      if (src[ds] === '\n') ds++;
      const lenM = dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
      const de = lenM ? ds + Number(lenM[1]) : src.indexOf('endstream', ds);
      stream = bytes.subarray(ds, de);
    }
    objs.set(Number(m[1]), { dict, stream });
    re.lastIndex = end;
  }
  // распаковать object streams
  for (const { dict, stream } of [...objs.values()]) {
    if (!stream || !/\/Type\s*\/ObjStm/.test(dict)) continue;
    const n = Number(dict.match(/\/N\s+(\d+)/)?.[1] ?? 0);
    const first = Number(dict.match(/\/First\s+(\d+)/)?.[1] ?? 0);
    const data = latin1(/\/FlateDecode/.test(dict) ? await inflate(stream) : stream);
    const head = data.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const num = head[2 * i];
      const off = first + head[2 * i + 1];
      const next = i + 1 < n ? first + head[2 * i + 3] : data.length;
      if (!objs.has(num)) objs.set(num, { dict: data.slice(off, next), stream: null });
    }
  }
  return objs;
}

const ref = (dict, key) => Number(dict.match(new RegExp(`/${key}\\s+(\\d+)\\s+0\\s+R`))?.[1] ?? NaN);

async function streamText(obj, inflate) {
  if (!obj?.stream) return '';
  return latin1(/\/FlateDecode/.test(obj.dict) ? await inflate(obj.stream) : obj.stream);
}

// ToUnicode: <код> → строка (bfchar и bfrange, в том числе с массивом).
function parseCMap(text) {
  const map = new Map();
  const hex2str = (h) => {
    let s = '';
    for (let i = 0; i + 4 <= h.length; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    return s;
  };
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, c, u] of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) map.set(parseInt(c, 16), hex2str(u));
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const [, a, b, rest] of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(\[[^\]]*\]|<[0-9A-Fa-f]+>)/g)) {
      const lo = parseInt(a, 16);
      const hi = parseInt(b, 16);
      if (rest.startsWith('[')) {
        [...rest.matchAll(/<([0-9A-Fa-f]+)>/g)].forEach(([, u], i) => map.set(lo + i, hex2str(u)));
      } else {
        const base = parseInt(rest.slice(1, -1), 16);
        for (let c = lo; c <= hi; c++) map.set(c, String.fromCharCode(base + (c - lo)));
      }
    }
  }
  return map;
}

// Строка PDF «(...)» → байты с учётом экранирования.
function literalBytes(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c === 92) {
      const n = s[++i];
      if (n >= '0' && n <= '7') {
        let o = n;
        while (o.length < 3 && s[i + 1] >= '0' && s[i + 1] <= '7') o += s[++i];
        c = parseInt(o, 8);
      } else c = { n: 10, r: 13, t: 9, b: 8, f: 12 }[n] ?? n.charCodeAt(0);
      if (n === '\r' || n === '\n') continue;
    }
    out.push(c & 255);
  }
  return out;
}

function decode(bytes, font) {
  if (!font) return String.fromCharCode(...bytes);
  let s = '';
  const step = font.twoByte ? 2 : 1;
  for (let i = 0; i + step <= bytes.length; i += step) {
    const code = step === 2 ? (bytes[i] << 8) | bytes[i + 1] : bytes[i];
    s += font.map.get(code) ?? (step === 1 ? String.fromCharCode(code) : '');
  }
  return s;
}

export async function pdfLines(bytes, inflate) {
  const objs = await readObjects(bytes, inflate);
  const pages = [...objs.values()].filter((o) => /\/Type\s*\/Page(?!s)/.test(o.dict));
  const lines = [];
  for (const page of pages) {
    // шрифты страницы: /F1 → { map, twoByte }
    let res = page.dict.match(/\/Resources\s*(<<[\s\S]*?>>\s*>>)/)?.[1] ?? '';
    if (!res && !Number.isNaN(ref(page.dict, 'Resources'))) res = objs.get(ref(page.dict, 'Resources'))?.dict ?? '';
    let fontsDict = res.match(/\/Font\s*<<([\s\S]*?)>>/)?.[1] ?? '';
    if (!fontsDict && !Number.isNaN(ref(res, 'Font'))) fontsDict = objs.get(ref(res, 'Font'))?.dict ?? '';
    const fonts = {};
    for (const [, name, num] of fontsDict.matchAll(/\/([\w.+-]+)\s+(\d+)\s+0\s+R/g)) {
      const fd = objs.get(Number(num))?.dict ?? '';
      const tu = ref(fd, 'ToUnicode');
      fonts[name] = { map: Number.isNaN(tu) ? new Map() : parseCMap(await streamText(objs.get(tu), inflate)), twoByte: /Type0|Identity-H/.test(fd) };
    }
    // содержимое: может быть одной ссылкой или массивом ссылок
    const cRefs = [...(page.dict.match(/\/Contents\s*(\[[^\]]*\]|\d+\s+0\s+R)/)?.[1] ?? '').matchAll(/(\d+)\s+0\s+R/g)].map((x) => Number(x[1]));
    let content = '';
    for (const r of cRefs) content += (await streamText(objs.get(r), inflate)) + '\n';
    // разбор: шрифт (Tf), позиция (cm / Tm / Td), строки (Tj, TJ, ', ")
    const segs = [];
    const stack = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    let tm = [0, 0];
    let font = null;
    const tok = /\((?:\\[\s\S]|[^\\)])*\)|<[0-9A-Fa-f\s]*>|\[|\]|\/[^\s/\[\]()<>]+|-?\d*\.?\d+|[A-Za-z'"*]+/g;
    const args = [];
    let arr = null;
    let t;
    while ((t = tok.exec(content))) {
      const v = t[0];
      if (v === '[') { arr = []; continue; }
      if (v === ']') { args.push(arr); arr = null; continue; }
      if (v[0] === '(' || v[0] === '<') {
        const b = v[0] === '(' ? literalBytes(v.slice(1, -1)) : (v.slice(1, -1).replace(/\s/g, '').match(/../g) ?? []).map((h) => parseInt(h, 16));
        (arr ?? args).push({ str: b });
        continue;
      }
      if (arr) { if (/^-?\d*\.?\d+$/.test(v)) arr.push(Number(v)); continue; }
      if (/^-?\d*\.?\d+$/.test(v) || v[0] === '/') { args.push(v[0] === '/' ? v.slice(1) : Number(v)); continue; }
      // оператор
      if (v === 'q') stack.push(ctm.slice());
      else if (v === 'Q') ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
      else if (v === 'cm' && args.length >= 6) {
        const [a, b, c, d, e, f] = args.slice(-6);
        ctm = [a * ctm[0] + b * ctm[2], a * ctm[1] + b * ctm[3], c * ctm[0] + d * ctm[2], c * ctm[1] + d * ctm[3], e * ctm[0] + f * ctm[2] + ctm[4], e * ctm[1] + f * ctm[3] + ctm[5]];
      } else if (v === 'BT') tm = [0, 0];
      else if (v === 'Tm' && args.length >= 6) tm = [args.at(-2), args.at(-1)];
      else if ((v === 'Td' || v === 'TD') && args.length >= 2) tm = [tm[0] + args.at(-2), tm[1] + args.at(-1)];
      else if (v === 'Tf' && args.length >= 2) font = fonts[args.at(-2)] ?? null;
      else if (v === 'Tj' || v === "'" || v === '"' || v === 'TJ') {
        const items = v === 'TJ' ? args.at(-1) ?? [] : [args.at(-1)];
        let text = '';
        for (const it of items) {
          if (it && it.str) text += decode(it.str, font);
          else if (typeof it === 'number' && it < -200) text += ' '; // большой отступ внутри TJ — пробел
        }
        if (text) segs.push({ x: ctm[4] + tm[0], y: ctm[5] + tm[1], text });
      }
      args.length = 0;
    }
    // строки: группируем по y (сверху вниз), внутри — по x
    segs.sort((a, b) => b.y - a.y || a.x - b.x);
    let cur = null;
    for (const s of segs) {
      if (cur && Math.abs(cur.y - s.y) <= 2.5) cur.parts.push(s);
      else { cur = { y: s.y, parts: [s] }; lines.push(cur); }
    }
  }
  return lines.map((l) => l.parts.sort((a, b) => a.x - b.x).map((p) => p.text.trim()).filter(Boolean).join('  ')).filter(Boolean);
}
