; Dictata — NSIS install hooks.
;
; Electron 44 refuses to create its sandboxed renderer processes when the install
; folder is not readable by the AppContainer token. Per-user installs under
; %LOCALAPPDATA%\Programs can inherit an ACL that carries an AppContainer package
; SID but not ALL APPLICATION PACKAGES, and the app then dies with:
;
;   FATAL:install_dir_access.cc: Sandboxed processes cannot read <dir>
;
; before any window or tray icon exists. Granting the well-known SID here fixes
; fresh installs and upgrades without asking the user to run anything.

!macro customInstall
  DetailPrint "Granting sandbox read access to the install folder"
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$INSTDIR" /grant *S-1-15-2-1:(OI)(CI)(RX)'
  Pop $0
!macroend
