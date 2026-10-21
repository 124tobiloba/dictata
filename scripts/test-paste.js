/**
 * test-paste.js — end-to-end test of the paste pipeline.
 *
 * Verifies the part of the app that cannot be unit-tested: window
 * targeting, the SendKeys paste and the clipboard restore.
 *
 * It opens Notepad, dictates "into" it via the real pasteText() code path
 * and then checks that (a) Notepad really received the text and (b) the
 * original clipboard content was put back.
 *
 * Run with:  npm run test:paste
 */

const { app, clipboard } = require('electron');
const { spawn, execSync } = require('child_process');
const { pasteText, readClipboardText } = require('../src/main/paste');
const { winHelper } = require('../src/main/winhelper');

const ORIGINAL = 'ORIGINAL-CLIPBOARD-CONTENT';
const TEXT = 'Hello from Voice Flow';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

app.whenReady().then(async () => {
  console.log('\nVoice Flow — paste pipeline test\n');
  winHelper.start();
  await sleep(300);

  // 1. A known clipboard value that must survive the paste.
  await clipboard.writeText(ORIGINAL);

  // 2. Open Notepad and wait until it is really the foreground window.
  const notepad = spawn('notepad.exe', [], { detached: true, stdio: 'ignore' });
  notepad.unref();
  await sleep(2500);

  let target = await winHelper.foregroundTarget();
  if (!/notepad/i.test(target.name || '')) {
    console.log(`  (foreground is "${target.name}" — waiting for Notepad)`);
    await sleep(2000);
    target = await winHelper.foregroundTarget();
  }
  console.log(`  foreground window: ${JSON.stringify(target)}`);
  check('Notepad is the foreground window', /notepad/i.test(target.name || ''),
        `name="${target.name}"`);

  // 3. The real paste path.
  const result = await pasteText({ text: TEXT, hwnd: target.hwnd, restore: true });
  check('pasteText reports success', result.pasted === true);

  // 4. The clipboard must be restored (after the 600 ms restore delay).
  await sleep(1500);
  const restored = await readClipboardText();
  check('clipboard was restored', restored === ORIGINAL, `got "${restored}"`);

  // 5. Did Notepad actually receive the text? Select all + copy it back.
  await winHelper.sendKeys('^a');
  await winHelper.sendKeys('^c');
  await sleep(600);
  const notepadText = await readClipboardText();
  check('Notepad received the text', notepadText === TEXT, `got "${notepadText}"`);

  // 6. Paste without a target window must only fill the clipboard.
  await clipboard.writeText(ORIGINAL);
  const noTarget = await pasteText({ text: 'second paste', restore: false, allowKeys: false });
  check('paste without a target does not send keys', noTarget.pasted === false);
  check('paste without a target still fills the clipboard',
        (await readClipboardText()) === 'second paste');

  try { process.kill(notepad.pid); } catch { /* the broker may already be gone */ }
  // Notepad keeps the console pipe open, which would stop npm from
  // returning — close it before quitting.
  try { execSync('taskkill /IM notepad.exe /F', { stdio: 'ignore' }); } catch { /* none running */ }
  winHelper.stop();

  console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
  app.exit(failures === 0 ? 0 : 1);
});
