import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';

const STAGES = { IDLE: 'idle', LOADING: 'loading', PREVIEW: 'preview', BATCH: 'batch', DONE: 'done' };

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

function getUserName() {
  try { return localStorage.getItem(USER_KEY) || ''; } catch { return ''; }
}

function setUserName(name) {
  try {
    if (name) localStorage.setItem(USER_KEY, name);
    else localStorage.removeItem(USER_KEY);
  } catch { /* ignore quota / private mode */ }
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
  const { toasts, push: pushToast, dismiss: dismissToast } = useToasts();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
  }, [theme]);

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
  }, []);

  const loadPreview = useCallback(async (f) => {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith('.csv')) {
      pushToast('error', 'Only .csv files are supported.');
      return;
    }
    setFile(f);
    setStage(STAGES.LOADING);
    try {
      const fd = new FormData();
      fd.append('file', f);
      const res = await apiFetch('/api/preview', { method: 'POST', body: fd });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Preview failed.');
      setPreview(body);
      setEditedRows(body.transformedPreview.map((r) => ({ ...r })));
      setStage(STAGES.PREVIEW);
      if (body.truncated) {
        pushToast('warn', `Large file — editing disabled (${body.rowCount.toLocaleString()} rows > preview cap).`);
      }
    } catch (e) {
      pushToast('error', e.message);
      setStage(STAGES.IDLE);
    }
  }, [pushToast]);

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
      const res = await apiFetch('/api/convert', { method: 'POST', body: fd });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Conversion failed.');
      }
      const blob = await res.blob();
      const outName = file.name.replace(/\.csv$/i, '_converted.csv');
      triggerDownload(blob, outName);
      finishConvert(`Downloaded ${outName}`);
    } catch (e) {
      pushToast('error', e.message);
    } finally {
      setBusy(false);
    }
  }, [file, busy, finishConvert, pushToast]);

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
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Conversion failed.');
      }
      const blob = await res.blob();
      triggerDownload(blob, outName);
      finishConvert(`Downloaded ${outName}`);
    } catch (e) {
      pushToast('error', e.message);
    } finally {
      setBusy(false);
    }
  }, [file, preview, editedRows, busy, finishConvert, pushToast]);

  const doConvertBatch = useCallback(async () => {
    if (batchFiles.length === 0 || busy) return;
    setBusy(true);
    try {
      const fd = new FormData();
      for (const f of batchFiles) fd.append('files', f);
      const res = await apiFetch('/api/convert-batch', { method: 'POST', body: fd });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Batch conversion failed.');
      }
      const summary = res.headers.get('X-Batch-Summary') || `${batchFiles.length} files`;
      const blob = await res.blob();
      triggerDownload(blob, 'converted_batch.zip');
      finishConvert(`Batch complete — ${summary}`);
    } catch (e) {
      pushToast('error', e.message);
    } finally {
      setBusy(false);
    }
  }, [batchFiles, busy, finishConvert, pushToast]);

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
  }, [doConvert, doConvertEdited, doConvertBatch, reset, stage, showHelp, showCmd, dirty]);

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
  }, [theme, stage, dirty, query, userName, handleFiles, doConvert, doConvertEdited, doConvertBatch, revertEdits, reset]);

  return (
    <div className="app" data-stage={stage}>
      <Aurora />
      <TopBar
        theme={theme}
        onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        onHelp={() => setShowHelp(true)}
        onCmd={() => setShowCmd(true)}
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
              onAgain={reset}
            />
          )}
        </div>
      </main>
      <Footer />
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
      {showConfetti && <Confetti />}
      {showHelp && <HelpOverlay onClose={() => setShowHelp(false)} />}
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

