/**
 * paste.js — Clipboard save → write → Ctrl+V paste → restore
 *
 * Mirrors the Wispr Flow paste flow:
 *   1. Save current clipboard.
 *   2. Write text (+ optional HTML) to clipboard.
 *   3. Simulate Ctrl+V (or Shift+Insert) in the foreground window.
 *   4. Wait briefly, then restore the original clipboard.
 *
 * Uses robotjs-free approach: child_process PowerShell SendKeys is not
 * needed because uiohook-napi (already installed) does not support output.
 * Instead we use Electron's built-in clipboard + a PowerShell one-liner for
 * the actual key-send, which requires no extra native dep on Windows.
 */

const { clipboard } = require('electron');
const { winHelper } = require('./winhelper');

const RESTORE_DELAY_MS = 600;  // give the target app time to paste

/**
 * @param {object} opts
 * @param {string}  opts.text          - plain text to paste
 * @param {string}  [opts.html]        - HTML version (optional, falls back to text)
 * @param {boolean} [opts.restore=true]- restore original clipboard after paste
 * @param {string}  [opts.method]      - 'ctrl-v' | 'shift-insert'
 */
async function pasteText({ text, html, restore = true, method = 'ctrl-v' }) {
  // 1. Snapshot current clipboard (best effort — never block the paste)
  const prevText = safe(() => clipboard.readText(), '');
  const prevHTML = safe(() => (typeof clipboard.readHTML === 'function' ? clipboard.readHTML() : ''), '');

  // 2. Write new content
  if (html && typeof clipboard.write === 'function') {
    clipboard.write({ text, html });
  } else {
    clipboard.writeText(text);
  }

  // 3. Simulate paste keystroke via PowerShell
  await simulatePaste(method);

  // 4. Restore in the background (doesn't delay the pipeline)
  if (restore) {
    setTimeout(() => safe(() => {
      if (prevHTML && typeof clipboard.write === 'function') {
        clipboard.write({ text: prevText, html: prevHTML });
      } else if (prevText) {
        clipboard.writeText(prevText);
      }
    }), RESTORE_DELAY_MS);
  }
}

function safe(fn, fallback) {
  try { return fn(); } catch (e) { console.warn('[paste] clipboard:', e.message); return fallback; }
}

/**
 * Uses PowerShell's SendKeys to simulate paste without robotjs.
 * Works across all Win32 apps — same technique as Wispr's helper.
 */
async function simulatePaste(method) {
  const key = method === 'shift-insert' ? '+{INSERT}' : '^v';
  await winHelper.sendKeys(key);
}

module.exports = { pasteText };
