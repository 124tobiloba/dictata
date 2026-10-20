/**
 * winhelper.js — one long-lived PowerShell process for Win32 tasks.
 *
 * Spawning powershell.exe costs ~1–2 s each time. We start it ONCE at app
 * launch and send it line commands over stdin, so each call takes ~20–50 ms:
 *   "app"       → prints the foreground app's product name
 *   "keys ^v"   → SendKeys (Ctrl+V)
 * Every reply ends with a line "__END__".
 */

const { spawn } = require('child_process');

const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class VfWin32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
}
"@
[Console]::Out.WriteLine('__READY__'); [Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  if ($line -eq 'app') {
    $procId = 0
    [VfWin32]::GetWindowThreadProcessId([VfWin32]::GetForegroundWindow(), [ref]$procId) | Out-Null
    $p = Get-Process -Id $procId
    $n = $p.MainModule.FileVersionInfo.ProductName
    if (-not $n) { $n = $p.ProcessName }
    [Console]::Out.WriteLine($n)
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

  foregroundApp() { return this._cmd('app', 1500); }
  sendKeys(keys)  { return this._cmd('keys ' + keys, 2000); }

  stop() { try { this.proc?.stdin.end(); this.proc?.kill(); } catch {} this.proc = null; }
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = { winHelper: new WinHelper() };
