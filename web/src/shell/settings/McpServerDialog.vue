<script setup>
// 新增 / 编辑 MCP 服务的表单弹窗。只做本地格式校验，最终口径以后端为准（detail 由父级 toast）。
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import NvIcon from '../../components/NvIcon.vue';
import NvSwitch from '../../components/NvSwitch.vue';

const props = defineProps({
    open: Boolean,
    server: { type: Object, default: null },
    busy: Boolean,
});
const emit = defineEmits(['submit', 'close']);

const NAME_RE = /^[a-z0-9_-]+$/;
const form = ref(blank());
const err = ref('');
const editing = computed(() => !!props.server);
// 打开弹窗时的 env / headers 文本：没改过的键不发进请求体，后端就会保留原值（改过才整条替换）
const initial = ref({ env: '', headers: '' });

function blank() {
    return { name: '', type: 'stdio', command: '', args: '', url: '', env: '', headers: '', timeout: 30, enabled: false };
}
function fill(server) {
    if (!server) {
        form.value = blank();
        initial.value = { env: '', headers: '' };
        return;
    }
    form.value = {
        name: String(server.name || ''),
        type: server.type === 'http' ? 'http' : 'stdio',
        command: String(server.command || ''),
        args: (server.args || []).join('\n'),
        url: String(server.url || ''),
        // 后端只回键名不回值：预填 KEY=，用户改了值才整栏替换
        env: (server.env_keys || []).map(k => k + '=').join('\n'),
        headers: (server.header_keys || []).map(k => k + '=').join('\n'),
        timeout: Number(server.timeout) > 0 ? Number(server.timeout) : 30,
        enabled: !!server.enabled,
    };
    initial.value = { env: form.value.env, headers: form.value.headers };
}

function unquote(value) {
    return String(value).replace(/^["']|["']$/g, '');
}
// args 支持「一行一个」（带空格的路径）与「空格分隔」两种写法，带引号的片段当一个参数
function parseArgs(text) {
    const raw = String(text || '');
    if (!raw.trim()) return [];
    if (raw.indexOf('\n') >= 0) {
        return raw.split('\n').map(x => unquote(x.trim())).filter(Boolean);
    }
    const tokens = raw.match(/"[^"]*"|'[^']*'|\S+/g) || [];
    return tokens.map(unquote).filter(Boolean);
}
function parsePairs(text) {
    const out = {};
    String(text || '').split('\n').forEach(line => {
        const raw = line.trim();
        if (!raw || raw.charAt(0) === '#') return;
        const at = raw.indexOf('=');
        if (at <= 0) return;
        const key = raw.slice(0, at).trim();
        const value = raw.slice(at + 1).trim();
        if (key && value) out[key] = value;
    });
    return out;
}

function setType(next) {
    if (form.value.type === next) return;
    form.value.type = next;
    err.value = '';
}

function submit() {
    if (props.busy) return;
    const f = form.value;
    const name = String(f.name || '').trim();
    const type = f.type === 'http' ? 'http' : 'stdio';
    const command = String(f.command || '').trim();
    const url = String(f.url || '').trim();
    const timeout = Number(f.timeout);
    if (!NAME_RE.test(name)) {
        err.value = '名称只能用小写字母、数字、下划线、连字符';
        return;
    }
    if (type === 'stdio' && !command) {
        err.value = 'stdio 服务必须填写 command';
        return;
    }
    if (type === 'http' && !/^https?:\/\//i.test(url)) {
        err.value = 'http 服务的 url 必须以 http:// 或 https:// 开头';
        return;
    }
    if (!Number.isFinite(timeout) || timeout <= 0) {
        err.value = '超时必须大于 0 秒';
        return;
    }
    err.value = '';
    const payload = {
        name,
        type,
        command: type === 'stdio' ? command : '',
        args: type === 'stdio' ? parseArgs(f.args) : [],
        url: type === 'http' ? url : '',
        timeout: Math.min(timeout, 600),
        enabled: !!f.enabled,
    };
    // 只发用户改过的那一栏：不出现该键 = 后端保留原值，出现就是整条替换（值留空即删掉该键）
    if (f.env !== initial.value.env) payload.env = parsePairs(f.env);
    if (type === 'http' && f.headers !== initial.value.headers) payload.headers = parsePairs(f.headers);
    emit('submit', payload);
}

function onKey(event) {
    if (!props.open || event.key !== 'Escape') return;
    event.stopImmediatePropagation();
    event.preventDefault();
    if (!props.busy) emit('close');
}
watch(() => props.open, open => {
    if (!open) {
        window.removeEventListener('keydown', onKey, true);
        return;
    }
    err.value = '';
    fill(props.server);
    window.addEventListener('keydown', onKey, true);
}, { immediate: true });
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true));
</script>

