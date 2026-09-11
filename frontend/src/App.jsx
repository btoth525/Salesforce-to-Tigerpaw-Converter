import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';

const STAGES = { IDLE: 'idle', LOADING: 'loading', PREVIEW: 'preview', BATCH: 'batch', DONE: 'done' };

// --- Output options (v2) ----------------------------------------------------
// Sent with every preview / convert request. Persisted per browser.
const OPTIONS_KEY = 'csv-forge-options';
const DEFAULT_OPTIONS = {
  asciiOnly: true,
  bom: true,
  quoteAll: false,
  keepExtras: true,
  groupAsPhase: false,
};
const OPTION_META = [
  { key: 'asciiOnly', label: 'Plain ASCII text (recommended)', hint: 'Smart quotes, dashes, symbols and accents become plain characters so nothing turns into “Ã¢â‚¬â„¢” garbage in Tigerpaw.' },
  { key: 'bom', label: 'UTF-8 BOM for Excel', hint: 'Adds the byte-order mark Excel expects. Turn off for a bare ANSI/ASCII file.' },
  { key: 'quoteAll', label: 'Quote every field', hint: 'Wrap every cell in double quotes (Salesforce style) instead of only the cells that need it.' },
  { key: 'keepExtras', label: 'Keep extra Salesforce columns', hint: 'Append unmapped source columns (Quote Number, Group Name…) after the Tigerpaw columns.' },
  { key: 'groupAsPhase', label: 'Use quote-line Group as Project Phase', hint: 'Copy the Salesforce “Group: Group Name” column into the Tigerpaw Project Phase column.' },
];

function loadOptions() {
  try {
    const raw = localStorage.getItem(OPTIONS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const out = { ...DEFAULT_OPTIONS };
    for (const k of Object.keys(DEFAULT_OPTIONS)) {
      if (typeof parsed?.[k] === 'boolean') out[k] = parsed[k];
    }
    return out;
  } catch {
    return { ...DEFAULT_OPTIONS };
  }
}

function saveOptions(opts) {
  try { localStorage.setItem(OPTIONS_KEY, JSON.stringify(opts)); } catch { /* ignore */ }
}

function appendOptions(fd, opts) {
  for (const k of Object.keys(DEFAULT_OPTIONS)) fd.append(k, String(!!opts?.[k]));
  return fd;
}

// Parse the X-Convert-Summary header the backend sets on CSV downloads.
function readSummary(res) {
  try {
    const raw = res.headers.get('X-Convert-Summary');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function summaryText(name, summary) {
  const parts = [`Downloaded ${name}`];
  if (!summary) return parts[0];
  if (typeof summary.rows === 'number') parts.push(`${summary.rows.toLocaleString()} row${summary.rows === 1 ? '' : 's'}`);
  if (summary.changes > 0) parts.push(`${summary.changes.toLocaleString()} cell${summary.changes === 1 ? '' : 's'} fixed`);
  if (summary.skipped > 0) parts.push(`${summary.skipped.toLocaleString()} row${summary.skipped === 1 ? '' : 's'} dropped`);
  return parts.join(' · ');
}

const CHANGE_KIND_LABELS = {
  mojibake: 'Mojibake repaired',
  punctuation: 'Smart punctuation',
  control: 'Control chars removed',
  linebreak: 'Line break removed',
  whitespace: 'Whitespace trimmed',
  number: 'Number cleaned',
  non_ascii: 'Non-ASCII replaced',
};
const SKIP_REASON_LABELS = {
  blank: 'Blank row',
  footer: 'Salesforce footer',
  totals: 'Totals row',
  preamble: 'Title/preamble line',
};
const labelKind = (k) => CHANGE_KIND_LABELS[k] || (k ? String(k).replace(/_/g, ' ') : 'Changed');
const labelReason = (r) => SKIP_REASON_LABELS[r] || (r ? String(r).replace(/_/g, ' ') : 'Dropped');

// Tigerpaw columns that hold numbers — right-aligned with tabular digits.
const NUMERIC_COLUMNS = new Set(['Quantity', 'Price', 'Cost', 'Total Price', 'List Price']);
const PAGE_SIZE = 100;

// Uncapped totals (v2.1 backend) with a fallback to the capped list length so
// an older backend still renders sensible counts.
const totalChanges = (p) => (typeof p?.changesTotal === 'number' ? p.changesTotal : (p?.changes || []).length);
const totalWarnings = (p) => (typeof p?.warningsTotal === 'number' ? p.warningsTotal : (p?.warnings || []).length);

const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

// The Transformation card is useful the first couple of times, then it is
// the same static block on every file — collapse it after that.
const MAPPING_OPEN_KEY = 'csv-forge-mapping-open';
function readMappingOpen() {
  try {
    const raw = localStorage.getItem(MAPPING_OPEN_KEY);
    if (raw === 'true' || raw === 'false') return raw === 'true';
    const seen = parseInt(raw || '0', 10) || 0;
    localStorage.setItem(MAPPING_OPEN_KEY, String(seen + 1));
    return seen < 2;
  } catch {
    return true;
  }
}
function writeMappingOpen(v) {
  try { localStorage.setItem(MAPPING_OPEN_KEY, v ? 'true' : 'false'); } catch { /* ignore */ }
}

// --- Error boundary ---------------------------------------------------------
// Catches render/commit errors anywhere in the tree so a crash shows a helpful
// fallback instead of a blank page.
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    // Log to console; in a bigger app this would hit Sentry or similar.
    console.error('UI crash', error, info);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash">
        <div className="crash-card">
          <div className="crash-title">Something went wrong rendering the app.</div>
          <pre className="crash-msg">{String(this.state.error?.message || this.state.error)}</pre>
          <button className="btn primary" onClick={() => location.reload()}>Reload</button>
        </div>
      </div>
    );
  }
}

// --- Focus trap -------------------------------------------------------------
// Keeps Tab / Shift+Tab inside a container so keyboard users can't escape a
// modal. Also focuses the first tabbable child on mount.
function useFocusTrap(active) {
  const ref = useRef(null);
  useEffect(() => {
    if (!active || !ref.current) return;
    const root = ref.current;
    const sel = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusables = () => Array.from(root.querySelectorAll(sel)).filter((el) => !el.hasAttribute('hidden'));

    const prev = document.activeElement;
    const first = focusables()[0];
    first?.focus();

    const onKey = (e) => {
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    root.addEventListener('keydown', onKey);
    return () => {
      root.removeEventListener('keydown', onKey);
      if (prev && prev.focus) prev.focus();
    };
  }, [active]);
  return ref;
}

// --- Toast system (lifted here to avoid a provider; single user of the app) -
let toastId = 0;

function useToasts() {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((type, message, timeout = 4200) => {
    const id = ++toastId;
    setToasts((t) => [...t, { id, type, message }]);
    if (timeout) setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), timeout);
  }, []);
  const dismiss = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  return { toasts, push, dismiss };
}

// --- Count-up hook for the stat cards ---------------------------------------
function useCountUp(target, duration = 650) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (typeof target !== 'number') { setValue(target); return; }
    if (target === 0) { setValue(0); return; }
    const start = performance.now();
    let raf;
    const tick = (t) => {
      const elapsed = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - elapsed, 3);  // easeOutCubic
      setValue(Math.round(target * eased));
      if (elapsed < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return value;
}

// --- Programmatically open a file picker (used by the command palette) ------
function openFilePicker(onFiles) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv,text/csv';
  input.multiple = true;
  input.onchange = (e) => onFiles(e.target.files);
  input.click();
}

// --- Identity ---------------------------------------------------------------
// `apiFetch` wraps fetch() to attach the current user's name as a header on
// every request. Backend uses it to track who did what.

const USER_KEY = 'csv-forge-user';
const RESET_KEY = 'csv-forge-reset-at';

function getUserName() {
  try { return localStorage.getItem(USER_KEY) || ''; } catch { return ''; }
}

function setUserName(name) {
  try {
    if (name) localStorage.setItem(USER_KEY, name);
    else localStorage.removeItem(USER_KEY);
  } catch { /* ignore quota / private mode */ }
}

function getStoredResetAt() {
  try { return localStorage.getItem(RESET_KEY) || ''; } catch { return ''; }
}
function setStoredResetAt(v) {
  try { if (v) localStorage.setItem(RESET_KEY, v); } catch { /* ignore */ }
}

async function apiFetch(url, opts = {}) {
  const headers = new Headers(opts.headers || {});
  const name = getUserName();
  if (name) headers.set('X-User-Name', name);
  return fetch(url, { ...opts, headers });
}

