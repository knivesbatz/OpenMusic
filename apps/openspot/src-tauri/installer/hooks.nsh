; OpenSpot installer hooks (tauri.conf.json bundle.windows.nsis.installerHooks), inserted into Tauri's
; NSIS template (installer.nsi). NSIS_HOOK_POSTUNINSTALL runs at the end of OpenSpot's uninstaller.

!define OPENSPOT_APPROVED_KEY "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"

!macro NSIS_HOOK_POSTUNINSTALL
  ; Task Manager's enabled/disabled state of "Launch at startup" (the Run value itself is removed
  ; by the uninstaller).
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "${OPENSPOT_APPROVED_KEY}" "${PRODUCTNAME}"
  ${EndIf}
!macroend
