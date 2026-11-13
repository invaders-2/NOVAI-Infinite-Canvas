; NOVAI 数据保护（Windows NSIS 自定义脚本）
;
; 「默认数据根 = 安装目录」之后，data/、assets/、output/、history.json、API/ 都放在 $INSTDIR 里。
; electron-builder 默认卸载会直接 "RMDir /r $INSTDIR"（templates/nsis/uninstaller.nsh），
; 覆盖安装 / 在线更新又会先跑上一个版本的卸载器把 $INSTDIR 清空 —— 用户数据会跟着程序一起没。
;
; 这里在删除动作之前把这几项挪到安装目录旁边的暂存目录，删除 / 安装完成后再挪回来，
; 目录内容本身一个字节都不动：
;   手动卸载：customUnInit（删前挪走）→ electron-builder 默认删除 → customUnInstall（删后放回）
;   覆盖安装：customInit（旧卸载器跑之前挪走）→ 安装 → customInstall（装好放回）
;   用户取消安装：.onGUIEnd 兜底放回
;
; 故意不定义 customRemoveFiles：那样会替换掉 electron-builder 自己的原子删除（atomicRMDir）逻辑，
; 这里只做「挪走 / 放回」，删除行为保持原样。
;
; 暂存目录 = $INSTDIR 的同级目录（同一个盘，只做 rename，不复制大文件）；装完 / 卸完自动删掉。
; 万一中途崩溃，数据还留在 "<安装目录>.novai-data-keep-*" 旁边，不会被清掉。

!include "LogicLib.nsh"

!define NOVAI_KEEP_PREFIX ".novai-data-keep"

Var novaiKeepDir
Var novaiKeepPending

!ifdef BUILD_UNINSTALLER
  ; 只在卸载器里用：1 = 用户选了「一并删除」，0 = 保留（默认 / 静默）
  Var novaiDeleteData
!endif

; 安装目录里有没有用户数据（任意一项存在就算）
!macro NOVAI_ANY_DATA _OUT
  StrCpy ${_OUT} "0"
  ${If} ${FileExists} "$INSTDIR\data"
  ${OrIf} ${FileExists} "$INSTDIR\assets"
  ${OrIf} ${FileExists} "$INSTDIR\output"
  ${OrIf} ${FileExists} "$INSTDIR\API"
  ${OrIf} ${FileExists} "$INSTDIR\history.json"
    StrCpy ${_OUT} "1"
  ${EndIf}
!macroend

; 把一项用户数据挪到暂存目录（同盘 rename）
!macro NOVAI_KEEP_MOVE_OUT _NAME
  ${If} ${FileExists} "$INSTDIR\${_NAME}"
    ClearErrors
    Rename "$INSTDIR\${_NAME}" "$novaiKeepDir\${_NAME}"
    ${If} ${Errors}
      Sleep 500
      ClearErrors
      Rename "$INSTDIR\${_NAME}" "$novaiKeepDir\${_NAME}"
      ${If} ${Errors}
        ClearErrors
        DetailPrint `[NOVAI] 无法暂存 ${_NAME}（可能仍被占用），它可能随程序文件一起被删除`
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

; 从暂存目录放回安装目录；目标已存在时不覆盖，改名为 .novai-restored 并保留
!macro NOVAI_KEEP_MOVE_BACK _NAME
  ${If} ${FileExists} "$novaiKeepDir\${_NAME}"
    ${IfNot} ${FileExists} "$INSTDIR\${_NAME}"
      ClearErrors
      Rename "$novaiKeepDir\${_NAME}" "$INSTDIR\${_NAME}"
      ${If} ${Errors}
        ClearErrors
        DetailPrint `[NOVAI] 恢复 ${_NAME} 失败，数据仍在 $novaiKeepDir`
      ${EndIf}
    ${Else}
      ClearErrors
      Rename "$novaiKeepDir\${_NAME}" "$INSTDIR\${_NAME}.novai-restored"
      ${If} ${Errors}
        ClearErrors
        DetailPrint `[NOVAI] $INSTDIR\${_NAME} 已存在，${_NAME} 留在 $novaiKeepDir`
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

