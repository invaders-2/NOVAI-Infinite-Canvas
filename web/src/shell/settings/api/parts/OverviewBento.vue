<script setup>
// 平台概览（便当格）：连接状态 / API Key / 平台信息 / 协议 / 图片接口 / 同时生成 / 系统代理 / 平台专属（CLI / Lovart 面板）
import { computed, inject, ref, watch, nextTick } from 'vue';
import AIcon from './AIcon.vue';
import KeyTile from './KeyTile.vue';
import CliPanel from '../CliPanel.vue';
import LovartPanel from '../LovartPanel.vue';
import { t } from '../../../../lib/store.js';
import { PROTOCOL_LABELS, IMAGE_MODE_LABELS, PROXY_LABELS, CONCURRENCY_STEPS, BUILTIN_IDS, EXAMPLE_BASE_URL } from '../core/constants.js';
import { deriveIdFromName, normalizeMaxConcurrency } from '../core/helpers.js';

const store = inject('apiStore');
const emitChild = inject('apiChildEvents');
const S = store.S;
const it = store.item;
const fl = store.flags;
const nameEl = ref(null);

/* 选项按钮：被锁定时只显示当前值 + 锁 */
function opts(values, current, locked, labels) {
    let list = values.slice();
    if (locked) list = [current];
    else if (!list.includes(current)) list = [current, ...list];
    return list.map(v => ({ v, label: labels[v] || v }));
}
const protoOpts = computed(() => opts(['openai', 'apimart', 'gemini', 'volcengine'], S.form.protocol, fl.value.protocolLocked, PROTOCOL_LABELS));
const modeOpts = computed(() => opts(['openai', 'openai-json', 'openai-video-proxy', 'openai-responses'], S.form.imageMode, fl.value.imageModeLocked, IMAGE_MODE_LABELS));
const proxyOpts = computed(() => opts(['auto', 'on', 'off'], S.form.useProxy, false, PROXY_LABELS));
function pickProto(v) { if (!fl.value.protocolLocked && v !== S.form.protocol) store.setProtocol(v); }
function pickMode(v) { if (!fl.value.imageModeLocked && v !== S.form.imageMode) store.setImageMode(v); }
function step(dir) {
    const n = normalizeMaxConcurrency(S.form.maxConc);
    let idx = CONCURRENCY_STEPS.indexOf(n);
    if (idx < 0) idx = CONCURRENCY_STEPS.findIndex(v => v > n) - 1;
    idx = Math.max(0, Math.min(CONCURRENCY_STEPS.length - 1, idx + dir));
    store.setMaxConc(CONCURRENCY_STEPS[idx]);
}

const APIMART_BASE_CN = 'https://apib.ai';
const APIMART_BASE_OFFICIAL = 'https://api.apimart.ai';
function applyApimartBase(base) { S.form.base = base; }

const idPreview = computed(() => {
    const p = it.value; if (!p) return '—';
    return BUILTIN_IDS.has(p.id) ? p.id : deriveIdFromName(S.form.name, p.id, S.providers);
});
const showMode = computed(() => !fl.value.imageModeLocked);
const showProxy = computed(() => !fl.value.isCli);
const isApimart = computed(() => {
    const base = String(S.form.base || (it.value && it.value.base_url) || '').toLowerCase();
    return base.includes('apimart.ai') || base.includes('apib.ai');
});
const apimartHint = computed(() => isApimart.value && !!((it.value && it.value.has_key) || S.form.key.trim()));
/* 平台专属面板（同事负责的组件）：显示条件与旧 renderEditor 一致 */
const cliKind = computed(() => fl.value.isJimeng ? 'jimeng' : fl.value.isCodex ? 'codex' : fl.value.isGeminiCli ? 'gemini' : '');
const showExtra = computed(() => !!cliKind.value || fl.value.isLovart);

const conn = computed(() => {
    const r = it.value ? S.connResults[it.value.id] : null;
    if (r && r.state === 'ok') {
        const proto = PROTOCOL_LABELS[String(r.protocol || '').toLowerCase()] || '';
        return { chip: '已连通', cls: 'ok', big: String(r.ms), unit: 'ms', count: r.count, proto };
    }
    if (r && r.state === 'warn') return { chip: '未通过', cls: 'bad', big: '失败', sub: r.text || '测试未通过，详情见下方' };
    return { chip: '未测试', cls: '', big: '—', sub: '点右上角「测试连接」验证地址与 Key，并自动识别协议' };
});
const rawOpen = ref(false);
watch(() => S.verify, () => { rawOpen.value = false; });
watch(() => S.focusName, () => nextTick(() => { if (nameEl.value) nameEl.value.focus({ preventScroll: true }); }));
</script>

