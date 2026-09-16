; MCode's additions to electron-builder's one-click NSIS installer
; (electron-builder.yml: nsis.include).

; A first install goes into a folder named after the product, as MiMo's does
; (electron-builder's one-click default is the lower-case package name). An
; existing install - its folder is in the registry - and an explicit /D= stay
; exactly where they are.
!macro customInit
  Var /GLOBAL mcodeKnownFolder
  Var /GLOBAL mcodeChosenFolder
  Var /GLOBAL mcodeProgramsFolder
  ReadRegStr $mcodeKnownFolder HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  !insertmacro GetDParameter $mcodeChosenFolder
  ${if} $mcodeKnownFolder == ""
  ${andIf} $mcodeChosenFolder == ""
    ${GetParent} "$INSTDIR" $mcodeProgramsFolder
    StrCpy $INSTDIR "$mcodeProgramsFolder\${PRODUCT_FILENAME}"
  ${endIf}
!macroend

; What a real uninstall (not the one an update runs) also takes away:
;  - the mcode: link handler MCode registers for itself at launch
;    (app.setAsDefaultProtocolClient), but only while it still points at this
;    installation's MCode.exe - a handler another copy registered is left;
;  - electron-updater's cache folder (the downloaded update and the copy of
;    the installer the next differential download starts from).
; The profile in %APPDATA%\mcode stays, as electron-builder leaves it.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    Var /GLOBAL mcodeLinkCommand
    Var /GLOBAL mcodeLinkHead
    Var /GLOBAL mcodeFolderLength
    ReadRegStr $mcodeLinkCommand HKCU "Software\Classes\mcode\shell\open\command" ""
    StrCpy $mcodeLinkHead $mcodeLinkCommand 1
    ${if} $mcodeLinkHead == '"'
      StrCpy $mcodeLinkCommand $mcodeLinkCommand "" 1
    ${endIf}
    StrLen $mcodeFolderLength "$INSTDIR\"
    StrCpy $mcodeLinkHead $mcodeLinkCommand $mcodeFolderLength
    ; LogicLib's == compares without case, as Windows paths are.
    ${if} $mcodeLinkHead == "$INSTDIR\"
      DeleteRegKey HKCU "Software\Classes\mcode"
    ${endIf}
    RMDir /r "$LOCALAPPDATA\${APP_PACKAGE_NAME}-updater"
  ${endIf}
!macroend
