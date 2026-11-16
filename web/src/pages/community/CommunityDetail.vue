<script setup>
// 社区作品详情（M3）：宽 1120 / 高 720 的非全屏弹窗。左边只读预览（画布可拖动缩放，技能 / 提示词显示正文），
// 右边 400 宽信息栏：标题、作者与在线状态、简介、标签、信息块、统计、说明，右下点赞 / 收藏 / 更多 + 克隆主按钮。
// 点作者头像 → 打开对方主页（只读，见 MePage）。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import NvIcon from '../../components/NvIcon.vue';
import CommunityCanvasPreview from './CommunityCanvasPreview.vue';
import { ago, avatarImage, avatarText, authorInitial, communityApi, coverUrl, fmtCount, fmtSize, kindMeta } from '../../lib/community.js';
import { bumpCommunity, openCommunityAuthor, toast } from '../../lib/store.js';
import { navigate, openCanvasUrl } from '../../lib/bridge.js';

const props = defineProps({ itemId: { type: String, required: true } });
const emit = defineEmits(['close']);

const loading = ref(true);
const failed = ref('');
const data = ref(null);
const busy = ref('');
const liked = ref(false);
const favorited = ref(false);
const moreOpen = ref(false);
const reportOpen = ref(false);

const REPORT_REASONS = ['与描述不符', '内容不适合局域网', '疑似抄袭', '包含隐私信息', '其它'];

const item = computed(() => (data.value && data.value.item) || null);
const payload = computed(() => (data.value && data.value.payload) || {});
const summary = computed(() => (data.value && data.value.summary) || {});
const kind = computed(() => (item.value && item.value.kind) || 'canvas');
const online = computed(() => !!(data.value && data.value.online));
const mine = computed(() => !!(data.value && data.value.mine));
const author = computed(() => (item.value && item.value.author) || {});
const stats = computed(() => (item.value && item.value.stats) || {});
const cover = computed(() => coverUrl(item.value));
const avatarBroken = ref(false);
const avatarSrc = computed(() => (avatarBroken.value ? '' : avatarImage(author.value)));
const KIND_EN = { canvas: 'CANVAS', skill: 'SKILL', prompt: 'PROMPT' };
const eyebrow = computed(() => (KIND_EN[kind.value] || 'CANVAS') + (item.value ? ' · V' + item.value.version : ''));
const publishedText = computed(() => {
    if (!item.value) return '';
    const when = ago(item.value.updated_at || item.value.created_at);
    return online.value ? '在线 · ' + (when ? when + '发布' : '已发布') : '作者离线 · ' + (when || '');
});
const facts = computed(() => {
    const rows = [];
    if (kind.value === 'canvas') {
        rows.push({ k: '节点', v: String(summary.value.nodes || 0) });
        rows.push({ k: '媒体', v: (summary.value.media || 0) + ' 张' });
        rows.push({ k: '模型', v: 'AUTO' });
        rows.push({ k: '发布包', v: fmtSize(summary.value.size_bytes) });
    } else if (kind.value === 'skill') {
        rows.push({ k: '类型', v: '技能' });
        rows.push({ k: '分类', v: item.value && item.value.category ? item.value.category : '未分类' });
        rows.push({ k: '发布包', v: fmtSize(summary.value.size_bytes) });
    } else {
        rows.push({ k: '类型', v: '提示词' });
        rows.push({ k: '分类', v: item.value && item.value.category ? item.value.category : '未分类' });
    }
    return rows;
});
const skillBody = computed(() => {
    const body = payload.value || {};
    return {
        name: body.name || (item.value && item.value.title) || '',
        description: body.description || (item.value && item.value.desc) || '',
        instruction: body.usage_instruction || '',
        prompt: body.skill_prompt || '',
        tags: Array.isArray(body.tags) ? body.tags : [],
    };
});
const promptBody = computed(() => {
    const body = payload.value || {};
    return {
        name: body.name || (item.value && item.value.title) || '',
        positive: body.positive || '',
        negative: body.negative || '',
    };
});
const canClone = computed(() => !!(item.value && item.value.allow_clone !== false) && (online.value || !!data.value));