<template>
    <Teleport to="#nv-layer">
        <Transition name="msd">
            <div v-if="open" class="msd-scrim" @mousedown.self="busy || emit('close')">
                <div class="msd" role="dialog" aria-modal="true" :aria-label="editing ? '编辑 MCP 服务' : '添加 MCP 服务'">
                    <div class="msd-head">
                        <div>
                            <h3>{{ editing ? '编辑 MCP 服务' : '添加 MCP 服务' }}</h3>
                            <p>stdio 用本机命令启动一个服务，http 连接已经跑起来的 MCP 服务。</p>
                        </div>
                        <button type="button" class="nv-icon-btn sm round" aria-label="关闭" @click="emit('close')"><NvIcon name="x" /></button>
                    </div>

                    <div class="msd-body">
                        <label class="fld">
                            <span>名称</span>
                            <input v-model="form.name" class="inp" placeholder="my-server" autocomplete="off" spellcheck="false">
                            <small>小写字母、数字、下划线、连字符</small>
                        </label>

                        <div class="fld">
                            <span>类型</span>
                            <div class="nv-seg static" role="group" aria-label="服务类型">
                                <button type="button" :class="{ 'is-on': form.type === 'stdio' }" :aria-pressed="form.type === 'stdio'" @click="setType('stdio')">stdio</button>
                                <button type="button" :class="{ 'is-on': form.type === 'http' }" :aria-pressed="form.type === 'http'" @click="setType('http')">http</button>
                            </div>
                        </div>

                        <template v-if="form.type === 'stdio'">
                            <label class="fld">
                                <span>command</span>
                                <input v-model="form.command" class="inp mono" placeholder="python3" autocomplete="off" spellcheck="false">
                            </label>
                            <label class="fld">
                                <span>args</span>
                                <textarea v-model="form.args" class="inp area mono" rows="3" placeholder="/abs/path/server.py" spellcheck="false"></textarea>
                                <small>一行一个参数；也可以空格分隔，带空格的参数用引号包起来</small>
                            </label>
                        </template>
                        <template v-else>
                            <label class="fld">
                                <span>url</span>
                                <input v-model="form.url" class="inp mono" placeholder="http://127.0.0.1:8000/mcp" autocomplete="off" spellcheck="false">
                            </label>
                            <label class="fld">
                                <span>headers</span>
                                <textarea v-model="form.headers" class="inp area mono" rows="2" placeholder="Authorization=Bearer ..." spellcheck="false"></textarea>
                                <small>{{ editing ? '已有请求头的值不会回显；不改这一栏就原样保留，改了就整栏替换' : '每行 KEY=VALUE；可选' }}</small>
                            </label>
                        </template>

                        <label class="fld">
                            <span>env</span>
                            <textarea v-model="form.env" class="inp area mono" rows="2" placeholder="API_TOKEN=..." spellcheck="false"></textarea>
                            <small>{{ editing ? '已有变量的值不会回显；不改这一栏就原样保留，改了就整栏替换（值留空等于删掉该变量）' : '每行 KEY=VALUE；值留空的行不提交' }}</small>
                        </label>

                        <div class="msd-two">
                            <label class="fld">
                                <span>超时（秒）</span>
                                <input v-model.number="form.timeout" class="inp" type="number" min="1" max="600">
                            </label>
                            <div class="fld">
                                <span>保存后立即启用</span>
                                <NvSwitch v-model="form.enabled" label="保存后立即启用" />
                            </div>
                        </div>

                        <p v-if="form.enabled" class="msd-warn"><NvIcon name="alert" />启用会以你的系统权限在本机启动这个外部程序，请确认来源可信。</p>
                    </div>

                    <p v-if="err" class="msd-err">{{ err }}</p>

                    <div class="msd-foot">
                        <button type="button" class="nv-btn sm" @click="emit('close')">取消</button>
                        <button type="button" class="nv-btn sm primary" :disabled="busy" @click="submit">{{ busy ? '保存中…' : (editing ? '保存' : '添加') }}</button>
                    </div>
                </div>
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped>
.msd-scrim { position: fixed; inset: 0; z-index: 2400; display: flex; align-items: center; justify-content: center; padding: 24px; background: var(--scrim); backdrop-filter: var(--material-thin); -webkit-backdrop-filter: var(--material-thin); font-family: var(--font-sans); color: var(--ink); }
.msd { width: min(560px, 100%); max-height: calc(100vh - 48px); overflow-y: auto; padding: 22px 22px 16px; border-radius: 20px; background: var(--solid); box-shadow: var(--shadow-dialog); display: flex; flex-direction: column; gap: 14px; animation: nv-dialog-in var(--duration-slow) var(--ease-sheet) both; }
.msd-head { display: flex; align-items: flex-start; gap: 10px; }
.msd-head > div { flex: 1; min-width: 0; }
.msd-head h3 { margin: 0; font: 500 16px/22px var(--font-sans); letter-spacing: -.01em; }
.msd-head p { margin: 4px 0 0; font: 400 12px/18px var(--font-sans); color: var(--ink-3); }
.msd-body { display: flex; flex-direction: column; gap: 12px; }
.fld { display: flex; flex-direction: column; gap: 5px; min-width: 0; font: 500 11.5px/16px var(--font-sans); color: var(--ink-2); }
.fld small { font: 400 11px/16px var(--font-sans); color: var(--ink-4); }
.inp { height: 34px; padding: 0 12px; border: 0; outline: 0; border-radius: 10px; background: var(--fill-1); color: var(--ink); font: 400 12.5px/1 var(--font-sans); min-width: 0; }
.inp.mono { font-family: var(--font-mono); font-size: 12px; }
.inp.area { height: auto; padding: 9px 12px; line-height: 19px; resize: vertical; }
.inp:hover { background: var(--fill-2); }
.inp:focus { background: var(--fill-2); }
.inp:disabled { color: var(--ink-4); cursor: default; }
.inp::placeholder { color: var(--ink-4); }
.fld .nv-seg { align-self: flex-start; }
.msd-two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
.msd-warn { display: flex; align-items: flex-start; gap: 6px; margin: 0; padding: 9px 11px; border-radius: 10px; background: var(--danger-fill); color: var(--ink-2); font: 400 11.5px/17px var(--font-sans); }
.msd-warn .nv-i { width: 14px; height: 14px; color: var(--danger); flex: none; margin-top: 1px; }
.msd-err { margin: 0; color: var(--danger); font: 400 12px/18px var(--font-sans); }
.msd-foot { display: flex; justify-content: flex-end; gap: 8px; }
.msd-enter-active { transition: opacity 240ms var(--ease-out); }
.msd-enter-active .msd { transition: transform 320ms var(--ease-sheet), opacity 320ms var(--ease-sheet); }
.msd-leave-active { transition: opacity 160ms var(--ease-out); }
.msd-enter-from, .msd-leave-to { opacity: 0; }
.msd-enter-from .msd { opacity: 0; transform: translateY(10px) scale(.98); }
</style>
