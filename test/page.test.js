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
