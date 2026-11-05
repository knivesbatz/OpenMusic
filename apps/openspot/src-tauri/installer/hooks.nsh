; OpenSpot installer hooks (tauri.conf.json bundle.windows.nsis.installerHooks), inserted into Tauri's
; NSIS template (installer.nsi): NSIS_HOOK_PREINSTALL runs before the files are copied,
; NSIS_HOOK_POSTINSTALL after the files, registry keys and shortcuts are written, and
; NSIS_HOOK_POSTUNINSTALL at the end of OpenSpot's own uninstaller.
;
; OpenSpot 2.x replaces YTSpot and PLEXSpot 1.x. It keeps YTSpot's identifier (app.openmusic.ytspot),
; so YTSpot's data is already OpenSpot's, and the app imports PLEXSpot's data
; (app.openmusic.plexspot) on its first start. These hooks therefore only remove the old programs
; (files, shortcuts, Add/Remove Programs entries) and carry "Launch at startup" over. They never
; touch %APPDATA% or %LOCALAPPDATA%\app.openmusic.*, except POSTUNINSTALL, which removes PLEXSpot's
; old data folders when "Delete app data" is ticked in OpenSpot's uninstaller.
;
; installMode is "currentUser": the 1.x apps were installed per user too, so everything lives under
; HKCU and the user's own folders.

!define OPENSPOT_UNINST_ROOT "Software\Microsoft\Windows\CurrentVersion\Uninstall"
!define OPENSPOT_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define OPENSPOT_APPROVED_KEY "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"
; HKEY_CURRENT_USER for System::Call (sign-extended, so it is right for 32- and 64-bit stubs).
!define OPENSPOT_HKCU -2147483647

; Strips one pair of surrounding double quotes from VAR (registry paths are stored quoted).
!macro OPENSPOT_UNQUOTE VAR
  StrCpy $R9 ${VAR} 1
  ${If} $R9 == '"'
    StrCpy ${VAR} ${VAR} "" 1
    StrCpy $R9 ${VAR} 1 -1
    ${If} $R9 == '"'
      StrCpy ${VAR} ${VAR} -1
    ${EndIf}
  ${EndIf}
!macroend

; Moves a 1.x "Launch at startup" entry (tauri-plugin-autostart: HKCU Run value named after the
; product, "<exe> --htpc") to OpenSpot, with its Task Manager enabled/disabled state. Must run
; before the old uninstaller, which deletes the Run value.
!macro OPENSPOT_TAKE_AUTOSTART NAME
  ReadRegStr $R3 HKCU "${OPENSPOT_RUN_KEY}" "${NAME}"
  ${If} $R3 != ""
    ReadRegStr $R4 HKCU "${OPENSPOT_RUN_KEY}" "${PRODUCTNAME}"
    ${If} $R4 == ""
      DetailPrint "Launch at startup: moving ${NAME}'s entry to ${PRODUCTNAME}"
      WriteRegStr HKCU "${OPENSPOT_RUN_KEY}" "${PRODUCTNAME}" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" --htpc"
      ; The StartupApproved value is binary (12 bytes); copy it as it is.
      System::Alloc 64
      Pop $R5
      StrCpy $R6 64
      System::Call 'advapi32::RegGetValueW(p ${OPENSPOT_HKCU}, w "${OPENSPOT_APPROVED_KEY}", w "${NAME}", i 0x8, p 0, p R5, *i R6 R6) i .R7'
      ${If} $R7 == "0"
        System::Call 'advapi32::RegSetKeyValueW(p ${OPENSPOT_HKCU}, w "${OPENSPOT_APPROVED_KEY}", w "${PRODUCTNAME}", i 3, p R5, i R6) i .R7'
      ${EndIf}
      System::Free $R5
    ${EndIf}
    DeleteRegValue HKCU "${OPENSPOT_RUN_KEY}" "${NAME}"
  ${EndIf}
  DeleteRegValue HKCU "${OPENSPOT_APPROVED_KEY}" "${NAME}"
!macroend

; Uninstalls a 1.x app found through its Add/Remove Programs key (it may have been installed
; anywhere: the 1.x installer had a directory page). Skipped when the key is missing.
!macro OPENSPOT_REMOVE_OLD NAME
  ReadRegStr $R2 HKCU "${OPENSPOT_UNINST_ROOT}\${NAME}" "DisplayName"
  ReadRegStr $R1 HKCU "${OPENSPOT_UNINST_ROOT}\${NAME}" "InstallLocation"
  !insertmacro OPENSPOT_UNQUOTE $R1
  ${If} $R1 == ""
    ReadRegStr $R3 HKCU "${OPENSPOT_UNINST_ROOT}\${NAME}" "UninstallString"
    !insertmacro OPENSPOT_UNQUOTE $R3
    ${If} $R3 != ""
      ${GetParent} $R3 $R1
    ${ElseIf} $R2 != ""
      StrCpy $R1 "$LOCALAPPDATA\${NAME}"
    ${EndIf}
  ${EndIf}
  ${If} $R1 != ""
    ${If} $R1 == $INSTDIR
      ; Installed into the same folder: our uninstall.exe replaced the old one, so only the old
      ; executable is left.
      Delete "$INSTDIR\${NAME}.exe"
    ${Else}
      ${If} ${FileExists} "$R1\uninstall.exe"
        DetailPrint "Removing ${NAME} from $R1"
        ; "_?=" runs the uninstaller in place, so ExecWait really waits (without it, an NSIS
        ; uninstaller copies itself to %TEMP% and returns at once). /S never deletes app data (the
        ; "Delete app data" box is never ticked), and there is no /UPDATE, so the old shortcuts go too.
        ExecWait '"$R1\uninstall.exe" /S _?=$R1' $R4
        DetailPrint "${NAME} uninstaller exit code: $R4"
        ; An in-place uninstaller can't delete itself.
        Delete "$R1\uninstall.exe"
      ${EndIf}
      Delete "$R1\${NAME}.exe"
      RMDir "$R1"
    ${EndIf}
  ${EndIf}
  ; Leftovers the uninstaller may keep: its Add/Remove Programs entry and the remembered install
  ; folder / installer language.
  DeleteRegKey HKCU "${OPENSPOT_UNINST_ROOT}\${NAME}"
  DeleteRegKey HKCU "Software\${MANUFACTURER}\${NAME}"
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; The 1.x updater starts this installer as the old app quits; make sure neither old app still
  ; holds its files (and the shared single-instance lock).
  nsis_tauri_utils::KillProcessCurrentUser "YTSpot.exe"
  Pop $R0
  DetailPrint "Close YTSpot: $R0"
  nsis_tauri_utils::KillProcessCurrentUser "PLEXSpot.exe"
  Pop $R0
  DetailPrint "Close PLEXSpot: $R0"
  Sleep 500
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro OPENSPOT_TAKE_AUTOSTART "YTSpot"
  !insertmacro OPENSPOT_TAKE_AUTOSTART "PLEXSpot"
  !insertmacro OPENSPOT_REMOVE_OLD "YTSpot"
  !insertmacro OPENSPOT_REMOVE_OLD "PLEXSpot"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; "Delete app data" removes ${BUNDLEID} (YTSpot's and OpenSpot's data). PLEXSpot's folders,
  ; kept as a backup after the import, go with it.
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    RMDir /r "$APPDATA\app.openmusic.plexspot"
    RMDir /r "$LOCALAPPDATA\app.openmusic.plexspot"
  ${EndIf}
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "${OPENSPOT_APPROVED_KEY}" "${PRODUCTNAME}"
  ${EndIf}
!macroend