<template>
    <section class="bento" :class="{ nokey: !fl.showKeyTile }">
        <!-- 连接状态 -->
        <div class="tile s2 conn" :data-state="conn.cls">
            <div class="th"><AIcon name="radar" /><span>连接状态</span><span class="chip r" :class="conn.cls">{{ conn.chip }}</span></div>
            <div class="big">{{ conn.big }}<small v-if="conn.unit">{{ conn.unit }}</small></div>
            <div class="sub">
                <template v-if="conn.cls === 'ok'">{{ conn.count === null ? '刚刚测试 · 密钥可用' : '刚刚测试 · 找到 ' }}<b v-if="conn.count !== null">{{ conn.count }}</b><template v-if="conn.count !== null"> 个模型{{ conn.proto ? ' · ' + conn.proto : '' }}</template></template>
                <template v-else>{{ conn.sub }}</template>
            </div>
            <div v-if="S.verify" class="verify" :class="S.verify.state">
                <div v-for="(b, i) in S.verify.blocks" :key="i" class="vl" :class="b.tone">
                    <span v-if="S.verify.loading && i === 0" class="spin xs"></span>
                    <AIcon v-else-if="b.tone === 'ok'" name="check" /><AIcon v-else-if="b.tone === 'warn'" name="alert" />
                    <span>{{ b.text }}</span>
                </div>
                <div v-if="S.verify.raw" class="raw">
                    <button type="button" class="rawbtn" :aria-expanded="rawOpen" @click="rawOpen = !rawOpen"><AIcon :name="rawOpen ? 'chev' : 'arrowr'" />查看原始响应 (HTTP {{ S.verify.raw.code }})</button>
                    <pre v-if="rawOpen">{{ S.verify.raw.json }}</pre>
                </div>
            </div>
        </div>

        <!-- API Key（CLI / Lovart 不需要） -->
        <KeyTile v-if="fl.showKeyTile" />

        <!-- 平台信息 -->
        <div class="tile s2 info">
            <div class="th"><AIcon name="link" /><span>平台信息</span></div>
            <label class="fld"><span>{{ t('api.platformName', '平台名称') }}</span>
                <input ref="nameEl" v-model="S.form.name" class="inp" type="text" placeholder="Comfly">
            </label>
            <label v-if="!fl.isCli" class="fld"><span>{{ t('api.baseUrl', '请求地址') }}</span>
                <input v-model="S.form.base" class="inp mono" type="text" :placeholder="EXAMPLE_BASE_URL" :disabled="fl.isLovart" :title="fl.isLovart ? 'Lovart 使用固定网关地址' : ''">
            </label>
            <div v-if="fl.isMs" class="hints">
                <span>{{ t('api.msChinaEndpoint', '国内默认请求地址：') }}<code>https://api-inference.modelscope.cn/v1</code></span>
                <span>{{ t('api.msGlobalEndpoint', '国外使用请求地址：') }}<code>https://api-inference.modelscope.ai/v1</code></span>
            </div>
            <div v-if="fl.isRh" class="hints"><span>国外地址：<code>https://www.runninghub.ai</code></span></div>
            <div v-if="apimartHint" class="hints">
                <span>国内请求地址：<code>https://apib.ai</code></span>
                <div class="bases">
                    <button type="button" class="basebtn" @click="applyApimartBase(APIMART_BASE_CN)">用国内地址</button>
                    <button type="button" class="basebtn" @click="applyApimartBase(APIMART_BASE_OFFICIAL)">用官方地址</button>
                </div>
            </div>
            <div class="idl">{{ t('api.platformIdShown', '平台 ID') }}：<code>{{ idPreview }}</code></div>
        </div>

        <!-- 协议 -->
        <div class="tile proto" :class="{ s2: !showMode }">
            <div class="th"><AIcon name="bolt" /><span>协议</span></div>
            <div class="opts" :title="fl.protocolTitle">
                <button v-for="o in protoOpts" :key="o.v" type="button" class="opt" :class="{ on: o.v === S.form.protocol, lock: fl.protocolLocked }" :disabled="fl.protocolLocked" @click="pickProto(o.v)">
                    <span>{{ o.label }}</span><AIcon v-if="o.v === S.form.protocol" :name="fl.protocolLocked ? 'lock' : 'check'" />
                </button>
            </div>
            <div v-if="fl.protocolLocked" class="sub">{{ fl.protocolTitle || '固定协议' }}</div>
        </div>

        <!-- 图片接口 -->
        <div v-if="showMode" class="tile imgmode">
            <div class="th"><AIcon name="image" /><span>图片接口</span></div>
            <div class="opts" :title="fl.imageModeTitle">
                <button v-for="o in modeOpts" :key="o.v" type="button" class="opt" :class="{ on: o.v === S.form.imageMode }" @click="pickMode(o.v)">
                    <span>{{ o.label }}</span><AIcon v-if="o.v === S.form.imageMode" name="check" />
                </button>
            </div>
        </div>

        <!-- 同时生成 -->
        <div class="tile s2 conc">
            <div class="th"><AIcon name="clock" /><span>同时生成</span></div>
            <div class="crow">
                <div class="big">{{ S.form.maxConc ? S.form.maxConc : '不限' }}<small v-if="S.form.maxConc">个</small></div>
                <div class="stepper"><button type="button" title="减少" aria-label="减少" @click="step(-1)"><AIcon name="minus" /></button><span>上限</span><button type="button" title="增加" aria-label="增加" @click="step(1)"><AIcon name="plus" /></button></div>
            </div>
            <div class="sub">同一平台同时进行的生图 / 视频任务数，超出的自动排队，避免被限流（429）</div>
        </div>

        <!-- 系统代理（CLI 不走代理） -->
        <div v-if="showProxy" class="tile s2 proxy">
            <div class="th"><AIcon name="globe" /><span>系统代理</span></div>
            <div class="opts row">
                <button v-for="o in proxyOpts" :key="o.v" type="button" class="opt" :class="{ on: o.v === S.form.useProxy }" @click="store.setUseProxy(o.v)">
                    <span>{{ o.label }}</span><AIcon v-if="o.v === S.form.useProxy" name="check" />
                </button>
            </div>
            <div class="sub">国内平台可设为直连，海外平台可强制走代理</div>
        </div>

        <!-- 平台专属：本机 CLI / Lovart（同事负责的面板） -->
        <div v-if="showExtra" class="tile s4 extra">
            <CliPanel v-if="cliKind" :key="cliKind + it.id" :kind="cliKind" :provider="it" :providers="S.providers" @dirty="emitChild.dirty" />
            <LovartPanel v-if="fl.isLovart" :key="'lovart' + it.id" :provider="it" :providers="S.providers" :save="store.save" :base-url="S.form.base" @dirty="emitChild.dirty" @save="store.save()" />
        </div>
    </section>
