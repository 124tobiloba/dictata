// historyRenderer.js

const list  = document.getElementById('list');
const empty = document.getElementById('empty');

// The last snapshot the main process pushed. Kept so the clear-all prompt can
// name the count that is about to go.
let lastHistory = [];

async function init() {
  const data = await window.vf.getStore();
  render(data.history || []);
  window.vf.onHistoryUpdated(render);
}

function render(history) {
  const entries = list.querySelectorAll('.entry');
  entries.forEach((e) => e.remove());
  lastHistory = history || [];
  empty.style.display = history.length ? 'none' : 'block';

  history.forEach((item) => {
    const el = document.createElement('div');
    el.className = 'entry';
    el.innerHTML = `
      <div class="entry-meta">
        <span>${fmtDate(item.at)}</span>
        <span class="duration-badge">${fmtDur(item.durationMs)}</span>
      </div>
      <div class="entry-text">${esc(item.cleaned || item.raw)}</div>
      ${item.raw && item.raw !== item.cleaned
        ? `<div class="entry-raw" id="raw-${item.id}">Raw: ${esc(item.raw)}</div>`
        : ''}
      <div class="entry-actions">
        <button class="entry-btn paste" data-id="${item.id}" data-text="${esc(item.cleaned || item.raw)}">Paste again</button>
        ${item.raw && item.raw !== item.cleaned
          ? `<button class="entry-btn" onclick="toggleRaw('${item.id}')">Show raw</button>`
          : ''}
        <button class="entry-btn del" data-id="${item.id}">Delete</button>
      </div>
    `;
    list.insertBefore(el, empty.nextSibling);
  });

  // Events
  list.querySelectorAll('.entry-btn.paste').forEach((btn) => {
    btn.addEventListener('click', () => window.vf.pasteEntry(btn.dataset.text));
  });

  list.querySelectorAll('.entry-btn.del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      // No local DOM surgery: the main process pushes the authoritative
      // vf:history-updated snapshot and render() rebuilds the list from it.
      await window.vf.deleteHistory(btn.dataset.id);
    });
  });
}

window.toggleRaw = (id) => {
  const el = document.getElementById(`raw-${id}`);
  if (el) el.classList.toggle('visible');
};

document.getElementById('btn-clear').addEventListener('click', async () => {
  const count = lastHistory.length;
  if (!count) return;
  // The prompt names the count; the push re-renders the empty list.
  if (!confirm(`Delete all ${count} dictation${count === 1 ? '' : 's'}?`)) return;
  await window.vf.clearHistory();
});

document.getElementById('btn-settings').addEventListener('click', () => {
  window.vf.openSettings();
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

function fmtDur(ms) {
  if (!ms) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function esc(s = '') {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

init();
