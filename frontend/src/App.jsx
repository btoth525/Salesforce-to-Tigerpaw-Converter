import { useRef, useState } from 'react';
import './App.css';

function App() {
  const fileInput = useRef();
  const [status, setStatus] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [showConfetti, setShowConfetti] = useState(false);
  const [showEasterEgg, setShowEasterEgg] = useState(false);

  const handleUpload = async (e) => {
    e.preventDefault();
    setStatus('');
    setDownloading(false);
    setShowConfetti(false);
    const file = fileInput.current.files[0];
    if (!file) {
      setStatus('Please select a CSV file.');
      return;
    }
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setStatus('Only CSV files are allowed.');
      return;
    }
    setStatus('Uploading and converting...');
    const formData = new FormData();
    formData.append('file', file);
    try {
      const response = await fetch('/', {
        method: 'POST',
        body: formData,
      });
      if (!response.ok) {
        const err = await response.json();
        setStatus(err.error || 'Conversion failed.');
        return;
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name.replace(/\.csv$/i, '_converted.csv');
      document.body.appendChild(a);
      setDownloading(true);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      setStatus('Conversion successful! Download should start automatically.');
      setShowConfetti(true);
      setTimeout(() => setShowConfetti(false), 2500);
    } catch (err) {
      setStatus('Error uploading file.');
    } finally {
      setDownloading(false);
    }
  };

  // Easter egg: clicking the icon triggers a big confetti show
  const handleIconClick = () => {
    setShowEasterEgg(true);
    setTimeout(() => setShowEasterEgg(false), 2500);
  };

  return (
    <div className="container">
      <img src="/favicon.png" alt="App Icon" className="floating-icon" onClick={handleIconClick} style={{cursor:'pointer'}} title="Click me for a surprise!" />
      <h1>Salesforce → Tigerpaw CSV Magic</h1>
      <form onSubmit={handleUpload} className="upload-form">
        <input type="file" accept=".csv" ref={fileInput} />
        <button type="submit" disabled={downloading}>Convert & Download</button>
      </form>
      {status && <div className="status">{status}</div>}
      <a className="contact-btn" href="mailto:Btoth@serviceasap.com?subject=Tigerpaw%20CSV%20Converter%20Contact" target="_blank" rel="noopener noreferrer">
        Email Brandon Toth About Issues
      </a>
      {(showConfetti || showEasterEgg) && <ConfettiBurst big={showEasterEgg} />}
      <Footer />
    </div>
  );
}

function ConfettiBurst({ big }) {
  // More bursts if big (easter egg)
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
          <span role="img" aria-label="confetti">{['🎉','🎊','✨','💥','🎈'][i%5]}</span>
        </div>
      ))}
    </>
  );
}

function Footer() {
  return (
    <footer style={{marginTop: '2.5rem', color: '#888', fontSize: '0.98rem', opacity: 0.85}}>
      <span>© {new Date().getFullYear()} Brandon Toth • Made with <span role="img" aria-label="love">❤️</span> for Service ASAP</span>
      <span style={{marginLeft: 12, fontSize: '0.93rem'}}> | v1.0.0</span>
      <span style={{marginLeft: 12, fontSize: '0.93rem'}}> | Last updated: Aug 2025</span>
      <span style={{marginLeft: 12}}>
        <a href="https://scribehow.com/viewer/How_to_Use_Brandons_Salesforce_To_TigerPaw_Converter__UcSaDyXrQbyyoozC531-CQ" target="_blank" rel="noopener noreferrer" style={{color:'#2a5298', textDecoration:'underline', fontWeight:600}}>
          How to use
        </a>
      </span>
    </footer>
  );
}

export default App;
