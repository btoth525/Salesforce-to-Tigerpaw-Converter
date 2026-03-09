import { useRef, useState, useCallback, useEffect } from 'react';
import './App.css';

const MAX_FILE_SIZE_MB = 10;

// The exact columns Salesforce exports and what they become in Tigerpaw
const SF_REQUIRED = ['Product Code', 'Description', 'Quantity', 'Net Unit Price', 'Unit Cost'];
const COLUMN_MAP = {
  'Product Code': 'Part Number',
  'Description': 'Description',
  'Quantity': 'Quantity',
  'Net Unit Price': 'Price',
  'Unit Cost': 'Cost',
};

// ── CSV parsing helpers (runs entirely in the browser) ─────────────────────
function detectDelimiter(line) {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  for (const ch of line) if (ch in counts) counts[ch]++;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

function parseCSVPreview(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return null;
  const delim = detectDelimiter(lines[0]);
  const parseRow = line => line.split(delim).map(c => c.replace(/^"|"$/g, '').trim());
  const headers = parseRow(lines[0]);
  const rows = lines.slice(1, 4).map(parseRow);
  return { headers, rows, totalRows: lines.length - 1 };
}

// ── Main App ───────────────────────────────────────────────────────────────
function App() {
  const fileInput = useRef();

  const [status, setStatus] = useState('');
  const [statusType, setStatusType] = useState(''); // 'success' | 'error' | 'info'
  const [converting, setConverting] = useState(false);
  const [showConfetti, setShowConfetti] = useState(false);
  const [showEasterEgg, setShowEasterEgg] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);
  const [preview, setPreview] = useState(null);       // parsed CSV preview
  const [rowsConverted, setRowsConverted] = useState(null);
  const [lastBlob, setLastBlob] = useState(null);     // kept for clipboard copy
  const [copySuccess, setCopySuccess] = useState(false);
  const [darkMode, setDarkMode] = useState(
    () => localStorage.getItem('darkMode') === 'true'
  );

  // Apply dark mode class to <body> and persist
  useEffect(() => {
    document.body.classList.toggle('dark', darkMode);
    localStorage.setItem('darkMode', darkMode);
  }, [darkMode]);

  // Keyboard shortcut: Ctrl/Cmd + Enter to convert
  useEffect(() => {
    const handler = e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && selectedFile && !converting) {
        document.getElementById('convert-form')?.requestSubmit();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedFile, converting]);

  const setMsg = (msg, type = 'info') => { setStatus(msg); setStatusType(type); };

  // Parse the selected file in the browser and populate the preview panel
  const parseFilePreview = file => {
    const reader = new FileReader();
    reader.onload = e => {
      const parsed = parseCSVPreview(e.target.result);
      setPreview(parsed);
    };
    reader.readAsText(file);
  };

  const validateFile = file => {
    if (!file) return 'Please select a CSV file.';
    if (!file.name.toLowerCase().endsWith('.csv')) return 'Only CSV files are allowed.';
    if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024)
      return `File too large. Maximum size is ${MAX_FILE_SIZE_MB} MB.`;
    return null;
  };

  const applyFile = file => {
    setSelectedFile(file);
    setMsg('');
    setPreview(null);
    setRowsConverted(null);
    setLastBlob(null);
    if (file && file.name.toLowerCase().endsWith('.csv')) parseFilePreview(file);
  };

  const handleFileChange = e => applyFile(e.target.files[0] || null);

  const triggerDownload = (blob, filename) => {
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  };

  const handleUpload = async e => {
    e.preventDefault();
    const file = selectedFile || fileInput.current?.files[0];
    const err = validateFile(file);
    if (err) { setMsg(err, 'error'); return; }

    setMsg('Uploading and converting…', 'info');
    setConverting(true);
    setShowConfetti(false);
    setRowsConverted(null);
    setLastBlob(null);

    const formData = new FormData();
    formData.append('file', file);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch('/', { method: 'POST', body: formData, signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        setMsg(errData.error || 'Conversion failed. Please try again.', 'error');
        return;
      }

      const rows = parseInt(response.headers.get('X-Row-Count') || '0', 10);
      const blob = await response.blob();
      const outName = file.name.replace(/\.csv$/i, '_converted.csv');
      setLastBlob({ blob, filename: outName });
      if (rows > 0) setRowsConverted(rows);

      triggerDownload(blob, outName);

      setMsg(
        rows > 0
          ? `Conversion successful! ${rows} row${rows !== 1 ? 's' : ''} converted — download started.`
          : 'Conversion successful! Download started.',
        'success'
      );
      setShowConfetti(true);
      setTimeout(() => setShowConfetti(false), 2500);
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        setMsg('Conversion timed out — the server is taking too long. Try a smaller file or try again.', 'error');
      } else {
        setMsg('Network error — please check your connection and try again.', 'error');
      }
    } finally {
      setConverting(false);
    }
  };

  const handleRedownload = () => {
    if (!lastBlob) return;
    triggerDownload(lastBlob.blob, lastBlob.filename);
  };

  const handleCopyCSV = async () => {
    if (!lastBlob) return;
    try {
      const text = await lastBlob.blob.text();
      await navigator.clipboard.writeText(text);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch {
      setMsg('Could not copy to clipboard — try downloading instead.', 'error');
    }
  };

  // Drag-and-drop
  const onDragOver = useCallback(e => { e.preventDefault(); setDragging(true); }, []);
  const onDragLeave = useCallback(e => { e.preventDefault(); setDragging(false); }, []);
  const onDrop = useCallback(e => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0] || null;
    if (!file) return;
    applyFile(file);
    if (fileInput.current) {
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.current.files = dt.files;
    }
  }, []);

  const handleIconClick = () => {
    setShowEasterEgg(true);
    setTimeout(() => setShowEasterEgg(false), 2500);
  };

  return (
    <div className={`container${darkMode ? ' dark' : ''}`}>
      {/* Dark mode toggle */}
      <button
        className="dark-toggle"
        onClick={() => setDarkMode(d => !d)}
        aria-label="Toggle dark mode"
        title="Toggle dark mode"
      >
        {darkMode ? '☀️' : '🌙'}
      </button>

      <img
        src="/favicon.png"
        alt="App Icon"
        className="floating-icon"
        onClick={handleIconClick}
        style={{ cursor: 'pointer' }}
        title="Click me for a surprise!"
      />
      <h1>Salesforce → Tigerpaw CSV Magic</h1>

      <form id="convert-form" onSubmit={handleUpload} className="upload-form">
        {/* Drop zone */}
        <div
          className={[
            'drop-zone',
            dragging ? 'drop-zone--active' : '',
            selectedFile ? 'drop-zone--has-file' : '',
          ].join(' ')}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onClick={() => fileInput.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={e => e.key === 'Enter' && fileInput.current?.click()}
          aria-label="Click or drag and drop a CSV file here"
        >
          <input
            type="file"
            accept=".csv"
            ref={fileInput}
            onChange={handleFileChange}
            style={{ display: 'none' }}
          />
          {selectedFile ? (
            <>
              <span className="drop-zone__icon">📄</span>
              <span className="drop-zone__filename">{selectedFile.name}</span>
              <span className="drop-zone__size">
                ({(selectedFile.size / 1024).toFixed(1)} KB)
              </span>
              <span className="drop-zone__change">Click to change file</span>
            </>
          ) : (
            <>
              <span className="drop-zone__icon">📂</span>
              <span className="drop-zone__hint">
                Drag &amp; drop your CSV here, or <u>click to browse</u>
              </span>
              <span className="drop-zone__sub">Max {MAX_FILE_SIZE_MB} MB • .csv only</span>
            </>
          )}
        </div>

        {/* Live preview panel — appears immediately after file selection */}
        {preview && <PreviewPanel preview={preview} />}

        <button
          type="submit"
          disabled={converting}
          className={converting ? 'btn--loading' : ''}
        >
          {converting
            ? <><span className="spinner" /> Converting…</>
            : 'Convert & Download'}
        </button>

        {selectedFile && !converting && (
          <p className="shortcut-hint">
            <kbd>Ctrl</kbd>+<kbd>Enter</kbd> to convert
          </p>
        )}
      </form>

      {/* Status message */}
      {status && (
        <div className={`status status--${statusType}`} role="status" aria-live="polite">
          {statusType === 'success' && '✅ '}
          {statusType === 'error' && '❌ '}
          {status}
        </div>
      )}

      {/* Post-conversion actions */}
      {lastBlob && (
        <div className="post-actions">
          <button className="copy-btn" onClick={handleRedownload}>
            ⬇️ Re-download
          </button>
          <button className="copy-btn" onClick={handleCopyCSV}>
            {copySuccess ? '✅ Copied!' : '📋 Copy to Clipboard'}
          </button>
          {rowsConverted !== null && (
            <div className="stat-badge">
              <span className="stat-badge__number">{rowsConverted}</span>
              <span className="stat-badge__label">rows converted</span>
            </div>
          )}
        </div>
      )}

      <a
        className="contact-btn"
        href="mailto:Btoth@serviceasap.com?subject=Tigerpaw%20CSV%20Converter%20Contact"
        target="_blank"
        rel="noopener noreferrer"
      >
        Email Brandon Toth About Issues
      </a>

      {(showConfetti || showEasterEgg) && <ConfettiBurst big={showEasterEgg} />}
      <Footer />
    </div>
  );
}

