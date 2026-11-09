Unicode true
Name "Ion IDE"
OutFile "Ion-IDE-${ION_VERSION}-windows-x64-setup.exe"
InstallDir "$LOCALAPPDATA\Programs\Ion IDE"
RequestExecutionLevel user
CRCCheck force
SetCompressor /SOLID lzma
!ifndef ION_PUBLISHER
  !define ION_PUBLISHER "Vaddi Srisanth"
!endif
VIProductVersion "${ION_VERSION}.0"
VIAddVersionKey "ProductName" "Ion IDE"
VIAddVersionKey "CompanyName" "${ION_PUBLISHER}"
VIAddVersionKey "FileDescription" "Ion IDE Setup"
VIAddVersionKey "FileVersion" "${ION_VERSION}"
VIAddVersionKey "ProductVersion" "${ION_VERSION}"
VIAddVersionKey "LegalCopyright" ""

!include "MUI2.nsh"
!include "WinVer.nsh"
!include "x64.nsh"
!define MUI_ICON "ion.ico"
!define MUI_UNICON "ion.ico"
!define OPEN_WITH_KEY "Software\Classes\Applications\Ion IDE.exe"
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
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "${ION_PUBLISHER}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\App\Ion IDE.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '$\"$INSTDIR\Uninstall.exe$\" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  WriteRegStr HKCU "${OPEN_WITH_KEY}" "FriendlyAppName" "Ion IDE"
  WriteRegStr HKCU "${OPEN_WITH_KEY}\DefaultIcon" "" '$\"$INSTDIR\App\Ion IDE.exe$\",0'
  WriteRegStr HKCU "${OPEN_WITH_KEY}\shell\open\command" "" '$\"$INSTDIR\App\Ion IDE.exe$\" $\"%1$\"'
  WriteRegStr HKCU "${OPEN_WITH_KEY}\SupportedTypes" ".c" ""
  WriteRegStr HKCU "${OPEN_WITH_KEY}\SupportedTypes" ".h" ""
  WriteRegStr HKCU "${OPEN_WITH_KEY}\SupportedTypes" ".cc" ""
  WriteRegStr HKCU "${OPEN_WITH_KEY}\SupportedTypes" ".cpp" ""
  WriteRegStr HKCU "${OPEN_WITH_KEY}\SupportedTypes" ".cxx" ""
  WriteRegStr HKCU "${OPEN_WITH_KEY}\SupportedTypes" ".hpp" ""
  WriteRegStr HKCU "${OPEN_WITH_KEY}\SupportedTypes" ".java" ""
  WriteRegStr HKCU "${OPEN_WITH_KEY}\SupportedTypes" ".py" ""
  WriteRegStr HKCU "${OPEN_WITH_KEY}\SupportedTypes" ".python" ""
  WriteRegStr HKCU "${OPEN_WITH_KEY}\SupportedTypes" ".js" ""
  WriteRegStr HKCU "${OPEN_WITH_KEY}\SupportedTypes" ".cjs" ""
  WriteRegStr HKCU "${OPEN_WITH_KEY}\SupportedTypes" ".mjs" ""
  WriteRegStr HKCU "${OPEN_WITH_KEY}\SupportedTypes" ".ts" ""
  WriteRegStr HKCU "${OPEN_WITH_KEY}\SupportedTypes" ".tsx" ""
  WriteRegStr HKCU "${OPEN_WITH_KEY}\SupportedTypes" ".jsx" ""
  WriteRegStr HKCU "${OPEN_WITH_KEY}\SupportedTypes" ".html" ""
  WriteRegStr HKCU "${OPEN_WITH_KEY}\SupportedTypes" ".css" ""
  WriteRegStr HKCU "${OPEN_WITH_KEY}\SupportedTypes" ".json" ""
  WriteRegStr HKCU "${OPEN_WITH_KEY}\SupportedTypes" ".txt" ""
  WriteRegStr HKCU "${OPEN_WITH_KEY}\SupportedTypes" ".md" ""
  WriteRegStr HKCU "${OPEN_WITH_KEY}\SupportedTypes" ".markdown" ""
  WriteRegStr HKCU "${OPEN_WITH_KEY}\SupportedTypes" ".ipynb" ""
  WriteRegStr HKCU "${OPEN_WITH_KEY}\SupportedTypes" ".csv" ""
  WriteRegStr HKCU "${OPEN_WITH_KEY}\SupportedTypes" ".pdf" ""
  WriteRegStr HKCU "${OPEN_WITH_KEY}\SupportedTypes" ".docx" ""
  WriteRegStr HKCU "${OPEN_WITH_KEY}\SupportedTypes" ".xlsx" ""
  WriteRegStr HKCU "${OPEN_WITH_KEY}\SupportedTypes" ".pptx" ""
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
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
  DeleteRegKey HKCU "${OPEN_WITH_KEY}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  Goto done

  running:
  MessageBox MB_ICONSTOP "Close Ion IDE before running the uninstaller again." /SD IDOK
  SetErrorLevel 3
  Abort
  done:
SectionEnd
