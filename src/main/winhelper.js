/**
 * winhelper.js — one long-lived PowerShell process for Win32 tasks.
 *
 * Spawning powershell.exe costs ~1–2 s each time. We start it ONCE at app
 * launch and send it line commands over stdin, so each call takes ~20–50 ms:
 *   "target"       → JSON { hwnd, pid, self, name } of the foreground window
 *   "focus <hwnd>" → bring that window to the foreground (verified)
 *   "keys ^v"      → SendKeys (Ctrl+V)
 * Every reply ends with a line "__END__".
 */

const { spawn } = require('child_process');

// The foreground window belongs to a *renderer* process, so comparing PIDs
// would not detect our own windows. Compare the executable path instead.
const APP_PATH = String(process.execPath || '').replace(/'/g, "''");

const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class VfWin32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
"@
[Console]::Out.WriteLine('__READY__'); [Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  if ($line -eq 'target') {
    $hwnd = [VfWin32]::GetForegroundWindow()
    $procId = 0
    [void][VfWin32]::GetWindowThreadProcessId($hwnd, [ref]$procId)
    $name = ''
    $path = ''
    try {
      $p = Get-Process -Id $procId
      if ($p -ne $null) {
        try { $name = $p.MainModule.FileVersionInfo.ProductName } catch { $name = '' }
        if (-not $name) { $name = $p.ProcessName }
        try { $path = $p.Path } catch { $path = '' }
      }
    } catch { $name = '' }
    $name = ($name -replace '\\\\', '/') -replace '"', "'"
    # The console codepage mangles non-ASCII characters, so the name is
    # sent base64-encoded and decoded on the Node side.
    $nameB64 = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($name))
    $self = 'false'
    if ($path -and ($path -eq '${APP_PATH}')) { $self = 'true' }
    $hwndVal = $hwnd.ToInt64()
    [Console]::Out.WriteLine('{"hwnd":' + $hwndVal + ',"pid":' + $procId + ',"self":' + $self + ',"nameB64":"' + $nameB64 + '"}')
  } elseif ($line.StartsWith('focus ')) {
    $hwndVal = 0
    [void][int]::TryParse($line.Substring(6).Trim(), [ref]$hwndVal)
    if ($hwndVal -le 0) {
      [Console]::Out.WriteLine('fail')
    } else {
      $h = [IntPtr]::new([int64]$hwndVal)
      $fg = [VfWin32]::GetForegroundWindow()
      $fgPid = 0
      $fgThread = [VfWin32]::GetWindowThreadProcessId($fg, [ref]$fgPid)
      $curThread = [VfWin32]::GetCurrentThreadId()
      [void][VfWin32]::AttachThreadInput($curThread, $fgThread, $true)
      if ([VfWin32]::IsIconic($h)) { [void][VfWin32]::ShowWindow($h, 9) }
      [void][VfWin32]::SetForegroundWindow($h)
      [void][VfWin32]::AttachThreadInput($curThread, $fgThread, $false)
      Start-Sleep -Milliseconds 40
      if ([VfWin32]::GetForegroundWindow() -eq $h) { [Console]::Out.WriteLine('ok') }
      else { [Console]::Out.WriteLine('fail') }
    }
  } elseif ($line.StartsWith('keys ')) {
    [System.Windows.Forms.SendKeys]::SendWait($line.Substring(5))
  }
  [Console]::Out.WriteLine('__END__'); [Console]::Out.Flush()
}
`;

class WinHelper {
  constructor() {
    this.proc = null;
    this.queue = [];      // pending { resolve, lines, timer }
    this.buf = '';
    this.ready = null;
  }

  start() {
    if (this.proc) return this.ready;
    this.proc = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });

    this.ready = new Promise((resolve) => { this._onReady = resolve; });

    this.proc.stdout.on('data', (d) => this._onData(d.toString()));
    this.proc.on('exit', () => {
      this.proc = null;
      this.queue.splice(0).forEach((q) => { clearTimeout(q.timer); q.resolve(''); });
    });

    // Feed the script, then keep stdin open for commands.
    this.proc.stdin.write(SCRIPT.replace(/\r?\n/g, '\r\n') + '\r\n');
    return this.ready;
  }

  _onData(s) {
    this.buf += s;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).replace(/\r$/, '');
      this.buf = this.buf.slice(idx + 1);
      if (line === '__READY__') { this._onReady?.(); continue; }
      const cur = this.queue[0];
      if (!cur) continue;
      if (line === '__END__') {
        this.queue.shift();
        clearTimeout(cur.timer);
        cur.resolve(cur.lines.join('\n').trim());
      } else {
        cur.lines.push(line);
      }
    }
  }

  async _cmd(cmd, timeoutMs = 2000) {
    this.start();
    await Promise.race([this.ready, wait(4000)]);
    if (!this.proc) return '';
    return new Promise((resolve) => {
      const entry = { resolve, lines: [] };
      entry.timer = setTimeout(() => {
        const i = this.queue.indexOf(entry);
        if (i >= 0) this.queue.splice(i, 1);
        resolve('');
      }, timeoutMs);
      this.queue.push(entry);
      this.proc.stdin.write(cmd + '\r\n');
    });
  }

  /**
   * The foreground window: { hwnd, pid, self, name }.
   * `self` is true when the foreground window belongs to Voice Flow itself.
   */
  async foregroundTarget() {
    const out = await this._cmd('target', 1500);
    try {
      const parsed = JSON.parse(out);
      let name = '';
      if (parsed.nameB64) {
        try { name = Buffer.from(parsed.nameB64, 'base64').toString('utf8'); } catch { name = ''; }
      }
      return {
        hwnd: Number(parsed.hwnd) || 0,
        pid: Number(parsed.pid) || 0,
        self: !!parsed.self,
        name,
      };
    } catch {
      return { hwnd: 0, pid: 0, self: false, name: '' };
    }
  }

  /** Bring a window to the foreground. Returns true when it worked. */
  async focusHwnd(hwnd) {
    if (!hwnd || hwnd <= 0) return false;
    const out = await this._cmd('focus ' + hwnd, 2000);
    return out === 'ok';
  }

  sendKeys(keys)  { return this._cmd('keys ' + keys, 2000); }

  stop() { try { this.proc?.stdin.end(); this.proc?.kill(); } catch {} this.proc = null; }
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = { winHelper: new WinHelper() };
