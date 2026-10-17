#!/usr/bin/env node
'use strict';
/*
 * 「按需安装 OpenClaw」引导的回归测试。
 *
 * 守住的是这条路径的契约，不是覆盖率：
 *   [1] 安装命令 / 地址 / 体积提示 / Node 版本要求只存在于 config/openclaw.json
 *   [2] 前端业务代码（core / state / modal / banner）里不出现任何 URL 或安装命令字面量
 *   [3] Node 版本提示三态：满足 / 低于官方要求 / 未检测到
 *   [4] 引导入口只在「确实没装」时出现；检测失败不误报
 *   [5] SSE 事件 → 进度日志的映射完整（start/log/verify/done/error）
 *   [6] 手动安装指引与命令展示全部取自后端 payload，不前端拼命令
 *   [7] 安装只能由弹窗里的显式确认触发；入口按钮只开弹窗
 *   [8] 权限提示 / 权限失败指引 / Chrome 检测路径与提示文案全部来自 config/openclaw.json；
 *       没有 Chrome 只提示、不阻断安装；权限失败错误码与手动指引透传到前端
 *
 * 跑法：node tests/test_openclaw_setup.js
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const AGENTS = path.join(ROOT, 'web/src/pages/chat/agents');
const CORE = path.join(AGENTS, 'openclawSetupCore.js');
const STATE = path.join(AGENTS, 'openclawSetup.js');
const MODAL = path.join(AGENTS, 'OpenClawInstallModal.vue');
const BANNER = path.join(AGENTS, 'OpenClawSetupBanner.vue');
const CONFIG = path.join(ROOT, 'config/openclaw.json');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if (cond) pass += 1; else fails.push(label); };
const eq = (actual, expected, label) => ok(JSON.stringify(actual) === JSON.stringify(expected),
    label + ' 期望' + JSON.stringify(expected) + ' 实际' + JSON.stringify(actual));
const read = file => fs.readFileSync(file, 'utf8');

const SAMPLE = {
    ok: true, config_ok: true,
    config_source: '/repo/config/openclaw.json',
    available: false, installed: false,
    binary_path: '', version: '', version_raw: '',
    gateway: { url: 'ws://127.0.0.1:18789', host: '127.0.0.1', port: 18789, reachable: false },
    node: { path: '/usr/bin/node', version: '22.22.3', satisfies: false, required_min: '24.16.0', required_alt_min: '26.1.0', note: 'note' },
    chrome: { found: true, path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', source: 'chrome.paths', searched: [], note: 'chrome-note', impact_note: 'chrome-impact', impact_note_origin: 'chrome.impact_note' },
    setup: {
        platform: 'darwin', windows: false,
        command: 'curl -fsSL https://openclaw.ai/install.sh | bash',
        command_origin: 'install.command_unix',
        shell: '/bin/bash',
        script_url: 'https://openclaw.ai/install.sh',
        size_hint: '约 100–300 MB', network_note: '需要联网', docs_url: 'https://docs.openclaw.ai/start/getting-started',
        privilege_note: '将自动安装 Node.js 与全部依赖；过程中可能弹出系统密码框、需要管理员权限',
        privilege_note_origin: 'install.privilege_note',
        permission_hint: '请在弹出的系统密码框里确认授权',
        permission_hint_origin: 'install.permission_hint',
        node_warning_title: 'Node 不达标会改动系统 Node（系统级）',
        node_warning_title_origin: 'node.warning_title',
        node_warning: 'macOS 上 Node 不达标时官方脚本会用 Homebrew 升级系统 Node（实测）',
        node_warning_origin: 'node.warning',
        init_incomplete_title: '包已安装，但初始化未完成',
        init_incomplete_title_origin: 'install.init_incomplete_title',
        init_incomplete_note: 'doctor 失败并以 EXIT=1 结束，按下面顺序收尾',
        init_incomplete_note_origin: 'install.init_incomplete_note',
        doctor_steps: [
            { label: '1. 停止 Gateway', value: 'openclaw gateway stop' },
            { label: '2. 修复并迁移数据', value: 'openclaw doctor --fix' },
            { label: '3. 重新启动 Gateway', value: 'openclaw gateway start' },
        ],
        doctor_steps_origin: 'install.doctor_steps',
        doctor_hint: '执行完点重新检测',
        doctor_hint_origin: 'install.doctor_hint',
        install_docs_url: 'https://docs.openclaw.ai/install', windows_docs_url: 'https://docs.openclaw.ai/platforms/windows',
        npm_command: 'npx openclaw@latest', timeout_ms: 900000,
    },
    errors: [], checked_at: 1, cached: false,
};

(async () => {
    const core = await import(pathToFileURL(CORE).href);
    const cfg = JSON.parse(read(CONFIG));

    console.log('[1] 安装命令 / 地址 / 版本要求只存在于 config/openclaw.json');
    eq(cfg.install.command_unix, 'curl -fsSL https://openclaw.ai/install.sh | bash', 'macOS/Linux 官方命令与文档一致');
    eq(cfg.install.command_windows, 'iwr -useb https://openclaw.ai/install.ps1 | iex', 'Windows 官方 PowerShell 命令与文档一致');
    eq(cfg.install.script_url_unix, 'https://openclaw.ai/install.sh', '安装脚本地址来自配置');
    eq(cfg.node.required_min, '24.16.0', 'Node 最低版本来自配置');
    eq(cfg.node.required_alt_min, '26.1.0', 'Node 备选版本来自配置');
    eq(cfg.gateway.port, 18789, 'Gateway 端口来自配置');
    ok(!!cfg.install.size_hint && !!cfg.install.network_note, '体积提示与联网提示来自配置');
    ok(Array.isArray(cfg.binary.names) && cfg.binary.names.includes('openclaw'), '可执行文件名来自配置');

    console.log('[2] 前端业务代码里不出现 URL / 命令字面量');
    for (const [name, file] of [['core', CORE], ['state', STATE], ['modal', MODAL], ['banner', BANNER]]) {
        const src = read(file);
        ok(!/https?:\/\//.test(src), name + ' 不含 http(s) URL 字面量');
    }
    ok(!/curl -fsSL|openclaw\.ai\/install|iwr -useb/.test(read(CORE) + read(STATE) + read(MODAL) + read(BANNER)),
        '前端不出现安装命令字面量');

    console.log('[3] Node 版本提示三态');
    const lower = core.normalizeStatus(SAMPLE).node;
    eq(core.nodeHint(lower).level, 'warn', '低于官方要求 → warn');
    ok(/22\.22\.3/.test(core.nodeHint(lower).text) && /24\.16\.0/.test(core.nodeHint(lower).text), '如实告知本机版本与官方要求');
    ok(/安装脚本/.test(core.nodeHint(lower).text), '说明官方脚本会处理 Node（不偷偷绕过）');
    const okNode = Object.assign({}, SAMPLE.node, { version: '24.16.0', satisfies: true });
    eq(core.nodeHint(okNode).level, 'ok', '满足官方要求 → ok');
    const noNode = Object.assign({}, SAMPLE.node, { version: '', satisfies: false });
    eq(core.nodeHint(noNode).level, 'unknown', '未检测到 Node → unknown');
    eq(core.nodeRequirementLabel(SAMPLE.node), '24.16.0+ 或 26.1.0+', '版本要求文案来自配置');

    console.log('[4] 引导入口只在确实没装时出现');
    ok(core.needsInstall(core.normalizeStatus(SAMPLE)) === true, '未安装 → 需要引导');
    ok(core.needsInstall(core.normalizeStatus(Object.assign({}, SAMPLE, { installed: true, available: true, version: '2026.6.9' }))) === false, '已安装 → 不显示引导');
    ok(core.needsInstall(null) === false, '检测失败（status 为空）→ 不误报');

    console.log('[5] SSE 事件 → 进度日志');
    eq(core.eventToLog({ event: 'start', command: 'x' }, 'start').kind, 'start', 'start 映射');
    eq(core.eventToLog({ event: 'log', line: 'ok' }, 'log').text, 'ok', 'log 行原样保留');
    eq(core.eventToLog({ event: 'verify', message: 'v' }, 'verify').kind, 'verify', 'verify 映射');
    eq(core.eventToLog({ event: 'done', ok: true, message: '好' }, 'done').level, 'ok', 'done 成功级别');
    eq(core.eventToLog({ event: 'done', ok: false, message: '坏' }, 'done').level, 'error', 'done 失败级别');
    eq(core.eventToLog({ event: 'error', message: '炸' }, 'error').level, 'error', 'error 映射');
    ok(core.eventToLog({}, '') === null, '空事件不产出日志');

    console.log('[6] 命令 / 手动指引全部来自后端 payload');
    const normalized = core.normalizeStatus(SAMPLE);
    eq(core.commandOf(normalized), SAMPLE.setup.command, '命令取自 status.setup.command');
    eq(core.sizeLabel(normalized), SAMPLE.setup.size_hint, '体积提示取自 payload');
    ok(/可达|不可达/.test(core.verifyLabel(normalized)), '验证一行同时报版本与 Gateway');
    const steps = core.manualSteps(normalized);
    ok(steps.some(s => s.value === SAMPLE.setup.command), '手动指引包含命令');
    ok(steps.some(s => s.value === SAMPLE.setup.npm_command), '手动指引包含 npm 方式');
    ok(steps.some(s => s.url === SAMPLE.setup.docs_url), '手动指引包含官方文档');
    ok(core.manualSteps(core.normalizeStatus({})).length === 0, '没有配置时不给假命令');

    console.log('[7] 只有显式确认才会执行安装');
    ok(core.canStartInstall(normalized) === true, '配置就绪时可安装');
    ok(core.canStartInstall(core.normalizeStatus(Object.assign({}, SAMPLE, { config_ok: false }))) === false, '配置缺失时不可安装');
    const bannerSrc = read(BANNER);
    const modalSrc = read(MODAL);
    const stateSrc = read(STATE);
    ok(/openInstallModal/.test(bannerSrc) && !/startInstall/.test(bannerSrc), '入口按钮只打开弹窗，不直接安装');
    ok(/确认安装/.test(modalSrc), '弹窗有显式「确认安装」按钮');
    ok(/confirmInstall/.test(modalSrc) && /startInstall/.test(stateSrc), '安装由弹窗确认函数驱动');
    ok(!/onMounted\([^)]*startInstall/.test(stateSrc + modalSrc), '挂载时不自动安装');
    ok(/commandOrigin|command_origin/.test(modalSrc + read(CORE)), '弹窗展示命令来源配置项');

    console.log('[8] 权限提示与 Chrome 检测（文案 / 路径来自配置）');
    ok(/管理员权限/.test(cfg.install.privilege_note) && /Node\.js/.test(cfg.install.privilege_note), '安装前的权限提示来自配置，写明可能弹密码框 / 需要管理员权限');
    ok(/达标/.test(cfg.install.privilege_note) && /Homebrew/.test(cfg.install.privilege_note) && /不会进行任何系统权限操作/.test(cfg.install.privilege_note),
        '权限提示改为条件式：Node 达标无系统权限操作，不达标才经系统包管理器（macOS 为 Homebrew）');
    ok(!!cfg.install.permission_hint, '权限失败的手动指引来自配置');
    ok(Array.isArray(cfg.install.permission_error_patterns) && cfg.install.permission_error_patterns.length > 0, '权限失败识别特征来自配置');
    const chromeCfg = cfg.chrome || {};
    ok(Array.isArray(chromeCfg.paths && chromeCfg.paths.darwin) && chromeCfg.paths.darwin.some(p => /Google Chrome\.app/.test(p)), 'macOS Chrome 常见路径来自配置');
    ok(Array.isArray(chromeCfg.names) && chromeCfg.names.includes('chromium'), 'Chrome 命令名来自配置');
    ok(!!chromeCfg.impact_note, 'Chrome 缺失提示文案来自配置');

    const normalizedChrome = core.normalizeStatus(SAMPLE);
    eq(normalizedChrome.setup.privilege_note, SAMPLE.setup.privilege_note, 'privilege_note 透传到前端状态');
    eq(normalizedChrome.setup.privilege_note_origin, 'install.privilege_note', '权限文案带来源配置项');
    eq(core.chromeHint(normalizedChrome).level, 'ok', '检测到 Chrome → ok');
    ok(/Google Chrome/.test(core.chromeHint(normalizedChrome).text), 'Chrome ok 时展示实际路径');
    const noChrome = core.normalizeStatus(Object.assign({}, SAMPLE, { chrome: { found: false, impact_note: '没有浏览器', impact_note_origin: 'chrome.impact_note' } }));
    eq(core.chromeHint(noChrome).level, 'warn', '没有 Chrome → warn');
    ok(/没有浏览器/.test(core.chromeHint(noChrome).text), 'Chrome 缺失提示取自配置，不前端硬编码');
    ok(core.chromeMissing(noChrome) === true, 'chromeMissing 供入口条使用');
    ok(core.canStartInstall(noChrome) === true, '没有 Chrome 不阻断 OpenClaw 安装');
    eq(core.eventToLog({ event: 'error', code: 'permission_denied', hint: '去授权', message: '权限不足' }, 'error').code, 'permission_denied', '权限失败错误码透传');
    eq(core.eventToLog({ event: 'error', code: 'permission_denied', hint: '去授权', message: '权限不足' }, 'error').hint, '去授权', '权限失败手动指引透传');
    ok(/privilege_note/.test(modalSrc) && /chromeHint/.test(modalSrc), '弹窗展示权限提示与 Chrome 提示');
    ok(/data-oc-permission/.test(modalSrc) && /permissionDenied/.test(modalSrc), '权限失败有独立明确提示块');
    ok(/chromeHint|chromeMissing/.test(bannerSrc), '入口条展示 Chrome 提示');
    ok(/privilege_note/.test(stateSrc) || /privilege_note/.test(modalSrc), '权限文案不硬编码在组件外');

    console.log('[9] Node 系统级改动警告 / 包已装但初始化未完成的独立终态');
    ok(!!cfg.node.warning && /Homebrew/.test(cfg.node.warning) && /macOS/.test(cfg.node.warning) && /系统级/.test(cfg.node.warning),
        'node.warning 写明 macOS 上 Node 不达标会用 Homebrew 做系统级升级');
    ok(!!cfg.node.warning_title, 'node.warning_title 来自配置');
    ok(!!cfg.install.init_incomplete_title && !!cfg.install.init_incomplete_note, '初始化未完成的标题与说明来自配置');
    ok(Array.isArray(cfg.install.doctor_steps) && cfg.install.doctor_steps.some(s => s.value === 'openclaw doctor --fix'),
        'doctor 收尾步骤来自配置');
    ok(!!cfg.install.doctor_hint, 'doctor 收尾提示来自配置');

    const nw = core.nodeWarning(normalized);
    eq(nw.text, SAMPLE.setup.node_warning, 'nodeWarning 文案取自后端 payload');
    eq(nw.title, SAMPLE.setup.node_warning_title, 'nodeWarning 标题取自后端 payload');
    eq(nw.origin, 'node.warning', 'nodeWarning 带来源配置项');
    eq(core.initIncompleteTitle(normalized), SAMPLE.setup.init_incomplete_title, '初始化未完成标题取自 payload');
    eq(core.initIncompleteNote(normalized), SAMPLE.setup.init_incomplete_note, '初始化未完成说明取自 payload');
    eq(core.doctorSteps(normalized).length, 3, 'doctor 步骤取自 payload');
    ok(core.doctorSteps(normalized).some(s => s.value === 'openclaw doctor --fix'), 'doctor 步骤含 doctor --fix');
    eq(core.doctorHint(normalized), SAMPLE.setup.doctor_hint, 'doctor 提示取自 payload');

    const partialLog = core.eventToLog({ event: 'done', ok: false, code: 'init_incomplete', outcome: 'partial', init_incomplete: true, message: '包已装但收尾失败' }, 'done');
    eq(partialLog.initIncomplete, true, 'done 事件能标出「包已装但初始化未完成」');
    eq(partialLog.outcome, 'partial', 'done 事件透传 outcome');
    eq(partialLog.level, 'error', '初始化未完成仍不算成功');
    eq(core.eventToLog({ event: 'done', ok: false, message: '退出码 1：未知错误' }, 'done').initIncomplete, false,
        '普通失败不误判为初始化未完成');

    ok(/'partial'/.test(stateSrc) && /initIncomplete/.test(stateSrc), '状态机有 partial 终态');
    ok(/data-oc-partial/.test(modalSrc), '结果页有「初始化未完成」独立分支');
    ok(/data-oc-node-warning/.test(modalSrc), '弹窗有 Node 系统级改动警告块');
    ok(/initIncompleteTitle|initIncompleteNote|doctorSteps/.test(modalSrc), '结果页展示配置里的初始化未完成文案与 doctor 指引');
    ok(!/gateway stop|doctor --fix|gateway start/.test(read(CORE) + stateSrc + modalSrc + read(BANNER)),
        '前端不出现 doctor 收尾命令字面量');

    console.log('OpenClaw 按需安装引导：' + pass + ' 项通过' + (fails.length ? '，' + fails.length + ' 项失败' : ''));
    if (fails.length) {
        fails.forEach(name => console.error('  \u2717 ' + name));
        console.error('OpenClaw 按需安装引导：失败 ' + fails.length + ' 项');
        process.exit(1);
    }
    console.log('全部通过');
})().catch(err => {
    console.error('测试异常：' + (err && err.stack || err));
    process.exit(1);
});
