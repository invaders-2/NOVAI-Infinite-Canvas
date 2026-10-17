// OpenClaw 安装引导的纯逻辑：状态归一化 / 事件转日志 / 手动安装步骤。
// 不 import vue、不碰 DOM，方便直接被 node 测试动态 import（tests/test_openclaw_setup.js）。
// 所有命令、地址、体积与版本要求都来自后端 /api/openclaw/status（源头是 config/openclaw.json），
// 这里不出现任何 URL 或命令字面量。

function text(v) { return v == null ? '' : String(v); }

export function nodeRequirementLabel(node) {
    const n = node && typeof node === 'object' ? node : {};
    const min = text(n.required_min).trim();
    const alt = text(n.required_alt_min).trim();
    if (min && alt) return min + '+ 或 ' + alt + '+';
    return min || alt || '';
}

// Node 提示分三态：ok=满足；warn=装了但低于官方要求（如实告知，不阻挡安装）；unknown=本机没有 node
export function nodeHint(node) {
    const n = node && typeof node === 'object' ? node : {};
    const version = text(n.version).trim();
    const label = nodeRequirementLabel(n);
    if (!version) {
        return { level: 'unknown', version: '', label: label, text: '未检测到 Node.js。官方要求 ' + (label || '更高版本') + '；官方安装脚本会一并处理 Node 与依赖。' };
    }
    if (n.satisfies) {
        return { level: 'ok', version: version, label: label, text: 'Node ' + version + '，满足官方要求 ' + (label || '') + '。' };
    }
    return {
        level: 'warn', version: version, label: label,
        text: '本机 Node ' + version + '，低于官方要求的 ' + (label || '') + '。官方安装脚本会替用户装好 Node 与全部依赖；本引导不代为降级或绕过。',
    };
}

// Chrome 提示分两态：ok=找到了；warn=没找到（如实提示浏览器抓取不可用，但不阻断 OpenClaw 安装）
export function chromeHint(status) {
    const c = (status && status.chrome) || {};
    if (c.found) {
        return { level: 'ok', path: text(c.path), text: '已检测到 Chrome：' + (text(c.path) || '') + '，浏览器抓取可用。' };
    }
    const impact = text(c.impact_note).trim();
    return {
        level: 'warn', path: '',
        text: impact || '未检测到 Chrome，浏览器抓取功能将不可用；OpenClaw 安装脚本不会代为安装，OpenClaw 本体仍可安装。',
    };
}

export function chromeMissing(status) {
    return !!(status && status.chrome && status.chrome.found !== true);
}

function normalizeGateway(raw) {
    const g = raw && typeof raw === 'object' ? raw : {};
    return {
        url: text(g.url),
        host: text(g.host),
        port: Number(g.port) || 0,
        reachable: g.reachable === true,
    };
}

function normalizeNode(raw) {
    const n = raw && typeof raw === 'object' ? raw : {};
    return {
        path: text(n.path),
        version: text(n.version),
        raw: text(n.raw),
        satisfies: n.satisfies === true,
        required_min: text(n.required_min),
        required_alt_min: text(n.required_alt_min),
        note: text(n.note),
    };
}

function normalizeChrome(raw) {
    const c = raw && typeof raw === 'object' ? raw : {};
    return {
        found: c.found === true,
        path: text(c.path),
        source: text(c.source),
        searched: Array.isArray(c.searched) ? c.searched.map(text) : [],
        note: text(c.note),
        impact_note: text(c.impact_note),
        impact_note_origin: text(c.impact_note_origin),
    };
}

function normalizeSetup(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    return {
        platform: text(s.platform),
        windows: s.windows === true,
        command: text(s.command).trim(),
        command_origin: text(s.command_origin),
        shell: text(s.shell),
        script_url: text(s.script_url),
        script_url_origin: text(s.script_url_origin),
        size_hint: text(s.size_hint),
        size_hint_origin: text(s.size_hint_origin),
        network_note: text(s.network_note),
        network_note_origin: text(s.network_note_origin),
        privilege_note: text(s.privilege_note),
        privilege_note_origin: text(s.privilege_note_origin),
        permission_hint: text(s.permission_hint),
        permission_hint_origin: text(s.permission_hint_origin),
        node_warning_title: text(s.node_warning_title),
        node_warning_title_origin: text(s.node_warning_title_origin),
        node_warning: text(s.node_warning),
        node_warning_origin: text(s.node_warning_origin),
        init_incomplete_title: text(s.init_incomplete_title),
        init_incomplete_title_origin: text(s.init_incomplete_title_origin),
        init_incomplete_note: text(s.init_incomplete_note),
        init_incomplete_note_origin: text(s.init_incomplete_note_origin),
        doctor_steps: Array.isArray(s.doctor_steps)
            ? s.doctor_steps.map(it => ({ label: text(it && it.label), value: text(it && it.value) })).filter(it => it.value)
            : [],
        doctor_steps_origin: text(s.doctor_steps_origin),
        doctor_hint: text(s.doctor_hint),
        doctor_hint_origin: text(s.doctor_hint_origin),
        docs_url: text(s.docs_url),
        docs_url_origin: text(s.docs_url_origin),
        install_docs_url: text(s.install_docs_url),
        windows_docs_url: text(s.windows_docs_url),
        npm_command: text(s.npm_command),
        timeout_ms: Number(s.timeout_ms) || 0,
    };
}

