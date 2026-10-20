/* AGY SCOPE | Browser-local trend analysis. No network calls. */
'use strict';
(() => {
const $ = id => document.getElementById(id);
const palette = ['#45e6d5','#afa0ff','#ffbe66','#50aaff','#fb81ae','#a4de76','#f48268','#71d6f0','#df95f5','#e0d971'];
const DEFAULT_COL_WIDTHS = [230, 130, 130, 110, 155, 155, 110, 95];
const sortLabels = {
  signal: '訊號 / 來源',
  cursorA: '標尺 A',
  cursorB: '標尺 B',
  delta: 'Δ B − A',
  min: '最小值 / 時間',
  max: '最大值 / 時間',
  mean: '平均值',
  n: '有效點數'
};

const state = {
  sidebarCollapsed: false,
  panelCollapsed: { files: false, alignment: false, channels: false },
  colWidths: [...DEFAULT_COL_WIDTHS],
  tableSort: { col: null, dir: null },
  tableFilter: '',
  files: [],
  activeReportId: null,
  mode: 'zoom',
  alignment: 'elapsed',
  scale: 'raw',
  view: null,
  full: null,
  y: null,
  range: null,
  cursors: [null, null],
  drag: null,
  hover: null,
  demo: false,
  serial: 0,
  stats: [],
  statsDirty: true
};

const canvas = $('chart'), ctx = canvas.getContext('2d');
let W = 0, H = 0, plot = {}, scheduled = false, importing = false;
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = v => Number.isFinite(v) ? v.toLocaleString('en-US', { maximumFractionDigits: 5 }) : '—';
const pad = (n, len = 2) => String(n).padStart(len, '0');

function dateText(t){
  if(!Number.isFinite(t)) return '—';
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
function elapsed(t, ms = false){
  const sign = t < 0 ? '−' : '';
  t = Math.abs(t);
  const h = Math.floor(t / 3600000), m = Math.floor(t / 60000) % 60, s = Math.floor(t / 1000) % 60;
  return `${sign}${pad(h)}:${pad(m)}:${pad(s)}${ms ? '.' + pad(Math.round(t % 1000), 3) : ''}`;
}
const timeText = t => state.alignment === 'elapsed' ? elapsed(t, true) : dateText(t);
const status = (s, error = false) => { $('status').textContent = s; $('status').classList.toggle('error', error); };
const selected = () => state.files.flatMap(f => f.channels.filter(c => c.visible).map(c => ({ f, c })));
const origin = f => state.alignment === 'elapsed' ? f.rows[0].t : 0;
const xt = (f, r) => r.t - origin(f) + f.offset * 1000;
const val = (f, c, r) => r.v[c.index] === null ? null : r.v[c.index] - (state.scale === 'delta' ? c.base : 0);

function lower(rows, t){
  let a = 0, b = rows.length;
  while(a < b){
    let m = (a + b) >>> 1;
    if(rows[m].t < t) a = m + 1; else b = m;
  }
  return a;
}

function nearest(f, t){
  const target = t + origin(f) - f.offset * 1000, rows = f.rows;
  if(target < rows[0].t || target > rows[rows.length - 1].t) return null;
  let i = lower(rows, target);
  if(i === rows.length) i--;
  if(i > 0 && target - rows[i - 1].t <= rows[i].t - target) i--;
  return rows[i];
}

function bounds(){
  let a = Infinity, b = -Infinity;
  for(const f of state.files){
    a = Math.min(a, xt(f, f.rows[0]));
    b = Math.max(b, xt(f, f.rows.at(-1)));
  }
  return a === Infinity ? null : [a, b > a ? b : a + 1000];
}

function reset(){
  state.full = bounds();
  state.view = state.full ? [...state.full] : null;
  state.y = null;
  if(state.view) state.cursors = [.3, .7].map(x => state.view[0] + x * (state.view[1] - state.view[0]));
  state.statsDirty = true;
  render();
}

function changed(resetView = false){
  state.statsDirty = true;
  if(resetView) reset();
  else { state.full = bounds(); render(); }
}

function parseCSV(text){
  text = text.replace(/^\uFEFF/, '');
  const first = text.split(/\r?\n/, 1)[0];
  let delimiter = ',';
  if(/^sep=./i.test(first)){
    delimiter = first.at(-1);
    text = text.slice(text.indexOf('\n') + 1);
  } else {
    let inQuotes = false, counts = { ',': 0, ';': 0, '\t': 0 };
    for(let i = 0; i < first.length; i++){
      if(first[i] === '"') inQuotes = !inQuotes;
      else if(!inQuotes && first[i] in counts) counts[first[i]]++;
    }
    delimiter = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  }
  const rows = [];
  let row = [], cell = '', quoted = false;
  for(let i = 0; i < text.length; i++){
    let c = text[i];
    if(c === '"'){
      if(quoted && text[i + 1] === '"'){ cell += '"'; i++; }
      else if(quoted || cell === '') quoted = !quoted;
      else cell += c;
    } else if(c === delimiter && !quoted){
      row.push(cell); cell = '';
    } else if((c === '\n' || c === '\r') && !quoted){
      if(c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if(quoted) throw Error('CSV 引號未成對，請檢查檔案格式');
  if(cell !== '' || row.length){ row.push(cell); rows.push(row); }
  return rows;
}

function parseTime(v, date1904 = false){
  if(v instanceof Date) return v.getTime();
  if(typeof v === 'number' || (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()))){
    let n = Number(v);
    if(!Number.isFinite(n)) return NaN;
    if(n >= 1e11) return n;
    if(n >= 1e9) return n * 1000;
    const p = XLSX.SSF.parse_date_code(n, { date1904 });
    if(!p) return NaN;
    return new Date(p.y, p.m - 1, p.d, p.H, p.M, p.S, Math.round(p.u * 1000)).getTime();
  }
  if(typeof v !== 'string') return NaN;
  v = v.trim();
  let m = v.match(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
  if(m){
    if(+m[1] > 23 || +m[2] > 59 || +(m[3] || 0) > 59) return NaN;
    return new Date(2000, 0, 1, +m[1], +m[2], +(m[3] || 0), +(m[4] || '0').padEnd(3, '0')).getTime();
  }
  m = v.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/);
  if(m){
    const y = +m[1], mo = +m[2], d = +m[3], h = +(m[4] || 0), mi = +(m[5] || 0), s = +(m[6] || 0), dt = new Date(y, mo - 1, d, h, mi, s, +(m[7] || '0').padEnd(3, '0'));
    return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d && h < 24 && mi < 60 && s < 60 ? dt.getTime() : NaN;
  }
  return /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(v) ? Date.parse(v) : NaN;
}

function numeric(v){
  if(v === null || v === undefined || typeof v === 'boolean' || String(v).trim() === '') return null;
  const n = Number(typeof v === 'string' ? v.replace(/,/g, '').trim() : v);
  return Number.isFinite(n) ? n : null;
}

function makeDataset(matrix, name, date1904 = false){
  const headerIndex = matrix.findIndex(r => r.some(v => v !== null && v !== undefined && String(v).trim() !== ''));
  if(headerIndex < 0) return null;
  const header = matrix[headerIndex];
  if(header.length < 2) throw Error('需有時間欄及至少一個數值欄');
  const headers = Array.from({ length: header.length - 1 }, (_, i) => String(header[i + 1] ?? '').trim() || `欄位 ${i + 2}`);
  let skipped = 0, blank = 0, roll = 0, previous = null;
  const rows = [];
  for(let i = headerIndex + 1; i < matrix.length; i++){
    const r = matrix[i];
    if(!r.some(v => v !== null && v !== undefined && String(v).trim() !== '')){ blank++; continue; }
    let t = parseTime(r[0], date1904);
    if(!Number.isFinite(t)){ skipped++; continue; }
    const timeOnly = typeof r[0] === 'string' && /^\d{1,2}:\d\d(?::\d\d(?:\.\d+)?)?$/.test(r[0].trim()) || typeof r[0] === 'number' && r[0] >= 0 && r[0] < 1;
    if(timeOnly){
      if(previous !== null && t < previous - 43200000) roll += 86400000;
      previous = t;
      t += roll;
    }
    rows.push({ t, row: i + 1, v: headers.map((_, j) => numeric(r[j + 1])) });
  }
  if(!rows.length) throw Error('找不到有效時間紀錄；第一欄請使用日期時間或 HH:mm:ss');
  rows.sort((a, b) => a.t - b.t);
  const id = ++state.serial;
  const channels = headers.map((name, index) => {
    const base = rows.find(r => r.v[index] !== null)?.v[index];
    return { name, index, base: base ?? 0, visible: base !== undefined, color: palette[((id - 1) * 3 + index) % palette.length], axis: /速度|speed|rpm/i.test(name) ? 1 : 0 };
  });
  if(channels.every(c => !c.visible)) throw Error('時間有效，但其餘欄位皆無有效數值');
  return { id, name, rows, channels, offset: 0, skipped, blank };
}

async function importFiles(input){
  if(importing) return;
  importing = true;
  $('importBtn').disabled = true;
  const errors = [], notes = [];
  let count = 0;
  if(state.demo){ state.files = []; state.demo = false; }
  try {
    for(const file of input){
      status(`正在讀取 ${file.name}…`);
      await new Promise(r => setTimeout(r, 15));
      try {
        const buf = await file.arrayBuffer();
        let sheets = [];
        if(/\.(csv|tsv)$/i.test(file.name)){
          let encoding = $('encoding').value, text;
          if(encoding === 'auto'){
            try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
            catch { text = new TextDecoder('big5').decode(buf); }
          } else text = new TextDecoder(encoding).decode(buf);
          sheets = [{ name: file.name, matrix: parseCSV(text) }];
        } else if(/\.(xlsx|xls)$/i.test(file.name)){
          const wb = XLSX.read(buf, { type: 'array', cellDates: false });
          sheets = wb.SheetNames.map(name => ({
            name: wb.SheetNames.length > 1 ? `${file.name} / ${name}` : file.name,
            matrix: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: true, range: 0 }),
            date1904: !!wb.Workbook?.WBProps?.date1904
          }));
        } else throw Error('僅支援 XLSX、XLS、CSV 或 TSV');
        for(const sheet of sheets){
          try {
            const f = makeDataset(sheet.matrix, sheet.name, sheet.date1904);
            if(f){
              state.files.push(f);
              count++;
              if(f.skipped) notes.push(`${f.name}：略過 ${f.skipped} 列無效時間`);
            }
          } catch(e){ errors.push(`${sheet.name}：${e.message}`); }
        }
      } catch(e){ errors.push(`${file.name}：${e.message}`); }
    }
    rebuild();
    state.range = null;
    reset();
    status(`已載入 ${count} 份資料，共 ${state.files.reduce((n, f) => n + f.rows.length, 0).toLocaleString()} 筆。${notes.length ? '\n' + notes.join('\n') : ''}${errors.length ? '\n部分檔案未載入：\n' + errors.join('\n') : ''}`, errors.length > 0);
  } finally {
    importing = false;
    $('importBtn').disabled = false;
    $('fileInput').value = '';
  }
}

function rebuild(){
  $('fileList').innerHTML = state.files.map(f => `<div class="file-card" data-report="${f.id}"><div class="file-top"><button class="file-select" data-select-report="${f.id}" aria-pressed="false" aria-label="操作報表 ${esc(f.name)}"><span class="swatch" style="background:${f.channels[0].color}"></span><span class="file-name" title="${esc(f.name)}">${esc(f.name)}</span><span class="selected-badge">操作中</span></button><button class="remove" data-remove="${f.id}" aria-label="移除 ${esc(f.name)}">×</button></div><div class="file-meta">${f.rows.length.toLocaleString()} 筆 · ${f.channels.length} 通道${f.skipped ? ' · ' + f.skipped + ' 列略過' : ''}</div><label class="offset-field">時間偏移 <input type="number" step="0.1" data-offset="${f.id}" value="${f.offset}" aria-label="${esc(f.name)} 時間偏移秒數"> 秒</label></div>`).join('');
  $('channels').innerHTML = state.files.map(f => `<div class="channel-group-name" data-group-report="${f.id}" title="${esc(f.name)}">${esc(f.name)}</div>${f.channels.map(c => `<div class="channel-row"><label><input type="checkbox" data-channel="${f.id}:${c.index}" ${c.visible ? 'checked' : ''}><i class="swatch" style="background:${c.color}"></i><span title="${esc(c.name)}">${esc(c.name)}</span></label><select class="axis-select" data-axis="${f.id}:${c.index}" aria-label="${esc(f.name + ' ' + c.name)} 座標軸"><option value="0" ${c.axis === 0 ? 'selected' : ''}>左</option><option value="1" ${c.axis === 1 ? 'selected' : ''}>右</option></select></div>`).join('')}`).join('') || '<div class="subtle-empty">匯入後即可選擇訊號</div>';
  for(const id of ['referenceFile', 'movingFile']){
    const old = $(id).value;
    $(id).innerHTML = state.files.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('') || '<option value="">請先匯入檔案</option>';
    if(state.files.some(f => String(f.id) === old)) $(id).value = old;
    else if(id === 'movingFile' && state.files.length > 1) $(id).value = state.files[1].id;
  }
  syncReportSelection();
  commonSignals();
  $('fileCount').textContent = state.files.length;
  $('channelCount').textContent = state.files.reduce((n, f) => n + f.channels.length, 0);
}

function syncReportSelection(){
  const id = state.activeReportId;
  document.querySelectorAll('[data-report]').forEach(card => {
    const active = id !== null && +card.dataset.report === id;
    card.classList.toggle('selected', active);
    const btn = card.querySelector('[data-select-report]');
    if(btn) btn.setAttribute('aria-pressed', String(active));
  });
  document.querySelectorAll('[data-group-report]').forEach(grp => {
    const active = id !== null && +grp.dataset.groupReport === id;
    grp.classList.toggle('active', active);
  });
}

function selectReport(id, forceSelect = false){
  const f = state.files.find(f => f.id === +id);
  if(!f) return;
  if(!forceSelect && state.activeReportId === f.id){
    state.activeReportId = null;
    syncReportSelection();
    render();
    status('已取消聚焦特定報表，所有報表曲線皆正常顯示。');
    return;
  }
  const previous = +$('movingFile').value;
  let swapped = false;
  if(state.files.length > 1 && +$('referenceFile').value === f.id){
    const reference = state.files.find(f => f.id === previous && f.id !== +id) || state.files.find(f => f.id !== +id);
    if(reference){
      $('referenceFile').value = String(reference.id);
      swapped = true;
      commonSignals();
    }
  }
  $('movingFile').value = String(f.id);
  state.activeReportId = f.id;
  syncReportSelection();
  render();
  status(`操作中：${f.name}。趨勢圖與資料表已高亮聚焦該報表曲線，其餘報表淡化顯示。${swapped ? '原參考報表已切換為另一份報表。' : ''}`);
}

function commonSignals(){
  const ref = state.files.find(f => f.id === +$('referenceFile').value), old = $('alignSignal').value;
  const names = ref ? ref.channels.filter(c => state.files.filter(f => f !== ref).some(f => f.channels.some(x => x.name === c.name))).map(c => c.name) : [];
  $('alignSignal').innerHTML = names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('') || '<option value="">至少匯入兩份含共同訊號的資料</option>';
  if(names.includes(old)) $('alignSignal').value = old;
  else if(names.some(n => /速度|speed/i.test(n))) $('alignSignal').value = names.find(n => /速度|speed/i.test(n));
}

function setMode(mode){
  state.mode = mode;
  document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  canvas.style.cursor = mode === 'pan' ? 'grab' : mode === 'shift' ? 'ew-resize' : 'crosshair';
  if(mode === 'shift'){
    if(state.activeReportId === null && $('movingFile').value){
      state.activeReportId = +$('movingFile').value;
      syncReportSelection();
      render();
    }
    const curFile = state.files.find(f => f.id === +$('movingFile').value);
    status(`單份報表平移：${curFile ? curFile.name + ' ' : ''}在圖中左右拖曳即可調整時間偏移。`);
  }
}

function feature(f, name, method){
  const c = f.channels.find(c => c.name === name);
  if(!c) return null;
  let result = null, best = method === 'min' ? Infinity : -Infinity, prior = null;
  for(const r of f.rows){
    const v = r.v[c.index];
    if(v === null){ prior = null; continue; }
    if(method === 'rise'){
      if(prior && r.t > prior.t){
        const slope = (v - prior.v) / (r.t - prior.t);
        if(slope > 0 && slope > best){ best = slope; result = r; }
      }
      prior = { t: r.t, v };
    } else if(method === 'max' ? v > best : v < best){
      best = v;
      result = r;
    }
  }
  if(method !== 'rise'){
    let min = Infinity, max = -Infinity;
    for(const r of f.rows){
      const v = r.v[c.index];
      if(v !== null){ min = Math.min(min, v); max = Math.max(max, v); }
    }
    if(min === max) return null;
  }
  return result;
}

function autoAlign(){
  const ref = state.files.find(f => f.id === +$('referenceFile').value), name = $('alignSignal').value, method = $('alignMethod').value;
  if(!ref || state.files.length < 2 || !name) return status('請先匯入至少兩份含共同訊號的報表。', true);
  const anchor = feature(ref, name, method);
  if(!anchor) return status('參考報表找不到可辨識的特徵，請改選訊號或特徵。', true);
  let n = 0, skipped = [];
  for(const f of state.files){
    if(f === ref) continue;
    const r = feature(f, name, method);
    if(!r){ skipped.push(f.name); continue; }
    f.offset = (xt(ref, anchor) - (r.t - origin(f))) / 1000;
    n++;
  }
  rebuild();
  state.range = null;
  reset();
  status(`已依「${name}」的「${$('alignMethod').selectedOptions[0].textContent}」對齊 ${n} 份報表。參考：${ref.name}；原始時間 ${dateText(anchor.t)}。請確認特徵為相同測試事件。${skipped.length ? '\n無可用特徵，保留原偏移：' + skipped.join('、') : ''}`, skipped.length > 0);
}

function alignCursors(){
  const ref = state.files.find(f => f.id === +$('referenceFile').value), f = state.files.find(f => f.id === +$('movingFile').value);
  if(!ref || !f || f === ref) return status('請選擇不同的參考報表及移動報表。', true);
  const a = nearest(ref, state.cursors[0]), b = nearest(f, state.cursors[1]);
  if(!a || !b) return status('A 標尺需在參考報表範圍內，B 標尺需在移動報表範圍內。', true);
  f.offset += (xt(ref, a) - xt(f, b)) / 1000;
  rebuild();
  state.range = null;
  reset();
  status(`已將 ${f.name} 第 ${b.row} 列對齊 ${ref.name} 第 ${a.row} 列。時間偏移 ${fmt(f.offset)} 秒。`);
}

function limits(axis, lo = state.view?.[0], hi = state.view?.[1]){
  let min = Infinity, max = -Infinity;
  for(const { f, c } of selected()){
    if(c.axis !== axis) continue;
    const a = lo + origin(f) - f.offset * 1000, b = hi + origin(f) - f.offset * 1000;
    let start = Math.max(0, lower(f.rows, a) - 1);
    for(let i = start; i < f.rows.length && f.rows[i].t <= b; i++){
      const v = val(f, c, f.rows[i]);
      if(v !== null){ min = Math.min(min, v); max = Math.max(max, v); }
    }
  }
  if(!Number.isFinite(min)) return [0, 1];
  const margin = (max - min || Math.abs(max) * .05 || 1) * .08;
  return [min - margin, max + margin];
}

const px = t => plot.l + (t - state.view[0]) / (state.view[1] - state.view[0]) * plot.w;
const tx = x => state.view[0] + (x - plot.l) / plot.w * (state.view[1] - state.view[0]);
const py = (v, axis) => plot.b - (v - state.y[axis][0]) / (state.y[axis][1] - state.y[axis][0]) * plot.h;
const vy = (y, axis) => state.y[axis][0] + (plot.b - y) / plot.h * (state.y[axis][1] - state.y[axis][0]);
const clampX = x => Math.max(plot.l, Math.min(plot.r, x));

/* Sidebar collapse & full width */
function toggleSidebar(forceState){
  const next = typeof forceState === 'boolean' ? forceState : !state.sidebarCollapsed;
  state.sidebarCollapsed = next;
  const ws = $('workspace');
  if(ws) ws.classList.toggle('sidebar-collapsed', next);
  const expBtn = $('expandSidebarBtn');
  if(expBtn) expBtn.hidden = !next;
  const wideBtn = $('toggleWideBtn');
  if(wideBtn){
    wideBtn.classList.toggle('active', next);
    const icon = $('toggleWideIcon'), text = $('toggleWideText');
    if(icon) icon.textContent = next ? '◨' : '◧';
    if(text) text.textContent = next ? '顯示側邊欄' : '全寬檢視';
    wideBtn.title = next ? '顯示左側設定區塊 (Alt+S 或 [ 鍵)' : '縮排左側設定區塊，最大化圖表檢視 (Alt+S 或 [ 鍵)';
  }
  try { localStorage.setItem('agy_scope_sidebar_collapsed', next ? '1' : '0'); } catch(e){}
  resize();
  setTimeout(resize, 240);
  status(next ? '● 已收合左側設定區塊，圖表已切換為全寬檢視（按 Alt+S 或點擊「顯示側邊欄」可隨時恢復）。' : '● 已展開左側設定區塊。');
}

/* Individual Tool Panel Collapsible (收合區塊剩標題，使用者要用再點開) */
function togglePanel(panelId, forceState){
  const panel = $(`panel${panelId.charAt(0).toUpperCase() + panelId.slice(1)}`);
  if(!panel) return;
  const isCurrentlyCollapsed = panel.classList.contains('panel-collapsed');
  const nextCollapsed = typeof forceState === 'boolean' ? forceState : !isCurrentlyCollapsed;
  panel.classList.toggle('panel-collapsed', nextCollapsed);
  state.panelCollapsed[panelId] = nextCollapsed;
  const btn = panel.querySelector('.panel-collapse-btn');
  if(btn) btn.setAttribute('aria-expanded', String(!nextCollapsed));
  try { localStorage.setItem(`agy_scope_panel_${panelId}_collapsed`, nextCollapsed ? '1' : '0'); } catch(e){}
}

/* Column Widths Application */
function applyColWidths(){
  const cols = document.querySelectorAll('#statsTable col');
  cols.forEach((col, i) => {
    if(state.colWidths[i]) col.style.width = state.colWidths[i] + 'px';
  });
}

/* Restore Default Layout (恢復預設版面排版) */
function resetDefaultLayout(){
  // 1. Sidebar width
  document.documentElement.style.removeProperty('--sidebar-w');
  try { localStorage.removeItem('agy_scope_sidebar_width'); } catch(e){}
  if(state.sidebarCollapsed) toggleSidebar(false);

  // 2. Uncollapse all tool panels
  ['files', 'alignment', 'channels'].forEach(p => togglePanel(p, false));

  // 3. Clear custom panel heights
  ['panelBodyFiles', 'panelBodyAlignment', 'channels'].forEach(id => {
    const el = $(id);
    if(el) el.style.maxHeight = '';
    try { localStorage.removeItem(`agy_scope_panel_h_${id}`); } catch(e){}
  });

  // 4. Chart height
  if($('chartWrap')){
    $('chartWrap').style.height = '';
    try { localStorage.removeItem('agy_scope_chart_height'); } catch(e){}
  }

  // 5. Table height
  if($('tableScroll')){
    $('tableScroll').style.maxHeight = '';
    try { localStorage.removeItem('agy_scope_table_height'); } catch(e){}
  }

  // 6. Table column widths
  state.colWidths = [...DEFAULT_COL_WIDTHS];
  applyColWidths();
  try { localStorage.removeItem('agy_scope_col_widths'); } catch(e){}

  // 7. Table sort & search filter
  state.tableSort = { col: null, dir: null };
  state.tableFilter = '';
  if($('tableSearchInput')) $('tableSearchInput').value = '';
  if($('clearSearchBtn')) $('clearSearchBtn').hidden = true;

  resize();
  render();
  status('● 已成功恢復預設版面排版（包含側邊欄寬度、各工具區塊收合狀態、圖表高度與數據表欄位排版）。');
}

/* Column Resizing Interaction */
function initColResizing(){
  document.querySelectorAll('#statsTable th').forEach(th => {
    const resizer = th.querySelector('.col-resizer');
    if(!resizer) return;
    const colIndex = +th.dataset.colIndex;
    resizer.addEventListener('pointerdown', e => {
      e.stopPropagation();
      e.preventDefault();
      resizer.setPointerCapture(e.pointerId);
      resizer.classList.add('resizing');
      document.body.classList.add('is-resizing-col');
      const startX = e.clientX;
      const startWidth = state.colWidths[colIndex] || DEFAULT_COL_WIDTHS[colIndex] || 120;
      const onPointerMove = ev => {
        const delta = ev.clientX - startX;
        const newWidth = Math.max(65, Math.round(startWidth + delta));
        state.colWidths[colIndex] = newWidth;
        applyColWidths();
      };
      const onPointerUp = ev => {
        resizer.releasePointerCapture(ev.pointerId);
        resizer.classList.remove('resizing');
        document.body.classList.remove('is-resizing-col');
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        try { localStorage.setItem('agy_scope_col_widths', JSON.stringify(state.colWidths)); } catch(err){}
      };
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
    });

    resizer.addEventListener('dblclick', e => {
      e.stopPropagation();
      state.colWidths[colIndex] = DEFAULT_COL_WIDTHS[colIndex] || 120;
      applyColWidths();
      try { localStorage.setItem('agy_scope_col_widths', JSON.stringify(state.colWidths)); } catch(err){}
      status(`已恢復「${th.querySelector('.th-content span')?.textContent || ''}」欄位預設寬度。`);
    });
  });
}

/* Column Sorting Interaction */
function initColSorting(){
  document.querySelectorAll('#statsTable th.sortable').forEach(th => {
    th.addEventListener('click', e => {
      if(e.target.closest('.col-resizer')) return;
      const col = th.dataset.col;
      if(!col) return;
      if(state.tableSort.col === col){
        if(state.tableSort.dir === 'asc') state.tableSort.dir = 'desc';
        else if(state.tableSort.dir === 'desc') { state.tableSort.col = null; state.tableSort.dir = null; }
        else state.tableSort.dir = 'asc';
      } else {
        state.tableSort.col = col;
        state.tableSort.dir = 'asc';
      }
      updateReadouts();
    });
  });
}

/* Layout Resizing (Sidebar width, chart height, table height, panel body height) */
function initLayoutResizing(){
  // 1. Sidebar width splitter
  const sidebarResizer = $('sidebarResizer');
  if(sidebarResizer){
    sidebarResizer.addEventListener('pointerdown', e => {
      e.preventDefault();
      sidebarResizer.setPointerCapture(e.pointerId);
      sidebarResizer.classList.add('resizing');
      document.body.classList.add('is-resizing-col');
      const startX = e.clientX;
      const curW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')) || $('sidebar').getBoundingClientRect().width || 276;
      const onMove = ev => {
        const delta = ev.clientX - startX;
        const newW = Math.max(180, Math.min(650, Math.round(curW + delta)));
        document.documentElement.style.setProperty('--sidebar-w', newW + 'px');
        resize();
      };
      const onUp = ev => {
        sidebarResizer.releasePointerCapture(ev.pointerId);
        sidebarResizer.classList.remove('resizing');
        document.body.classList.remove('is-resizing-col');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        const finalW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')) || 276;
        try { localStorage.setItem('agy_scope_sidebar_width', finalW + 'px'); } catch(err){}
        resize();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });

    sidebarResizer.addEventListener('dblclick', () => {
      document.documentElement.style.setProperty('--sidebar-w', '276px');
      try { localStorage.removeItem('agy_scope_sidebar_width'); } catch(e){}
      resize();
      status('已恢復側邊欄預設寬度 (276px)。');
    });
  }

  // 2. Chart height resizer
  const chartResizer = $('chartResizer');
  if(chartResizer){
    chartResizer.addEventListener('pointerdown', e => {
      e.preventDefault();
      chartResizer.setPointerCapture(e.pointerId);
      chartResizer.classList.add('resizing');
      document.body.classList.add('is-resizing-row');
      const startY = e.clientY;
      const curH = $('chartWrap').getBoundingClientRect().height || 430;
      const onMove = ev => {
        const delta = ev.clientY - startY;
        const newH = Math.max(240, Math.min(850, Math.round(curH + delta)));
        $('chartWrap').style.height = newH + 'px';
        resize();
      };
      const onUp = ev => {
        chartResizer.releasePointerCapture(ev.pointerId);
        chartResizer.classList.remove('resizing');
        document.body.classList.remove('is-resizing-row');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        try { localStorage.setItem('agy_scope_chart_height', $('chartWrap').style.height); } catch(err){}
        resize();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });

    chartResizer.addEventListener('dblclick', () => {
      $('chartWrap').style.height = '';
      try { localStorage.removeItem('agy_scope_chart_height'); } catch(e){}
      resize();
      status('已恢復趨勢圖預設高度 (430px)。');
    });
  }

  // 3. Table height resizer
  const tableResizer = $('tableResizer');
  if(tableResizer){
    tableResizer.addEventListener('pointerdown', e => {
      e.preventDefault();
      tableResizer.setPointerCapture(e.pointerId);
      tableResizer.classList.add('resizing');
      document.body.classList.add('is-resizing-row');
      const startY = e.clientY;
      const curH = $('tableScroll').getBoundingClientRect().height || 400;
      const onMove = ev => {
        const delta = ev.clientY - startY;
        const newH = Math.max(160, Math.min(950, Math.round(curH + delta)));
        $('tableScroll').style.maxHeight = newH + 'px';
      };
      const onUp = ev => {
        tableResizer.releasePointerCapture(ev.pointerId);
        tableResizer.classList.remove('resizing');
        document.body.classList.remove('is-resizing-row');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        try { localStorage.setItem('agy_scope_table_height', $('tableScroll').style.maxHeight); } catch(err){}
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });

    tableResizer.addEventListener('dblclick', () => {
      $('tableScroll').style.maxHeight = '';
      try { localStorage.removeItem('agy_scope_table_height'); } catch(e){}
      status('已恢復數據表預設高度 (400px)。');
    });
  }

  // 4. Panel height resizers
  document.querySelectorAll('.panel-resizer-h').forEach(handle => {
    const targetId = handle.dataset.panelTarget;
    const targetEl = $(targetId);
    if(!targetEl) return;
    handle.addEventListener('pointerdown', e => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      document.body.classList.add('is-resizing-row');
      const startY = e.clientY;
      const curH = targetEl.getBoundingClientRect().height;
      const onMove = ev => {
        const delta = ev.clientY - startY;
        const newH = Math.max(90, Math.min(750, Math.round(curH + delta)));
        targetEl.style.maxHeight = newH + 'px';
      };
      const onUp = ev => {
        handle.releasePointerCapture(ev.pointerId);
        document.body.classList.remove('is-resizing-row');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        try { localStorage.setItem(`agy_scope_panel_h_${targetId}`, targetEl.style.maxHeight); } catch(err){}
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });

    handle.addEventListener('dblclick', () => {
      targetEl.style.maxHeight = '';
      try { localStorage.removeItem(`agy_scope_panel_h_${targetId}`); } catch(e){}
      status('已恢復該工具區塊的預設高度。');
    });
  });
}

function resize(){
  const r = $('chartWrap').getBoundingClientRect();
  W = r.width;
  H = r.height;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(W * ratio);
  canvas.height = Math.round(H * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  plot = { l: 67, r: W - 67, t: 28, b: H - 46, w: W - 134, h: H - 74 };
  render();
}

function render(){
  if(scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    draw();
    updateReadouts();
  });
}

function draw(){
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0c1520';
  ctx.fillRect(0, 0, W, H);
  ctx.font = '10px Consolas, monospace';

  for(let i = 0; i <= 6; i++){
    const y = plot.t + i * plot.h / 6;
    ctx.strokeStyle = '#203143';
    ctx.lineWidth = .7;
    ctx.beginPath();
    ctx.moveTo(plot.l, y);
    ctx.lineTo(plot.r, y);
    ctx.stroke();
  }
  for(let i = 0; i <= 8; i++){
    const x = plot.l + i * plot.w / 8;
    ctx.strokeStyle = '#1c2a3b';
    ctx.beginPath();
    ctx.moveTo(x, plot.t);
    ctx.lineTo(x, plot.b);
    ctx.stroke();
  }

  $('chartEmpty').hidden = !!state.files.length;
  if(!state.view) return;
  if(!state.y) state.y = [limits(0), limits(1)];
  const visible = selected();

  for(let i = 0; i <= 6; i++){
    const y = plot.t + i * plot.h / 6;
    for(let axis = 0; axis < 2; axis++){
      if(!visible.some(s => s.c.axis === axis)) continue;
      ctx.fillStyle = axis ? '#9994bc' : '#8da4b8';
      ctx.textAlign = axis ? 'left' : 'right';
      ctx.fillText(fmt(vy(y, axis)), axis ? plot.r + 10 : plot.l - 10, y + 3);
    }
  }

  ctx.textAlign = 'left';
  ctx.fillStyle = '#67849a';
  ctx.fillText(state.scale === 'delta' ? '左軸 Δ' : '左軸', plot.l, 14);
  ctx.textAlign = 'right';
  ctx.fillText(state.scale === 'delta' ? '右軸 Δ' : '右軸', plot.r, 14);

  const ticks = Math.max(2, Math.floor(plot.w / 125));
  for(let i = 0; i <= ticks; i++){
    const t = state.view[0] + i / ticks * (state.view[1] - state.view[0]), x = plot.l + i / ticks * plot.w;
    ctx.fillStyle = '#7d95ad';
    ctx.textAlign = i === 0 ? 'left' : i === ticks ? 'right' : 'center';
    ctx.fillText(state.alignment === 'elapsed' ? elapsed(t, state.view[1] - state.view[0] < 10000) : dateText(t).slice(11, state.view[1] - state.view[0] < 10000 ? 23 : 19), x, plot.b + 20);
    if(state.alignment === 'absolute'){
      ctx.fillStyle = '#4c6880';
      ctx.fillText(dateText(t).slice(0, 10), x, plot.b + 34);
    }
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.l, plot.t, plot.w, plot.h);
  ctx.clip();

  if(state.range){
    ctx.fillStyle = '#43e4d812';
    ctx.fillRect(px(state.range[0]), plot.t, px(state.range[1]) - px(state.range[0]), plot.h);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#53b5a8';
    for(const t of state.range){
      ctx.beginPath();
      ctx.moveTo(px(t), plot.t);
      ctx.lineTo(px(t), plot.b);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  const hasActive = state.activeReportId !== null && state.files.some(f => f.id === state.activeReportId);
  const orderedVisible = hasActive
    ? [...visible.filter(s => s.f.id !== state.activeReportId), ...visible.filter(s => s.f.id === state.activeReportId)]
    : visible;

  for(const { f, c } of orderedVisible){
    const isActive = !hasActive || f.id === state.activeReportId;
    ctx.strokeStyle = c.color;
    ctx.lineWidth = isActive ? (hasActive ? 2.4 : 1.4) : 1.15;
    ctx.globalAlpha = isActive ? 1 : 0.22;
    ctx.beginPath();
    let started = false, bucket = -Infinity, group = [];
    const emit = (r) => {
      const x = px(xt(f, r)), y = py(val(f, c, r), c.axis);
      if(started) ctx.lineTo(x, y);
      else { ctx.moveTo(x, y); started = true; }
    };
    const flush = () => {
      if(!group.length) return;
      let a = group[0], b = a;
      for(const r of group){
        if(val(f, c, r) < val(f, c, a)) a = r;
        if(val(f, c, r) > val(f, c, b)) b = r;
      }
      const pts = [group[0], a, b, group.at(-1)].sort((a, b) => a.t - b.t || a.row - b.row);
      for(const r of [...new Set(pts)]) emit(r);
      group = [];
    };
    const from = state.view[0] + origin(f) - f.offset * 1000, to = state.view[1] + origin(f) - f.offset * 1000;
    const end = Math.min(f.rows.length, lower(f.rows, to) + 2);
    for(let i = Math.max(0, lower(f.rows, from) - 1); i < end; i++){
      const r = f.rows[i], v = val(f, c, r);
      if(v === null){ flush(); started = false; continue; }
      const x = Math.floor(px(xt(f, r)));
      if(x !== bucket){ flush(); bucket = x; }
      group.push(r);
    }
    flush();
    ctx.stroke();

    if(f.rows.length === 1 && val(f, c, f.rows[0]) !== null){
      ctx.fillStyle = c.color;
      ctx.beginPath();
      ctx.arc(px(xt(f, f.rows[0])), py(val(f, c, f.rows[0]), c.axis), isActive ? 3.5 : 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  if($('cursorToggle').checked){
    state.cursors.forEach((t, i) => {
      const x = px(t);
      const isDraggingThis = state.drag && state.drag.type === 'cursor' && state.drag.index === i;
      ctx.strokeStyle = i ? '#b59bff' : '#43e4d8';
      ctx.lineWidth = isDraggingThis ? 1.5 : 1;
      ctx.setLineDash(isDraggingThis ? [4, 2] : [5, 4]);
      ctx.beginPath();
      ctx.moveTo(x, plot.t);
      ctx.lineTo(x, plot.b);
      ctx.stroke();
      ctx.setLineDash([]);
      for(const { f, c } of visible){
        if(hasActive && f.id !== state.activeReportId) continue;
        const isActive = !hasActive || f.id === state.activeReportId;
        ctx.globalAlpha = isActive ? 1 : 0.22;
        const r = nearest(f, t), v = r ? val(f, c, r) : null;
        if(v !== null){
          const dotX = px(xt(f, r)), dotY = py(v, c.axis);
          ctx.beginPath();
          ctx.arc(dotX, dotY, isDraggingThis ? 4.5 : (isActive ? 3.2 : 2), 0, Math.PI * 2);
          ctx.fillStyle = c.color;
          ctx.fill();

          if(isDraggingThis){
            const text = fmt(v);
            ctx.font = 'bold 9.5px Consolas, monospace';
            const tw = ctx.measureText(text).width;
            const tagX = (dotX + 6 + tw + 8 > plot.r) ? dotX - tw - 12 : dotX + 6;
            ctx.fillStyle = '#0a1420f0';
            ctx.strokeStyle = c.color;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.roundRect(tagX, dotY - 9, tw + 8, 16, 3);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = '#e6fbf9';
            ctx.fillText(text, tagX + 4, dotY + 3);
          }
        }
      }
      ctx.globalAlpha = 1;
    });
  }

  if(state.hover !== null && !state.drag){
    ctx.strokeStyle = '#718aa177';
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(state.hover, plot.t);
    ctx.lineTo(state.hover, plot.b);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if(state.drag && ['zoom', 'range'].includes(state.drag.type)){
    const d = state.drag;
    ctx.fillStyle = d.type === 'range' ? '#43e4d81b' : '#72a9ff25';
    ctx.strokeStyle = d.type === 'range' ? '#43e4d8' : '#86b9ff';
    const top = d.type === 'range' ? plot.t : Math.min(d.sy, d.y), height = d.type === 'range' ? plot.h : Math.abs(d.y-d.sy);
    ctx.fillRect(Math.min(d.sx, d.x), top, Math.abs(d.x - d.sx), height);
    ctx.strokeRect(Math.min(d.sx, d.x), top, Math.abs(d.x - d.sx), height);
  }
  ctx.restore();

  if($('cursorToggle').checked){
    state.cursors.forEach((t, i) => {
      const x = px(t);
      if(x < plot.l || x > plot.r) return;
      const isDraggingThis = state.drag && state.drag.type === 'cursor' && state.drag.index === i;
      ctx.fillStyle = i ? '#b59bff' : '#43e4d8';
      ctx.beginPath();
      ctx.roundRect(x - 11, plot.t - 20, 22, 18, 3);
      ctx.fill();
      ctx.fillStyle = '#0b1520';
      ctx.textAlign = 'center';
      ctx.font = 'bold 11px Consolas';
      ctx.fillText(i ? 'B' : 'A', x, plot.t - 7);
      if(isDraggingThis){
        ctx.fillStyle = i ? '#b59bff' : '#43e4d8';
        ctx.font = 'bold 10px Consolas';
        ctx.fillText(timeText(t), x, plot.t - 24);
      }
      ctx.font = '10px Consolas';
    });
  }
}

function statsFor(f, c){
  let min = Infinity, max = -Infinity, minRow = null, maxRow = null, sum = 0, n = 0;
  for(const r of f.rows){
    const t = xt(f, r);
    if(state.range && (t < state.range[0] || t > state.range[1])) continue;
    const v = val(f, c, r);
    if(v === null) continue;
    sum += v;
    n++;
    if(v < min){ min = v; minRow = r; }
    if(v > max){ max = v; maxRow = r; }
  }
  return { f, c, min: n ? min : null, max: n ? max : null, mean: n ? sum / n : null, n, minRow, maxRow };
}

function updateReadouts(){
  const channels = selected();
  $('totalRows').textContent = state.files.length ? state.files.reduce((n, f) => n + f.rows.length, 0).toLocaleString() : '—';
  $('visibleChannels').textContent = state.files.length ? channels.length : '—';
  $('duration').textContent = state.view ? elapsed(state.view[1] - state.view[0]) : '—';
  $('rangeCaption').textContent = state.view ? (state.alignment === 'elapsed' ? '起始歸零' : '實際時間') + ' · ' + (state.scale === 'delta' ? '相對變化' : '原始數值') : '等待資料匯入';
  $('viewRange').textContent = state.view ? `${timeText(state.view[0])} → ${timeText(state.view[1])}` : '尚未載入資料';
  $('analysisState').textContent = state.range ? '已選取區間' : '全部資料';
  $('analysisCaption').textContent = state.range ? '統計範圍 ' + elapsed(state.range[1] - state.range[0], true) : '可框選區間進行統計';
  $('rangeBar').hidden = !state.range;
  if(state.range) $('rangeText').textContent = `選取：${timeText(state.range[0])} → ${timeText(state.range[1])}`;

  $('cursorATime').textContent = state.view ? timeText(state.cursors[0]) : '—';
  $('cursorBTime').textContent = state.view ? timeText(state.cursors[1]) : '—';
  $('cursorDelta').textContent = state.view ? elapsed(state.cursors[1] - state.cursors[0], true) : '—';

  if(state.statsDirty){
    state.stats = channels.map(({ f, c }) => statsFor(f, c));
    state.statsDirty = false;
  }

  // Build items with all calculated values for sorting and display
  const items = state.stats.map(s => {
    const { f, c } = s;
    const a = nearest(f, state.cursors[0]);
    const b = nearest(f, state.cursors[1]);
    const av = a ? val(f, c, a) : null;
    const bv = b ? val(f, c, b) : null;
    const delta = (av !== null && bv !== null) ? bv - av : null;
    return {
      s, f, c, a, b, av, bv, delta,
      min: s.min,
      max: s.max,
      mean: s.mean,
      n: s.n,
      minRow: s.minRow,
      maxRow: s.maxRow
    };
  });

  // Filter
  const filterKey = (state.tableFilter || '').toLowerCase();
  const filtered = filterKey
    ? items.filter(it => it.c.name.toLowerCase().includes(filterKey) || it.f.name.toLowerCase().includes(filterKey))
    : [...items];

  // Update filter count badge
  const filterBadge = $('tableFilterCount');
  if(filterBadge){
    if(filterKey){
      filterBadge.hidden = false;
      filterBadge.textContent = `顯示 ${filtered.length} / ${items.length} 訊號`;
    } else {
      filterBadge.hidden = true;
    }
  }

  // Sort
  const { col, dir } = state.tableSort;
  if(col && dir){
    filtered.sort((x, y) => {
      let vx = x[col];
      let vy = y[col];
      if(col === 'signal'){
        const sx = `${x.c.name} ${x.f.name}`;
        const sy = `${y.c.name} ${y.f.name}`;
        const cmp = sx.localeCompare(sy, 'zh-Hant');
        return dir === 'asc' ? cmp : -cmp;
      }
      // Numeric comparisons
      const xValid = typeof vx === 'number' && Number.isFinite(vx);
      const yValid = typeof vy === 'number' && Number.isFinite(vy);
      if(!xValid && !yValid) return 0;
      if(!xValid) return 1; // nulls always at bottom
      if(!yValid) return -1;
      return dir === 'asc' ? vx - vy : vy - vx;
    });
  }

  // Update table header sort indicators
  document.querySelectorAll('#statsTable th.sortable').forEach(th => {
    const c = th.dataset.col;
    const icon = th.querySelector('.sort-icon');
    const isSorted = col === c && dir !== null;
    th.classList.toggle('sorted-asc', isSorted && dir === 'asc');
    th.classList.toggle('sorted-desc', isSorted && dir === 'desc');
    th.setAttribute('aria-sort', isSorted ? (dir === 'asc' ? 'ascending' : 'descending') : 'none');
    if(icon){
      icon.textContent = isSorted ? (dir === 'asc' ? '▲' : '▼') : '⇅';
    }
  });

  // Update Sort Indicator Badge in toolbar
  const sortBadge = $('sortIndicatorBadge');
  if(sortBadge){
    if(col && dir){
      sortBadge.hidden = false;
      sortBadge.innerHTML = `已依「${esc(sortLabels[col] || col)}」${dir === 'asc' ? '升冪 ▲' : '降冪 ▼'} 排序 <button id="badgeResetSortBtn" class="text-btn" style="color:var(--cyan);margin-left:5px;font-weight:bold;" title="取消排序">×</button>`;
      const bBtn = $('badgeResetSortBtn');
      if(bBtn) bBtn.onclick = () => { state.tableSort = { col: null, dir: null }; updateReadouts(); };
    } else {
      sortBadge.hidden = true;
    }
  }

  // Render rows
  const cell = (f, c, r) => r ? `${fmt(val(f, c, r))}<small>${esc(dateText(r.t))}<br>原始列 ${r.row}</small>` : '—';
  const extremaCell = (f, c, r, valNum, cursorTarget) => {
    if(!r || valNum === null) return '—';
    const cursorName = cursorTarget === 'a' ? 'A' : 'B';
    return `<span class="jump-time" data-jump-cursor="${cursorTarget}" data-jump-t="${r.t}" data-jump-name="${esc(c.name)}" data-jump-val="${fmt(valNum)}" title="點擊將 ${cursorName} 標尺直接定位到此時間 (${dateText(r.t)})">${fmt(valNum)} <span class="jump-pin">⌖</span><small>${esc(dateText(r.t))}<br>原始列 ${r.row}</small></span>`;
  };

  const hasActive = state.activeReportId !== null && state.files.some(f => f.id === state.activeReportId);
  $('statsBody').innerHTML = filtered.map(it => {
    const { f, c, a, b, av, bv, delta, s } = it;
    const isOperating = hasActive && f.id === state.activeReportId;
    const isDimmed = hasActive && f.id !== state.activeReportId;
    const rowClass = isOperating ? 'row-active' : isDimmed ? 'row-dimmed' : '';
    return `<tr class="row-clickable ${rowClass}" data-report-id="${f.id}" title="點擊切換聚焦高亮此報表曲線">
      <td><i class="swatch" style="background:${c.color}"></i>${esc(c.name)}${isOperating ? ' <span class="badge-mini">操作中</span>' : ''} <small title="${esc(f.name)}">${esc(f.name)} · ${c.axis ? '右軸' : '左軸'} · 偏移 ${fmt(f.offset)} s</small></td>
      <td>${cell(f, c, a)}</td>
      <td>${cell(f, c, b)}</td>
      <td>${delta !== null ? fmt(delta) : '—'}</td>
      <td>${extremaCell(f, c, s.minRow, s.min, 'a')}</td>
      <td>${extremaCell(f, c, s.maxRow, s.max, 'b')}</td>
      <td>${fmt(s.mean)}</td>
      <td>${s.n.toLocaleString()}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="8" class="table-empty">${
    !state.files.length
      ? '匯入資料後，拖曳圖上標尺查看對應資料與原始列號。'
      : (filterKey ? '無符合搜尋條件的訊號，請嘗試不同關鍵字。' : '請勾選至少一個訊號通道。')
  }</td></tr>`;
}

function download(blob, name){
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function exportImage(){
  if(!state.view) return status('請先載入資料。', true);
  draw();
  const out = document.createElement('canvas'), dpr = window.devicePixelRatio || 1;
  out.width = canvas.width;
  out.height = canvas.height + Math.ceil((60 + selected().length * 18) * dpr);
  const c = out.getContext('2d');
  c.fillStyle = '#0c1520';
  c.fillRect(0, 0, out.width, out.height);
  c.drawImage(canvas, 0, 0);
  c.scale(dpr, dpr);
  c.fillStyle = '#bcd1df';
  c.font = '12px Segoe UI';
  c.fillText(`TrendAlign | ${state.alignment === 'elapsed' ? '起始歸零' : '實際時間'} | ${state.scale === 'delta' ? '相對變化' : '原始數值'} | ${timeText(state.view[0])} → ${timeText(state.view[1])}`, 20, H + 23);
  selected().forEach(({ f, c: ch }, i) => {
    c.fillStyle = ch.color;
    c.fillText(`${ch.name} · ${f.name} · ${ch.axis ? '右軸' : '左軸'} · 偏移 ${fmt(f.offset)} s`, 20, H + 48 + i * 18);
  });
  out.toBlob(b => download(b, 'TrendAlign-趨勢圖.png'));
}

function exportStats(){
  if(!state.files.length) return status('請先載入資料。', true);
  updateReadouts();
  const rows = [['來源', '訊號', '數值模式', '時間對齊', '偏移秒', '區間起', '區間迄', '最小值', '最小值原始時間', '最小值原始列', '最大值', '最大值原始時間', '最大值原始列', '平均值', '有效點數', 'A值', 'A原始時間', 'A原始列', 'B值', 'B原始時間', 'B原始列', 'B-A']];
  for(const s of state.stats){
    const { f, c } = s, a = nearest(f, state.cursors[0]), b = nearest(f, state.cursors[1]), av = a ? val(f, c, a) : null, bv = b ? val(f, c, b) : null;
    rows.push([f.name, c.name, state.scale, state.alignment, f.offset, state.range ? timeText(state.range[0]) : '全部', state.range ? timeText(state.range[1]) : '全部', s.min, s.minRow ? dateText(s.minRow.t) : '', s.minRow?.row, s.max, s.maxRow ? dateText(s.maxRow.t) : '', s.maxRow?.row, s.mean, s.n, av, a ? dateText(a.t) : '', a?.row, bv, b ? dateText(b.t) : '', b?.row, av !== null && bv !== null ? bv - av : null]);
  }
  const csv = rows.map(r => r.map(v => {
    let s = String(v ?? '');
    if(typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }).join(',')).join('\r\n');
  download(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }), 'TrendAlign-區間統計.csv');
}

function eventPoint(e){
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
const inside = p => p.x >= plot.l && p.x <= plot.r && p.y >= plot.t - 22 && p.y <= plot.b;

canvas.addEventListener('wheel', e => {
  if(!state.view || !inside(eventPoint(e))) return;
  e.preventDefault();
  $('hoverTip').hidden = true;
  const x = clampX(eventPoint(e).x), t = tx(x), span = state.view[1] - state.view[0], full = state.full[1] - state.full[0], newSpan = Math.max(1, Math.min(full * 20, span * Math.exp(Math.sign(e.deltaY) * .18))), r = (t - state.view[0]) / span;
  state.view = [t - newSpan * r, t + newSpan * (1 - r)];
  state.y = null;
  render();
}, { passive: false });

function hideHoverTip(){
  const tip = $('hoverTip');
  if(tip){
    tip.hidden = true;
    tip.style.display = 'none';
  }
}

const isCursorHit = (t, x, y) => {
  if(t === null || t === undefined) return false;
  const cx = px(t);
  const nearLine = Math.abs(cx - x) <= 18;
  const nearBadge = Math.abs(cx - x) <= 16 && y <= plot.t + 6;
  return nearLine || nearBadge;
};

function updateHoverTip(x, y, t, cursorIdx = -1){
  const tip = $('hoverTip');
  if(!tip || !state.view) return;
  const s = selected();
  const hasActive = state.activeReportId !== null && state.files.some(f => f.id === state.activeReportId);
  const activeFile = hasActive ? state.files.find(f => f.id === state.activeReportId) : null;

  // 選擇操作中的報表時，只顯示操作中報表的資料，其他的不用顯示
  let targetSignals = s;
  if(hasActive){
    targetSignals = s.filter(({ f }) => f.id === state.activeReportId);
  }

  let html = '';
  if(cursorIdx >= 0){
    const cursorName = cursorIdx === 0 ? 'A' : 'B';
    const cursorColor = cursorIdx === 0 ? '#43e4d8' : '#b59bff';
    const otherTime = state.cursors[cursorIdx === 0 ? 1 : 0];
    const isBoth = state.cursors[0] !== null && state.cursors[1] !== null;
    const deltaText = isBoth
      ? `<span style="color:#8ba4b9;font-size:9.5px;margin-left:auto;">Δt: ${elapsed(Math.abs(state.cursors[1] - state.cursors[0]), true)}</span>`
      : '';
    html += `<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;padding-bottom:4px;border-bottom:1px solid #3c536a;">
      <span style="background:${cursorColor};color:#0b1520;font-weight:700;padding:1px 6px;border-radius:3px;font-size:10px;">標尺 ${cursorName}</span>
      <strong>${esc(timeText(t))}</strong>
      ${deltaText}
    </div>`;
  } else {
    html += `<div style="margin-bottom:5px;padding-bottom:3px;border-bottom:1px solid #3c536a;"><strong>${esc(timeText(t))}</strong></div>`;
  }

  if(hasActive && activeFile){
    html += `<div style="font-size:10px;color:var(--cyan);margin-bottom:5px;display:flex;align-items:center;gap:4px;">
      <span style="background:rgba(67,228,216,0.18);padding:1px 5px;border-radius:3px;font-weight:600;">操作中</span>
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:210px;" title="${esc(activeFile.name)}">${esc(activeFile.name)}</span>
    </div>`;
  }

  if(targetSignals.length === 0){
    html += `<div style="color:#8ba4b9;font-size:10px;padding:4px 0;">${hasActive ? '操作中報表未勾選任何訊號通道' : '尚未選取任何通道'}</div>`;
  } else {
    const displaySignals = hasActive ? targetSignals : targetSignals.slice(0, 8);
    html += displaySignals.map(({ f, c }) => {
      const r = nearest(f, t);
      const valStr = r ? fmt(val(f, c, r)) : '—';
      const label = hasActive ? esc(c.name) : `${esc(c.name)} · #${f.id}`;
      return `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin:3px 0;">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px;"><span style="color:${c.color}">●</span> ${label}</span>
        <strong style="color:#e6fbf9;font-family:var(--mono);">${valStr}</strong>
      </div>`;
    }).join('');
    if(!hasActive && targetSignals.length > 8){
      html += `<div style="font-size:9px;color:#8ba4b9;margin-top:4px;">其他訊號請查看下方標尺表格</div>`;
    }
  }

  tip.innerHTML = html;
  tip.hidden = false;
  tip.style.display = 'block';
  tip.style.zIndex = '999';

  const tipW = tip.offsetWidth || 220;
  const tipH = tip.offsetHeight || 120;
  let left = x + 16;
  if(left + tipW > W - 10){
    left = Math.max(10, x - tipW - 16);
  }
  let top = Math.max(plot.t, Math.min(y - 20, H - tipH - 10));
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}

canvas.addEventListener('pointerdown', e => {
  if(e.button !== 0 || !state.view) return;
  const p = eventPoint(e);
  if(!inside(p)) return;
  $('contextMenu').hidden = true;
  canvas.focus();
  const x = clampX(p.x), y = Math.max(plot.t, Math.min(plot.b, p.y));
  let type = e.shiftKey ? 'pan' : state.mode, index = -1;
  if($('cursorToggle').checked){
    index = state.cursors.findIndex(t => isCursorHit(t, x, p.y));
    if(index >= 0) type = 'cursor';
  }
  if(type === 'cursor'){
    updateHoverTip(px(state.cursors[index]), y, state.cursors[index], index);
  } else {
    hideHoverTip();
  }
  const f = state.files.find(f => f.id === +$('movingFile').value);
  if(type === 'shift' && !f) return status('請選擇要移動的報表。', true);
  if(type === 'shift' && state.files.length > 1 && f.id === +$('referenceFile').value) return status('參考報表固定不動，請選擇另一份要移動的報表。', true);
  canvas.setPointerCapture(e.pointerId);
  state.drag = { type, index, sx: x, sy: y, x, y, view: [...state.view], yLimits: state.y.map(a => [...a]), file: f, offset: f?.offset };
});

canvas.addEventListener('pointermove', e => {
  if(!state.view) return;
  const p = eventPoint(e), d = state.drag;
  const x = clampX(p.x), y = Math.max(plot.t, Math.min(plot.b, p.y));
  if(d){
    d.x = x;
    d.y = y;
    if(d.type === 'cursor'){
      const curT = tx(x);
      state.cursors[d.index] = curT;
      updateHoverTip(x, y, curT, d.index);
    } else {
      hideHoverTip();
      if(d.type === 'pan'){
        const dt = (x - d.sx) / plot.w * (d.view[1] - d.view[0]);
        state.view = d.view.map(t => t - dt);
      } else if(d.type === 'shift'){
        d.file.offset = d.offset + (x - d.sx) / plot.w * (d.view[1] - d.view[0]) / 1000;
        const inp = document.querySelector(`[data-offset="${d.file.id}"]`);
        if(inp) inp.value = Math.round(d.file.offset * 1000) / 1000;
        state.statsDirty = true;
        state.full = bounds();
      }
    }
    render();
    return;
  }
  if(!inside(p)){
    hideHoverTip();
    state.hover = null;
    render();
    return;
  }
  state.hover = x;
  let cursorHitIdx = -1;
  if($('cursorToggle').checked){
    cursorHitIdx = state.cursors.findIndex(t => isCursorHit(t, x, p.y));
  }
  const cursorHit = cursorHitIdx >= 0;
  canvas.style.cursor = cursorHit ? 'ew-resize' : state.mode === 'pan' ? 'grab' : state.mode === 'shift' ? 'ew-resize' : 'crosshair';

  if(cursorHit){
    const cT = state.cursors[cursorHitIdx];
    updateHoverTip(px(cT), y, cT, cursorHitIdx);
  } else {
    updateHoverTip(x, y, tx(x), -1);
  }
  render();
});

function endDrag(e, cancel = false){
  const d = state.drag;
  if(!d) return;
  const wasCursor = d.type === 'cursor';
  const cursorIdx = d.index;
  const lastY = d.y;
  if(cancel){
    if(d.type === 'shift'){ d.file.offset = d.offset; rebuild(); state.statsDirty = true; }
    state.view = d.view;
    state.y = d.yLimits;
  } else if(Math.abs(d.x - d.sx) > 5){
    const a = tx(Math.min(d.sx, d.x)), b = tx(Math.max(d.sx, d.x));
    if(d.type === 'zoom'){
      if(Math.abs(d.y - d.sy) > 5){
        state.y = [0, 1].map(axis => [vy(Math.max(d.y, d.sy), axis), vy(Math.min(d.y, d.sy), axis)]);
      }
      state.view = [a, b];
    } else if(d.type === 'range'){
      state.range = [a, b];
      state.statsDirty = true;
    } else if(d.type === 'shift'){
      status(`已移動 ${d.file.name}；時間偏移 ${fmt(d.file.offset)} 秒。`);
    }
  }
  state.drag = null;
  state.full = bounds();
  if(canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  if(wasCursor && cursorIdx >= 0 && $('cursorToggle').checked){
    const cT = state.cursors[cursorIdx];
    updateHoverTip(px(cT), lastY, cT, cursorIdx);
  }
  render();
}

canvas.addEventListener('pointerup', e => endDrag(e));
canvas.addEventListener('pointercancel', e => endDrag(e, true));
canvas.addEventListener('pointerleave', () => { state.hover = null; $('hoverTip').hidden = true; render(); });
canvas.addEventListener('dblclick', reset);

canvas.addEventListener('keydown', e => {
  if(!state.view || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  e.preventDefault();
  let i = e.shiftKey ? 1 : 0;
  const f = state.files.find(f => f.id === +$('referenceFile').value) || state.files[0], target = state.cursors[i] + origin(f) - f.offset * 1000;
  let n = lower(f.rows, target);
  if(e.key === 'ArrowRight'){
    while(n < f.rows.length && f.rows[n].t <= target) n++;
  } else {
    n--;
    while(n >= 0 && f.rows[n].t >= target) n--;
  }
  n = Math.min(f.rows.length - 1, Math.max(0, n));
  state.cursors[i] = xt(f, f.rows[n]);
  if($('cursorToggle').checked){
    updateHoverTip(px(state.cursors[i]), plot.t + 30, state.cursors[i], i);
  }
  render();
});

canvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  const menu = $('contextMenu');
  menu.hidden = false;
  menu.style.left = Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 10) + 'px';
  menu.style.top = Math.max(5, Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 10) + 'px');
});

document.addEventListener('click', e => { if(!$('contextMenu').contains(e.target)) $('contextMenu').hidden = true; });
document.addEventListener('keydown', e => { if(e.key === 'Escape'){ $('contextMenu').hidden = true; } });

$('contextMenu').addEventListener('click', e => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  $('contextMenu').hidden = true;
  if(action === 'resetLayout'){ resetDefaultLayout(); return; }
  if(!state.view) return;
  if(action === 'reset') reset();
  if(action === 'fitY'){ state.y = null; render(); }
  if(action === 'range'){ state.range = [...state.view]; changed(); }
  if(action === 'clear'){ state.range = null; changed(); }
  if(action === 'image') exportImage();
});

for(const id of ['importBtn', 'dropZone']) $(id).onclick = () => $('fileInput').click();
$('fileInput').onchange = e => importFiles([...e.target.files]);

for(const name of ['dragenter', 'dragover']) $('dropZone').addEventListener(name, e => { e.preventDefault(); $('dropZone').classList.add('dragover'); });
$('dropZone').addEventListener('dragleave', () => $('dropZone').classList.remove('dragover'));
$('dropZone').addEventListener('drop', e => { e.preventDefault(); $('dropZone').classList.remove('dragover'); importFiles([...e.dataTransfer.files]); });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => e.preventDefault());

$('fileList').addEventListener('click', e => {
  const id = e.target.closest('[data-remove]')?.dataset.remove;
  if(!id){
    if(e.target.closest('input,label')) return;
    const card = e.target.closest('[data-report]');
    if(card) selectReport(card.dataset.report);
    return;
  }
  state.files = state.files.filter(f => f.id !== +id);
  if(state.activeReportId === +id) state.activeReportId = null;
  rebuild();
  state.range = null;
  reset();
});

$('fileList').addEventListener('change', e => {
  if(!e.target.matches('[data-offset]')) return;
  const n = Number(e.target.value);
  if(!Number.isFinite(n)) return;
  state.files.find(f => f.id === +e.target.dataset.offset).offset = n;
  state.range = null;
  changed(true);
});

$('channels').addEventListener('click', e => {
  const grp = e.target.closest('[data-group-report]');
  if(grp) selectReport(grp.dataset.groupReport);
});

$('channels').addEventListener('change', e => {
  const key = e.target.dataset.channel || e.target.dataset.axis;
  if(!key) return;
  const [id, i] = key.split(':').map(Number), c = state.files.find(f => f.id === id).channels[i];
  if(e.target.dataset.channel) c.visible = e.target.checked;
  else c.axis = +e.target.value;
  state.y = null;
  changed();
});

$('allChannels').onclick = () => {
  const all = state.files.flatMap(f => f.channels), on = all.some(c => !c.visible);
  all.forEach(c => c.visible = on);
  rebuild();
  state.y = null;
  changed();
};

$('clearBtn').onclick = () => {
  state.files = [];
  state.activeReportId = null;
  state.demo = false;
  state.range = null;
  state.cursors = [null, null];
  rebuild();
  reset();
  status('資料已清空，請匯入新檔案。');
};

$('alignment').onchange = e => {
  state.alignment = e.target.value;
  $('alignHint').textContent = state.alignment === 'elapsed' ? '每個檔案第一筆有效時間設為 00:00。' : '以報表中的原始日期時間作為基準。';
  state.range = null;
  reset();
};
$('scaleMode').onchange = e => {
  state.scale = e.target.value;
  state.y = null;
  changed();
};
$('modeButtons').onclick = e => {
  const b = e.target.closest('[data-mode]');
  if(b) setMode(b.dataset.mode);
};
$('referenceFile').onchange = commonSignals;
$('movingFile').onchange = () => {
  const val = +$('movingFile').value;
  if(val) selectReport(val, true);
};
$('moveReport').onclick = () => {
  const val = +$('movingFile').value;
  if(val) selectReport(val, true);
  setMode('shift');
};
$('autoAlign').onclick = autoAlign;
$('alignCursors').onclick = alignCursors;
$('resetOffsets').onclick = () => {
  state.files.forEach(f => f.offset = 0);
  rebuild();
  state.range = null;
  reset();
  status('已重設所有報表的時間偏移。');
};

/* Collapsible Tool Blocks click handling */
document.querySelectorAll('.panel-collapsible-header').forEach(hdr => {
  hdr.addEventListener('click', e => {
    if(e.target.closest('button:not(.panel-collapse-btn)')) return;
    const panelId = hdr.dataset.panel;
    if(panelId) togglePanel(panelId);
  });
});

/* Sidebar collapse buttons */
$('collapseSidebarBtn') && ($('collapseSidebarBtn').onclick = () => toggleSidebar(true));
$('expandSidebarBtn') && ($('expandSidebarBtn').onclick = () => toggleSidebar(false));
$('toggleWideBtn') && ($('toggleWideBtn').onclick = () => toggleSidebar());

window.addEventListener('keydown', e => {
  if(e.target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  if((e.altKey && (e.code === 'KeyS' || e.key === 's' || e.key === 'S')) || (e.key === '[' && !e.ctrlKey && !e.metaKey && !e.altKey)){
    e.preventDefault();
    toggleSidebar();
  }
});

/* Reset default layout buttons */
$('resetLayoutBtn') && ($('resetLayoutBtn').onclick = resetDefaultLayout);
$('resetLayoutChartBtn') && ($('resetLayoutChartBtn').onclick = resetDefaultLayout);

/* Table actions: search, clear, reset columns */
$('resetSortBtn') && ($('resetSortBtn').onclick = () => {
  state.tableSort = { col: null, dir: null };
  state.colWidths = [...DEFAULT_COL_WIDTHS];
  applyColWidths();
  state.tableFilter = '';
  if($('tableSearchInput')) $('tableSearchInput').value = '';
  if($('clearSearchBtn')) $('clearSearchBtn').hidden = true;
  try { localStorage.removeItem('agy_scope_col_widths'); } catch(e){}
  updateReadouts();
  status('已重設資料表排序、搜尋篩選與預設欄寬。');
});

$('tableSearchInput') && $('tableSearchInput').addEventListener('input', e => {
  state.tableFilter = e.target.value.trim().toLowerCase();
  $('clearSearchBtn').hidden = !state.tableFilter;
  updateReadouts();
});

$('clearSearchBtn') && $('clearSearchBtn').addEventListener('click', () => {
  $('tableSearchInput').value = '';
  state.tableFilter = '';
  $('clearSearchBtn').hidden = true;
  updateReadouts();
  $('tableSearchInput').focus();
});

/* Click events on stats table body: row focus, cursor jump on extrema */
$('statsBody').addEventListener('click', e => {
  const jumpEl = e.target.closest('[data-jump-cursor]');
  if(jumpEl){
    e.stopPropagation();
    const cursorIdx = jumpEl.dataset.jumpCursor === 'b' ? 1 : 0;
    const t = +jumpEl.dataset.jumpT;
    const name = jumpEl.dataset.jumpName;
    const valStr = jumpEl.dataset.jumpVal;
    if(Number.isFinite(t)){
      state.cursors[cursorIdx] = t;
      render();
      status(`● 已將 ${cursorIdx ? 'B' : 'A'} 標尺快速定位至「${name}」極值 (${valStr}) 發生時間：${dateText(t)}。`);
    }
    return;
  }
  const row = e.target.closest('tr[data-report-id]');
  if(row){
    const reportId = +row.dataset.reportId;
    if(reportId) selectReport(reportId);
  }
});

/* Standard buttons & controls */
$('resetBtn').onclick = reset;
$('cursorToggle').onchange = render;
$('clearRange').onclick = () => { state.range = null; changed(); };
$('exportImage').onclick = exportImage;
$('exportStats').onclick = exportStats;
$('helpBtn').onclick = () => $('helpDialog').showModal();
$('closeHelp').onclick = () => $('helpDialog').close();

$('demoBtn').onclick = () => {
  const matrices = [0, 1].map(k => {
    const m = [['日期/時間', '速度', '入口側-後', '入口側-前', '出口側-後', '出口側-前']];
    for(let i = 0; i < 1200; i++){
      const t = i - k * 95, v = Math.max(0, Math.min(300, t - 180, 1040 - t)) * Math.sin(Math.max(0, Math.min(1, (t - 100) / 100)) * Math.PI / 2);
      m.push([new Date(2026, 7, 19 + k, 11, 3, i), v, 87.5 + Math.sin(t / 65) * .7 + (v / 300) * 1.2, 86.8 + Math.sin(t / 65 + .3) * .6 + (v / 300), 88 + Math.sin(t / 90) * .4 + (v / 300) * .9, 85.6 + Math.sin(t / 90 + .4) * .4 + (v / 300) * 1.1]);
    }
    return m;
  });
  state.files = matrices.map((m, i) => makeDataset(m, `示範測試 ${i ? 'B' : 'A'}（合成訊號）`));
  state.demo = true;
  state.range = null;
  rebuild();
  reset();
  status('已載入兩份合成示範資料，可嘗試以「速度／最明顯上升沿」自動對齊。這些不是實際報表數據。');
};

// Restore persisted layout states
try {
  if(localStorage.getItem('agy_scope_sidebar_collapsed') === '1') toggleSidebar(true);

  const savedW = localStorage.getItem('agy_scope_sidebar_width');
  if(savedW) document.documentElement.style.setProperty('--sidebar-w', savedW);

  ['files', 'alignment', 'channels'].forEach(p => {
    if(localStorage.getItem(`agy_scope_panel_${p}_collapsed`) === '1'){
      togglePanel(p, true);
    }
  });

  ['panelBodyFiles', 'panelBodyAlignment', 'channels'].forEach(id => {
    const savedH = localStorage.getItem(`agy_scope_panel_h_${id}`);
    const el = $(id);
    if(savedH && el) el.style.maxHeight = savedH;
  });

  const savedChartH = localStorage.getItem('agy_scope_chart_height');
  if(savedChartH && $('chartWrap')) $('chartWrap').style.height = savedChartH;

  const savedTableH = localStorage.getItem('agy_scope_table_height');
  if(savedTableH && $('tableScroll')) $('tableScroll').style.maxHeight = savedTableH;

  const savedColW = localStorage.getItem('agy_scope_col_widths');
  if(savedColW){
    const parsed = JSON.parse(savedColW);
    if(Array.isArray(parsed) && parsed.length >= DEFAULT_COL_WIDTHS.length) state.colWidths = parsed;
  }
} catch(e){}

new ResizeObserver(resize).observe($('chartWrap'));
rebuild();
initColResizing();
initColSorting();
initLayoutResizing();
applyColWidths();
setMode('zoom');
})();