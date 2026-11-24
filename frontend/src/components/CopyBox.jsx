// Read-only text with a Copy button (Clipboard API needs a secure context, which we have since step 2).
import { useState } from 'react';

export default function CopyBox({ text, rows = 5, label }) {
  const [copied, setCopied] = useState(false);

  const copy = async (e) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback (e.g. clipboard permission denied): select it so Ctrl/Cmd+C works.
      e.target.closest('.copy-box')?.querySelector('textarea')?.select();
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="copy-box">
      <textarea readOnly rows={rows} value={text} aria-label={label} onFocus={(e) => e.target.select()} />
      <div className="copy-box-bar">
        <span className="muted small">{text.length.toLocaleString()} chars</span>
        <button className="primary" onClick={copy}>
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
