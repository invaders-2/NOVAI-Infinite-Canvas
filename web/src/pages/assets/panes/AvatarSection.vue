<script setup>
// 详情里的「平台注册」：已有注册卡（已认证 / 审核中 / 未通过）+ 选择平台注册新平台
import { computed } from 'vue';
import NvIcon from '../../../components/NvIcon.vue';
import MenuSelect from '../parts/MenuSelect.vue';
import { setStatus, run } from '../lib/state.js';
import { copyText } from '../lib/util.js';
import { L } from '../lib/library.js';
import * as V from '../lib/avatar.js';

const props = defineProps({ item: { type: Object, required: true } });
const busy = computed(() => L.avatarBusy === props.item.id);
const regs = computed(() => V.registrations(props.item));
const providers = computed(() => V.candidateProviders());
const options = computed(() => providers.value.map(p => ({ value: p.id, label: V.providerOptionLabel(p) })));
const selected = computed(() => V.activeProvider());
const selPlatform = computed(() => V.providerPlatform(selected.value));
const supported = computed(() => V.providerSupported(selected.value));
const noKey = computed(() => !!selected.value && selected.value.has_key === false);
const already = computed(() => supported.value && regs.value.some(r => r.platform === selPlatform.value));
async function copyUri(uri) { setStatus((await copyText(uri)) ? '已复制 asset:// 地址' : `复制失败，请手动复制：${uri}`); }
const provFor = r => V.providerIdForPlatform(r.platform, r.provider_id || '');
</script>

<template>
    <div class="am-sec av">
        <template v-for="r in regs" :key="r.platform">
            <div v-if="r.status === 'Active' && r.asset_uri" class="am-av">
                <div class="am-avh"><NvIcon name="badge" />已认证可用<span class="pt">{{ V.platformLabel(r.platform) }}</span></div>
                <div class="am-uri" :title="'只能在 ' + V.platformLabel(r.platform) + ' 平台的视频生成中通过 @ 调用'">{{ r.asset_uri }}</div>
                <div class="am-avr">
                    <button type="button" class="am-mini" @click="copyUri(r.asset_uri)"><NvIcon name="copy" />复制 asset:// 地址</button>
                    <button type="button" class="am-mini" :disabled="busy" @click="run(V.register(item.id, provFor(r)))"><NvIcon name="refresh" />{{ busy ? '处理中…' : '重新注册' }}</button>
                </div>
            </div>
            <div v-else-if="r.status === 'Processing'" class="am-av">
                <div class="am-avh"><span class="am-spin"></span>审核中<span class="pt">{{ V.platformLabel(r.platform) }}</span></div>
                <div class="am-avt">已提交到 {{ V.platformLabel(r.platform) }} 审核（任务 {{ r.task_id || '' }}），通过后会自动生成 asset:// 地址。审核通常需要几十秒到几分钟。</div>
                <button type="button" class="am-wbtn" :disabled="busy" @click="run(V.checkStatus(item.id, false, provFor(r)))"><NvIcon name="refresh" />{{ busy ? '查询中…' : '刷新审核状态' }}</button>
            </div>
            <div v-else class="am-av">
                <div class="am-avh"><NvIcon name="x" />审核未通过<span class="pt">{{ V.platformLabel(r.platform) }}</span></div>
                <div class="am-avt warn">{{ r.detail || '审核未通过，请更换素材后重试。' }}</div>
                <button type="button" class="am-wbtn sec" :disabled="busy" @click="run(V.register(item.id, provFor(r)))"><NvIcon name="refresh" />{{ busy ? '处理中…' : '重新提交' }}</button>
            </div>
            <div class="am-avsep"></div>
        </template>

        <div class="am-av">
            <div class="am-avh"><NvIcon name="user" />{{ providers.length ? '注册到平台' : '注册为真人/数字人' }}</div>
            <div v-if="!providers.length" class="am-avt">未检测到可用平台。请先在「API 平台管理」中添加并启用 API 平台（如 APIMart）并填写 Key。</div>
            <template v-else-if="!supported">
                <div class="am-avt">认证是跨平台功能，但「{{ selPlatform ? V.platformLabel(selPlatform) : (selected && (selected.name || selected.id)) || '该平台' }}」的资产认证 API 尚未接入（待接入）。请选择已支持的平台，或继续使用官方控制台认证。</div>
                <MenuSelect :model-value="selected ? selected.id : ''" :options="options" variant="block" @update:model-value="v => (L.avatarProvider = v)" />
            </template>
            <template v-else>
                <div class="am-avt">提交到 {{ V.platformLabel(selPlatform) }} 私域素材审核，通过后生成 asset:// 地址，可在该平台的视频生成中通过 @ 直接调用（一个素材可注册到多个平台，平台间互相隔离）。</div>
                <MenuSelect :model-value="selected ? selected.id : ''" :options="options" variant="block" @update:model-value="v => (L.avatarProvider = v)" />
                <div v-if="noKey" class="am-avt warn">该平台尚未配置 API Key。</div>
                <div v-if="already" class="am-avt">该平台已注册，再次提交会覆盖该平台的认证。</div>
                <button type="button" class="am-wbtn" :disabled="busy || noKey" @click="run(V.register(item.id, selected && selected.id))">
                    <span v-if="busy" class="am-spin"></span><NvIcon v-else name="user" />{{ busy ? '注册中，请稍候…' : (already ? '重新注册到该平台' : '注册并等待审核') }}
                </button>
            </template>
        </div>
    </div>
</template>

<style scoped>
.am-av { display: flex; flex-direction: column; gap: 8px; }
.am-avh { display: flex; align-items: center; gap: 6px; font: 500 12px/16px var(--font-sans); }
.am-avh .nv-i { width: 14px; height: 14px; color: var(--ink-2); }
.am-avh .pt { margin-left: auto; height: 18px; padding: 0 6px; border-radius: 5px; background: var(--solid); font: 400 11px/18px var(--font-mono); color: var(--ink-2); letter-spacing: .03em; }
.am-avt { font: 400 11.5px/17px var(--font-sans); color: var(--ink-3); }
.am-avt.warn { color: var(--danger); }
.am-uri { font: 400 11px/16px var(--font-mono); padding: 6px 8px; border-radius: 7px; background: var(--solid); color: var(--ink); word-break: break-all; }
.am-avr { display: flex; gap: 6px; flex-wrap: wrap; }
.am-avsep { height: 6px; }
</style>
