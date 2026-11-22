Unicode true

; Grace Studio installer, modelled on the Attendance Report Studio installer:
; a plain welcome -> options -> install -> finish wizard, per-user install in
; LOCALAPPDATA so Windows never shows an administrator prompt, Start Menu
; shortcut, optional desktop shortcut and a proper uninstall entry.

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

!ifndef APP_VERSION
  !define APP_VERSION "0.0.0"
!endif
!ifndef APP_ARCH
  !define APP_ARCH "x64"
!endif
!ifndef OUTPUT_DIR
  !error "Pass OUTPUT_DIR as the directory for the generated setup file"
!endif

!define APP_NAME "Grace Studio"
!define APP_PUBLISHER "Grace Wood Industry"
!define APP_EXE "Grace Studio.exe"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\GraceStudio"
!define INSTALL_DIR "$LOCALAPPDATA\Programs\Grace Studio"

Name "${APP_NAME}"
Caption "${APP_NAME} Setup"
BrandingText "${APP_PUBLISHER}"
OutFile "${OUTPUT_DIR}\GraceStudio-Setup-${APP_VERSION}.exe"
InstallDir "${INSTALL_DIR}"
RequestExecutionLevel user
SetCompressor /SOLID zlib
ShowInstDetails show
Unicode true

VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "${APP_NAME} Setup"
VIAddVersionKey "FileDescription" "${APP_NAME} installer"
VIAddVersionKey "FileVersion" "${APP_VERSION}.0"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "CompanyName" "${APP_PUBLISHER}"
VIAddVersionKey "LegalCopyright" "Copyright (c) 2026 ${APP_PUBLISHER}"

!define MUI_ABORTWARNING
!ifndef ICON_PATH
  !define ICON_PATH "${__FILEDIR__}/../build/icon.ico"
!endif
!define MUI_ICON "${ICON_PATH}"
!define MUI_UNICON "${ICON_PATH}"
!define MUI_WELCOMEPAGE_TITLE "Welcome to ${APP_NAME}"
!define MUI_WELCOMEPAGE_TEXT "This will install ${APP_NAME} on your computer.$\r$\n$\r$\nIt installs for the current Windows user. No administrator password is needed.$\r$\n$\r$\nClick Next to continue."
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Launch ${APP_NAME}"
!define MUI_FINISHPAGE_TITLE "${APP_NAME} is installed"
!define MUI_FINISHPAGE_TEXT "${APP_NAME} has been installed. Open Settings inside the app and add the language model endpoint, model and key to start making brochures."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "This installer is for 64-bit Windows."
    Abort
  ${EndIf}
  StrCpy $INSTDIR "${INSTALL_DIR}"
FunctionEnd

Function un.onInit
  StrCpy $INSTDIR "${INSTALL_DIR}"
FunctionEnd

Section "Grace Studio (required)" SecApp
  SectionIn RO
  SetShellVarContext current
  SetOutPath "$TEMP"

  ; A fresh copy on every install, so upgrades do not leave old Electron files
  ; behind. User data lives in APPDATA, not here, and is never touched.
  nsExec::ExecToLog 'taskkill /IM "${APP_EXE}" /F'
  RMDir /r "$INSTDIR"
  SetOutPath "$INSTDIR"
  File /r "${PAYLOAD_DIR}\*"

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}"

  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" "$\"$INSTDIR\Uninstall.exe$\""
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" "$\"$INSTDIR\Uninstall.exe$\" /S"
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "EstimatedSize" 133000
SectionEnd

Section /o "Create a desktop shortcut" SecDesktop
  SetShellVarContext current
  CreateShortCut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}"
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  SetOutPath "$TEMP"

  ; Close the app if it is still running, otherwise Windows locks its files.
  nsExec::ExecToLog 'taskkill /IM "${APP_EXE}" /F'

  Delete "$INSTDIR\Uninstall.exe"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"
  Delete "$DESKTOP\${APP_NAME}.lnk"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  RMDir /r "$INSTDIR"
SectionEnd
