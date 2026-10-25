// Guards on the Windows packaging configuration.
//
// These are the failures that only show up after someone downloads the app, so
// the unit tests are the only cheap place to catch them: an installer that does
// not grant the sandbox SID crashes before it draws a window, and a packaged
// .env would ship somebody's API key.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const nsis = fs.readFileSync(path.join(ROOT, 'build', 'installer.nsh'), 'utf8');

test('the installer grants the AppContainer read SID Electron 44 requires', () => {
  // Electron 44 aborts with FATAL:install_dir_access.cc when the install folder
  // is not readable by the sandbox token. A per-user NSIS install under
  // %LOCALAPPDATA%\Programs can inherit exactly that ACL.
  assert.match(nsis, /S-1-15-2-1/, 'missing ALL APPLICATION PACKAGES grant');
  assert.match(nsis, /icacls/, 'the grant is never applied');
  assert.match(nsis, /!macro\s+customInstall/, 'the hook does not run at install time');
  assert.equal(pkg.build.nsis.include, 'build/installer.nsh');
});

test('the package whitelist cannot pick up a secrets file', () => {
  const files = pkg.build.files;
  assert.ok(files.includes('src/**/*'));
  assert.ok(files.includes('assets/**/*'));
  assert.ok(!files.some((f) => /\.env|secret|credential/i.test(f)), 'build.files includes a secrets path');
  // scripts/ holds test helpers that read the environment; it must stay out.
  assert.ok(!files.some((f) => /^scripts/.test(f)), 'build.files ships the dev scripts');
});

test('the installer artifact name matches the release metadata', () => {
  // electron-builder writes latest.yml with the artifactName. If the two drift,
  // an auto-update downloads a URL that does not exist.
  assert.match(pkg.build.artifactName, /\$\{productName\}-Setup-\$\{version\}/);
});
