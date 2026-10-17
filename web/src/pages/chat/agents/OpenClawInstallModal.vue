<script setup>
// 「安装 OpenClaw」引导弹窗：说明为什么需要 / 下什么、多大、要不要联网 / 展示将要执行的确切命令 /
// Node 版本如实提示 / 用户显式确认后才执行 / 实时日志 + 取消 / 完成后自动验证 / 失败给重试与手动指引。
// 命令与地址全部来自 /api/openclaw/status（源头 config/openclaw.json），组件里不写任何 URL 或命令。
import { computed, ref, watch, nextTick } from 'vue';
import ChIcon from '../ChIcon.vue';
import {
    OC, closeInstallModal, startInstall, cancelInstall, retryInstall, loadStatus, readyToInstall,
} from './openclawSetup.js';
import {
    nodeHint, chromeHint, manualSteps, sizeLabel, verifyLabel, commandOf,
    nodeWarning, initIncompleteTitle, initIncompleteNote, doctorSteps, doctorHint,
} from './openclawSetupCore.js';

const copied = ref(false);
const logBox = ref(null);

const status = computed(() => OC.status || null);
const setup = computed(() => (status.value && status.value.setup) || {});
const command = computed(() => commandOf(status.value));
const hint = computed(() => nodeHint(status.value && status.value.node));
const chrome = computed(() => chromeHint(status.value));
const permissionDenied = computed(() => OC.errorCode === 'permission_denied');
const permissionHint = computed(() => OC.permissionHint || setup.value.permission_hint || '');
const steps = computed(() => manualSteps(status.value));
const nodeWarn = computed(() => nodeWarning(status.value));
const partialTitle = computed(() => initIncompleteTitle(status.value));
const partialNote = computed(() => initIncompleteNote(status.value));
const doctorList = computed(() => doctorSteps(status.value));
const partialHint = computed(() => doctorHint(status.value));
const running = computed(() => OC.phase === 'running');
const canInstall = computed(() => readyToInstall() && OC.phase === 'confirm');

watch(() => OC.logs.length, () => {
    nextTick(() => { if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight; });
});

function confirmInstall() {
    if (!canInstall.value) return;
    startInstall();
}
function copyCommand() {
    const value = command.value;
    if (!value) return;
    const done = () => { copied.value = true; setTimeout(() => { copied.value = false; }, 1600); };
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(value).then(done, done);
        else done();
    } catch (e) { done(); }
}
function onScrim(e) {
    if (e.target === e.currentTarget && !running.value) closeInstallModal();
}
function recheck() { loadStatus(true); }
function openUrl(url) { if (url) window.open(url, '_blank', 'noopener'); }
</script>

