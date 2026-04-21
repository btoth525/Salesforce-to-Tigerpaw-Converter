import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';

const STAGES = { IDLE: 'idle', LOADING: 'loading', PREVIEW: 'preview', DONE: 'done' };

function App() {
  const [stage, setStage] = useState(STAGES.IDLE);
  const [error, setError] = useState('');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');
  const [tab, setTab] = useState('converted');
  const [query, setQuery] = useState('');
  const [showConfetti, setShowConfetti] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
  }, [theme]);

  const reset = useCallback(() => {
    setStage(STAGES.IDLE);
    setFile(null);
    setPreview(null);
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
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name.replace(/\.csv$/i, '_converted.csv');
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStage(STAGES.DONE);
      setShowConfetti(true);
      setTimeout(() => setShowConfetti(false), 2400);
    } catch (e) {
      setError(e.message);
    }
  }, [file]);

  useEffect(() => {
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 'Enter' && stage === STAGES.PREVIEW) {
        e.preventDefault();
        doConvert();
      }
      if (e.key === 'Escape' && stage !== STAGES.IDLE) reset();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doConvert, reset, stage]);

  return (
    <div className="app" data-stage={stage}>
      <Aurora />
      <TopBar theme={theme} onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')} />
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

        {stage === STAGES.IDLE && <DropZone onFile={loadPreview} />}
        {stage === STAGES.LOADING && <Loading filename={file?.name} />}
        {stage === STAGES.PREVIEW && preview && (
          <PreviewPanel
            file={file}
            preview={preview}
            tab={tab}
            setTab={setTab}
            query={query}
            setQuery={setQuery}
            onConvert={doConvert}
            onReset={reset}
          />
        )}
        {stage === STAGES.DONE && <SuccessCard filename={file?.name} onAgain={reset} />}
      </main>
      <Footer />
      {showConfetti && <Confetti />}
    </div>
  );
}

function TopBar({ theme, onToggleTheme }) {
  return (
    <div className="topbar">
      <div className="brand">
        <span className="brand-dot" />
        <span>CSV Forge</span>
      </div>
      <button className="icon-btn" onClick={onToggleTheme} aria-label="Toggle theme" title="Toggle theme (⌘/Ctrl+Shift+L)">
        {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
      </button>
    </div>
  );
}

function DropZone({ onFile }) {
  const inputRef = useRef();
  const [over, setOver] = useState(false);

  const onDrop = (e) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) onFile(f);
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
        <div className="dropzone-primary">Drop your Salesforce CSV here</div>
        <div className="dropzone-secondary">or click to browse &middot; max 10 MB</div>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          hidden
          onChange={(e) => onFile(e.target.files?.[0])}
        />
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

function PreviewPanel({ file, preview, tab, setTab, query, setQuery, onConvert, onReset }) {
  const { rowCount, originalColumns, transformedColumns, originalPreview, transformedPreview,
    mapping, addedColumns, droppedColumns } = preview;

  const fileSize = useMemo(() => formatBytes(file?.size ?? 0), [file]);

  const activeRows = tab === 'converted' ? transformedPreview : originalPreview;
  const activeCols = tab === 'converted' ? transformedColumns : originalColumns;

  const filteredRows = useMemo(() => {
    if (!query) return activeRows;
    const q = query.toLowerCase();
    return activeRows.filter((r) =>
      Object.values(r).some((v) => v != null && String(v).toLowerCase().includes(q))
    );
  }, [activeRows, query]);

  return (
    <div className="preview">
      <StatsRow
        rowCount={rowCount}
        shown={activeRows.length}
        inCols={originalColumns.length}
        outCols={transformedColumns.length}
        fileSize={fileSize}
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
        <DataTable columns={activeCols} rows={filteredRows} addedColumns={addedColumns} mapping={mapping} isConverted={tab === 'converted'} />
        <div className="table-footnote">
          Showing {filteredRows.length} of {activeRows.length} preview rows{rowCount > activeRows.length ? ` (first ${activeRows.length} of ${rowCount})` : ''}.
        </div>
      </div>

      <div className="actions">
        <button className="btn ghost" onClick={onReset}>← Back</button>
        <button className="btn primary" onClick={onConvert} title="⌘/Ctrl+Enter">
          <DownloadIcon /> Convert &amp; Download
        </button>
      </div>
    </div>
  );
}

function StatsRow({ rowCount, shown, inCols, outCols, fileSize }) {
  const stats = [
    { label: 'Rows', value: rowCount.toLocaleString() },
    { label: 'In columns', value: inCols },
    { label: 'Out columns', value: outCols },
    { label: 'File size', value: fileSize },
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

function DataTable({ columns, rows, addedColumns, mapping, isConverted }) {
  if (rows.length === 0) {
    return <div className="table-empty">No rows match your filter.</div>;
  }
  const renameDests = new Set(
    Object.entries(mapping).filter(([s, d]) => s !== d).map(([, d]) => d)
  );
  const added = new Set(addedColumns);
  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            {columns.map((c) => {
              let cls = '';
              if (isConverted) {
                if (added.has(c)) cls = 'col-added';
                else if (renameDests.has(c)) cls = 'col-renamed';
              }
              return <th key={c} className={cls}>{c}</th>;
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {columns.map((c) => {
                const v = r[c];
                const isEmpty = v === null || v === undefined || v === '';
                return <td key={c} className={isEmpty ? 'empty' : ''}>{isEmpty ? '—' : String(v)}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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

export default App;