async function load() {
    loading.value = true;
    failed.value = '';
    try {
        const body = await communityApi('/items/' + encodeURIComponent(props.itemId));
        data.value = body;
        liked.value = !!body.liked;
        favorited.value = !!body.favorited;
    } catch (e) {
        failed.value = e.message || '作品打不开，作者可能已经离线';
    } finally {
        loading.value = false;
    }
}

async function toggleLike() {
    if (busy.value) return;
    busy.value = 'like';
    try {
        const body = await communityApi('/items/' + encodeURIComponent(props.itemId) + '/like', { method: 'POST' });
        liked.value = !!body.liked;
        if (item.value && body.stats) item.value.stats = body.stats;
        bumpCommunity();
    } catch (e) {
        toast(e.message || '点赞失败', { danger: true });
    } finally { busy.value = ''; }
}
async function toggleFavorite() {
    if (busy.value) return;
    busy.value = 'favorite';
    try {
        const body = await communityApi('/items/' + encodeURIComponent(props.itemId) + '/favorite', { method: 'POST' });
        favorited.value = !!body.favorited;
        toast(favorited.value ? '已收藏' : '已取消收藏');
        bumpCommunity();
    } catch (e) {
        toast(e.message || '收藏失败', { danger: true });
    } finally { busy.value = ''; }
}
async function doClone() {
    if (busy.value) return;
    busy.value = 'clone';
    try {
        const body = await communityApi('/items/' + encodeURIComponent(props.itemId) + '/clone', { method: 'POST' });
        bumpCommunity();
        if (body.kind === 'canvas') {
            const failed = Number(body.failed) || 0;
            toast('已克隆到我的画布' + (failed ? '（' + failed + ' 个素材没取到，已标注）' : ''), {
                onClick: () => {
                    openCanvasUrl('/static/canvas.html?id=' + encodeURIComponent(body.target_id) + '&project=default');
                    emit('close');
                },
            });
        } else if (body.kind === 'skill') {
            toast(body.message || '技能已导入，默认停用，去设置里确认后启用');
        } else {
            toast('提示词已加进「社区」分组');
        }
        await load();
    } catch (e) {
        toast(e.message || '克隆失败', { danger: true });
    } finally { busy.value = ''; }
}
async function report(reason) {
    reportOpen.value = false;
    moreOpen.value = false;
    try {
        await communityApi('/items/' + encodeURIComponent(props.itemId) + '/report', { method: 'POST', body: { reason } });
        bumpCommunity();
        toast('已举报，本机不再显示这个作品');
        emit('close');
    } catch (e) {
        toast(e.message || '举报失败', { danger: true });
    }
}
async function blockAuthor() {
    moreOpen.value = false;
    const accountId = String(author.value.account_id || '');
    if (!accountId) { toast('拿不到作者信息', { danger: true }); return; }
    try {
        await communityApi('/block', { method: 'POST', body: { account_id: accountId, blocked: true } });
        bumpCommunity();
        toast('已屏蔽 ' + (author.value.nickname || '该作者') + '，本机不再显示 TA 的作品');
        emit('close');
    } catch (e) {
        toast(e.message || '屏蔽失败', { danger: true });
    }
}
function openAuthor() {
    if (!item.value) return;
    openCommunityAuthor(props.itemId);
    navigate('me');
    emit('close');
}
function onKey(event) { if (event.key === 'Escape') emit('close'); }
function onDocDown(event) {
    if (!event.target.closest || !event.target.closest('.cd-more')) moreOpen.value = false;
}
onMounted(() => {
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDocDown, true);
    load();
});
onBeforeUnmount(() => {
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('mousedown', onDocDown, true);
});
watch(() => props.itemId, load);
</script>

