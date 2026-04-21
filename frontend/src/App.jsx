import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';

const STAGES = { IDLE: 'idle', LOADING: 'loading', PREVIEW: 'preview', BATCH: 'batch', DONE: 'done' };

function App() {
  const [stage, setStage] = useState(STAGES.IDLE);
  const [error, setError] = useState('');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [batchFiles, setBatchFiles] = useState([]);
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');
  const [tab, setTab] = useState('converted');
  const [query, setQuery] = useState('');
  const [showConfetti, setShowConfetti] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
  }, [theme]);

  const reset = useCallback(() => {
    setStage(STAGES.IDLE);
    setFile(null);
    setPreview(null);
    setBatchFiles([]);
    setError('');
    setQuery('');
  }, []);

  const loadPreview = useCallback(async (f) => {
    setError('');
    if (!f) return;
    if (!f.name.toLowerCase().endsWith('.csv')) {
      setError('Only .csv files are supported.');
      return;
    }
    setFile(f);
    setStage(STAGES.LOADING);
    try {
      const fd = new FormData();
      fd.append('file', f);
      const res = await fetch('/api/preview', { method: 'POST', body: fd });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Preview failed.');
      setPreview(body);
      setStage(STAGES.PREVIEW);
    } catch (e) {
      setError(e.message);
      setStage(STAGES.IDLE);
    }
  }, []);

  // Entry point from drop / picker / paste — branches single vs batch.
  const handleFiles = useCallback((fileList) => {
    const arr = Array.from(fileList || []).filter((f) => f && f.name);
    if (arr.length === 0) return;
    const csvs = arr.filter((f) => f.name.toLowerCase().endsWith('.csv'));
    if (csvs.length === 0) {
      setError('Only .csv files are supported.');
      return;
    }
    if (csvs.length === 1) {
      loadPreview(csvs[0]);
    } else {
      setBatchFiles(csvs);
      setStage(STAGES.BATCH);
    }
  }, [loadPreview]);

  const doConvert = useCallback(async () => {
    if (!file) return;
    setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/convert', { method: 'POST', body: fd });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Conversion failed.');
      }
      const blob = await res.blob();
      triggerDownload(blob, file.name.replace(/\.csv$/i, '_converted.csv'));
      setStage(STAGES.DONE);
      setShowConfetti(true);
      setTimeout(() => setShowConfetti(false), 2400);
    } catch (e) {
      setError(e.message);
    }
  }, [file]);

  // Apply user edits by POSTing the already-transformed JSON to the backend.
  const doConvertEdited = useCallback(async (editedRows) => {
    if (!file || !preview) return;
    setError('');
    try {
      const res = await fetch('/api/convert-edited', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name.replace(/\.csv$/i, '_edited.csv'),
          columns: preview.transformedColumns,
          rows: editedRows,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Conversion failed.');
      }
      const blob = await res.blob();
      triggerDownload(blob, file.name.replace(/\.csv$/i, '_edited.csv'));
      setStage(STAGES.DONE);
      setShowConfetti(true);
      setTimeout(() => setShowConfetti(false), 2400);
    } catch (e) {
      setError(e.message);
    }
  }, [file, preview]);

  const doConvertBatch = useCallback(async () => {
    if (batchFiles.length === 0) return;
    setError('');
    try {
      const fd = new FormData();
      for (const f of batchFiles) fd.append('files', f);
      const res = await fetch('/api/convert-batch', { method: 'POST', body: fd });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Batch conversion failed.');
      }
      const blob = await res.blob();
      triggerDownload(blob, 'converted_batch.zip');
      setStage(STAGES.DONE);
      setShowConfetti(true);
      setTimeout(() => setShowConfetti(false), 2400);
    } catch (e) {
      setError(e.message);
    }
  }, [batchFiles]);

  useEffect(() => {
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      const target = e.target;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
      if (mod && e.key === 'Enter' && stage === STAGES.PREVIEW) {
        e.preventDefault();
        doConvert();
      }
      if (e.key === 'Escape') {
        if (showHelp) setShowHelp(false);
        else if (stage !== STAGES.IDLE) reset();
      }
      if (!typing && (e.key === '?' || (e.shiftKey && e.key === '/'))) {
        e.preventDefault();
        setShowHelp((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doConvert, reset, stage, showHelp]);

  // Paste-anywhere — paste a CSV file (or raw CSV text) from the clipboard.
  useEffect(() => {
    const onPaste = (e) => {
      if (stage !== STAGES.IDLE) return;
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
  }, [handleFiles, stage]);

  return (
    <div className="app" data-stage={stage}>
      <Aurora />
      <TopBar
        theme={theme}
        onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        onHelp={() => setShowHelp(true)}
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

        {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}

        <div className="stage-wrap" key={stage}>
          {stage === STAGES.IDLE && <DropZone onFiles={handleFiles} />}
          {stage === STAGES.LOADING && <Loading filename={file?.name} />}
          {stage === STAGES.BATCH && (
            <BatchPanel
              files={batchFiles}
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
          {stage === STAGES.PREVIEW && preview && (
            <PreviewPanel
              file={file}
              preview={preview}
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
      {showConfetti && <Confetti />}
      {showHelp && <HelpOverlay onClose={() => setShowHelp(false)} />}
    </div>
  );
}

function TopBar({ theme, onToggleTheme, onHelp }) {
  return (
    <div className="topbar">
      <div className="brand">
        <img src="/favicon.png" alt="" className="brand-logo" />
        <span>CSV Forge</span>
      </div>
      <div className="topbar-actions">
        <button
          className="icon-btn"
          onClick={onHelp}
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts (?)"
        >
          <HelpIcon />
        </button>
        <button
          className="icon-btn"
          onClick={onToggleTheme}
          aria-label="Toggle theme"
          title="Toggle theme"
        >
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        </button>
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

function BatchPanel({ files, onConvert, onReset, onRemove }) {
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
        <button className="btn ghost" onClick={onReset}>← Back</button>
        <button className="btn primary glow" onClick={onConvert} title="⌘/Ctrl+Enter">
          <DownloadIcon /> Convert All → Download ZIP
        </button>
      </div>
    </div>
  );
}

function Loading({ filename }) {
  return (
    <div className="card loading-card">
      <div className="spinner" />
      <div className="loading-text">
        <div className="loading-title">Analyzing {filename}…</div>
        <div className="loading-sub">Detecting encoding, parsing rows, mapping columns.</div>
      </div>
    </div>
  );
}

function PreviewPanel({ file, preview, tab, setTab, query, setQuery, onConvert, onConvertEdited, onReset }) {
  const { rowCount, originalColumns, transformedColumns, originalPreview, transformedPreview,
    mapping, addedColumns, droppedColumns, truncated } = preview;

  const fileSize = useMemo(() => formatBytes(file?.size ?? 0), [file]);

  // Local editable copy of the converted rows. Reset whenever a new preview arrives.
  const [editedRows, setEditedRows] = useState(() => transformedPreview.map((r) => ({ ...r })));
  useEffect(() => { setEditedRows(transformedPreview.map((r) => ({ ...r }))); }, [transformedPreview]);

  const dirty = useMemo(() => {
    if (editedRows.length !== transformedPreview.length) return true;
    for (let i = 0; i < editedRows.length; i++) {
      const a = editedRows[i];
      const b = transformedPreview[i];
      for (const c of transformedColumns) {
        if ((a?.[c] ?? '') !== (b?.[c] ?? '')) return true;
      }
    }
    return false;
  }, [editedRows, transformedPreview, transformedColumns]);

  const setCell = useCallback((rowIdx, col, value) => {
    setEditedRows((prev) => {
      const next = prev.slice();
      next[rowIdx] = { ...next[rowIdx], [col]: value };
      return next;
    });
  }, []);

  const revertEdits = useCallback(() => {
    setEditedRows(transformedPreview.map((r) => ({ ...r })));
  }, [transformedPreview]);

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
        <button className="btn ghost" onClick={onReset}>← Back</button>
        {dirty && (
          <button className="btn ghost" onClick={revertEdits} title="Discard edits">
            Revert edits
          </button>
        )}
        <button
          className={`btn ${dirty ? '' : 'primary glow'}`}
          onClick={onConvert}
          title="⌘/Ctrl+Enter"
        >
          <DownloadIcon /> Download as-is
        </button>
        {dirty && (
          <button className="btn primary glow" onClick={() => onConvertEdited(editedRows)}>
            <DownloadIcon /> Download edited
          </button>
        )}
      </div>
    </div>
  );
}

function StatsRow({ rowCount, shown, inCols, outCols }) {
  const stats = [
    { label: 'Rows', value: rowCount.toLocaleString() },
    { label: 'In columns', value: inCols },
    { label: 'Out columns', value: outCols },
    { label: 'Preview rows', value: shown },
  ];
  return (
    <div className="stats">
      {stats.map((s) => (
        <div className="stat" key={s.label}>
          <div className="stat-value">{s.value}</div>
          <div className="stat-label">{s.label}</div>
        </div>
      ))}
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

function ErrorBanner({ message, onDismiss }) {
  return (
    <div className="banner error" role="alert">
      <span>{message}</span>
      <button className="icon-btn sm" onClick={onDismiss} aria-label="Dismiss">✕</button>
    </div>
  );
}

function HelpOverlay({ onClose }) {
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
      <div className="help-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Keyboard shortcuts">
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

export default App;