function App() {
  const [stage, setStage] = useState(STAGES.IDLE);
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [batchFiles, setBatchFiles] = useState([]);
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');
  const [tab, setTab] = useState('converted');
  const [query, setQuery] = useState('');
  const [showConfetti, setShowConfetti] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showCmd, setShowCmd] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [editedRows, setEditedRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [userName, setUserNameState] = useState(() => getUserName());
  const [showNamePrompt, setShowNamePrompt] = useState(() => !getUserName());
  const [nameError, setNameError] = useState('');
  const [showFeedback, setShowFeedback] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const [options, setOptions] = useState(() => loadOptions());
  const [appVersion, setAppVersion] = useState('');
  // Last produced download — lets the success card re-download / copy it.
  const [lastResult, setLastResult] = useState(null); // { blob, name, summary, kind: 'csv'|'zip' }
  const { toasts, push: pushToast, dismiss: dismissToast } = useToasts();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
  }, [theme]);

  useEffect(() => { saveOptions(options); }, [options]);

  // Version badge for the footer — fetched once.
  useEffect(() => {
    let alive = true;
    fetch('/api/health')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d?.version) setAppVersion(String(d.version)); })
      .catch(() => { /* footer falls back to a default */ });
    return () => { alive = false; };
  }, []);

  const setOption = useCallback((key, value) => {
    setOptions((prev) => ({ ...prev, [key]: !!value }));
  }, []);

  // Watch for an admin-initiated full reset. The server bumps `resetAt` in
  // /api/public-stats when an admin clicks "Reset data"; when we see a newer
  // timestamp than we've recorded, we clear local identity and force the
  // name modal. Runs on mount and every 30s while the tab is open.
  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const res = await fetch('/api/public-stats');
        if (!res.ok || !alive) return;
        const data = await res.json();
        const serverResetAt = data.resetAt || '';
        if (!serverResetAt) return;
        const stored = getStoredResetAt();
        if (!stored) {
          // First visit — just record the baseline so future bumps trigger.
          setStoredResetAt(serverResetAt);
          return;
        }
        if (serverResetAt > stored) {
          setStoredResetAt(serverResetAt);
          setUserName('');
          setUserNameState('');
          sessionStorage.removeItem('csv-forge-identified');
          setShowNamePrompt(true);
          pushToast('info', 'Admin reset all data — please enter your name again.');
        }
      } catch { /* network blip — try again next tick */ }
    };
    check();
    const t = setInterval(check, 30000);
    return () => { alive = false; clearInterval(t); };
  }, [pushToast]);

  // Identify the user with the server — validates the name and records
  // the first-visit event. Errors keep the modal open.
  const saveUserName = useCallback(async (name) => {
    const cleaned = (name || '').trim();
    setNameError('');
    try {
      const firstTime = !sessionStorage.getItem('csv-forge-identified');
      const res = await fetch('/api/identify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Name': cleaned },
        body: JSON.stringify({ name: cleaned, firstTime }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNameError(body.error || 'Please enter your name.');
        return;
      }
      setUserName(cleaned);
      setUserNameState(cleaned);
      setShowNamePrompt(false);
      sessionStorage.setItem('csv-forge-identified', '1');
      pushToast('success', `Hi, ${cleaned}!`);
    } catch {
      setNameError('Network error — try again.');
    }
  }, [pushToast]);

  const reset = useCallback(() => {
    setStage(STAGES.IDLE);
    setFile(null);
    setPreview(null);
    setBatchFiles([]);
    setQuery('');
    setEditedRows(null);
    setLastResult(null);
  }, []);

  // `silent` re-runs the preview in place (used when an output option changes)
  // without flashing the skeleton or re-warning about truncation.
  const loadPreview = useCallback(async (f, { silent = false, opts } = {}) => {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith('.csv')) {
      pushToast('error', 'Only .csv files are supported.');
      return;
    }
    setFile(f);
    if (!silent) setStage(STAGES.LOADING);
    try {
      const fd = new FormData();
      fd.append('file', f);
      appendOptions(fd, opts || options);
      const res = await apiFetch('/api/preview', { method: 'POST', body: fd });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Preview failed.');
      setPreview(body);
      setEditedRows((body.transformedPreview || []).map((r) => ({ ...r })));
      setStage(STAGES.PREVIEW);
      if (body.truncated && !silent) {
        const cap = body.previewLimit ? ` > ${body.previewLimit.toLocaleString()} preview cap` : ' > preview cap';
        pushToast('warn', `Large file — editing disabled (${(body.rowCount ?? 0).toLocaleString()} rows${cap}).`);
      }
    } catch (e) {
      pushToast('error', e.message);
      if (!silent) setStage(STAGES.IDLE);
    }
  }, [pushToast, options]);

  // Changing an output option while previewing re-runs the preview so the
  // Cleanup card and converted table reflect the new settings.
  const optionsRef = useRef(options);
  useEffect(() => {
    const prev = optionsRef.current;
    optionsRef.current = options;
    if (prev === options) return;
    if (stage === STAGES.PREVIEW && file) loadPreview(file, { silent: true, opts: options });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options]);

  // Entry point from drop / picker / paste — branches single vs batch.
  const handleFiles = useCallback((fileList) => {
    const arr = Array.from(fileList || []).filter((f) => f && f.name);
    if (arr.length === 0) return;
    const csvs = arr.filter((f) => f.name.toLowerCase().endsWith('.csv'));
    if (csvs.length === 0) {
      pushToast('error', 'Only .csv files are supported.');
      return;
    }
    if (csvs.length < arr.length) {
      pushToast('warn', `Skipped ${arr.length - csvs.length} non-CSV file(s).`);
    }
    if (csvs.length === 1) {
      loadPreview(csvs[0]);
    } else {
      setBatchFiles(csvs);
      setStage(STAGES.BATCH);
    }
  }, [loadPreview, pushToast]);

  const dirty = useMemo(() => {
    if (!preview || !editedRows) return false;
    if (editedRows.length !== preview.transformedPreview.length) return true;
    for (let i = 0; i < editedRows.length; i++) {
      const a = editedRows[i];
      const b = preview.transformedPreview[i];
      for (const c of preview.transformedColumns) {
        if ((a?.[c] ?? '') !== (b?.[c] ?? '')) return true;
      }
    }
    return false;
  }, [editedRows, preview]);

  const setCell = useCallback((rowIdx, col, value) => {
    setEditedRows((prev) => {
      if (!prev) return prev;
      const next = prev.slice();
      next[rowIdx] = { ...next[rowIdx], [col]: value };
      return next;
    });
  }, []);

  const revertEdits = useCallback(() => {
    if (!preview) return;
    setEditedRows(preview.transformedPreview.map((r) => ({ ...r })));
    pushToast('info', 'Edits reverted.');
  }, [preview, pushToast]);

  const finishConvert = useCallback((message) => {
    setStage(STAGES.DONE);
    setShowConfetti(true);
    setTimeout(() => setShowConfetti(false), 2400);
    pushToast('success', message);
  }, [pushToast]);

  const doConvert = useCallback(async () => {
    if (!file || busy) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      appendOptions(fd, options);
      const res = await apiFetch('/api/convert', { method: 'POST', body: fd });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Conversion failed.');
      }
      const summary = readSummary(res);
      const blob = await res.blob();
      const outName = file.name.replace(/\.csv$/i, '_converted.csv');
      triggerDownload(blob, outName);
      setLastResult({ blob, name: outName, summary, kind: 'csv' });
      finishConvert(summaryText(outName, summary));
    } catch (e) {
      pushToast('error', e.message);
    } finally {
      setBusy(false);
    }
  }, [file, busy, options, finishConvert, pushToast]);

  // Apply user edits by POSTing the already-transformed JSON to the backend.
  const doConvertEdited = useCallback(async () => {
    if (!file || !preview || !editedRows || busy) return;
    setBusy(true);
    try {
      const outName = file.name.replace(/\.csv$/i, '_edited.csv');
      const res = await apiFetch('/api/convert-edited', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: outName,
          columns: preview.transformedColumns,
          rows: editedRows,
          options,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Conversion failed.');
      }
      const summary = readSummary(res);
      const blob = await res.blob();
      triggerDownload(blob, outName);
      setLastResult({ blob, name: outName, summary, kind: 'csv' });
      finishConvert(summaryText(outName, summary));
    } catch (e) {
      pushToast('error', e.message);
    } finally {
      setBusy(false);
    }
  }, [file, preview, editedRows, busy, options, finishConvert, pushToast]);

  const doConvertBatch = useCallback(async () => {
    if (batchFiles.length === 0 || busy) return;
    setBusy(true);
    try {
      const fd = new FormData();
      for (const f of batchFiles) fd.append('files', f);
      appendOptions(fd, options);
      const res = await apiFetch('/api/convert-batch', { method: 'POST', body: fd });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Batch conversion failed.');
      }
      const summary = res.headers.get('X-Batch-Summary') || `${batchFiles.length} files`;
      const blob = await res.blob();
      triggerDownload(blob, 'converted_batch.zip');
      setLastResult({ blob, name: 'converted_batch.zip', summary: { batch: summary }, kind: 'zip' });
      finishConvert(`Batch complete — ${summary} · _report.txt inside the ZIP lists what was fixed per file`);
    } catch (e) {
      pushToast('error', e.message);
    } finally {
      setBusy(false);
    }
  }, [batchFiles, busy, options, finishConvert, pushToast]);

  useEffect(() => {
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      const target = e.target;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');

      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setShowCmd((v) => !v);
        return;
      }
      if (mod && e.key === 'Enter' && (stage === STAGES.PREVIEW || stage === STAGES.BATCH)) {
        e.preventDefault();
        if (stage === STAGES.PREVIEW) (dirty ? doConvertEdited() : doConvert());
        else doConvertBatch();
      }
      if (e.key === 'Escape') {
        if (showCmd) setShowCmd(false);
        else if (showOptions) setShowOptions(false);
        else if (showHelp) setShowHelp(false);
        else if (stage !== STAGES.IDLE) reset();
      }
      if (!typing && !showCmd && (e.key === '?' || (e.shiftKey && e.key === '/'))) {
        e.preventDefault();
        setShowHelp((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doConvert, doConvertEdited, doConvertBatch, reset, stage, showHelp, showCmd, showOptions, dirty]);

  // Global drag overlay — a translucent "drop anywhere to upload" veil.
  useEffect(() => {
    let dragDepth = 0;
    const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');

    const onEnter = (e) => {
      if (!hasFiles(e)) return;
      dragDepth += 1;
      setDragActive(true);
    };
    const onLeave = () => {
      dragDepth -= 1;
      if (dragDepth <= 0) { dragDepth = 0; setDragActive(false); }
    };
    const onOver = (e) => { if (hasFiles(e)) e.preventDefault(); };
    const onDrop = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      setDragActive(false);
      if (stage === STAGES.IDLE) handleFiles(e.dataTransfer.files);
    };

    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [handleFiles, stage]);

  // Paste-anywhere — paste a CSV file (or raw CSV text) from the clipboard.
  useEffect(() => {
    const onPaste = (e) => {
      if (stage !== STAGES.IDLE || showCmd || showHelp) return;
      const items = e.clipboardData?.items || [];
      const files = [];
      for (const it of items) {
        if (it.kind === 'file') {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) { handleFiles(files); return; }
      const text = e.clipboardData?.getData('text');
      if (text && text.includes(',') && text.includes('\n')) {
        const blob = new Blob([text], { type: 'text/csv' });
        handleFiles([new File([blob], 'pasted.csv', { type: 'text/csv' })]);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [handleFiles, stage, showCmd, showHelp]);

  // Build the command palette action list contextually.
  const commands = useMemo(() => {
    const cmds = [];
    cmds.push({
      id: 'theme',
      title: theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
      group: 'Theme',
      keywords: 'dark light mode',
      perform: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
    });
    cmds.push({
      id: 'help',
      title: 'Show keyboard shortcuts',
      hint: '?',
      group: 'Help',
      keywords: 'keys help',
      perform: () => setShowHelp(true),
    });
    cmds.push({
      id: 'name',
      title: userName ? `Change name (currently: ${userName})` : 'Set your name',
      group: 'Profile',
      keywords: 'identity user who me',
      perform: () => setShowNamePrompt(true),
    });
    cmds.push({
      id: 'feedback',
      title: 'Send feedback (suggestion or issue)',
      group: 'Feedback',
      keywords: 'bug report suggest improvement idea problem',
      perform: () => setShowFeedback(true),
    });
    cmds.push({
      id: 'options',
      title: 'Output options (encoding, quoting, extra columns)',
      group: 'Options',
      keywords: 'settings ascii bom utf-8 quote quotes extra columns group phase encoding',
      perform: () => setShowOptions(true),
    });
    for (const m of OPTION_META) {
      const on = !!options[m.key];
      cmds.push({
        id: `opt-${m.key}`,
        title: `${on ? 'Disable' : 'Enable'}: ${m.label}`,
        group: 'Options',
        keywords: `toggle option ${m.key} ${m.label}`,
        perform: () => setOption(m.key, !on),
      });
    }
    if (stage === STAGES.IDLE) {
      cmds.push({
        id: 'browse',
        title: 'Browse for files…',
        group: 'File',
        keywords: 'upload open pick',
        perform: () => openFilePicker(handleFiles),
      });
    }
    if (stage === STAGES.PREVIEW) {
      cmds.push({
        id: 'download',
        title: dirty ? 'Download as-is (discard edits)' : 'Download converted CSV',
        hint: '⌘↵',
        group: 'Download',
        perform: doConvert,
      });
      if (dirty) {
        cmds.push({
          id: 'download-edited',
          title: 'Download edited CSV',
          group: 'Download',
          keywords: 'save export changes',
          perform: doConvertEdited,
        });
        cmds.push({
          id: 'revert',
          title: 'Revert all edits',
          group: 'Edit',
          keywords: 'undo reset',
          perform: revertEdits,
        });
      }
      cmds.push({
        id: 'tab-converted',
        title: 'Show Converted table',
        group: 'View',
        perform: () => setTab('converted'),
      });
      cmds.push({
        id: 'tab-original',
        title: 'Show Original table',
        group: 'View',
        perform: () => setTab('original'),
      });
      if (query) {
        cmds.push({
          id: 'clear-filter',
          title: 'Clear row filter',
          group: 'View',
          perform: () => setQuery(''),
        });
      }
      cmds.push({
        id: 'remove',
        title: 'Remove file and start over',
        hint: 'Esc',
        group: 'File',
        perform: reset,
      });
    }
    if (stage === STAGES.BATCH) {
      cmds.push({
        id: 'batch-convert',
        title: 'Convert all → download ZIP',
        hint: '⌘↵',
        group: 'Download',
        perform: doConvertBatch,
      });
      cmds.push({
        id: 'batch-reset',
        title: 'Clear all files',
        hint: 'Esc',
        group: 'File',
        perform: reset,
      });
    }
    if (stage === STAGES.DONE) {
      cmds.push({
        id: 'again',
        title: 'Convert another',
        hint: 'Esc',
        group: 'Action',
        perform: reset,
      });
    }
    return cmds;
  }, [theme, stage, dirty, query, userName, options, setOption, handleFiles, doConvert, doConvertEdited, doConvertBatch, revertEdits, reset]);

  return (
    <div className="app" data-stage={stage}>
      <Aurora />
      <TopBar
        theme={theme}
        onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        onHelp={() => setShowHelp(true)}
        onCmd={() => setShowCmd(true)}
        onOptions={() => setShowOptions(true)}
        optionsDirty={Object.keys(DEFAULT_OPTIONS).some((k) => options[k] !== DEFAULT_OPTIONS[k])}
        userName={userName}
        onChangeName={() => setShowNamePrompt(true)}
      />
      <main className="shell">
        <header className="hero">
          <h1 className="title">
            <span className="tag">Salesforce</span>
            <ArrowIcon />
            <span className="tag alt">Tigerpaw</span>
          </h1>
          <p className="subtitle">Drop a CSV. Preview the transform. Download in one click.</p>
        </header>

        <div className="stage-wrap" key={stage}>
          {stage === STAGES.IDLE && (
            <>
              <HeroStats />
              <DropZone onFiles={handleFiles} />
              <ExportHelp />
              <TeamWall currentUser={userName} pushToast={pushToast} />
            </>
          )}
          {stage === STAGES.LOADING && <Skeleton filename={file?.name} />}
          {stage === STAGES.BATCH && (
            <BatchPanel
              files={batchFiles}
              busy={busy}
              onConvert={doConvertBatch}
              onReset={reset}
              onRemove={(idx) => {
                const next = batchFiles.filter((_, i) => i !== idx);
                if (next.length === 0) reset();
                else if (next.length === 1) loadPreview(next[0]);
                else setBatchFiles(next);
              }}
            />
          )}
          {stage === STAGES.PREVIEW && preview && editedRows && (
            <PreviewPanel
              file={file}
              preview={preview}
              editedRows={editedRows}
              setCell={setCell}
              dirty={dirty}
              busy={busy}
              onRevert={revertEdits}
              tab={tab}
              setTab={setTab}
              query={query}
              setQuery={setQuery}
              onConvert={doConvert}
              onConvertEdited={doConvertEdited}
              onReset={reset}
            />
          )}
          {stage === STAGES.DONE && (
            <SuccessCard
              filename={file?.name || (batchFiles.length ? `${batchFiles.length} files` : '')}
              result={lastResult}
              onAgain={reset}
              pushToast={pushToast}
            />
          )}
        </div>
      </main>
      <Footer version={appVersion} />
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
      {showConfetti && <Confetti />}
      {showHelp && <HelpOverlay onClose={() => setShowHelp(false)} />}
      {showOptions && (
        <OptionsModal
          options={options}
          onChange={setOption}
          onReset={() => setOptions({ ...DEFAULT_OPTIONS })}
          onClose={() => setShowOptions(false)}
          livePreview={stage === STAGES.PREVIEW}
        />
      )}
      {showCmd && <CommandPalette commands={commands} onClose={() => setShowCmd(false)} />}
      {dragActive && <DragVeil active={stage === STAGES.IDLE} />}
      {userName && !showNamePrompt && (
        <FeedbackFab onOpen={() => setShowFeedback(true)} />
      )}
      {showFeedback && (
        <FeedbackModal
          onClose={() => setShowFeedback(false)}
          pushToast={pushToast}
        />
      )}
      {showNamePrompt && (
        <NameModal
          initialValue={userName}
          allowCancel={!!userName}
          error={nameError}
          onSave={saveUserName}
          onCancel={() => { setShowNamePrompt(false); setNameError(''); }}
        />
      )}
    </div>
  );
}

function TopBar({ theme, onToggleTheme, onHelp, onCmd, onOptions, optionsDirty, userName, onChangeName }) {
  return (
    <div className="topbar">
      <div className="brand">
        <img src="/favicon.png" alt="" className="brand-logo" />
        <span>CSV Forge</span>
      </div>
      <div className="topbar-actions">
        {userName && (
          <button className="user-chip" onClick={onChangeName} title="Change name">
            <span className="user-chip-dot" aria-hidden="true">{userName.charAt(0).toUpperCase()}</span>
            <span className="user-chip-name">{userName}</span>
          </button>
        )}
        <button className="cmd-hint" onClick={onCmd} title="Command palette (⌘/Ctrl+K)">
          <SearchIcon />
          <span>Quick actions</span>
          <kbd>⌘K</kbd>
        </button>
        <button className={`cmd-hint options-chip ${optionsDirty ? 'dirty' : ''}`} onClick={onOptions} title="Output options — encoding, quoting, extra columns">
          <SlidersIcon />
          <span>Options</span>
          {optionsDirty && <span className="options-dot" aria-hidden="true" />}
        </button>
        <button className="icon-btn" onClick={onHelp} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">
          <HelpIcon />
        </button>
        <button className="icon-btn" onClick={onToggleTheme} aria-label="Toggle theme" title="Toggle theme">
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        </button>
      </div>
    </div>
  );
}

function OptionsModal({ options, onChange, onReset, onClose, livePreview }) {
  const trapRef = useFocusTrap(true);
  const isDefault = Object.keys(DEFAULT_OPTIONS).every((k) => options[k] === DEFAULT_OPTIONS[k]);
  return (
    <div className="name-backdrop" onClick={onClose}>
      <div ref={trapRef} className="name-panel options-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Output options">
        <div className="name-head">
          <div className="name-title">Output options</div>
          <div className="name-sub">
            Applied to every preview and download. Saved on this browser.
            {livePreview ? ' Changes re-run the current preview instantly.' : ''}
          </div>
        </div>
        <div className="options-list">
          {OPTION_META.map((m) => (
            <label key={m.key} className={`option-row ${options[m.key] ? 'on' : ''}`}>
              <input
                type="checkbox"
                checked={!!options[m.key]}
                onChange={(e) => onChange(m.key, e.target.checked)}
              />
              <span className="option-switch" aria-hidden="true" />
              <span className="option-text">
                <span className="option-label">{m.label}</span>
                <span className="option-hint">{m.hint}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="name-actions">
          <button type="button" className="btn ghost" onClick={onReset} disabled={isDefault}>Reset to defaults</button>
          <button type="button" className="btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

function NameModal({ initialValue, allowCancel, onSave, onCancel, error }) {
  const [value, setValue] = useState(initialValue || '');
  const trapRef = useFocusTrap(true);
  const clean = value.trim();
  const invalid = !clean || clean.toLowerCase() === 'guest';
  return (
    <div className="name-backdrop" onClick={allowCancel ? onCancel : undefined}>
      <div ref={trapRef} className="name-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Enter your name">
        <div className="name-head">
          <div className="name-title">{allowCancel ? 'Change your name' : 'Welcome! What\'s your name?'}</div>
          <div className="name-sub">Required — so your teammates know who converted what. Stored on this browser only.</div>
        </div>
        <form
          className="name-form"
          onSubmit={(e) => { e.preventDefault(); if (!invalid) onSave(clean); }}
        >
          <input
            className="name-input"
            autoFocus
            maxLength={60}
            placeholder="e.g. Brandon T."
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          {error && <div className="name-error">{error}</div>}
          <div className="name-actions">
            {allowCancel && (
              <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
            )}
            <button type="submit" className="btn primary" disabled={invalid}>Save</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function DropZone({ onFiles }) {
  const inputRef = useRef();
  const [over, setOver] = useState(false);

  const onDrop = (e) => {
    e.preventDefault();
    setOver(false);
    if (e.dataTransfer.files?.length) onFiles(e.dataTransfer.files);
  };

  return (
    <div
      className={`dropzone ${over ? 'over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
    >
      <div className="dropzone-inner">
        <div className="dropzone-icon"><UploadIcon /></div>
        <div className="dropzone-primary">Drop your Salesforce CSV{'(s)'} here</div>
        <div className="dropzone-secondary">
          one file = preview &amp; edit · multiple files = batch convert → ZIP
        </div>
        <div className="dropzone-secondary dim">
          click to browse, drag-and-drop, or <kbd>⌘/Ctrl</kbd>+<kbd>V</kbd> to paste &middot; max 10 MB each
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          multiple
          hidden
          onChange={(e) => onFiles(e.target.files)}
        />
      </div>
    </div>
  );
}

function HeroStats() {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch('/api/public-stats');
        if (!res.ok) throw new Error('stats');
        const data = await res.json();
        if (alive) setStats(data);
      } catch {
        if (alive) setError(true);
      }
    };
    load();
    const t = setInterval(load, 30000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const jobs = useCountUpInline(stats?.totalJobs ?? 0);

  if (error || !stats) {
    return (
      <div className="hero-stats loading">
        <div className="hero-big">—</div>
        <div className="hero-sub">Warming up…</div>
      </div>
    );
  }

  const hasToday = stats.jobsToday > 0;
  const hasActive = stats.activeUsers > 0;

  return (
    <div className="hero-stats">
      <div className="hero-left">
        <div className="hero-big">
          <span className="hero-emoji" aria-hidden="true">🔥</span>
          <span>{jobs.toLocaleString()}</span>
          <span className="hero-label">jobs flipped</span>
        </div>
        <div className="hero-sub">
          {hasToday && <span className="hero-pill today">{stats.jobsToday} today</span>}
          {hasActive && <span className="hero-pill live"><span className="hero-dot" /> {stats.activeUsers} active now</span>}
          {!hasToday && !hasActive && <span className="hero-muted">No conversions today — be the first.</span>}
        </div>
      </div>
      {stats.topAllTime && stats.topAllTime.length > 0 && (
        <div className="hero-leaderboard">
          <div className="hero-lb-title">All-time podium</div>
          <ol>
            {stats.topAllTime.slice(0, 3).map((u, i) => (
              <li key={u.name}>
                <span className="hero-lb-rank">{['🥇','🥈','🥉'][i]}</span>
                <span className="hero-lb-name">{u.name}</span>
                <span className="hero-lb-count">{u.count}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

// Inline count-up (separate from useCountUp because this one uses it in a
// component that doesn't live inside App).
function useCountUpInline(target, duration = 650) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (typeof target !== 'number') { setValue(target); return; }
    if (target === 0) { setValue(0); return; }
    const start = performance.now();
    let raf;
    const tick = (t) => {
      const elapsed = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - elapsed, 3);
      setValue(Math.round(target * eased));
      if (elapsed < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return value;
}

const WALL_PLACEHOLDERS = [
  "How's the day going?",
  'Crushed a big one?',
  'Shout out a teammate',
  'Drop a gif link. Or a vibe.',
  'What are you working on?',
  'Celebrate a win',
  'Share a smart trick',
];

function TeamWall({ currentUser, pushToast }) {
  const [notes, setNotes] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const placeholder = useMemo(() => WALL_PLACEHOLDERS[Math.floor(Math.random() * WALL_PLACEHOLDERS.length)], []);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/notes?limit=15');
      if (!res.ok) return;
      const data = await res.json();
      setNotes(data.notes || []);
      setLoaded(true);
    } catch { /* keep previous */ }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  const submit = async (e) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const res = await apiFetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Failed to post.');
      setText('');
      setNotes((prev) => [{ id: body.id, user: body.user, text: body.text, createdAt: body.createdAt }, ...prev].slice(0, 15));
      pushToast('success', 'Posted!');
    } catch (err) {
      pushToast('error', err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wall">
      <div className="wall-head">
        <span className="wall-title">Team wall</span>
        <span className="wall-sub">Say hi, share a win, leave a note · {notes.length} {notes.length === 1 ? 'note' : 'notes'}</span>
      </div>
      <form className="wall-form" onSubmit={submit}>
        <div className="wall-input-wrap">
          <input
            className="wall-input"
            maxLength={280}
            placeholder={currentUser ? `${placeholder} (as ${currentUser})` : placeholder}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <span className={`wall-counter ${text.length > 240 ? 'near-limit' : ''}`}>{280 - text.length}</span>
        </div>
        <button className="btn primary" type="submit" disabled={!text.trim() || busy}>
          {busy ? 'Posting…' : 'Post'}
        </button>
      </form>
      <div className="wall-list">
        {!loaded && <div className="wall-empty small muted">Loading…</div>}
        {loaded && notes.length === 0 && (
          <div className="wall-empty">No notes yet. Break the ice ✨</div>
        )}
        {notes.map((n) => (
          <div key={n.id} className="wall-note">
            <div className="wall-avatar" aria-hidden="true">{n.user.charAt(0).toUpperCase()}</div>
            <div className="wall-body">
              <div className="wall-meta">
                <span className="wall-name">{n.user}</span>
                <span className="wall-time" title={new Date(n.createdAt).toLocaleString()}>{formatRel(n.createdAt)}</span>
              </div>
              <div className="wall-text">{n.text}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatRel(iso) {
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function BatchPanel({ files, busy, onConvert, onReset, onRemove }) {
  const totalBytes = files.reduce((a, f) => a + f.size, 0);
  return (
    <div className="batch">
      <div className="card batch-card">
        <div className="card-title batch-title">
          <span>Batch convert · {files.length} file{files.length === 1 ? '' : 's'}</span>
          <span className="batch-total">{formatBytes(totalBytes)}</span>
        </div>
        <div className="batch-list">
          {files.map((f, i) => (
            <div className="batch-row" key={`${f.name}-${i}`}>
              <FileIcon />
              <span className="batch-name" title={f.name}>{f.name}</span>
              <span className="batch-size">{formatBytes(f.size)}</span>
              <button className="icon-btn sm" onClick={() => onRemove(i)} aria-label={`Remove ${f.name}`}>✕</button>
            </div>
          ))}
        </div>
        <div className="batch-footnote">
          Each file is transformed independently. Files that can't be parsed are listed in <code>_errors.txt</code> inside the ZIP — successful conversions are still included.
        </div>
      </div>
      <div className="actions">
        <button className="btn ghost" onClick={onReset} disabled={busy}>← Back</button>
        <button
          className="btn primary glow"
          onClick={onConvert}
          title="⌘/Ctrl+Enter"
          disabled={busy}
        >
          {busy ? <><span className="spinner sm inline" /> Converting…</> : <><DownloadIcon /> Convert All → Download ZIP</>}
        </button>
      </div>
    </div>
  );
}

function Skeleton({ filename }) {
  return (
    <div className="skeleton">
      <div className="sk-chip sk-shimmer" />
      <div className="sk-stats">
        {Array.from({ length: 5 }).map((_, i) => <div key={i} className="sk-stat sk-shimmer" />)}
      </div>
      <div className="sk-card sk-shimmer" style={{ height: 140 }} />
      <div className="sk-card sk-shimmer" style={{ height: 280 }} />
      <div className="sk-note">
        <div className="spinner sm" />
        <span>Analyzing {filename || 'your file'}…</span>
      </div>
    </div>
  );
}

function PreviewPanel({ file, preview, editedRows, setCell, dirty, busy, onRevert, tab, setTab, query, setQuery, onConvert, onConvertEdited, onReset }) {
  const {
    rowCount = 0,
    originalColumns = [],
    transformedColumns = [],
    originalPreview = [],
    mapping = {},
    addedColumns = [],
    droppedColumns = [],
    truncated = false,
    previewLimit = 2000,
    aliasesUsed = {},
    skippedRows = [],
    changes = [],
    warnings = [],
  } = preview || {};

  const fileSize = useMemo(() => formatBytes(file?.size ?? 0), [file]);
  const nChanges = totalChanges(preview);
  const nWarnings = totalWarnings(preview);
  const nSkipped = skippedRows.length;

  // Row filter chips (All / Fixed / Warnings) + pagination live here so the
  // absolute preview index survives filtering and paging.
  const [rowFilter, setRowFilter] = useState('all'); // 'all' | 'fixed' | 'warn'
  const [page, setPage] = useState(0);

  const activeRows = useMemo(
    () => (tab === 'converted' ? editedRows : originalPreview) || [],
    [tab, editedRows, originalPreview],
  );
  const activeCols = tab === 'converted' ? transformedColumns : originalColumns;
  const editable = tab === 'converted' && !truncated;

  // Lookup maps for per-cell highlighting in the converted table, plus the
  // set of rows touched by each so the chips can filter.
  const { changeMap, changedRowSet } = useMemo(() => {
    const m = new Map();
    const rows = new Set();
    for (const c of changes || []) {
      if (c && typeof c.row === 'number' && c.column != null) { m.set(`${c.row}|${c.column}`, c); rows.add(c.row); }
    }
    return { changeMap: m, changedRowSet: rows };
  }, [changes]);
  const { warnMap, warnedRowSet } = useMemo(() => {
    const m = new Map();
    const rows = new Set();
    for (const w of warnings || []) {
      if (w && typeof w.row === 'number') {
        rows.add(w.row);
        if (w.column != null) m.set(`${w.row}|${w.column}`, w);
      }
    }
    return { warnMap: m, warnedRowSet: rows };
  }, [warnings]);

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = [];
    for (let i = 0; i < activeRows.length; i++) {
      if (rowFilter === 'fixed' && !changedRowSet.has(i)) continue;
      if (rowFilter === 'warn' && !warnedRowSet.has(i)) continue;
      const r = activeRows[i];
      if (q && !Object.values(r).some((v) => v != null && String(v).toLowerCase().includes(q))) continue;
      out.push({ r, i });
    }
    return out;
  }, [activeRows, query, rowFilter, changedRowSet, warnedRowSet]);

  // Reset paging whenever the visible set changes shape.
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  useEffect(() => { setPage(0); }, [query, rowFilter, tab, filteredRows.length]);
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = useMemo(
    () => filteredRows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE),
    [filteredRows, safePage],
  );
  const isFiltered = !!query.trim() || rowFilter !== 'all';
  const firstShown = filteredRows.length === 0 ? 0 : safePage * PAGE_SIZE + 1;
  const lastShown = Math.min(filteredRows.length, (safePage + 1) * PAGE_SIZE);

  // Chips only make sense on the converted tab (that's where fixes live).
  const showWarnings = useCallback(() => { setTab('converted'); setRowFilter('warn'); }, [setTab]);

  // For converted-column tooltips: reverse-lookup the source column.
  const sourceFor = useMemo(() => {
    const m = {};
    for (const [src, dst] of Object.entries(mapping)) m[dst] = src;
    return m;
  }, [mapping]);

  const downloadButtons = (glow) => (
    <>
      <button
        className={`btn ${dirty ? '' : `primary ${glow ? 'glow' : ''}`}`}
        onClick={onConvert}
        title="⌘/Ctrl+Enter"
        disabled={busy}
      >
        {busy ? <><span className="spinner sm inline" /> Converting…</> : <><DownloadIcon /> Download as-is</>}
      </button>
      {dirty && (
        <button
          className={`btn primary ${glow ? 'glow' : ''}`}
          onClick={onConvertEdited}
          title="⌘/Ctrl+Enter"
          disabled={busy}
        >
          {busy ? <><span className="spinner sm inline" /> Converting…</> : <><DownloadIcon /> Download edited</>}
        </button>
      )}
    </>
  );

  return (
    <div className="preview">
      <div className="file-chip" title={file?.name}>
        <FileIcon />
        <span className="file-chip-name">{file?.name}</span>
        <span className="file-chip-size">{fileSize}</span>
        {dirty && <span className="dirty-dot" title="You have unsaved edits" />}
        <button className="file-chip-x" onClick={onReset} aria-label="Remove file">✕</button>
      </div>

      <VerdictStrip
        rows={rowCount}
        changes={nChanges}
        skipped={nSkipped}
        warnings={nWarnings}
        onShowWarnings={showWarnings}
        actions={downloadButtons(false)}
      />

      <StatsRow
        rowCount={rowCount}
        fixed={nChanges}
        dropped={nSkipped}
        warnings={nWarnings}
        outCols={transformedColumns.length}
      />

      <MappingCard
        mapping={mapping}
        originalColumns={originalColumns}
        addedColumns={addedColumns}
        droppedColumns={droppedColumns}
      />

      <CleanupCard preview={preview} />

      <div className="card table-card">
        <div className="tabs">
          <button className={`tab ${tab === 'converted' ? 'active' : ''}`} onClick={() => setTab('converted')}>
            Converted <span className="chip">{transformedColumns.length} cols</span>
          </button>
          <button className={`tab ${tab === 'original' ? 'active' : ''}`} onClick={() => setTab('original')}>
            Original <span className="chip">{originalColumns.length} cols</span>
          </button>
          <div className="tabs-spacer" />
          {editable && (
            <div className="edit-hint" title="Click any converted cell to edit it. Changes stay local until you download.">
              <PencilIcon /> <span>Cells are editable</span>
            </div>
          )}
          {tab === 'converted' && (
            <div className="row-chips" role="group" aria-label="Row filter">
              <button className={`row-chip ${rowFilter === 'all' ? 'active' : ''}`} aria-pressed={rowFilter === 'all'} aria-label="Show all rows" onClick={() => setRowFilter('all')}>All</button>
              <button className={`row-chip fix ${rowFilter === 'fixed' ? 'active' : ''}`} aria-pressed={rowFilter === 'fixed'} aria-label={`Show only rows with fixed cells (${changedRowSet.size})`} onClick={() => setRowFilter('fixed')} disabled={changedRowSet.size === 0}>
                Fixed <span className="chip">{changedRowSet.size.toLocaleString()}</span>
              </button>
              <button className={`row-chip warn ${rowFilter === 'warn' ? 'active' : ''}`} aria-pressed={rowFilter === 'warn'} aria-label={`Show only rows with warnings (${warnedRowSet.size})`} onClick={() => setRowFilter('warn')} disabled={warnedRowSet.size === 0}>
                Warnings <span className="chip">{warnedRowSet.size.toLocaleString()}</span>
              </button>
            </div>
          )}
          <div className="search">
            <SearchIcon />
            <input
              type="text"
              placeholder="Filter rows…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Filter rows"
            />
          </div>
        </div>
        <DataTable
          columns={activeCols}
          rows={pageRows}
          addedColumns={addedColumns}
          sourceFor={sourceFor}
          aliasesUsed={aliasesUsed}
          isConverted={tab === 'converted'}
          editable={editable}
          onCellChange={setCell}
          changeMap={tab === 'converted' ? changeMap : null}
          warnMap={tab === 'converted' ? warnMap : null}
          emptyMessage={rowFilter !== 'all' && !query ? 'No rows in this filter.' : 'No rows match your filter.'}
        />
        <div className="table-footnote">
          <span>
            {filteredRows.length === 0
              ? `0 of ${activeRows.length.toLocaleString()} rows`
              : `Showing rows ${firstShown.toLocaleString()}–${lastShown.toLocaleString()} of ${activeRows.length.toLocaleString()}`}
            {isFiltered ? ` (filtered: ${filteredRows.length.toLocaleString()})` : ''}
            {truncated ? ` — file has ${rowCount.toLocaleString()} rows, editing available for files ≤ ${previewLimit.toLocaleString()} rows` : ''}
          </span>
          {pageCount > 1 && (
            <div className="pager" role="navigation" aria-label="Table pages">
              <button className="pager-btn" onClick={() => setPage(0)} disabled={safePage === 0} aria-label="First page">«</button>
              <button className="pager-btn" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={safePage === 0} aria-label="Previous page">‹</button>
              <span className="pager-label">{safePage + 1} / {pageCount}</span>
              <button className="pager-btn" onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} disabled={safePage >= pageCount - 1} aria-label="Next page">›</button>
              <button className="pager-btn" onClick={() => setPage(pageCount - 1)} disabled={safePage >= pageCount - 1} aria-label="Last page">»</button>
            </div>
          )}
        </div>
      </div>

      <div className="actions sticky-actions">
        <button className="btn ghost" onClick={onReset} disabled={busy}>← Back</button>
        {dirty && (
          <button className="btn ghost" onClick={onRevert} title="Discard edits" disabled={busy}>
            Revert edits
          </button>
        )}
        {downloadButtons(true)}
      </div>
    </div>
  );
}

// One-line answer to "can I import this?" — sits right under the file chip
// with the download button, so the common case is a single glance + click.
function VerdictStrip({ rows, changes, skipped, warnings, onShowWarnings, actions }) {
  const ok = warnings === 0;
  let text;
  if (!ok) {
    text = `Review ${plural(warnings, 'warning')} before importing`;
  } else {
    const parts = [];
    parts.push(plural(rows, 'row'));
    if (changes > 0) parts.push(`${changes.toLocaleString()} cell${changes === 1 ? '' : 's'} auto-fixed`);
    if (skipped > 0) parts.push(`${plural(skipped, 'row')} dropped`);
    text = changes === 0 && skipped === 0
      ? 'Ready for Tigerpaw — clean file, nothing needed changing'
      : `Ready for Tigerpaw — ${parts.join(', ')}`;
  }
  return (
    <div className={`verdict ${ok ? 'ok' : 'warn'}`} role="status">
      <div className="verdict-left">
        <span className="verdict-icon" aria-hidden="true">{ok ? <CheckIcon /> : <WarnIcon />}</span>
        <span className="verdict-text">{text}</span>
        {!ok && (
          <button className="btn ghost sm verdict-show" onClick={onShowWarnings}>Show</button>
        )}
      </div>
      <div className="verdict-actions">{actions}</div>
    </div>
  );
}

function StatsRow({ rowCount, fixed = 0, dropped = 0, warnings = 0, outCols }) {
  return (
    <div className="stats">
      <Stat label="Rows" value={rowCount} />
      <Stat label="Cells fixed" value={fixed} tone={fixed > 0 ? 'fix' : ''} />
      <Stat label="Rows dropped" value={dropped} tone={dropped > 0 ? 'drop' : ''} />
      <Stat label="Warnings" value={warnings} tone={warnings > 0 ? 'warn' : ''} />
      <Stat label="Out columns" value={outCols} />
    </div>
  );
}

// --- Cleanup card (v2) -------------------------------------------------------
// Shows what the backend fixed, dropped, or flagged while parsing the file.
const CLEANUP_RENDER_CAP = 200;

function CleanupCard({ preview }) {
  const [open, setOpen] = useState(null); // 'changes' | 'skipped' | 'warnings' | null
  const changes = preview?.changes || [];
  const skipped = preview?.skippedRows || [];
  const warnings = preview?.warnings || [];
  const encoding = preview?.encoding || '';
  const hadBom = !!preview?.hadBom;
  const changesTruncated = !!preview?.changesTruncated;
  const warningsTruncated = !!preview?.warningsTruncated;
  const nChanges = totalChanges(preview);
  const nWarnings = totalWarnings(preview);

  const encLower = String(encoding).toLowerCase();
  const hadMojibake = changes.some((c) => c?.kind === 'mojibake');
  const encFixed = encLower.includes('1252') || encLower.includes('windows') || hadMojibake;
  const encLabel = encoding
    ? `${encLower.includes('1252') ? 'Windows-1252' : encoding}${hadBom ? ' · BOM' : ''}${encFixed ? ' → fixed' : ''}`
    : '';

  const allClean = nChanges === 0 && skipped.length === 0 && nWarnings === 0;
  const toggle = (k) => setOpen((cur) => (cur === k ? null : k));

  const renderList = (items, render, truncatedFlag) => {
    const shown = items.slice(0, CLEANUP_RENDER_CAP);
    const more = items.length - shown.length;
    return (
      <div className="cleanup-list">
        {shown.map(render)}
        {(more > 0 || truncatedFlag) && (
          <div className="cleanup-more">
            {more > 0 ? `…and ${more.toLocaleString()} more` : ''}
            {more > 0 && truncatedFlag ? ' · ' : ''}
            {truncatedFlag ? `showing the first ${items.length.toLocaleString()} — every one is applied in the download` : ''}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="card cleanup-card">
      <div className="card-title cleanup-title">
        <span>Cleanup</span>
        <span className="cleanup-sub">what changed on the way to Tigerpaw</span>
      </div>
      <div className="cleanup-body">
        <div className="cleanup-pills">
          {encLabel && (
            <span className={`cleanup-pill info ${encFixed ? 'fixed' : ''}`} title="Detected source file encoding">
              <span className="cleanup-pill-k">Encoding</span> {encLabel}
            </span>
          )}
          {nChanges > 0 && (
            <button className={`cleanup-pill fix ${open === 'changes' ? 'active' : ''}`} onClick={() => toggle('changes')} aria-expanded={open === 'changes'}>
              {plural(nChanges, 'cell')} fixed
              <ChevronIcon open={open === 'changes'} />
            </button>
          )}
          {skipped.length > 0 && (
            <button className={`cleanup-pill drop ${open === 'skipped' ? 'active' : ''}`} onClick={() => toggle('skipped')} aria-expanded={open === 'skipped'}>
              {skipped.length.toLocaleString()} row{skipped.length === 1 ? '' : 's'} dropped
              <ChevronIcon open={open === 'skipped'} />
            </button>
          )}
          {nWarnings > 0 && (
            <button className={`cleanup-pill warn ${open === 'warnings' ? 'active' : ''}`} onClick={() => toggle('warnings')} aria-expanded={open === 'warnings'}>
              {plural(nWarnings, 'warning')}
              <ChevronIcon open={open === 'warnings'} />
            </button>
          )}
          {allClean && (
            <span className="cleanup-clean"><CheckIcon /> Clean file — nothing needed changing</span>
          )}
        </div>

        {open === 'changes' && renderList(changes, (c, i) => (
          <div className="cleanup-row" key={`c-${i}`}>
            <span className="cleanup-loc">Row {(c?.row ?? 0) + 1}</span>
            <span className="cleanup-col">{c?.column}</span>
            <span className="cleanup-diff">
              <span className="cleanup-from">“{String(c?.from ?? '')}”</span>
              <span className="cleanup-arrow">→</span>
              <span className="cleanup-to">“{String(c?.to ?? '')}”</span>
            </span>
            <span className={`cleanup-kind kind-${c?.kind || 'other'}`}>{labelKind(c?.kind)}</span>
          </div>
        ), changesTruncated)}

        {open === 'skipped' && renderList(skipped, (s, i) => (
          <div className="cleanup-row" key={`s-${i}`}>
            <span className="cleanup-loc">Row {(s?.index ?? 0) + 1}</span>
            <span className={`cleanup-kind reason-${s?.reason || 'other'}`}>{labelReason(s?.reason)}</span>
            <span className="cleanup-preview" title={String(s?.preview ?? '')}>{String(s?.preview ?? '') || <em>(empty)</em>}</span>
          </div>
        ), false)}

        {open === 'warnings' && renderList(warnings, (w, i) => (
          <div className="cleanup-row" key={`w-${i}`}>
            <span className="cleanup-loc">{typeof w?.row === 'number' ? `Row ${w.row + 1}` : 'File'}</span>
            <span className="cleanup-col">{w?.column || ''}</span>
            <span className="cleanup-msg">{w?.message || labelKind(w?.kind)}</span>
          </div>
        ), warningsTruncated)}
      </div>
    </div>
  );
}

function Stat({ label, value, tone = '' }) {
  const animated = useCountUp(value);
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ''}`}>
      <div className="stat-value">{typeof value === 'number' ? animated.toLocaleString() : value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function MappingCard({ mapping, originalColumns, addedColumns, droppedColumns }) {
  const [open, setOpen] = useState(() => readMappingOpen());
  const renames = Object.entries(mapping).filter(([src, dst]) => src !== dst && originalColumns.includes(src));
  const kept = Object.entries(mapping).filter(([src, dst]) => src === dst && originalColumns.includes(src));
  const toggle = () => setOpen((v) => { writeMappingOpen(!v); return !v; });
  const summary = `${renames.length} renamed · ${kept.length} kept · ${addedColumns.length} added · ${droppedColumns.length} dropped`;
  return (
    <div className={`card mapping-card ${open ? 'open' : 'closed'}`}>
      <button className="card-title mapping-head" onClick={toggle} aria-expanded={open} aria-controls="mapping-grid">
        <span>Transformation</span>
        <span className="mapping-summary">{summary}</span>
        <ChevronIcon open={open} />
      </button>
      {open && (
        <div className="mapping-grid" id="mapping-grid">
          <MappingGroup color="rename" title={`Renamed (${renames.length})`} items={renames.map(([s, d]) => `${s} → ${d}`)} />
          <MappingGroup color="keep" title={`Kept (${kept.length})`} items={kept.map(([s]) => s)} />
          <MappingGroup color="add" title={`Added (${addedColumns.length})`} items={addedColumns} />
          <MappingGroup color="drop" title={`Dropped (${droppedColumns.length})`} items={droppedColumns} />
        </div>
      )}
    </div>
  );
}

function MappingGroup({ color, title, items }) {
  return (
    <div className={`mapping-group ${color}`}>
      <div className="mapping-title">{title}</div>
      <div className="mapping-items">
        {items.length === 0
          ? <span className="mapping-empty">—</span>
          : items.map((i) => <span className="pill" key={i}>{i}</span>)}
      </div>
    </div>
  );
}

function DataTable({ columns, rows, addedColumns, sourceFor, aliasesUsed, isConverted, editable, onCellChange, changeMap, warnMap, emptyMessage }) {
  if (rows.length === 0) {
    return <div className="table-empty">{emptyMessage || 'No rows match your filter.'}</div>;
  }
  const added = new Set(addedColumns || []);
  const aliases = aliasesUsed || {};
  // Column classes: the first column is frozen, numeric columns right-align.
  const colClass = (c, idx) => `${idx === 0 ? 'col-first' : ''} ${isConverted && NUMERIC_COLUMNS.has(c) ? 'num' : ''} ${c === 'Description' ? 'col-desc' : ''}`.trim();
  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            {columns.map((c, idx) => {
              let cls = colClass(c, idx);
              let tip = '';
              if (isConverted) {
                const src = sourceFor[c];
                if (added.has(c)) { cls += ' col-added'; tip = 'Added empty · Tigerpaw column'; }
                else if (src && aliases[src]) { cls += ' col-renamed'; tip = `Matched '${src}' → ${aliases[src]}`; }
                else if (src && src !== c) { cls += ' col-renamed'; tip = `Renamed from: ${src}`; }
                else if (src) { tip = 'Kept from source'; }
                else { tip = 'Preserved extra column'; }
              } else {
                tip = aliases[c] ? `Recognized as ${aliases[c]}` : 'Source column';
              }
              return (
                <th key={c} className={cls.trim()} data-tip={tip}>
                  <span>{c}</span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ r, i }) => (
            <tr key={i}>
              {columns.map((c, idx) => {
                const change = changeMap?.get(`${i}|${c}`);
                const warn = warnMap?.get(`${i}|${c}`);
                return (
                  <EditableCell
                    key={c}
                    value={r[c]}
                    editable={editable}
                    onChange={(v) => onCellChange?.(i, c, v)}
                    change={change}
                    warn={warn}
                    extraClass={colClass(c, idx)}
                  />
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EditableCell({ value, editable, onChange, change, warn, extraClass = '' }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const ref = useRef();

  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus();
      ref.current.select();
    }
  }, [editing]);

  const start = () => {
    if (!editable) return;
    setDraft(value == null ? '' : String(value));
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    onChange(draft);
  };
  const cancel = () => {
    setEditing(false);
  };

  const isEmpty = value === null || value === undefined || value === '';
  if (editing) {
    return (
      <td className={`cell editing ${extraClass}`}>
        <input
          ref={ref}
          className="cell-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { e.preventDefault(); cancel(); }
          }}
        />
      </td>
    );
  }
  // Highlight cells the backend auto-fixed or flagged. Warn wins visually
  // when both apply; the title carries the more useful detail.
  let title = editable ? 'Click to edit' : undefined;
  let flagCls = '';
  if (change) {
    flagCls = 'cell-fixed';
    title = `Was: ${String(change.from ?? '')}${change.kind ? ` · ${labelKind(change.kind)}` : ''}`;
  }
  if (warn) {
    flagCls = `${flagCls} cell-warn`.trim();
    title = warn.message || labelKind(warn.kind);
  }
  // The text sits in its own span so the flag dot (absolutely positioned in
  // the td's corner) never overlaps the value.
  return (
    <td
      className={`cell ${isEmpty ? 'empty' : ''} ${editable ? 'editable' : ''} ${flagCls} ${extraClass}`}
      onClick={start}
      title={title}
    >
      <span className="cell-text">{isEmpty ? '—' : String(value)}</span>
    </td>
  );
}

function SuccessCard({ filename, result, onAgain, pushToast }) {
  const [copying, setCopying] = useState(false);
  const outName = result?.name || (filename ? filename.replace(/\.csv$/i, '_converted.csv') : '');
  const s = result?.summary;
  const summaryBits = [];
  if (s && typeof s.rows === 'number') summaryBits.push(plural(s.rows, 'row'));
  if (s && s.changes > 0) summaryBits.push(`${s.changes.toLocaleString()} cell${s.changes === 1 ? '' : 's'} fixed`);
  if (s && s.skipped > 0) summaryBits.push(`${plural(s.skipped, 'row')} dropped`);
  if (s && s.warnings > 0) summaryBits.push(`${plural(s.warnings, 'warning')}`);
  if (s && s.batch) summaryBits.push(String(s.batch));

  const again = () => {
    if (!result?.blob) return;
    triggerDownload(result.blob, result.name);
    pushToast?.('success', `Downloaded ${result.name} again`);
  };
  const copy = async () => {
    if (!result?.blob || copying) return;
    setCopying(true);
    try {
      const text = await result.blob.text();
      await navigator.clipboard.writeText(text.replace(/^\uFEFF/, ''));
      pushToast?.('success', 'CSV copied to clipboard — paste it into Excel or Tigerpaw');
    } catch {
      pushToast?.('error', 'Clipboard blocked by the browser — use Download again instead.');
    } finally {
      setCopying(false);
    }
  };

  return (
    <div className="card success-card">
      <div className="success-check"><CheckIcon /></div>
      <div className="success-title">Converted!</div>
      <div className="success-sub">{filename ? `${filename} → ${outName || 'download'}` : 'Download started.'}</div>
      {summaryBits.length > 0 && (
        <div className="success-summary">{summaryBits.join(' · ')}</div>
      )}
      <div className="success-actions">
        {result?.blob && (
          <button className="btn ghost" onClick={again} title="Save the same file again">
            <DownloadIcon /> Download again
          </button>
        )}
        {result?.blob && result.kind === 'csv' && (
          <button className="btn ghost" onClick={copy} disabled={copying} title="Copy the converted CSV text">
            <CopyIcon /> {copying ? 'Copying…' : 'Copy CSV to clipboard'}
          </button>
        )}
        <button className="btn primary" onClick={onAgain}>Convert another</button>
      </div>
    </div>
  );
}

// Three-step reminder for teammates who export from Salesforce rarely.
function ExportHelp() {
  const [open, setOpen] = useState(false);
  return (
    <div className={`export-help ${open ? 'open' : ''}`}>
      <button className="export-help-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <HelpIcon /> How do I export from Salesforce? <ChevronIcon open={open} />
      </button>
      {open && (
        <ol className="export-help-steps">
          <li>Open the quote line items report → <strong>Export</strong>.</li>
          <li>Choose <strong>Details Only</strong>, Format <strong>CSV</strong>, Encoding <strong>UTF-8</strong> (or leave the default — every encoding is handled).</li>
          <li>Drop the downloaded <code>report….csv</code> here.</li>
        </ol>
      )}
    </div>
  );
}

function ToastStack({ toasts, onDismiss }) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.type}`}>
          <span className="toast-dot" />
          <span className="toast-msg">{t.message}</span>
          <button className="toast-x" onClick={() => onDismiss(t.id)} aria-label="Dismiss">✕</button>
        </div>
      ))}
    </div>
  );
}

function DragVeil({ active }) {
  return (
    <div className={`drag-veil ${active ? 'ready' : ''}`} aria-hidden="true">
      <div className="drag-veil-inner">
        <div className="drag-ring">
          <UploadIcon />
        </div>
        <div className="drag-veil-primary">{active ? 'Drop to upload' : 'Finish current step first'}</div>
        <div className="drag-veil-secondary">
          {active ? 'One file opens preview · multiple files go to batch' : 'Reset to upload new files'}
        </div>
      </div>
    </div>
  );
}

function CommandPalette({ commands, onClose }) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef();
  const trapRef = useFocusTrap(true);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => {
      const hay = (c.title + ' ' + (c.keywords || '') + ' ' + (c.group || '')).toLowerCase();
      return q.split(/\s+/).every((term) => hay.includes(term));
    });
  }, [commands, query]);

  useEffect(() => { setCursor(0); }, [query]);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const run = (cmd) => {
    if (!cmd) return;
    onClose();
    requestAnimationFrame(() => cmd.perform());
  };

  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, filtered.length - 1)); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
    if (e.key === 'Enter')     { e.preventDefault(); run(filtered[cursor]); }
    if (e.key === 'Escape')    { e.preventDefault(); onClose(); }
  };

  // Group by group label, preserving input order.
  const grouped = useMemo(() => {
    const map = new Map();
    filtered.forEach((c) => {
      const g = c.group || 'Actions';
      if (!map.has(g)) map.set(g, []);
      map.get(g).push(c);
    });
    return Array.from(map.entries());
  }, [filtered]);

  let flatIdx = -1;
  return (
    <div className="cmd-backdrop" onClick={onClose}>
      <div ref={trapRef} className="cmd-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="cmd-input-row">
          <SearchIcon />
          <input
            ref={inputRef}
            className="cmd-input"
            placeholder="Type a command or search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="cmd-list">
          {grouped.length === 0 && <div className="cmd-empty">No matching commands.</div>}
          {grouped.map(([group, cmds]) => (
            <div key={group} className="cmd-group">
              <div className="cmd-group-label">{group}</div>
              {cmds.map((c) => {
                flatIdx += 1;
                const active = flatIdx === cursor;
                return (
                  <button
                    key={c.id}
                    className={`cmd-item ${active ? 'active' : ''}`}
                    onMouseEnter={() => setCursor(flatIdx)}
                    onClick={() => run(c)}
                  >
                    <span className="cmd-item-title">{c.title}</span>
                    {c.hint && <span className="cmd-item-hint">{c.hint}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="cmd-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> run</span>
          <span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}

function HelpOverlay({ onClose }) {
  const trapRef = useFocusTrap(true);
  const shortcuts = [
    { keys: ['⌘/Ctrl', 'V'], desc: 'Paste a CSV (file or raw text)' },
    { keys: ['⌘/Ctrl', '↵'], desc: 'Convert & download (on preview)' },
    { keys: ['Esc'], desc: 'Close this overlay / reset' },
    { keys: ['?'], desc: 'Show/hide this overlay' },
  ];
  const tips = [
    'Drop multiple files at once for a batch → ZIP conversion.',
    'Click any converted cell to edit before downloading.',
    'Added columns are green; renamed columns are purple.',
    'Cells with an amber dot were auto-fixed — hover to see the original.',
    'Use the Fixed / Warnings chips above the table to see only the rows that changed.',
    'Options (top bar) controls encoding, quoting and extra columns.',
    'Theme preference is saved per browser.',
  ];
  return (
    <div className="help-backdrop" onClick={onClose}>
      <div ref={trapRef} className="help-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <div className="help-header">
          <div>Keyboard shortcuts</div>
          <button className="icon-btn sm" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="help-body">
          <ul className="kb-list">
            {shortcuts.map((s, i) => (
              <li key={i}>
                <div className="kb-keys">
                  {s.keys.map((k, j) => (
                    <span key={j}>
                      <kbd>{k}</kbd>{j < s.keys.length - 1 ? ' + ' : ''}
                    </span>
                  ))}
                </div>
                <span className="kb-desc">{s.desc}</span>
              </li>
            ))}
          </ul>
          <div className="help-divider" />
          <div className="help-title-sm">Tips</div>
          <ul className="tips-list">
            {tips.map((t, i) => <li key={i}>{t}</li>)}
          </ul>
        </div>
      </div>
    </div>
  );
}

function Aurora() {
  return (
    <div className="aurora" aria-hidden="true">
      <div className="blob b1" />
      <div className="blob b2" />
      <div className="blob b3" />
    </div>
  );
}

function Confetti() {
  const pieces = Array.from({ length: 30 });
  return (
    <div className="confetti" aria-hidden="true">
      {pieces.map((_, i) => (
        <span
          key={i}
          style={{
            left: `${Math.random() * 100}%`,
            animationDelay: `${Math.random() * 0.5}s`,
            background: ['#7c5cff', '#29d3c2', '#ffb547', '#ff5e8a', '#aee2ff'][i % 5],
            transform: `rotate(${Math.random() * 360}deg)`,
          }}
        />
      ))}
    </div>
  );
}

function FeedbackFab({ onOpen }) {
  return (
    <button className="fab" onClick={onOpen} title="Send feedback (suggestion or issue)" aria-label="Send feedback">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
      </svg>
      <span>Feedback</span>
    </button>
  );
}

function FeedbackModal({ onClose, pushToast }) {
  const [kind, setKind] = useState('suggestion');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const trapRef = useFocusTrap(true);

  const submit = async (e) => {
    e.preventDefault();
    const clean = text.trim();
    if (!clean || busy) return;
    setBusy(true);
    try {
      const res = await apiFetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, text: clean }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Failed to submit.');
      pushToast('success', kind === 'issue' ? 'Issue submitted — thanks!' : 'Suggestion submitted — thanks!');
      onClose();
    } catch (err) {
      pushToast('error', err.message);
    } finally {
      setBusy(false);
    }
  };

  const remaining = 2000 - text.length;

  return (
    <div className="feedback-backdrop" onClick={onClose}>
      <div ref={trapRef} className="feedback-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Send feedback">
        <div className="feedback-head">
          <div>
            <div className="feedback-title">Send feedback</div>
            <div className="feedback-sub">Admins see this in the dashboard. Be as specific as you like.</div>
          </div>
          <button className="icon-btn sm" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <form className="feedback-form" onSubmit={submit}>
          <div className="feedback-kind">
            <label className={`kind-chip ${kind === 'suggestion' ? 'active' : ''}`}>
              <input type="radio" name="kind" value="suggestion" checked={kind === 'suggestion'} onChange={() => setKind('suggestion')} />
              <span>💡 Suggestion</span>
            </label>
            <label className={`kind-chip ${kind === 'issue' ? 'active' : ''}`}>
              <input type="radio" name="kind" value="issue" checked={kind === 'issue'} onChange={() => setKind('issue')} />
              <span>🐛 Issue</span>
            </label>
          </div>
          <textarea
            className="feedback-textarea"
            placeholder={kind === 'issue' ? 'What broke? What were you trying to do? (Include filenames if relevant.)' : "What would make this better? Paste links or examples if it helps."}
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, 2000))}
            rows={6}
            autoFocus
          />
          <div className="feedback-footer">
            <span className={`feedback-counter ${remaining < 100 ? 'near-limit' : ''}`}>{remaining} left</span>
            <div className="feedback-actions">
              <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn primary" disabled={!text.trim() || busy}>
                {busy ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

function Footer({ version }) {
  const v = version ? (String(version).startsWith('v') ? version : `v${version}`) : 'v2.0.0';
  return (
    <footer className="footer">
      <span>© {new Date().getFullYear()} Brandon Toth · Service ASAP</span>
      <span>·</span>
      <span className="footer-version" title="App version">{v}</span>
      <span>·</span>
      <a href="https://scribehow.com/viewer/How_to_Use_Brandons_Salesforce_To_TigerPaw_Converter__UcSaDyXrQbyyoozC531-CQ" target="_blank" rel="noopener noreferrer">How to use</a>
      <span>·</span>
      <a href="mailto:Btoth@serviceasap.com?subject=Tigerpaw%20CSV%20Converter">Contact</a>
    </footer>
  );
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// --- Icons -------------------------------------------------------------------

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}
function UploadIcon() {
  return (
    <svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 16V4M6 10l6-6 6 6M4 20h16" />
    </svg>
  );
}
function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4v12M6 14l6 6 6-6M4 20h16" />
    </svg>
  );
}
function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
    </svg>
  );
}
function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}
function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12l5 5 9-11" />
    </svg>
  );
}
function HelpIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1 1-1 1.7" />
      <circle cx="12" cy="17" r="0.6" fill="currentColor" />
    </svg>
  );
}
function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  );
}
function SlidersIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" />
      <circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" />
    </svg>
  );
}
function WarnIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}
function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}
function ChevronIcon({ open }) {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
function FileIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

function Root() {
  return <ErrorBoundary><App /></ErrorBoundary>;
}

export default Root;