<template>
    <Teleport to="#nv-layer">
        <Transition name="modal">
            <div v-if="OC.modal" class="oc-scrim" @mousedown="onScrim">
                <div class="oc" role="dialog" aria-modal="true" aria-labelledby="oc-title">
                    <header class="oc-h">
                        <div>
                            <span class="eyebrow">首次使用引导</span>
                            <h3 id="oc-title">安装 OpenClaw</h3>
                        </div>
                        <button type="button" class="nv-icon-btn sm" title="关闭" :disabled="running" @click="closeInstallModal"><ChIcon name="x" /></button>
                    </header>

                    <div class="oc-b">
                        <p class="oc-lede">智能体 / 技能的运行由本机 OpenClaw 提供 Gateway 与工具执行能力。当前检测到本机没有可用的 OpenClaw，先装好它才能运行这些能力；普通文字对话与生图不受影响。</p>

                        <div class="oc-rows">
                            <div class="oc-row">
                                <ChIcon name="cpu" />
                                <div><b>当前检测</b><span>{{ verifyLabel(status) }}</span></div>
                            </div>
                            <div class="oc-row">
                                <ChIcon name="download" />
                                <div>
                                    <b>将会下载什么</b>
                                    <span>{{ sizeLabel(status) }}。{{ setup.network_note || '需要联网下载安装脚本与依赖。' }}</span>
                                </div>
                            </div>
                        </div>

                        <div class="oc-node" :class="hint.level">
                            <ChIcon :name="hint.level === 'ok' ? 'check' : 'alert'" />
                            <div><b>Node 版本</b><span>{{ hint.text }}</span></div>
                        </div>

                        <div v-if="nodeWarn.text" class="oc-safe warn" data-oc-node-warning="1">
                            <ChIcon name="alert" />
                            <div>
                                <b>{{ nodeWarn.title || 'Node 不达标时的系统级改动' }}</b>
                                <span>{{ nodeWarn.text }}</span>
                                <span class="oc-src">文案来源：{{ nodeWarn.origin || '（未配置）' }}</span>
                            </div>
                        </div>

                        <div class="oc-node" :class="chrome.level" data-oc-chrome="1">
                            <ChIcon :name="chrome.level === 'ok' ? 'check' : 'alert'" />
                            <div><b>浏览器（Chrome）</b><span>{{ chrome.text }}</span></div>
                        </div>

                        <div class="oc-cmd">
                            <div class="oc-cmd-h">
                                <b>将要执行的官方命令</b>
                                <button type="button" class="nv-btn xs" :disabled="!command" @click="copyCommand">{{ copied ? '已复制' : '复制' }}</button>
                            </div>
                            <pre>{{ command || '（命令未配置，请检查 config/openclaw.json）' }}</pre>
                            <div class="oc-src">命令来源：{{ setup.command_origin || '（未配置）' }} · 配置文件 {{ status && status.config_source }}</div>
                        </div>

                        <div class="oc-safe">
                            <ChIcon name="shield" />
                            <div>
                                <b>执行前请知悉</b>
                                <span>这是供应链敏感操作：命令会把 <em>{{ setup.script_url || '官方安装脚本' }}</em> 下载后直接交给 shell 执行。只有你点下面的「确认安装」后才会运行，过程中可随时取消；脚本自身的完整性校验由官方脚本负责，本引导不做额外校验和 / 签名验证。</span>
                            </div>
                        </div>

                        <div class="oc-safe" data-oc-privilege="1">
                            <ChIcon name="shield" />
                            <div>
                                <b>是否需要管理员权限</b>
                                <span>{{ setup.privilege_note || '安装过程会一并处理 Node.js 与依赖，可能弹出系统密码框、需要管理员权限。' }}</span>
                                <span class="oc-src">文案来源：{{ setup.privilege_note_origin || '（未配置）' }}</span>
                            </div>
                        </div>

                        <div v-if="OC.logs.length || running" ref="logBox" class="oc-log" aria-live="polite">
                            <div v-for="(l, i) in OC.logs" :key="i" class="oc-line" :class="l.level">{{ l.text }}</div>
                            <div v-if="running && !OC.logs.length" class="oc-line plain">正在启动安装进程…</div>
                        </div>

                        <div v-if="OC.phase === 'done'" class="oc-result ok">
                            <ChIcon name="check" />
                            <div>
                                <b>安装完成，OpenClaw 已可用</b>
                                <span>{{ verifyLabel(OC.result || status) }}</span>
                            </div>
                        </div>

                        <div v-if="OC.phase === 'partial'" class="oc-result partial" data-oc-partial="1">
                            <ChIcon name="alert" />
                            <div>
                                <b>{{ partialTitle || '包已安装，但初始化未完成' }}</b>
                                <span v-if="partialNote">{{ partialNote }}</span>
                                <div v-if="doctorList.length" class="oc-doctor" data-oc-doctor="1">
                                    <div v-for="(s, i) in doctorList" :key="i" class="oc-step">
                                        <span class="lb">{{ s.label }}</span>
                                        <code>{{ s.value }}</code>
                                    </div>
                                </div>
                                <span v-if="partialHint" class="oc-src">{{ partialHint }}</span>
                                <span class="oc-src">指引来源：{{ setup.init_incomplete_note_origin || '（未配置）' }} · 命令来源：{{ setup.doctor_steps_origin || '（未配置）' }}</span>
                            </div>
                        </div>

                        <div v-if="OC.phase === 'failed' || OC.phase === 'cancelled'" class="oc-result fail">
                            <ChIcon name="alert" />
                            <div>
                                <b>{{ OC.phase === 'cancelled' ? '安装已取消' : '安装未完成' }}</b>
                                <span v-if="OC.error">{{ OC.error }}</span>
                                <span v-for="(l, i) in (permissionDenied ? [] : OC.logs.filter(x => x.level === 'error').slice(-2))" :key="i">{{ l.text }}</span>
                            </div>
                        </div>

                        <div v-if="permissionDenied" class="oc-result fail" data-oc-permission="1">
                            <ChIcon name="alert" />
                            <div>
                                <b>需要管理员权限</b>
                                <span>{{ permissionHint || '请在弹出的系统密码框 / UAC 授权框中确认，或用管理员身份重开 NOVAI 后重试。' }}</span>
                                <span class="oc-src">指引来源：{{ setup.permission_hint_origin || '（未配置）' }}</span>
                            </div>
                        </div>

                        <div v-if="OC.phase === 'failed' || OC.phase === 'cancelled'" class="oc-manual">
                            <b>手动安装指引</b>
                            <div v-for="(s, i) in steps" :key="i" class="oc-step">
                                <span class="lb">{{ s.label }}</span>
                                <code v-if="s.value">{{ s.value }}</code>
                                <button v-if="s.url" type="button" class="oc-link" @click="openUrl(s.url)">{{ s.url }}</button>
                            </div>
                        </div>
                    </div>

                    <footer class="oc-f">
                        <template v-if="running">
                            <span class="oc-state"><span class="spin sm"></span>安装进行中，请勿关闭窗口</span>
                            <span class="grow"></span>
                            <button type="button" class="nv-btn sm ghost" @click="cancelInstall">取消安装</button>
                        </template>
                        <template v-else-if="OC.phase === 'done'">
                            <button type="button" class="nv-btn sm" @click="recheck">重新检测</button>
                            <span class="grow"></span>
                            <button type="button" class="nv-btn sm primary" @click="closeInstallModal">完成</button>
                        </template>
                        <template v-else-if="OC.phase === 'partial'">
                            <button type="button" class="nv-btn sm" @click="recheck">重新检测</button>
                            <span class="grow"></span>
                            <button type="button" class="nv-btn sm ghost" @click="closeInstallModal">关闭</button>
                        </template>
                        <template v-else-if="OC.phase === 'failed' || OC.phase === 'cancelled'">
                            <button type="button" class="nv-btn sm" @click="retryInstall">重试</button>
                            <span class="grow"></span>
                            <button type="button" class="nv-btn sm ghost" @click="closeInstallModal">关闭</button>
                        </template>
                        <template v-else>
                            <button type="button" class="nv-btn sm ghost" @click="closeInstallModal">取消</button>
                            <span class="grow"></span>
                            <button type="button" class="nv-btn sm primary" :disabled="!canInstall" @click="confirmInstall">
                                <ChIcon name="download" />确认安装
                            </button>
                        </template>
                    </footer>
                </div>
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped>
.oc-scrim { position: fixed; inset: 0; z-index: 2600; background: var(--scrim); backdrop-filter: var(--material-thin); -webkit-backdrop-filter: var(--material-thin); display: flex; align-items: center; justify-content: center; padding: 24px; }
.oc { width: min(680px, 100%); max-height: calc(100vh - 48px); display: flex; flex-direction: column; border-radius: 20px; background: var(--solid); box-shadow: var(--shadow-dialog); overflow: hidden; }
.oc-h { display: flex; align-items: flex-start; justify-content: space-between; padding: 22px 24px 8px; }
.eyebrow { font: 400 11px/14px var(--font-mono); letter-spacing: .04em; color: var(--ink-3); }
.oc-h h3 { margin: 4px 0 0; font: 500 17px/24px var(--font-sans); letter-spacing: -.01em; }
.oc-b { padding: 6px 24px 8px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
.oc-lede { margin: 0; font: 400 12.5px/19px var(--font-sans); color: var(--ink-2); }
.oc-rows { display: flex; flex-direction: column; gap: 8px; }
.oc-row { display: flex; gap: 10px; padding: 12px 14px; border-radius: 12px; background: var(--fill-1); }
.oc-row .nv-i { width: 16px; height: 16px; flex: none; margin-top: 2px; color: var(--ink-3); }
.oc-row b, .oc-node b, .oc-safe b, .oc-result b, .oc-manual > b { display: block; font: 500 12.5px/18px var(--font-sans); color: var(--ink); }
.oc-row span, .oc-node span, .oc-safe span, .oc-result span { font: 400 12px/18px var(--font-sans); color: var(--ink-2); }
.oc-node { display: flex; gap: 10px; padding: 12px 14px; border-radius: 12px; background: var(--fill-1); }
.oc-node .nv-i { width: 16px; height: 16px; flex: none; margin-top: 2px; }
.oc-node.ok .nv-i { color: var(--ink); }
.oc-node.warn { background: var(--danger-fill); }
.oc-node.warn .nv-i, .oc-node.warn b { color: var(--danger); }
.oc-cmd { border-radius: 12px; background: var(--fill-1); padding: 12px 14px; }
.oc-cmd-h { display: flex; align-items: center; justify-content: space-between; }
.oc-cmd-h b { font: 500 12.5px/18px var(--font-sans); }
.oc-cmd pre { margin: 8px 0 6px; padding: 10px 12px; border-radius: 10px; background: var(--solid); overflow-x: auto; font: 400 12px/18px var(--font-mono); color: var(--ink); white-space: pre-wrap; word-break: break-all; }
.oc-src { font: 400 11px/16px var(--font-mono); color: var(--ink-4); word-break: break-all; }
.oc-safe { display: flex; gap: 10px; padding: 12px 14px; border-radius: 12px; background: var(--fill-1); }
.oc-safe .nv-i { width: 16px; height: 16px; flex: none; margin-top: 2px; color: var(--ink-3); }
.oc-safe em { font-style: normal; word-break: break-all; }
.oc-safe .oc-src, .oc-result .oc-src { display: block; font: 400 11px/16px var(--font-mono); color: var(--ink-4); word-break: break-all; }
.oc-log { max-height: 190px; overflow-y: auto; padding: 10px 12px; border-radius: 12px; background: #101014; }
.oc-line { font: 400 11.5px/17px var(--font-mono); color: #cfd2d9; white-space: pre-wrap; word-break: break-all; }
.oc-line.info { color: #8ab4ff; }
.oc-line.ok { color: #6ee7a8; }
.oc-line.error { color: #ff8a8a; }
.oc-result { display: flex; gap: 10px; padding: 12px 14px; border-radius: 12px; background: var(--fill-1); }
.oc-result .nv-i { width: 16px; height: 16px; flex: none; margin-top: 2px; }
.oc-result.ok .nv-i { color: var(--ink); }
.oc-result.fail { background: var(--danger-fill); }
.oc-result.fail .nv-i, .oc-result.fail b { color: var(--danger); }
.oc-result.partial { background: var(--fill-2); }
.oc-result.partial .nv-i, .oc-result.partial b { color: var(--ink); }
.oc-result span { display: block; }
.oc-safe.warn { background: var(--danger-fill); }
.oc-safe.warn .nv-i, .oc-safe.warn b { color: var(--danger); }
.oc-doctor { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.oc-manual { padding: 12px 14px; border-radius: 12px; background: var(--fill-1); display: flex; flex-direction: column; gap: 8px; }
.oc-step { display: flex; flex-direction: column; gap: 3px; }
.oc-step .lb { font: 400 11px/16px var(--font-mono); color: var(--ink-4); }
.oc-step code { font: 400 11.5px/17px var(--font-mono); color: var(--ink); word-break: break-all; }
.oc-link { align-self: flex-start; padding: 0; border: 0; background: transparent; color: var(--ink-2); font: 400 11.5px/17px var(--font-sans); text-decoration: underline; cursor: pointer; word-break: break-all; text-align: left; }
.oc-f { display: flex; align-items: center; gap: 8px; padding: 14px 24px 20px; }
.oc-f .grow { flex: 1; }
.oc-state { display: inline-flex; align-items: center; gap: 6px; font: 400 11.5px/16px var(--font-sans); color: var(--ink-3); }
.spin.sm { width: 12px; height: 12px; }
.modal-enter-active, .modal-leave-active { transition: opacity var(--duration-base) var(--ease-out); }
.modal-enter-active .oc { animation: nv-dialog-in var(--duration-slow) var(--ease-sheet) both; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
</style>