<template>
    <Teleport to="#nv-layer">
        <div class="cd-scrim" @click="emit('close')"></div>
        <div class="cd" role="dialog" aria-modal="true" :aria-label="(item && item.title) || '作品详情'">
            <div class="cd-left">
                <div v-if="loading" class="cd-loading">正在打开作品…</div>
                <div v-else-if="failed" class="cd-fail">
                    <NvIcon name="alert" />
                    <b>作品打不开</b>
                    <span>{{ failed }}</span>
                </div>
                <template v-else>
                    <CommunityCanvasPreview v-if="kind === 'canvas'" :payload="payload" />
                    <div v-else class="cd-text">
                        <template v-if="kind === 'skill'">
                            <span class="lab mono"><NvIcon name="wand2" />技能</span>
                            <h3>{{ skillBody.name }}</h3>
                            <p v-if="skillBody.description" class="lead">{{ skillBody.description }}</p>
                            <template v-if="skillBody.instruction">
                                <h4>怎么用</h4>
                                <p class="body">{{ skillBody.instruction }}</p>
                            </template>
                            <template v-if="skillBody.prompt">
                                <h4>技能提示词</h4>
                                <p class="body">{{ skillBody.prompt }}</p>
                            </template>
                        </template>
                        <template v-else>
                            <span class="lab mono"><NvIcon name="type" />提示词</span>
                            <h3>{{ promptBody.name }}</h3>
                            <h4>正向</h4>
                            <p class="body">{{ promptBody.positive }}</p>
                            <template v-if="promptBody.negative">
                                <h4>负向</h4>
                                <p class="body">{{ promptBody.negative }}</p>
                            </template>
                        </template>
                    </div>
                </template>
            </div>

            <div v-if="item" class="cd-side">
                <div class="cd-top">
                    <span class="eyebrow mono">{{ eyebrow }}</span>
                    <button type="button" class="cd-x" aria-label="关闭" @click="emit('close')"><NvIcon name="x" /></button>
                </div>
                <h2>{{ item.title }}</h2>
                <div class="cd-who">
                    <button type="button" class="av" :aria-label="'看 ' + (author.nickname || '作者') + ' 的主页'" @click="openAuthor">
                        <img v-if="avatarSrc" :src="avatarSrc" alt="" @error="avatarBroken = true" />
                        <template v-else>{{ avatarText(author) || authorInitial(author) }}</template>
                    </button>
                    <button type="button" class="nm" @click="openAuthor">{{ author.nickname || '局域网用户' }}</button>
                    <span class="dot" :class="{ off: !online }" aria-hidden="true"></span>
                    <small>{{ publishedText }}</small>
                </div>
                <p v-if="item.desc" class="cd-desc">{{ item.desc }}</p>
                <div v-if="(item.tags || []).length || item.category" class="cd-tags">
                    <span v-if="item.category" class="tag">{{ item.category }}</span>
                    <span v-for="tag in item.tags" :key="tag" class="tag">{{ tag }}</span>
                </div>
                <dl class="cd-facts">
                    <div v-for="row in facts" :key="row.k"><dt>{{ row.k }}</dt><dd class="mono">{{ row.v }}</dd></div>
                </dl>
                <div class="cd-stats">
                    <span><NvIcon name="heart" /><b class="mono">{{ fmtCount(stats.likes) }}</b></span>
                    <span><NvIcon name="copy" /><b class="mono">{{ fmtCount(stats.clones) }}</b> 次克隆</span>
                    <span><NvIcon name="eye" /><b class="mono">{{ fmtCount(stats.views) }}</b></span>
                </div>
                <p class="cd-note"><NvIcon name="info" /><span>克隆后成为你自己的画布，图片和视频会复制到本机，不再依赖作者在线。模型按你的 API 设置自动选择。</span></p>
                <div class="cd-acts">
                    <button type="button" class="cd-ib" :class="{ on: liked }" :aria-pressed="liked" :disabled="!online && !mine" :title="liked ? '取消点赞' : '点赞'" @click="toggleLike"><NvIcon name="heart" /></button>
                    <button type="button" class="cd-ib" :class="{ on: favorited }" :aria-pressed="favorited" :title="favorited ? '取消收藏' : '收藏'" @click="toggleFavorite"><NvIcon name="star" /></button>
                    <div class="cd-more">
                        <button type="button" class="cd-ib" title="更多" aria-label="更多" @click="moreOpen = !moreOpen"><NvIcon name="more" /></button>
                        <Transition name="cd-pop">
                            <div v-if="moreOpen" class="cd-menu">
                                <button type="button" :disabled="online && mine" @click="reportOpen = !reportOpen"><NvIcon name="alert" />举报作品</button>
                                <button type="button" @click="blockAuthor"><NvIcon name="eyeoff" />屏蔽这位作者</button>
                            </div>
                        </Transition>
                        <Transition name="cd-pop">
                            <div v-if="reportOpen" class="cd-menu reasons">
                                <button v-for="reason in REPORT_REASONS" :key="reason" type="button" @click="report(reason)">{{ reason }}</button>
                            </div>
                        </Transition>
                    </div>
                    <span class="sp"></span>
                    <button type="button" class="cd-clone" :disabled="!canClone || !!busy" :title="canClone ? '克隆到我的画布' : '作者没有开放克隆'" @click="doClone">
                        <NvIcon :name="kind === 'canvas' ? 'copy' : kind === 'skill' ? 'wand2' : 'type'" />
                        {{ busy === 'clone' ? '克隆中…' : (kind === 'canvas' ? '克隆到我的画布' : kind === 'skill' ? '克隆这个技能' : '克隆这条提示词') }}
                    </button>
                </div>
            </div>
            <button v-else class="cd-x floating" aria-label="关闭" @click="emit('close')"><NvIcon name="x" /></button>
        </div>
    </Teleport>