</template>

<style scoped>
.bento { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.bento.nokey .conn { grid-column: span 2; }
.tile { position: relative; background: var(--fill-1); border-radius: 14px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.tile.s2 { grid-column: span 2; }
.tile.s4 { grid-column: 1 / -1; }
.extra { background: transparent; padding: 0; }
.th { display: flex; align-items: center; gap: 7px; font: 500 12px/16px var(--font-sans); color: var(--ink-2); }
.th .nv-i { width: 14px; height: 14px; color: var(--ink-3); }
.th .r { margin-left: auto; }
.chip { display: inline-flex; align-items: center; height: 18px; padding: 0 7px; border-radius: 99px; background: var(--solid); font: 400 10.5px/1 var(--font-sans); color: var(--ink-2); }
.chip.ok { background: var(--accent); color: var(--on-accent); }
.chip.bad { background: var(--danger-fill); color: var(--danger); }
.big { font: 500 20px/26px var(--font-mono); letter-spacing: -.02em; color: var(--ink); }
.big small { font: 400 11px/1 var(--font-mono); color: var(--ink-3); margin-left: 3px; letter-spacing: 0; }
.conn[data-state="bad"] .big { font-family: var(--font-sans); }
.sub { font: 400 11.5px/17px var(--font-sans); color: var(--ink-3); }
.sub b { color: var(--ink); font-weight: 500; }
.verify { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border-radius: 10px; background: var(--solid); animation: vin 220ms var(--ease-out); }
@keyframes vin { from { opacity: 0; transform: translateY(-3px); } }
.vl { display: flex; align-items: flex-start; gap: 6px; font: 400 11.5px/17px var(--font-sans); color: var(--ink-2); word-break: break-word; }
.vl .nv-i { width: 13px; height: 13px; margin-top: 2px; flex: none; }
.vl.ok { color: var(--ink); font-weight: 500; }
.vl.warn { color: var(--danger); font-weight: 500; }
.vl.muted { color: var(--ink-3); }
.vl.note { color: var(--ink-2); padding-left: 19px; }
.spin.xs { width: 11px; height: 11px; margin-top: 3px; flex: none; border-width: 1.2px; }
.rawbtn { display: inline-flex; align-items: center; gap: 4px; margin-top: 2px; padding: 0; border: 0; background: transparent; font: 400 11px/16px var(--font-sans); color: var(--ink-3); cursor: pointer; }
.rawbtn:hover { color: var(--ink); }
.rawbtn .nv-i { width: 11px; height: 11px; }
.raw pre { margin: 6px 0 0; padding: 10px 12px; max-height: 200px; overflow: auto; border-radius: 8px; background: var(--fill-1); font: 400 10.5px/15px var(--font-mono); color: var(--ink-2); white-space: pre-wrap; word-break: break-all; }
.fld { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.fld > span { font: 400 11px/14px var(--font-sans); color: var(--ink-3); }
.inp { height: 32px; padding: 0 10px; border: 0; outline: 0; border-radius: 8px; background: var(--solid); font: 400 12.5px/1 var(--font-sans); color: var(--ink); min-width: 0; transition: box-shadow 160ms; }
.inp.mono { font-family: var(--font-mono); font-size: 12px; }
.inp:focus { background: var(--fill-2); box-shadow: none; }
.inp:disabled { color: var(--ink-3); background: var(--fill-1); cursor: not-allowed; }
.inp::placeholder { color: var(--ink-4); }
.hints { display: flex; flex-direction: column; gap: 2px; font: 400 11.5px/17px var(--font-sans); color: var(--ink-3); }
.bases { display: flex; align-items: center; gap: 6px; margin-top: 4px; flex-wrap: wrap; }
.basebtn { height: 24px; padding: 0 10px; border: 0; border-radius: 99px; background: var(--solid); font: 400 11px/1 var(--font-sans); color: var(--ink-2); cursor: pointer; transition: background 120ms, color 120ms; }
.basebtn:hover { background: var(--fill-2); color: var(--ink); }
code { font: 400 11px/1 var(--font-mono); color: var(--ink-2); }
.idl { font: 400 11px/15px var(--font-sans); color: var(--ink-3); }
.idl code { color: var(--ink); }
.opts { display: flex; flex-direction: column; gap: 2px; }
.opts.row { flex-direction: row; gap: 4px; }
.opt { display: flex; align-items: center; justify-content: space-between; gap: 8px; height: 30px; padding: 0 10px; border: 0; border-radius: 8px; background: transparent; font: 400 12px/1 var(--font-sans); color: var(--ink-2); white-space: nowrap; cursor: pointer; transition: background 120ms, color 120ms; }
.opts.row .opt { flex: 1; justify-content: center; }
.opt:hover { background: var(--fill-1); color: var(--ink); }
.opt.on { background: var(--solid); color: var(--ink); font-weight: 500; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
.opt.lock { cursor: default; }
.opt.lock.on { color: var(--ink-2); }
.opt .nv-i { width: 12px; height: 12px; }
.crow { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.stepper { display: inline-flex; align-items: center; gap: 2px; padding: 2px; border-radius: 99px; background: var(--solid); box-shadow: 0 1px 3px rgba(0,0,0,.05); }
.stepper span { font: 400 11px/1 var(--font-sans); color: var(--ink-3); padding: 0 6px; }
.stepper button { width: 24px; height: 24px; border: 0; padding: 0; border-radius: 99px; display: inline-flex; align-items: center; justify-content: center; color: var(--ink-2); background: var(--fill-1); cursor: pointer; }
.stepper button:hover { background: var(--fill-2); color: var(--ink); }
.stepper .nv-i { width: 12px; height: 12px; }
@media (max-width: 860px) { .tile.s2, .tile.proto, .tile.imgmode { grid-column: 1 / -1; } }
</style>
