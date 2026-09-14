; NOVAI Windows 安装脚本 (NSIS 3.x)
; 用法: makensis installer.nsi

Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"

; ── 基本信息 ──
!define PRODUCT_NAME "NOVAI"
!define PRODUCT_DISPLAY "NOVAI 智能画布"
; 版本号：优先用命令行 -DPRODUCT_VERSION 传入，否则回退到写死的值
!ifndef PRODUCT_VERSION
  !define PRODUCT_VERSION "1.0.84"
!endif
!define PRODUCT_PUBLISHER "NOVAI"
!define PRODUCT_WEB_SITE "https://github.com/invaders-2/NOVAI"
!define PRODUCT_DIR_REGKEY "Software\Microsoft\Windows\CurrentVersion\App Paths\NOVAI.exe"
!define PRODUCT_UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}"

Name "${PRODUCT_DISPLAY} ${PRODUCT_VERSION}"
OutFile "dist-desktop\NOVAI-Setup-${PRODUCT_VERSION}.exe"
InstallDir "$PROGRAMFILES64\${PRODUCT_NAME}"
InstallDirRegKey HKLM "${PRODUCT_DIR_REGKEY}" ""
RequestExecutionLevel admin
SetCompressor /SOLID lzma

; ── 界面设置 ──
!define MUI_ABORTWARNING
!define MUI_ICON "static\images\icon.ico"
!define MUI_UNICON "static\images\icon.ico"

; 欢迎页面
!define MUI_WELCOMEPAGE_TITLE "欢迎安装 ${PRODUCT_DISPLAY}"
!define MUI_WELCOMEPAGE_TEXT "即将安装 ${PRODUCT_DISPLAY} v${PRODUCT_VERSION}。$\r$\n$\r$\n请关闭其他应用程序后再继续。"

; 完成页面
!define MUI_FINISHPAGE_RUN "$INSTDIR\NOVAI.exe"
!define MUI_FINISHPAGE_RUN_TEXT "启动 ${PRODUCT_DISPLAY}"
!define MUI_FINISHPAGE_SHOWREADME ""
!define MUI_FINISHPAGE_SHOWREADME_TEXT "创建桌面快捷方式"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateDesktopShortcut

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "LICENSE.nsi"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

; ── 安装区段 ──
Section "Install"
  SetOutPath "$INSTDIR"

  ; 停止旧进程
  DetailPrint "正在停止旧进程..."
  nsExec::ExecToLog 'taskkill /F /IM NOVAI.exe'
  Sleep 2000

  ; ── 复制文件 ──
  DetailPrint "正在安装文件..."

  ; 主程序
  File "dist-desktop\NOVAI.exe"

  ; 业务代码（可更新文件）
  File "main.py"
  File "app.py"
  File "VERSION"
  File "requirements.txt"

  ; 目录（排除测试图片、API 配置、日志等敏感/临时文件）
  SetOutPath "$INSTDIR\static"
  File /r /x "*.pyc" /x "__pycache__" /x "test-*.png" /x "tmp_*.png" /x "*.log" /x ".env" "static\*.*"

  SetOutPath "$INSTDIR\tools"
  File /r /x "*.pyc" /x "__pycache__" /x "test-*.png" /x "tmp_*.png" /x "*.log" /x ".env" "tools\*.*"

  SetOutPath "$INSTDIR"

  ; 即梦CLI脚本
  File "安装即梦CLI.bat"
  File "登录即梦CLI.bat"

  ; assets（图标等，排除 input/output/uploads + 测试/临时文件）
  SetOutPath "$INSTDIR\assets"
  File /r /x "*.pyc" /x "__pycache__" /x "test-*.png" /x "tmp_*.png" /x "*.log" /x ".env" /x "input" /x "output" /x "uploads" "assets\*.*"

  ; ── 注册表 ──
  WriteRegStr HKLM "${PRODUCT_DIR_REGKEY}" "" "$INSTDIR\NOVAI.exe"
  WriteRegStr HKLM "${PRODUCT_UNINST_KEY}" "DisplayName" "${PRODUCT_DISPLAY}"
  WriteRegStr HKLM "${PRODUCT_UNINST_KEY}" "UninstallString" "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "${PRODUCT_UNINST_KEY}" "DisplayIcon" "$INSTDIR\NOVAI.exe"
  WriteRegStr HKLM "${PRODUCT_UNINST_KEY}" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKLM "${PRODUCT_UNINST_KEY}" "Publisher" "${PRODUCT_PUBLISHER}"
  WriteRegStr HKLM "${PRODUCT_UNINST_KEY}" "URLInfoAbout" "${PRODUCT_WEB_SITE}"
  WriteRegDWORD HKLM "${PRODUCT_UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${PRODUCT_UNINST_KEY}" "NoRepair" 1

  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKLM "${PRODUCT_UNINST_KEY}" "EstimatedSize" "$0"

  ; ── 卸载程序 ──
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; ── 防火墙规则（允许 3000 端口入站，供局域网手机/iPad 访问）──
  DetailPrint "正在配置防火墙规则..."
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="NOVAI Server (port 3000)"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="NOVAI Server (port 3000)" dir=in action=allow protocol=TCP localport=3000'

  ; ── 快捷方式 ──
  CreateDirectory "$SMPROGRAMS\${PRODUCT_DISPLAY}"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_DISPLAY}\${PRODUCT_DISPLAY}.lnk" "$INSTDIR\NOVAI.exe"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_DISPLAY}\卸载 ${PRODUCT_DISPLAY}.lnk" "$INSTDIR\uninstall.exe"

  ; 桌面快捷方式在完成页面由用户选择是否创建
