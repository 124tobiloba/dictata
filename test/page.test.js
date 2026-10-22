// Static checks on the dashboard page itself.
//
// The page is plain HTML/CSS/JS with no build step, so nothing would catch a
// typo'd id or a stray webfont request. These tests do.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'src', 'dashboard');
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(DIR, 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(DIR, 'app.js'), 'utf8');

test('the page loads its own stylesheet and script', () => {
  assert.match(html, /<link rel="stylesheet" href="styles\.css"/);
  assert.match(html, /<script src="app\.js"><\/script>/);
});

test('every element the client looks up exists in the markup', () => {
  // $('#someId') / $$('#someId') lookups must resolve, or the page breaks at
  // runtime with a null dereference the tests would otherwise never see.
  const ids = new Set([...js.matchAll(/\$\$?\('#([\w-]+)'\)/g)].map((m) => m[1]));
  assert.ok(ids.size > 20, `expected the client to look up many ids, found ${ids.size}`);

  const missing = [...ids].filter((id) => !new RegExp(`id="${id}"`).test(html));
  assert.deepEqual(missing, [], `app.js references ids that index.html does not define: ${missing.join(', ')}`);
});

test('every tab has a matching panel', () => {
  const tabs = [...html.matchAll(/data-tab="([\w-]+)"/g)].map((m) => m[1]);
  const panels = [...html.matchAll(/data-panel="([\w-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tabs.sort(), panels.sort());
  assert.deepEqual(tabs.sort(), ['history', 'insights', 'live']);
});

test('hidden really hides', () => {
  // `display: grid/flex` on a layout class outranks the browser's [hidden]
  // rule, which once left the takeover card and the banner on screen while
  // the dashboard was perfectly healthy.
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
});

test('there is no demo mode left', () => {
  for (const [name, source] of [['index.html', html], ['app.js', js], ['styles.css', css]]) {
    assert.doesNotMatch(source, /\bdemo\b/i, `${name} still mentions a demo`);
    assert.doesNotMatch(source, /simulate|fake transcription/i, `${name} still simulates activity`);
  }
});

test('the page never fetches a webfont or any remote resource', () => {
  for (const [name, source] of [['index.html', html], ['styles.css', css], ['app.js', js]]) {
    assert.doesNotMatch(source, /@font-face/, `${name} declares a webfont`);
    assert.doesNotMatch(source, /fonts\.googleapis|fonts\.gstatic|cdn\./i, `${name} reaches out to a CDN`);
    assert.doesNotMatch(source, /https?:\/\/(?!127\.0\.0\.1)/, `${name} links to an external origin`);
  }
});

test('the layout is responsive', () => {
  const breakpoints = [...css.matchAll(/@media \(max-width: (\d+)px\)/g)].map((m) => Number(m[1]));
  assert.ok(breakpoints.length >= 3, 'expected at least three breakpoints');
  assert.ok(Math.min(...breakpoints) <= 620, 'expected a phone breakpoint');
  assert.ok(Math.max(...breakpoints) >= 1000, 'expected a wide-screen breakpoint');
  assert.match(css, /prefers-reduced-motion/);
});

test('the history view groups dictations by day', () => {
  assert.match(html, /data-panel="history"/);
  assert.match(js, /day-label/);
  assert.match(js, /fmtDay/);
});

test('a stale link gets a full-page explanation instead of an empty dashboard', () => {
  assert.match(html, /id="takeover"/);
  assert.match(js, /takeover/);
  // The offline state must hide the dashboard rather than render it empty.
  assert.match(js, /status === 'offline'[\s\S]{0,400}takeover\.hidden = false/);
  assert.match(js, /status === 'offline'[\s\S]{0,400}layout\.hidden = true/);
  // ...and the retry loop must not paint the quieter banner back on top of it.
  assert.match(js, /if \(state\.connection !== 'offline'\) setConnection\('reconnecting'\)/);
});

test('the row delete affordance exists in both the client and the stylesheet', () => {
  // Both row branches (dictation and failed attempt) render the control.
  assert.match(js, /class="rec-del"/);
  assert.match(js, /class="rec-del-confirm"/);
  assert.match(js, /aria-label="Delete this dictation"/);
  assert.match(css, /\.rec-del\s*\{/);
  assert.match(css, /\.rec-del-confirm/);
});

test('the delete affordance is invisible at rest and revealed by hover or focus', () => {
  assert.match(css, /\.rec-del\s*\{[^}]*opacity:\s*0/, 'the trash starts invisible');
  assert.match(css, /\.rec:hover \.rec-del[^{]*\{[^}]*opacity:\s*1/, 'hover reveals it');
  assert.match(css, /\.rec:focus-within \.rec-del[^{]*\{[^}]*opacity:\s*1/, 'row focus reveals it');
  assert.match(css, /\.rec-del:focus-visible[^{]*\{[^}]*opacity:\s*1/, 'keyboard focus reveals it');

  // Touch devices have no hover, so the control must always be visible there.
  assert.match(css, /@media \(hover: none\)[\s\S]{0,160}\.rec-del\s*\{[^}]*opacity:\s*1/);
});

test('the delete affordance is never removed from the tab order', () => {
  for (const match of css.matchAll(/([^{}]*\.rec-del[^{}]*)\{([^}]*)\}/g)) {
    const [, selector, body] = match;
    assert.doesNotMatch(body, /display:\s*none/, `${selector.trim()} hides the trash with display:none`);
    assert.doesNotMatch(body, /visibility:\s*hidden/, `${selector.trim()} hides the trash with visibility:hidden`);
  }
});

test('the clear-all control names the count before it deletes anything', () => {
  assert.match(html, /id="clearHistory"/);
  assert.match(html, /id="clearCancel"/);
  assert.match(html, /id="clearCount"/);
  // The confirmation state lives in the client state, not a DOM attribute.
  assert.match(js, /confirmClear:\s*false/);
  assert.match(js, /Delete all \$\{num\(count\)\} dictation/);
  assert.match(js, /method:\s*'DELETE'/);
});

test('the dashboard states the retention policy as read-only facts', () => {
  // D-02: retention, storage and the audit count are facts here; the one
  // control opens the Settings window, which owns the editable form.
  assert.match(html, /id="privacyFacts"/);
  assert.match(html, /id="openSettings"/);
  assert.match(js, /renderPrivacy/);
  assert.match(js, /Keep forever/);
  assert.match(js, /Retention: /);
  assert.match(js, /Audit records: /);
  // The path is a filesystem string, so it goes in with textContent.
  assert.match(js, /pathChip\.textContent = facts\.storeDir/);
  // A relative URL, a POST, and the token exactly like every other call.
  assert.match(js, /\/api\/settings\/open\?token=\$\{encodeURIComponent\(token\)\}/);
  assert.match(js, /method:\s*'POST'/);
});

// ── Settings window markup ────────────────────────────────────────────────────
// The second page in the app, checked the same way: no build step means a
// typo'd id is a null dereference at runtime, and nothing else would catch it.
const RENDERER_DIR = path.join(__dirname, '..', 'src', 'renderer');
const settingsHtml = fs.readFileSync(path.join(RENDERER_DIR, 'settings.html'), 'utf8');
const settingsJs = fs.readFileSync(path.join(RENDERER_DIR, 'settingsRenderer.js'), 'utf8');

test('every element the settings window looks up exists in its markup', () => {
  const ids = new Set([
    ...[...settingsJs.matchAll(/getElementById\('([\w-]+)'\)/g)].map((m) => m[1]),
    ...[...settingsJs.matchAll(/\b(?:bind|bindSelect|bindText|bindNumber)\('([\w-]+)'/g)].map((m) => m[1]),
  ]);
  assert.ok(ids.size > 18, `expected the window to look up many ids, found ${ids.size}`);

  const missing = [...ids].filter((id) => !new RegExp(`id="${id}"`).test(settingsHtml));
  assert.deepEqual(missing, [], `settingsRenderer.js references ids that settings.html does not define: ${missing.join(', ')}`);
});

test('every settings panel has a matching nav button', () => {
  const navs = [...settingsHtml.matchAll(/data-panel="([\w-]+)"/g)].map((m) => m[1]);
  assert.ok(navs.length >= 6, `expected the six settings sections, found ${navs.length}`);
  for (const panel of navs) {
    assert.match(settingsHtml, new RegExp(`id="panel-${panel}"`), `missing #panel-${panel}`);
  }
});

test('the settings window exposes the storage folder and a way to change it', () => {
  for (const id of ['storagePath', 'changeStorage', 'storageStatus']) {
    assert.match(settingsHtml, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  // The three facts the help copy has to state (D-15 and D-14).
  assert.match(settingsHtml, /logs/i, 'logs stay in app data');
  assert.match(settingsHtml, /current Windows user/i, 'the key is per-user');
  assert.match(settingsHtml, /survives uninstall/i, 'a moved store outlives the app');
});

test('a move updates the folder on screen before it reports success', () => {
  assert.match(settingsJs, /chooseStorageDir/);
  assert.match(settingsJs, /moveStorage/);
  // The window that started the move must not keep showing the old folder.
  assert.match(settingsJs, /moved[\s\S]{0,400}textContent = result\.dir/);
});

test('an open dashboard tab follows a storage move without a reload', () => {
  // The SSE info event carries kind: 'storage'; the client re-reads the
  // authoritative state instead of polling for the new path.
  assert.match(js, /kind === 'storage'[\s\S]{0,200}loadState\(\)/);
});