; 删除前调用：有数据就先挪到暂存目录
!macro NOVAI_KEEP_BEGIN _SUFFIX
  StrCpy $novaiKeepDir "$INSTDIR${NOVAI_KEEP_PREFIX}-${_SUFFIX}"
  StrCpy $novaiKeepPending "0"
  !insertmacro NOVAI_ANY_DATA $0
  ${If} $0 == "1"
    CreateDirectory "$novaiKeepDir"
    ${If} ${Errors}
      ClearErrors
      StrCpy $novaiKeepDir "$TEMP\novai-data-keep-${_SUFFIX}"
      CreateDirectory "$novaiKeepDir"
    ${EndIf}
    StrCpy $novaiKeepPending "1"
    !insertmacro NOVAI_KEEP_MOVE_OUT data
    !insertmacro NOVAI_KEEP_MOVE_OUT assets
    !insertmacro NOVAI_KEEP_MOVE_OUT output
    !insertmacro NOVAI_KEEP_MOVE_OUT API
    !insertmacro NOVAI_KEEP_MOVE_OUT history.json
    DetailPrint `[NOVAI] 用户数据先挪到 $novaiKeepDir，完成后自动放回`
  ${EndIf}
!macroend

; 恢复完清理空的暂存目录（非空就保留，绝不 RMDir /r）
!macro NOVAI_KEEP_END
  ${If} $novaiKeepPending == "1"
    RMDir "$novaiKeepDir"
    StrCpy $novaiKeepPending "0"
  ${EndIf}
!macroend

!macro NOVAI_KEEP_RESTORE
  ${If} $novaiKeepPending == "1"
    !insertmacro NOVAI_KEEP_MOVE_BACK data
    !insertmacro NOVAI_KEEP_MOVE_BACK assets
    !insertmacro NOVAI_KEEP_MOVE_BACK output
    !insertmacro NOVAI_KEEP_MOVE_BACK API
    !insertmacro NOVAI_KEEP_MOVE_BACK history.json
    !insertmacro NOVAI_KEEP_END
    DetailPrint `[NOVAI] 用户数据已放回 $INSTDIR`
  ${EndIf}
!macroend

!ifndef BUILD_UNINSTALLER
  ; 安装 / 覆盖安装前确认 NOVAI 已经退出。
  ;
  ; 不能用 electron-builder 的 CHECK_APP_RUNNING：它内部带 loop: 标签，而 .onInit 里已经插了
  ; ALLOW_ONLY_ONE_INSTALLER_INSTANCE（同样有 loop:），NSIS 的 label 是函数作用域，会报
  ; 「label "loop:" already declared in function」（v2.0.07 Windows 打包就是这么挂的）；
  ; 自定义 include 又是在 CHECK_APP_RUNNING 定义之前被 include 的，不能包一层 Function 再引它。
  ; 这里直接 tasklist + find 判断（不定义任何和别处重名的标签），运行中就提示并 taskkill。
  !macro NOVAI_APP_RUNNING_CHECK
    nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | %SYSTEMROOT%\System32\find.exe /I "${APP_EXECUTABLE_FILENAME}"`
    Pop $0
  !macroend

  !macro NOVAI_CLOSE_APP
    !insertmacro NOVAI_APP_RUNNING_CHECK
    ${If} $0 == "0"
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "NOVAI 正在运行，安装 / 覆盖安装前需要先关闭它。$\r$\n$\r$\n点「确定」自动关闭 NOVAI 后继续安装；点「取消」退出安装。" /SD IDOK IDOK novai_close_app IDCANCEL novai_abort_install
      novai_close_app:
        nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c taskkill /f /im "${APP_EXECUTABLE_FILENAME}"`
        Sleep 1500
        Goto novai_after_close
      novai_abort_install:
        Quit
      novai_after_close:
    ${EndIf}
  !macroend

  ; ---- 安装 / 覆盖安装 ----
  ; .onInit 里 initMultiUser 之后调用：先关掉正在运行的 NOVAI，
  ; 再把 $INSTDIR 里的用户数据挪到旁边 —— 旧版卸载器（哪怕它自己不认识这些目录）就删不到数据了，
  ; 装完 customInstall 再放回。
  !macro customInit
    !insertmacro NOVAI_CLOSE_APP
    Sleep 300
    !insertmacro NOVAI_KEEP_BEGIN install
  !macroend

  !macro customInstall
    !insertmacro NOVAI_KEEP_RESTORE
  !macroend

  ; 用户取消安装 / 安装失败退出时，把已经挪走的数据放回原位
  Function .onGUIEnd
    ${If} $novaiKeepPending == "1"
      !insertmacro NOVAI_KEEP_RESTORE
    ${EndIf}
  FunctionEnd