</template>

<style scoped>
.cd-scrim { position: fixed; inset: 0; z-index: 82; background: var(--scrim); backdrop-filter: var(--material-thin); -webkit-backdrop-filter: var(--material-thin); animation: cdFade .2s ease; }
.cd { position: fixed; left: 50%; top: 50%; z-index: 83; transform: translate(-50%, -50%); width: min(1120px, calc(100vw - 48px)); height: min(720px, calc(100vh - 64px));
    display: flex; border-radius: 20px; overflow: hidden; background: var(--solid); box-shadow: var(--shadow-dialog); color: var(--ink); font-family: var(--font-sans); animation: cdIn .24s var(--ease-out); }
@keyframes cdIn { from { opacity: 0; transform: translate(-50%, -48%) scale(.99); } }
@keyframes cdFade { from { opacity: 0; } }
.cd-left { position: relative; flex: 1; min-width: 0; background: var(--canvas); overflow: hidden; }
.cd-loading, .cd-fail { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--ink-3); font: 400 12.5px/18px var(--font-sans); }
.cd-fail .nv-i { width: 22px; height: 22px; }
.cd-fail b { font: 500 14px/20px var(--font-sans); color: var(--ink); }
.cd-text { height: 100%; overflow-y: auto; padding: 30px 34px 40px; background: var(--solid); }
.cd-text .lab { display: inline-flex; align-items: center; gap: 5px; font: 400 10.5px/1 var(--font-mono); letter-spacing: .08em; text-transform: uppercase; color: var(--ink-3); }
.cd-text .lab .nv-i { width: 12px; height: 12px; }
.cd-text h3 { margin: 10px 0 6px; font: 600 19px/26px var(--font-sans); letter-spacing: -.01em; }
.cd-text .lead { margin: 0 0 18px; font: 400 13px/21px var(--font-sans); color: var(--ink-2); }
.cd-text h4 { margin: 18px 0 6px; font: 600 12px/18px var(--font-sans); color: var(--ink-3); }
.cd-text .body { margin: 0; font: 400 12.5px/21px var(--font-sans); color: var(--ink-2); white-space: pre-wrap; }