// ── Preview Panel ──────────────────────────────────────────────────────────
function PreviewPanel({ preview }) {
  const { headers, rows, totalRows } = preview;
  const missing = SF_REQUIRED.filter(c => !headers.includes(c));
  const allGood = missing.length === 0;

  return (
    <div className={`preview-panel${allGood ? '' : ' preview-panel--warn'}`}>
      <div className="preview-header">
        <span className="preview-title">📊 File Preview</span>
        <span className="preview-meta">{totalRows} row{totalRows !== 1 ? 's' : ''} detected</span>
      </div>

      {/* Column mapping status */}
      <div className="col-map-grid">
        {SF_REQUIRED.map(col => {
          const found = headers.includes(col);
          return (
            <div key={col} className={`col-badge ${found ? 'col-badge--ok' : 'col-badge--missing'}`}>
              <span className="col-badge__icon">{found ? '✅' : '❌'}</span>
              <span className="col-badge__sf">{col}</span>
              {found && (
                <>
                  <span className="col-badge__arrow">→</span>
                  <span className="col-badge__tp">{COLUMN_MAP[col]}</span>
                </>
              )}
              {!found && <span className="col-badge__warn">missing</span>}
            </div>
          );
        })}
      </div>

      {/* Sample data table — only shown when all columns are present */}
      {allGood && rows.length > 0 && (
        <div className="preview-table-wrap">
          <table className="preview-table">
            <thead>
              <tr>
                {SF_REQUIRED.map(col => <th key={col}>{col}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const idxMap = SF_REQUIRED.map(col => headers.indexOf(col));
                return (
                  <tr key={i}>
                    {idxMap.map((idx, j) => (
                      <td key={j}>{idx >= 0 && row[idx] ? row[idx] : <span className="cell-empty">—</span>}</td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length > 0 && <p className="preview-more">Showing first {rows.length} of {totalRows} rows</p>}
        </div>
      )}

      {!allGood && (
        <p className="preview-warning">
          ⚠️ {missing.length} required column{missing.length > 1 ? 's are' : ' is'} missing:{' '}
          <strong>{missing.join(', ')}</strong>. Conversion will fail.
        </p>
      )}
    </div>
  );
}

// ── Confetti ───────────────────────────────────────────────────────────────
function ConfettiBurst({ big }) {
  const bursts = Array.from({ length: big ? 18 : 7 });
  return (
    <>
      {bursts.map((_, i) => (
        <div key={i} style={{
          position: 'fixed',
          left: `${5 + Math.random() * 90}%`,
          top: `${5 + Math.random() * 85}%`,
          pointerEvents: 'none',
          zIndex: 9999,
          fontSize: `${2 + Math.random() * (big ? 4 : 2.5)}rem`,
          animation: 'fadeConfetti 2.2s linear',
          transform: `rotate(${Math.random() * 360}deg)`,
        }}>
          <span role="img" aria-label="confetti">{['🎉', '🎊', '✨', '💥', '🎈'][i % 5]}</span>
        </div>
      ))}
    </>
  );
}

// ── Footer ─────────────────────────────────────────────────────────────────
function Footer() {
  return (
    <footer className="footer">
      <span>© {new Date().getFullYear()} Brandon Toth • Made with <span role="img" aria-label="love">❤️</span> for Service ASAP</span>
      <span className="footer-sep">|</span>
      <span>v1.1.0-beta</span>
      <span className="footer-sep">|</span>
      <a
        href="https://scribehow.com/viewer/How_to_Use_Brandons_Salesforce_To_TigerPaw_Converter__UcSaDyXrQbyyoozC531-CQ"
        target="_blank"
        rel="noopener noreferrer"
        className="footer-link"
      >
        How to use
      </a>
    </footer>
  );
}

export default App;