!endif

!ifdef BUILD_UNINSTALLER
  ; ---- 卸载 ----
  ; un.onInit 里 initMultiUser 之后、默认删除之前调用：先问用户「保留 / 一并删除」，再决定挪不挪数据。
  ; 静默卸载（/S、覆盖安装时旧版本卸载器）不弹窗，一律按「保留」处理。
  !macro customUnInit
    StrCpy $novaiDeleteData "0"
    ${IfNot} ${Silent}
      ; 原生 NSIS MessageBox 不支持 MB_DEFBUTTON2，默认按钮会是「是」，误按回车就删数据；
      ; 这里直接调 user32::MessageBox，flag = MB_YESNOCANCEL(0x03) | MB_ICONWARNING(0x30) | MB_DEFBUTTON2(0x100) = 0x133，
      ; 默认按钮 = 第二个「否 = 保留数据」。返回值：6=是(一并删除) 7=否(保留) 2=取消。
      System::Call 'user32::MessageBox(i 0, t "是否一并删除 NOVAI 的用户数据？$\r$\n$\r$\n是 = 一并删除：安装目录里的 data、assets、output、API、history.json，以及 $APPDATA\NOVAI$\r$\n否 = 保留数据（推荐，默认）：只删程序文件，数据留在原安装目录$\r$\n取消 = 退出卸载，不删任何东西", t "NOVAI 卸载", i 0x133) i .r0'
      ${If} $0 == 6
        StrCpy $novaiDeleteData "1"
      ${ElseIf} $0 == 7
        StrCpy $novaiDeleteData "0"
      ${Else}
        Abort
      ${EndIf}
    ${EndIf}
    ${If} $novaiDeleteData == "0"
      !insertmacro NOVAI_KEEP_BEGIN uninstall
    ${EndIf}
  !macroend

  ; 默认删除完成、快捷方式与注册表清理之后调用：按用户选择恢复数据 / 删掉 %APPDATA%\NOVAI，并说明结果
  !macro customUnInstall
    ${If} $novaiDeleteData == "1"
      ; 用户选了「一并删除」：安装目录里的数据已随默认删除清空，这里再删稳定配置 / 老用户数据。
      ; 只删这两处，config 里 data_root 指向的外部自定义目录不碰。
      SetShellVarContext current
      RMDir /r "$APPDATA\NOVAI"
      DetailPrint "[NOVAI] 程序与用户数据已删除（含 $APPDATA\NOVAI）"
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONINFORMATION "程序和用户数据已删除。"
      ${EndIf}
    ${Else}
      !insertmacro NOVAI_KEEP_RESTORE
      !insertmacro NOVAI_ANY_DATA $0
      ${If} $0 == "1"
        DetailPrint "[NOVAI] 程序文件已删除，用户数据保留在 $INSTDIR（data / assets / output / API / history.json）"
        ${IfNot} ${Silent}
          MessageBox MB_OK|MB_ICONINFORMATION "程序已卸载。$\r$\n$\r$\n用户数据已保留在：$\r$\n$INSTDIR$\r$\n（data、assets、output、API 文件夹和 history.json）$\r$\n$\r$\n如果确认不再需要，手动删除这个目录即可彻底清空。"
        ${EndIf}
      ${EndIf}
    ${EndIf}
  !macroend
!endif
