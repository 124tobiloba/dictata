/**
 * paste.js — Clipboard save → write → Ctrl+V paste → restore
 *
 * Mirrors the Wispr Flow paste flow:
 *   1. Optionally focus the target window (so we paste into the right app).
 *   2. Save current clipboard.
 *   3. Write text (+ optional HTML) to clipboard.
 *   4. Simulate Ctrl+V (or Shift+Insert) in the foreground window.
 *   5. Wait briefly, then restore the original clipboard.
 *
 * The key-send is done by the long-lived PowerShell helper (see winhelper.js),
 * so no extra native dependency is needed on Windows.
 */

const { clipboard } = require('electron');
const { winHelper } = require('./winhelper');

const RESTORE_DELAY_MS = 600;  // give the target app time to paste

/**
 * Electron 44 exposes the clipboard asynchronously — readText() returns a
 * Promise. These helpers work with both the old (sync) and the new (async)
 * clipboard API, and never throw.
 */
async function readClipboardText() {
  try {
    const value = await Promise.resolve(clipboard.readText());
    return typeof value === 'string' ? value : '';
  } catch (e) {
    console.warn('[paste] clipboard read:', e.message);
    return '';
  }
}

async function readClipboardHtml() {
  try {
    if (typeof clipboard.readHTML !== 'function') return '';
    const value = await Promise.resolve(clipboard.readHTML());
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

async function writeClipboard({ text, html }) {
  if (html && typeof clipboard.write === 'function') {
    await Promise.resolve(clipboard.write({ text, html }));
    return;
  }
  await Promise.resolve(clipboard.writeText(text));
}

async function clearClipboard() {
  if (typeof clipboard.clear === 'function') await Promise.resolve(clipboard.clear());
  else await Promise.resolve(clipboard.writeText(''));
}

/**
 * @param {object} opts
 * @param {string}  opts.text            - plain text to paste
 * @param {string}  [opts.html]          - HTML version (optional, falls back to text)
 * @param {boolean} [opts.restore=true]  - restore original clipboard after paste
 * @param {string}  [opts.method]        - 'ctrl-v' | 'shift-insert'
 * @param {number}  [opts.hwnd]          - target window handle, if known
 * @param {boolean} [opts.allowKeys=true] - false → only fill the clipboard
 * @returns {Promise<{pasted: boolean}>}  pasted=false → the text is on the clipboard only
 */
async function pasteText({ text, html, restore = true, method = 'ctrl-v', hwnd = 0, allowKeys = true }) {
  // 1. Snapshot current clipboard (best effort — never block the paste)
  const prevText = await readClipboardText();
  const prevHTML = await readClipboardHtml();

  // 2. Bring the target window forward (verified — SetForegroundWindow can fail)
  let pasted = allowKeys;
  if (pasted && hwnd) {
    pasted = await winHelper.focusHwnd(hwnd);
    if (!pasted) console.warn('[paste] could not focus the target window — text left on the clipboard');
  }

  // 3. Write new content — awaited, otherwise the keystroke could paste
  //    the *previous* clipboard content.
  await writeClipboard({ text, html });

  // 4. Simulate paste keystroke via PowerShell
  if (pasted) {
    await simulatePaste(method);
  }

  // 5. Restore in the background (doesn't delay the pipeline).
  //    Only when the paste actually happened — otherwise the user needs
  //    the text to paste manually.
  if (restore && pasted) {
    setTimeout(() => {
      (async () => {
        try {
          if (prevHTML) await writeClipboard({ text: prevText, html: prevHTML });
          else if (prevText) await Promise.resolve(clipboard.writeText(prevText));
          else await clearClipboard();
        } catch (e) {
          console.warn('[paste] clipboard restore:', e.message);
        }
      })();
    }, RESTORE_DELAY_MS);
  }

  return { pasted };
}

/**
 * Uses PowerShell's SendKeys to simulate paste without robotjs.
 * Works across all Win32 apps — same technique as Wispr's helper.
 */
async function simulatePaste(method) {
  const key = method === 'shift-insert' ? '+{INSERT}' : '^v';
  await winHelper.sendKeys(key);
}

module.exports = { pasteText, readClipboardText };
