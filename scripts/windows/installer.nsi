Unicode true
Name "Ion IDE"
OutFile "Ion-IDE-${ION_VERSION}-windows-x64-setup.exe"
InstallDir "$LOCALAPPDATA\Programs\Ion IDE"
RequestExecutionLevel user
CRCCheck force
SetCompressor /SOLID lzma
VIProductVersion "${ION_VERSION}.0"
VIAddVersionKey "ProductName" "Ion IDE"
VIAddVersionKey "CompanyName" "Vaddi Srisanth"
VIAddVersionKey "FileDescription" "Ion IDE Setup"
VIAddVersionKey "FileVersion" "${ION_VERSION}"
VIAddVersionKey "ProductVersion" "${ION_VERSION}"
VIAddVersionKey "LegalCopyright" ""

!include "MUI2.nsh"
!include "WinVer.nsh"
!include "x64.nsh"
!define MUI_ICON "ion.ico"
!define MUI_UNICON "ion.ico"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\dev.ionide.desktop"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\App\Ion IDE.exe"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${IfNot} ${RunningX64}
  ${OrIfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP "Ion IDE requires a 64-bit version of Windows 10 or later." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  ; Use the fixed application path for installation and managed upgrades.
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\Ion IDE"
  SetShellVarContext current
FunctionEnd

Section "Ion IDE"
  IfFileExists "$INSTDIR\App\Ion IDE.exe" 0 install
  ClearErrors
  FileOpen $0 "$INSTDIR\App\Ion IDE.exe" a
  IfErrors running
  FileClose $0

  install:
  SetOutPath "$INSTDIR\App"
  SetOverwrite on
  ClearErrors
  File /r "${ION_PAYLOAD}\*"
  IfErrors failed
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  IfErrors failed
  CreateShortcut "$SMPROGRAMS\Ion IDE.lnk" "$INSTDIR\App\Ion IDE.exe"
  IfErrors failed
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "Ion IDE"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${ION_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "Vaddi Srisanth"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\App\Ion IDE.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '$\"$INSTDIR\Uninstall.exe$\" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  Goto done

  running:
  MessageBox MB_ICONSTOP "Close Ion IDE before running Setup again." /SD IDOK
  SetErrorLevel 3
  Abort
  failed:
  MessageBox MB_ICONSTOP "Setup could not write the application files or shortcut. Check the available disk space and permissions, then run Setup again." /SD IDOK
  SetErrorLevel 4
  Abort
  done:
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  IfFileExists "$INSTDIR\App\Ion IDE.exe" 0 remove
  ClearErrors
  FileOpen $0 "$INSTDIR\App\Ion IDE.exe" a
  IfErrors running
  FileClose $0

  remove:
  ; The Electron profile in AppData\Roaming is separate from the app files.
  SetOutPath "$TEMP"
  Delete "$SMPROGRAMS\Ion IDE.lnk"
  !include "uninstall-files.nsh"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  Goto done

  running:
  MessageBox MB_ICONSTOP "Close Ion IDE before running the uninstaller again." /SD IDOK
  SetErrorLevel 3
  Abort
  done:
SectionEnd