.cd-side { width: 400px; flex: none; display: flex; flex-direction: column; padding: 18px 22px 18px; overflow-y: auto; background: var(--solid); }
.cd-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.cd-top .eyebrow { font: 400 10.5px/1 var(--font-mono); letter-spacing: .08em; text-transform: uppercase; color: var(--ink-3); }
.cd-x { width: 28px; height: 28px; border: 0; border-radius: 14px; background: transparent; color: var(--ink-3); display: flex; align-items: center; justify-content: center; cursor: pointer; }
.cd-x:hover { background: var(--fill-1); color: var(--ink); }
.cd-x .nv-i { width: 15px; height: 15px; }
.cd-x.floating { position: absolute; right: 14px; top: 14px; z-index: 2; background: var(--glass-strong); }
.cd-side h2 { margin: 8px 0 10px; font: 600 18px/25px var(--font-sans); letter-spacing: -.01em; }
.cd-who { display: flex; align-items: center; gap: 7px; }
.cd-who .av { width: 24px; height: 24px; flex: none; border: 0; padding: 0; border-radius: 50%; overflow: hidden; background: var(--fill-2); color: var(--ink); font: 500 11px/1 var(--font-sans); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
.cd-who .av img { width: 100%; height: 100%; object-fit: cover; display: block; }
.cd-who .nm { border: 0; background: transparent; padding: 0; font: 500 12.5px/1 var(--font-sans); color: var(--ink); cursor: pointer; }
.cd-who .nm:hover { text-decoration: underline; }
.cd-who .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--success); flex: none; }
.cd-who .dot.off { background: var(--ink-4); }
.cd-who small { font: 400 11.5px/1 var(--font-sans); color: var(--ink-3); }
.cd-desc { margin: 12px 0 0; font: 400 12.5px/20px var(--font-sans); color: var(--ink-2); }
.cd-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 12px; }
.cd-tags .tag { height: 22px; padding: 0 9px; border-radius: 11px; background: var(--fill-1); color: var(--ink-2); font: 400 11px/22px var(--font-sans); }
.cd-facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 14px; margin: 16px 0 0; padding: 14px; border-radius: 14px; background: var(--fill-1); }
.cd-facts div { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.cd-facts dt { margin: 0; font: 400 11px/16px var(--font-sans); color: var(--ink-3); }
.cd-facts dd { margin: 0; font: 500 12px/16px var(--font-mono); color: var(--ink); font-variant-numeric: tabular-nums; }
.cd-stats { display: flex; gap: 16px; margin-top: 14px; font: 400 11.5px/1 var(--font-sans); color: var(--ink-3); }
.cd-stats span { display: inline-flex; align-items: center; gap: 4px; }
.cd-stats .nv-i { width: 13px; height: 13px; }
.cd-stats b { font: 500 12px/1 var(--font-mono); color: var(--ink); }
.cd-note { display: flex; gap: 7px; margin: 14px 0 0; font: 400 11px/17px var(--font-sans); color: var(--ink-3); }
.cd-note .nv-i { width: 13px; height: 13px; flex: none; margin-top: 2px; }
.cd-acts { display: flex; align-items: center; gap: 6px; margin-top: auto; padding-top: 16px; }
.cd-acts .sp { flex: 1; }
.cd-ib { width: 34px; height: 34px; border: 0; border-radius: 17px; background: var(--fill-1); color: var(--ink-2); display: flex; align-items: center; justify-content: center; cursor: pointer; }
.cd-ib:hover:not(:disabled) { background: var(--fill-2); color: var(--ink); }
.cd-ib.on { background: var(--fill-3); color: var(--ink); }
.cd-ib:disabled { opacity: .4; cursor: not-allowed; }
.cd-ib .nv-i { width: 15px; height: 15px; }
.cd-more { position: relative; }
.cd-menu { position: absolute; left: 0; bottom: calc(100% + 6px); z-index: 4; min-width: 168px; padding: 4px; border-radius: 12px; background: var(--solid); box-shadow: var(--shadow-pop); animation: cdPop .14s ease both; }
.cd-menu.reasons { left: 100%; bottom: 0; margin-left: 6px; }
.cd-menu button { display: flex; align-items: center; gap: 8px; width: 100%; height: 30px; padding: 0 10px; border: 0; border-radius: 8px; background: transparent; color: var(--ink); font: 400 12.5px/1 var(--font-sans); text-align: left; cursor: pointer; white-space: nowrap; }
.cd-menu button:hover { background: var(--fill-1); }
.cd-menu button .nv-i { width: 14px; height: 14px; color: var(--ink-3); }
@keyframes cdPop { from { opacity: 0; transform: translateY(4px); } }
.cd-pop-enter-active, .cd-pop-leave-active { transition: opacity .14s ease, transform .14s ease; }
.cd-pop-enter-from, .cd-pop-leave-to { opacity: 0; transform: translateY(4px); }
.cd-clone { height: 38px; padding: 0 18px; border: 0; border-radius: 19px; background: var(--accent); color: var(--on-accent); font: 500 13px/1 var(--font-sans); display: inline-flex; align-items: center; gap: 6px; cursor: pointer; white-space: nowrap; }
.cd-clone:hover:not(:disabled) { box-shadow: var(--shadow-lift); transform: translateY(-1px); }
.cd-clone:disabled { background: var(--fill-2); color: var(--ink-4); cursor: not-allowed; }
.cd-clone .nv-i { width: 14px; height: 14px; }
@media (max-width: 980px) { .cd { flex-direction: column; height: calc(100vh - 32px); } .cd-left { min-height: 260px; } .cd-side { width: 100%; } }
</style>