SectionEnd

; ── 桌面快捷方式（完成页面回调） ──
Function CreateDesktopShortcut
  CreateShortCut "$DESKTOP\${PRODUCT_DISPLAY}.lnk" "$INSTDIR\NOVAI.exe"
FunctionEnd

; ── 卸载区段 ──
Section "Uninstall"
  ; 停止进程
  nsExec::ExecToLog 'taskkill /F /IM NOVAI.exe'
  Sleep 2000
  nsExec::ExecToLog 'taskkill /F /IM msedge.exe'
  Sleep 1000

  ; 询问是否保留生成的数据与 API 设置
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "是否保留生成的数据与 API 设置？$\r$\n$\r$\n\
选「是」保留以下内容：$\r$\n\
  · 画布 / 对话记录 / 项目文件$\r$\n\
  · API 密钥与提供商配置$\r$\n\
  · 素材库与输出图片$\r$\n$\r$\n\
选「否」彻底删除所有用户数据。" \
    IDYES keep_data

  ; 删除用户数据目录
  RMDir /r "$APPDATA\NOVAI"
  Goto done_data

keep_data:
  ; 保留用户数据（$APPDATA\NOVAI 不删除）

done_data:

  ; 清理旧版安装残留（Local 目录）
  IfFileExists "$LOCALAPPDATA\NOVAI" 0 +2
    RMDir /r "$LOCALAPPDATA\NOVAI"

  ; 清理浏览器 WebView 缓存
  nsExec::ExecToLog 'cmd /c for /d %i in ("%LOCALAPPDATA%\Microsoft\Edge\User Data\Default\IndexedDB\http_localhost_3000*") do rd /s /q "%i"'
  nsExec::ExecToLog 'cmd /c rd /s /q "%LOCALAPPDATA%\Microsoft\Edge\User Data\Default\Local Storage\leveldb" 2>nul'

  ; 清理 Temp 下 NOVAI 残留
  FindFirst $0 $1 "$TEMP\NOVAI*"
  StrCmp $0 0 skip_temp_clean
loop_temp:
  IfFileExists "$TEMP\$1" 0 next_temp
    RMDir /r "$TEMP\$1"
next_temp:
  FindNext $0 $1
  StrCmp $1 "" skip_temp_clean loop_temp
skip_temp_clean:
  FindClose $0

  ; 删除安装目录
  RMDir /r "$INSTDIR"

  ; 删除防火墙规则
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="NOVAI Server (port 3000)"'

  ; 删除快捷方式
  Delete "$DESKTOP\${PRODUCT_DISPLAY}.lnk"
  RMDir /r "$SMPROGRAMS\${PRODUCT_DISPLAY}"

  ; 删除注册表
  DeleteRegKey HKLM "${PRODUCT_UNINST_KEY}"
  DeleteRegKey HKLM "${PRODUCT_DIR_REGKEY}"
SectionEnd
