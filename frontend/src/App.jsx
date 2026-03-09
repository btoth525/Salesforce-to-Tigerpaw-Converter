import { useRef, useState, useCallback } from 'react';
import './App.css';

const MAX_FILE_SIZE_MB = 10;

function App() {
  const fileInput = useRef();
  const [status, setStatus] = useState('');
  const [statusType, setStatusType] = useState(''); // 'success' | 'error' | 'info'
  const [converting, setConverting] = useState(false);
  const [showConfetti, setShowConfetti] = useState(false);
  const [showEasterEgg, setShowEasterEgg] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);

  const setMsg = (msg, type = 'info') => {
    setStatus(msg);
    setStatusType(type);
  };

  const validateFile = (file) => {
    if (!file) return 'Please select a CSV file.';
    if (!file.name.toLowerCase().endsWith('.csv')) return 'Only CSV files are allowed.';
    if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) return `File is too large. Maximum size is ${MAX_FILE_SIZE_MB} MB.`;
    return null;
  };

  const handleFileChange = (e) => {
    const file = e.target.files[0] || null;
    setSelectedFile(file);
    setMsg('');
  };

  const handleUpload = async (e) => {
    e.preventDefault();
    const file = selectedFile || fileInput.current?.files[0];
    const validationError = validateFile(file);
    if (validationError) {
      setMsg(validationError, 'error');
      return;
    }

    setMsg('Uploading and converting...', 'info');
    setConverting(true);
    setShowConfetti(false);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await fetch('/', { method: 'POST', body: formData });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        setMsg(err.error || 'Conversion failed. Please try again.', 'error');
        return;
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name.replace(/\.csv$/i, '_converted.csv');
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      setMsg('Conversion successful! Your download has started.', 'success');
      setShowConfetti(true);
      setTimeout(() => setShowConfetti(false), 2500);
    } catch {
      setMsg('Network error — please check your connection and try again.', 'error');
    } finally {
      setConverting(false);
    }
  };

  // Drag-and-drop handlers
  const onDragOver = useCallback((e) => { e.preventDefault(); setDragging(true); }, []);
  const onDragLeave = useCallback((e) => { e.preventDefault(); setDragging(false); }, []);
  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0] || null;
    if (file) {
      setSelectedFile(file);
      setMsg('');
      if (fileInput.current) {
        // Sync the native input (for form submit fallback)
        const dt = new DataTransfer();
        dt.items.add(file);
        fileInput.current.files = dt.files;
      }
    }
  }, []);

  // Easter egg: clicking the icon triggers a big confetti show
  const handleIconClick = () => {
    setShowEasterEgg(true);
    setTimeout(() => setShowEasterEgg(false), 2500);
  };

  return (
    <div className="container">
      <img
        src="/favicon.png"
        alt="App Icon"
        className="floating-icon"
        onClick={handleIconClick}
        style={{ cursor: 'pointer' }}
        title="Click me for a surprise!"
      />
      <h1>Salesforce → Tigerpaw CSV Magic</h1>

      <form onSubmit={handleUpload} className="upload-form">
        <div
          className={`drop-zone${dragging ? ' drop-zone--active' : ''}${selectedFile ? ' drop-zone--has-file' : ''}`}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onClick={() => fileInput.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && fileInput.current?.click()}
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
              <span className="drop-zone__size">({(selectedFile.size / 1024).toFixed(1)} KB)</span>
            </>
          ) : (
            <>
              <span className="drop-zone__icon">📂</span>
              <span className="drop-zone__hint">Drag &amp; drop your CSV here, or <u>click to browse</u></span>
              <span className="drop-zone__sub">Max {MAX_FILE_SIZE_MB} MB</span>
            </>
          )}
        </div>

        <button type="submit" disabled={converting} className={converting ? 'btn--loading' : ''}>
          {converting ? <><span className="spinner" /> Converting…</> : 'Convert & Download'}
        </button>
      </form>

      {status && (
        <div className={`status status--${statusType}`} role="status" aria-live="polite">
          {statusType === 'success' && '✅ '}
          {statusType === 'error' && '❌ '}
          {status}
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
          transform: `rotate(${Math.random() * 360}deg)`
        }}>
          <span role="img" aria-label="confetti">{['🎉', '🎊', '✨', '💥', '🎈'][i % 5]}</span>
        </div>
      ))}
    </>
  );
}

function Footer() {
  return (
    <footer style={{ marginTop: '2.5rem', color: '#888', fontSize: '0.98rem', opacity: 0.85 }}>
      <span>© {new Date().getFullYear()} Brandon Toth • Made with <span role="img" aria-label="love">❤️</span> for Service ASAP</span>
      <span style={{ marginLeft: 12, fontSize: '0.93rem' }}> | v1.1.0-beta</span>
      <span style={{ marginLeft: 12, fontSize: '0.93rem' }}> | Last updated: Mar 2026</span>
      <span style={{ marginLeft: 12 }}>
        <a
          href="https://scribehow.com/viewer/How_to_Use_Brandons_Salesforce_To_TigerPaw_Converter__UcSaDyXrQbyyoozC531-CQ"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: '#2a5298', textDecoration: 'underline', fontWeight: 600 }}
        >
          How to use
        </a>
      </span>
    </footer>
  );
}

export default App;