function TopBar({ theme, onToggleTheme, onHelp, onCmd, userName, onChangeName }) {
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
      {stats.topWeek.length > 0 && (
        <div className="hero-leaderboard">
          <div className="hero-lb-title">Top this week</div>
          <ol>
            {stats.topWeek.map((u, i) => (
              <li key={u.name}>
                <span className="hero-lb-rank">{['🥇','🥈','🥉','·','·'][i] || '·'}</span>
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
        {Array.from({ length: 4 }).map((_, i) => <div key={i} className="sk-stat sk-shimmer" />)}
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
  const { rowCount, originalColumns, transformedColumns, originalPreview,
    mapping, addedColumns, droppedColumns, truncated } = preview;

  const fileSize = useMemo(() => formatBytes(file?.size ?? 0), [file]);

  const activeRows = tab === 'converted' ? editedRows : originalPreview;
  const activeCols = tab === 'converted' ? transformedColumns : originalColumns;
  const editable = tab === 'converted' && !truncated;

  const filteredRows = useMemo(() => {
    if (!query) return activeRows.map((r, i) => ({ r, i }));
    const q = query.toLowerCase();
    return activeRows
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => Object.values(r).some((v) => v != null && String(v).toLowerCase().includes(q)));
  }, [activeRows, query]);

  // For converted-column tooltips: reverse-lookup the source column.
  const sourceFor = useMemo(() => {
    const m = {};
    for (const [src, dst] of Object.entries(mapping)) m[dst] = src;
    return m;
  }, [mapping]);

  return (
    <div className="preview">
      <div className="file-chip" title={file?.name}>
        <FileIcon />
        <span className="file-chip-name">{file?.name}</span>
        <span className="file-chip-size">{fileSize}</span>
        {dirty && <span className="dirty-dot" title="You have unsaved edits" />}
        <button className="file-chip-x" onClick={onReset} aria-label="Remove file">✕</button>
      </div>

      <StatsRow
        rowCount={rowCount}
        shown={activeRows.length}
        inCols={originalColumns.length}
        outCols={transformedColumns.length}
      />

      <MappingCard
        mapping={mapping}
        originalColumns={originalColumns}
        addedColumns={addedColumns}
        droppedColumns={droppedColumns}
      />

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
          <div className="search">
            <SearchIcon />
            <input
              type="text"
              placeholder="Filter rows…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
        <DataTable
          columns={activeCols}
          rows={filteredRows}
          addedColumns={addedColumns}
          sourceFor={sourceFor}
          isConverted={tab === 'converted'}
          editable={editable}
          onCellChange={setCell}
        />
        <div className="table-footnote">
          Showing {filteredRows.length} of {activeRows.length} preview rows
          {truncated ? ` — file has ${rowCount} rows, editing available for files ≤ 500 rows` :
            (rowCount > activeRows.length ? ` (first ${activeRows.length} of ${rowCount})` : '')}.
        </div>
      </div>

      <div className="actions">
        <button className="btn ghost" onClick={onReset} disabled={busy}>← Back</button>
        {dirty && (
          <button className="btn ghost" onClick={onRevert} title="Discard edits" disabled={busy}>
            Revert edits
          </button>
        )}
        <button
          className={`btn ${dirty ? '' : 'primary glow'}`}
          onClick={onConvert}
          title="⌘/Ctrl+Enter"
          disabled={busy}
        >
          {busy ? <><span className="spinner sm inline" /> Converting…</> : <><DownloadIcon /> Download as-is</>}
        </button>
        {dirty && (
          <button
            className="btn primary glow"
            onClick={onConvertEdited}
            title="⌘/Ctrl+Enter"
            disabled={busy}
          >
            {busy ? <><span className="spinner sm inline" /> Converting…</> : <><DownloadIcon /> Download edited</>}
          </button>
        )}
      </div>
    </div>
  );
}

function StatsRow({ rowCount, shown, inCols, outCols }) {
  return (
    <div className="stats">
      <Stat label="Rows" value={rowCount} />
      <Stat label="In columns" value={inCols} />
      <Stat label="Out columns" value={outCols} />
      <Stat label="Preview rows" value={shown} />
    </div>
  );
}

function Stat({ label, value }) {
  const animated = useCountUp(value);
  return (
    <div className="stat">
      <div className="stat-value">{typeof value === 'number' ? animated.toLocaleString() : value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function MappingCard({ mapping, originalColumns, addedColumns, droppedColumns }) {
  const renames = Object.entries(mapping).filter(([src, dst]) => src !== dst && originalColumns.includes(src));
  const kept = Object.entries(mapping).filter(([src, dst]) => src === dst && originalColumns.includes(src));
  return (
    <div className="card mapping-card">
      <div className="card-title">Transformation</div>
      <div className="mapping-grid">
        <MappingGroup color="rename" title={`Renamed (${renames.length})`} items={renames.map(([s, d]) => `${s} → ${d}`)} />
        <MappingGroup color="keep" title={`Kept (${kept.length})`} items={kept.map(([s]) => s)} />
        <MappingGroup color="add" title={`Added (${addedColumns.length})`} items={addedColumns} />
        <MappingGroup color="drop" title={`Dropped (${droppedColumns.length})`} items={droppedColumns} />
      </div>
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

function DataTable({ columns, rows, addedColumns, sourceFor, isConverted, editable, onCellChange }) {
  if (rows.length === 0) {
    return <div className="table-empty">No rows match your filter.</div>;
  }
  const added = new Set(addedColumns);
  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            {columns.map((c) => {
              let cls = '';
              let tip = '';
              if (isConverted) {
                if (added.has(c)) { cls = 'col-added'; tip = 'Added empty · Tigerpaw column'; }
                else if (sourceFor[c] && sourceFor[c] !== c) { cls = 'col-renamed'; tip = `Renamed from: ${sourceFor[c]}`; }
                else if (sourceFor[c]) { tip = 'Kept from source'; }
                else { tip = 'Preserved extra column'; }
              } else {
                tip = 'Source column';
              }
              return (
                <th key={c} className={cls} data-tip={tip}>
                  <span>{c}</span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ r, i }) => (
            <tr key={i}>
              {columns.map((c) => (
                <EditableCell
                  key={c}
                  value={r[c]}
                  editable={editable}
                  onChange={(v) => onCellChange?.(i, c, v)}
                />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EditableCell({ value, editable, onChange }) {
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
      <td className="cell editing">
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
  return (
    <td
      className={`cell ${isEmpty ? 'empty' : ''} ${editable ? 'editable' : ''}`}
      onClick={start}
      title={editable ? 'Click to edit' : undefined}
    >
      {isEmpty ? '—' : String(value)}
    </td>
  );
}

function SuccessCard({ filename, onAgain }) {
  return (
    <div className="card success-card">
      <div className="success-check"><CheckIcon /></div>
      <div className="success-title">Converted!</div>
      <div className="success-sub">{filename ? `${filename} → ${filename.replace(/\.csv$/i, '_converted.csv')}` : 'Download started.'}</div>
      <button className="btn primary" onClick={onAgain}>Convert another</button>
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

function Footer() {
  return (
    <footer className="footer">
      <span>© {new Date().getFullYear()} Brandon Toth · Service ASAP</span>
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