export function normalizeStatus(raw) {
    const d = raw && typeof raw === 'object' ? raw : {};
    return {
        ok: d.ok !== false,
        config_ok: d.config_ok !== false,
        config_source: text(d.config_source),
        config_error: text(d.config_error),
        available: d.available === true,
        installed: d.installed === true,
        binary_path: text(d.binary_path),
        version: text(d.version),
        version_raw: text(d.version_raw),
        gateway: normalizeGateway(d.gateway),
        node: normalizeNode(d.node),
        chrome: normalizeChrome(d.chrome),
        setup: normalizeSetup(d.setup),
        errors: Array.isArray(d.errors) ? d.errors.map(text) : [],
        checked_at: Number(d.checked_at) || 0,
        cached: d.cached === true,
    };
}

// 引导入口只在「确实没装」时出现；装了但 Gateway 没起不是安装问题，不混进这里
export function needsInstall(status) {
    const s = status;
    return !!(s && s.ok && !s.installed);
}

export function commandOf(status) {
    return status && status.setup ? status.setup.command : '';
}

export function canStartInstall(status) {
    return !!(status && status.ok && status.config_ok && commandOf(status));
}

// 后端 SSE 事件 → 一行可读日志（未知事件原样透传，不吞）
export function eventToLog(event, name) {
    const ev = event && typeof event === 'object' ? event : {};
    const kind = text(ev.event || name || ev.type || '').trim();
    if (kind === 'start') {
        return { kind: 'start', level: 'info', text: '开始执行安装命令：' + text(ev.command) };
    }
    if (kind === 'log') {
        return { kind: 'log', level: 'plain', text: text(ev.line || ev.text) };
    }
    if (kind === 'verify') {
        return { kind: 'verify', level: 'info', text: text(ev.message) || '正在重新检测…' };
    }
    if (kind === 'error') {
        return {
            kind: 'error', level: 'error',
            text: text(ev.message || ev.detail) || '安装出错',
            code: text(ev.code), hint: text(ev.hint),
        };
    }
    if (kind === 'done') {
        const code = text(ev.code);
        const outcome = text(ev.outcome);
        return {
            kind: 'done', level: ev.ok === true ? 'ok' : 'error',
            text: text(ev.message) || (ev.ok === true ? '安装完成' : '安装失败'),
            ok: ev.ok === true, code: code,
            outcome: outcome,
            // 「包已装但收尾（doctor）失败」是独立终态，不能和彻底失败混为一谈
            initIncomplete: ev.ok !== true && (ev.init_incomplete === true || outcome === 'partial' || code === 'init_incomplete'),
        };
    }
    const fallback = text(ev.message || ev.detail || ev.line);
    return fallback ? { kind: kind || 'message', level: 'plain', text: fallback } : null;
}

// 失败后的手动安装指引：全部取自后端下发的配置，不在前端拼命令
export function manualSteps(status) {
    const s = status && status.setup ? status.setup : {};
    const out = [];
    if (s.command) out.push({ label: '官方安装命令', value: s.command });
    if (s.npm_command) out.push({ label: 'npm / 免安装体验', value: s.npm_command });
    if (s.script_url) out.push({ label: '安装脚本地址', value: s.script_url });
    if (s.docs_url) out.push({ label: '官方安装文档', url: s.docs_url });
    if (s.windows_docs_url && s.windows) out.push({ label: 'Windows 安装说明', url: s.windows_docs_url });
    if (s.install_docs_url) out.push({ label: '其他安装方式（Docker / Nix / 桌面版）', url: s.install_docs_url });
    return out;
}

// Node 不达标后果的警告文案：全部取自后端 payload（源头 config/openclaw.json 的 node.warning*），可 env 覆盖
export function nodeWarning(status) {
    const s = (status && status.setup) || {};
    return { title: text(s.node_warning_title), text: text(s.node_warning), origin: text(s.node_warning_origin) };
}

// 「包已安装但初始化未完成」结果页文案 / 收尾步骤：同样取自配置，前端不拼命令
export function initIncompleteTitle(status) {
    return text(((status && status.setup) || {}).init_incomplete_title);
}

export function initIncompleteNote(status) {
    return text(((status && status.setup) || {}).init_incomplete_note);
}

export function doctorSteps(status) {
    const steps = ((status && status.setup) || {}).doctor_steps;
    return Array.isArray(steps) ? steps.filter(it => it && it.value) : [];
}

export function doctorHint(status) {
    return text(((status && status.setup) || {}).doctor_hint);
}

export function sizeLabel(status) {
    const s = status && status.setup ? status.setup : {};
    return s.size_hint || '安装包大小以官方脚本实际下载为准';
}

export function verifyLabel(status) {
    const s = status || {};
    const parts = [];
    parts.push(s.installed ? ('可执行文件：' + (s.binary_path || '已找到')) : '可执行文件：未找到');
    parts.push(s.version ? ('版本：' + s.version) : '版本：未取到');
    const g = s.gateway || {};
    parts.push(g.reachable ? ('Gateway：' + (g.url || '') + ' 可达') : ('Gateway：' + (g.url || '') + ' 不可达'));
    return parts.join(' · ');
}
