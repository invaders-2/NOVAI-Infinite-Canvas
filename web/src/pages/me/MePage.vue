<script setup>
// 我的（M4）：从「个人中心」改成个人主页——顶部通栏背景图、大头像、统计（含好友浮层）、
// 发布 / 点赞 / 收藏 / 克隆四个 Tab + 筛选 + 作品网格。别人看你的主页是同一页面的只读模式（state.communityAuthor）。
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import NvIcon from '../../components/NvIcon.vue';
import MeProfileDialog from './MeProfileDialog.vue';
import { closeCommunityAuthor, openCommunityDetail, openCommunityPublish, state, toast } from '../../lib/store.js';
import { ago, coverUrl as itemCover, communityApi, fmtCount, kindMeta } from '../../lib/community.js';
import { broadcast, frameEl, navigate, openCanvasUrl } from '../../lib/bridge.js';

const readonly = computed(() => !!state.communityAuthor);
const AUTHOR = { canvas: 'canvas', skill: 'skill', prompt: 'prompt' };

/* ───────── 身份 / 主页 ───────── */
const lanMe = ref(null);
const mine = ref(null);          // /api/community/profile
const author = ref(null);        // 只读：别人的主页
const authorOnline = ref(true);
const coverBroken = ref(false);
const editOpen = ref(false);

const displayName = computed(() => {
    if (readonly.value) return String((author.value && author.value.author && author.value.author.nickname) || '局域网用户');
    return String((lanMe.value && lanMe.value.nickname) || (mine.value && mine.value.author && mine.value.author.nickname) || '本机用户');
});
const accountPayload = computed(() => (readonly.value ? (author.value && author.value.author) || {} : (lanMe.value || {})));
const friendCode = computed(() => String((lanMe.value && lanMe.value.friend_code) || ''));
const avatarSrc = computed(() => {
    const avatar = String(accountPayload.value.avatar || '');
    return avatar.startsWith('data:') ? avatar : '';
});
const avatarText = computed(() => {
    const avatar = String(accountPayload.value.avatar || '');
    if (avatar && !avatar.startsWith('data:')) return [...avatar].slice(0, 2).join('');
    return [...displayName.value][0] || '我';
});
const coverSource = computed(() => {
    if (readonly.value) return (author.value && author.value.profile && author.value.profile.cover_url) || '';
    return (mine.value && mine.value.profile && mine.value.profile.cover_url) || '';
});
const focusX = computed(() => Number((readonly.value ? author.value && author.value.profile : mine.value && mine.value.profile)?.focus_x ?? 50));
const focusY = computed(() => Number((readonly.value ? author.value && author.value.profile : mine.value && mine.value.profile)?.focus_y ?? 50));
const coverStyle = computed(() => {
    if (!coverSource.value || coverBroken.value) return {};
    return { backgroundImage: 'url("' + coverSource.value + '")', backgroundPosition: focusX.value + '% ' + focusY.value + '%' };
});
const stats = computed(() => {
    const source = readonly.value
        ? (author.value && author.value.stats) || {}
        : (mine.value && mine.value.stats) || {};
    return {
        items: Number(source.items) || 0,
        likes: Number(source.likes) || 0,
        clones: Number(source.clones) || 0,
        views: Number(source.views) || 0,
        friends: friends.value.length,
    };
});
const isOnline = computed(() => (readonly.value ? authorOnline.value : true));

/* ───────── 作品 ───────── */
const works = ref([]);
const likes = ref([]);
const favorites = ref([]);
const clones = ref([]);
const tab = ref('published');
const sort = ref('latest');
const kindFilter = ref('');
const statusFilter = ref('');
const q = ref('');
const loading = ref(true);
const failed = ref('');

// 数量优先用 /profile 里的统计（点赞 / 收藏 / 克隆各有多少），列表还没展开时也能显示真实数字
const TABS = computed(() => {
    const profileCounts = mine.value || {};
    return [
        { id: 'published', label: '发布', count: Math.max(works.value.length, Number(profileCounts.items) || 0) },
        { id: 'likes', label: '点赞', count: Math.max(likes.value.length, Number(profileCounts.likes) || 0) },
        { id: 'favorites', label: '收藏', count: Math.max(favorites.value.length, Number(profileCounts.favorites) || 0) },
        { id: 'clones', label: '克隆', count: Math.max(clones.value.length, Number(profileCounts.clones) || 0) },
    ];
});
const SORTS = [{ id: 'latest', label: '最新' }, { id: 'oldest', label: '最早' }];
const KINDS = [{ id: '', label: '全部类型' }, { id: 'canvas', label: '画布' }, { id: 'skill', label: '技能' }, { id: 'prompt', label: '提示词' }];
const STATUSES = [{ id: '', label: '全部状态' }, { id: 'published', label: '已发布' }, { id: 'unlisted', label: '已下架' }, { id: 'reported', label: '被举报' }];
const openMenu = ref('');

const sourceList = computed(() => {
    if (readonly.value) return ((author.value && author.value.items) || []).map(wrapRemote);
    if (tab.value === 'likes') return likes.value;
    if (tab.value === 'favorites') return favorites.value;
    if (tab.value === 'clones') return clones.value;
    return works.value;
});
function wrapRemote(item) { return { ...item, mineItem: false }; }
const visibleList = computed(() => {
    const keyword = q.value.trim().toLowerCase();
    let list = sourceList.value.filter(item => {
        if (!item || !item.id) return false;
        if (kindFilter.value && item.kind !== kindFilter.value) return false;
        if (!readonly.value && tab.value === 'published' && statusFilter.value) {
            const reports = Number((item.stats || {}).reports) || 0;
            if (statusFilter.value === 'reported' && reports <= 0) return false;
            if (statusFilter.value !== 'reported' && item.status !== statusFilter.value) return false;
        }
        if (keyword) {
            const hay = [item.title, item.desc, (item.author || {}).nickname].join(' ').toLowerCase();
            if (!hay.includes(keyword)) return false;
        }
        return true;
    });
    list = [...list].sort((a, b) => {
        const av = Number(a.updated_at || a.created_at) || 0;
        const bv = Number(b.updated_at || b.created_at) || 0;
        return sort.value === 'oldest' ? av - bv : bv - av;
    });
    return list;
});
const emptyText = computed(() => {
    if (q.value.trim()) return '没有找到「' + q.value.trim() + '」';
    if (tab.value === 'likes') return '还没有点赞过作品';
    if (tab.value === 'favorites') return '还没有收藏作品';
    if (tab.value === 'clones') return '还没有克隆过作品';
    return '还没有发布作品';
});
const emptyHint = computed(() => {
    if (tab.value === 'published') return '把画布、技能或提示词发布出来，局域网里的同事能看到并克隆';
    return '在社区里点作品右下角的「克隆」或详情里的收藏 / 点赞，就会出现在这里';
});

function wrapClone(item) { return item; }

/* ───────── 好友 ───────── */
const friends = ref([]);
const friendsOpen = ref(false);
const friendWorks = reactive({});
const addOpen = ref(false);
const addCode = ref('');
const addBusy = ref(false);
const inviteCopied = ref(false);

async function loadFriends() {
    try {
        const response = await fetch('/api/lan/friends', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
        if (!response.ok) return;
        const data = await response.json();
        friends.value = (Array.isArray(data && data.friends) ? data.friends : []).filter(f => f && f.id);
    } catch (e) { /* 旧后端没有 LAN 接口：好友做空态 */ }
}
async function loadFriendWorks() {
    await Promise.all(friends.value.filter(f => f.online).map(async friend => {
        if (friendWorks[friend.id] !== undefined) return;
        try {
            const data = await communityApi('/authors/' + encodeURIComponent(friend.id));
            friendWorks[friend.id] = Number((data.stats || {}).items) || 0;
        } catch (e) { friendWorks[friend.id] = null; }
    }));
}
function toggleFriends() { friendsOpen.value = !friendsOpen.value; if (friendsOpen.value) loadFriendWorks(); }
function friendAvatarImg(friend) {
    const avatar = String((friend && friend.avatar) || '');
    return avatar.startsWith('data:') ? avatar : '';
}
function friendAvatarText(friend) {
    const avatar = String((friend && friend.avatar) || '');
    if (avatar && !avatar.startsWith('data:')) return [...avatar].slice(0, 2).join('');
    return [...String((friend && friend.nickname) || '友')][0];
}
function friendStateText(friend) {
    if (friend && friend.online) {
        const count = friendWorks[friend.id];
        return '在线' + (count === null || count === undefined ? '' : ' · ' + count + ' 件作品');
    }
    const stamp = Number(friend && friend.last_seen) || 0;
    if (!stamp) return '离线';
    return '离线 · ' + (ago(stamp) || '刚刚') + '在线';
}
async function addFriend() {
    const code = addCode.value.trim();
    if (!code) return;
    addBusy.value = true;
    try {
        const response = await fetch('/api/lan/friends', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ code }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(String(data && data.detail || '加好友失败'));
        toast('已添加好友');
        addCode.value = '';
        addOpen.value = false;
        await loadFriends();
    } catch (e) {
        toast(e.message || '加好友失败', { danger: true });
    } finally {
        addBusy.value = false;
    }
}
function openFriendProfile(friend) {
    state.communityAuthor = 'account:' + friend.id;
    friendsOpen.value = false;
}
async function openFriendChat(friend) {
    friendsOpen.value = false;
    try {
        const response = await fetch('/api/canvases', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
        const data = response.ok ? await response.json() : {};
        const list = (Array.isArray(data && data.canvases) ? data.canvases : []).filter(Boolean);
        const ts = c => { const v = Number(c.updated_at || c.created_at || 0); return v < 1e10 ? v * 1000 : v; };
        list.sort((a, b) => ts(b) - ts(a));
        const canvas = list[0];
        if (!canvas) { toast('先打开一张画布，就能在里面聊天'); return; }
        const url = '/static/canvas.html?id=' + encodeURIComponent(canvas.id) + '&project=' + encodeURIComponent(canvas.project || 'default');
        openCanvasUrl(url);
        const frame = frameEl('canvas');
        let tries = 0;
        const target = new URL(url, location.href).href;
        const post = () => {
            let ready = false;
            try {
                const win = frame && frame.contentWindow;
                ready = !!win && win.location.href === target && win.document.readyState === 'complete';
            } catch (e) { ready = false; }
            if (ready || tries++ >= 80) {
                try { frame && frame.contentWindow && frame.contentWindow.postMessage({ type: 'novai:lan-open', friendId: String(friend.id) }, '*'); } catch (e) {}
                return;
            }
            setTimeout(post, 100);
        };
        post();
    } catch (e) {
        toast('打开聊天失败', { danger: true });
    }
}

/* ───────── 背景图 ───────── */
const coverMenu = ref(false);
const focusOpen = ref(false);
const assetOpen = ref(false);
const assets = ref([]);
const assetLoading = ref(false);
const focusDraft = reactive({ x: 50, y: 50 });
const fileEl = ref(null);

async function loadProfile() {
    try {
        const data = await communityApi('/profile');
        mine.value = data;
    } catch (e) { mine.value = null; }
}
function openFocus() {
    coverMenu.value = false;
    focusDraft.x = focusX.value;
    focusDraft.y = focusY.value;
    focusOpen.value = true;
}
async function saveFocus() {
    try {
        await communityApi('/profile', { method: 'PUT', body: { action: 'focus', focus_x: Math.round(focusDraft.x), focus_y: Math.round(focusDraft.y) } });
        focusOpen.value = false;
        await loadProfile();
        toast('背景位置已保存');
    } catch (e) { toast(e.message || '保存失败', { danger: true }); }
}
async function resetCover() {
    coverMenu.value = false;
    try {
        await communityApi('/profile', { method: 'PUT', body: { action: 'reset' } });
        coverBroken.value = false;
        await loadProfile();
        toast('已恢复默认背景');
    } catch (e) { toast(e.message || '恢复失败', { danger: true }); }
}
async function uploadCover() {
    coverMenu.value = false;
    if (fileEl.value) fileEl.value.click();
}
async function onCoverFile(event) {
    const file = (event.target.files || [])[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { toast('图片太大（上限 8MB）', { danger: true }); return; }
    const dataUrl = await new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => resolve('');
        reader.readAsDataURL(file);
    });
    if (!dataUrl) { toast('图片读不出来', { danger: true }); return; }
    try {
        await communityApi('/profile', { method: 'PUT', body: { action: 'upload', data_url: dataUrl } });
        coverBroken.value = false;
        await loadProfile();
        toast('背景已更新');
    } catch (e) { toast(e.message || '上传失败', { danger: true }); }
}
async function openAssetPicker() {
    coverMenu.value = false;
    assetOpen.value = true;
    if (assets.value.length) return;
    assetLoading.value = true;
    try {
        const response = await fetch('/api/local-assets', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
        const data = response.ok ? await response.json() : {};
        assets.value = (Array.isArray(data && data.items) ? data.items : []).filter(it => it && it.url && String(it.kind || '') !== 'video').slice(0, 60);
    } catch (e) { assets.value = []; }
    finally { assetLoading.value = false; }
}
async function pickAsset(item) {
    try {
        await communityApi('/profile', { method: 'PUT', body: { action: 'asset', url: item.url } });
        assetOpen.value = false;
        coverBroken.value = false;
        await loadProfile();
        toast('背景已更新');
    } catch (e) { toast(e.message || '设置失败', { danger: true }); }
}

/* ───────── 分享主页 ── */
const shareOpen = ref(false);
async function copyText(text, label) {
    try { await navigator.clipboard.writeText(text); toast(label + '已复制'); }
    catch (e) { toast('复制失败，请手动记下：' + text); }
}
function copyFriendCode() { shareOpen.value = false; copyText(friendCode.value, '好友码'); }
function copyHomeAddress() {
    shareOpen.value = false;
    const host = location.host || '本机';
    copyText('http://' + host + '/', '主页地址');
}

/* ───────── 作品操作 ───────── */
function openPublish() { openCommunityPublish({}); }
function openDetail(item) { if (item && item.id) openCommunityDetail(item.id); }
function editWork(item) {
    openMenu.value = '';
    openCommunityPublish({ kind: item.kind, sourceId: item.source_id || '', itemId: item.id, title: item.title });
}
async function toggleUnlist(item) {
    openMenu.value = '';
    const unlisted = item.status === 'unlisted';
    try {
        await communityApi('/mine/' + encodeURIComponent(item.id) + (unlisted ? '/relist' : '/unlist'), { method: 'POST' });
        toast(unlisted ? '已重新上架到社区' : '已从社区下架');
        await loadWorks();
    } catch (e) { toast(e.message || '操作失败', { danger: true }); }
}
async function removeWork(item) {
    openMenu.value = '';
    if (!window.confirm('删除后社区里就没有这个作品了（源画布 / 技能不会被删除），继续吗？')) return;
    try {
        await communityApi('/mine/' + encodeURIComponent(item.id), { method: 'DELETE' });
        toast('已删除发布');
        await loadWorks();
    } catch (e) { toast(e.message || '删除失败', { danger: true }); }
}

/* ───────── 加载 ───────── */
async function loadMe() {
    try {
        const response = await fetch('/api/lan/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
        if (!response.ok) return;
        const data = await response.json();
        if (data && data.me) lanMe.value = data.me;
    } catch (e) { /* 旧后端没有 LAN 接口：退回本机用户 */ }
}
async function loadWorks() {
    loading.value = true;
    failed.value = '';
    try {
        const data = await communityApi('/mine');
        works.value = (Array.isArray(data.items) ? data.items : []).map(item => ({ ...item, mineItem: true }));
    } catch (e) {
        failed.value = e.message || '';
        works.value = [];
    } finally {
        loading.value = false;
    }
}
async function loadTabList(id) {
    if (readonly.value) return;
    if (id === 'likes' && !likes.value.length) {
        try { const data = await communityApi('/likes'); likes.value = (data.items || []).filter(Boolean); } catch (e) { likes.value = []; }
    }
    if (id === 'favorites' && !favorites.value.length) {
        try { const data = await communityApi('/favorites'); favorites.value = (data.items || []).filter(Boolean); } catch (e) { favorites.value = []; }
    }
    if (id === 'clones' && !clones.value.length) {
        try { const data = await communityApi('/clones'); clones.value = (data.items || []).filter(Boolean).map(wrapClone); } catch (e) { clones.value = []; }
    }
}
function switchTab(id) { tab.value = id; loadTabList(id); }

async function loadAuthor() {
    const key = String(state.communityAuthor || '');
    loading.value = true;
    failed.value = '';
    try {
        const data = key.startsWith('account:')
            ? await communityApi('/authors/' + encodeURIComponent(key.slice(8)))
            : await communityApi('/author/' + encodeURIComponent(key.replace(/^item:/, '')));
        author.value = data;
        authorOnline.value = data.online !== false;
    } catch (e) {
        failed.value = e.message || '打不开这个主页';
        author.value = null;
    } finally {
        loading.value = false;
    }
}

async function loadAll() {
    if (readonly.value) { await loadAuthor(); return; }
    await Promise.all([loadMe(), loadProfile(), loadWorks(), loadFriends()]);
    if (tab.value !== 'published') loadTabList(tab.value);
}
function closeAuthor() { closeCommunityAuthor(); tab.value = 'published'; loadAll(); }

function onFocusPage(event) {
    if (!event.detail || event.detail.id !== 'me') return;
    if (readonly.value) loadAuthor(); else { loadMe(); loadProfile(); loadWorks(); loadFriends(); }
}
function onDocDown(event) {
    if (!event.target.closest || !event.target.closest('.mp-menu, .mp-more, .mp-share')) {
        coverMenu.value = false;
        openMenu.value = '';
        shareOpen.value = false;
    }
}
// 在别处点赞 / 收藏 / 克隆后，列表和数量都要重拉（列表懒加载，清空后按当前 Tab 重取）
watch(() => state.communityRefresh, () => {
    if (readonly.value) { loadAuthor(); return; }
    likes.value = [];
    favorites.value = [];
    clones.value = [];
    loadWorks();
    loadProfile();
    loadTabList(tab.value);
});
watch(() => state.communityAuthor, () => { loadAll(); });
// 离开「我的」页时退出别人的主页视角，下次进来还是自己的主页
watch(() => state.active, id => { if (id !== 'me' && readonly.value) closeCommunityAuthor(); });

onMounted(() => {
    loadAll();
    window.addEventListener('novai-page-focus', onFocusPage);
    document.addEventListener('mousedown', onDocDown, true);
});
onBeforeUnmount(() => {
    window.removeEventListener('novai-page-focus', onFocusPage);
    document.removeEventListener('mousedown', onDocDown, true);
});
</script>

<template>
    <div class="mp">
        <div class="mp-cover" :class="{ 'is-default': !coverSource || coverBroken }" :style="coverStyle">
            <template v-if="!readonly">
                <button type="button" class="mp-coverbtn" @click="coverMenu = !coverMenu"><NvIcon name="bg" />更换背景</button>
                <Transition name="mp-pop">
                    <div v-if="coverMenu" class="mp-menu mp-covermenu">
                        <button type="button" @click="uploadCover"><NvIcon name="upload" />上传图片<small>建议 2400×500</small></button>
                        <button type="button" @click="openAssetPicker"><NvIcon name="library" />从素材库选择</button>
                        <button type="button" :disabled="!coverSource" @click="openFocus"><NvIcon name="crop" />调整位置</button>
                        <button type="button" @click="resetCover"><NvIcon name="refresh" />恢复默认</button>
                    </div>
                </Transition>
                <input ref="fileEl" type="file" accept="image/*" hidden @change="onCoverFile" />
            </template>
        </div>

        <div class="mp-in">
            <div class="mp-head">
                <span class="mp-av" aria-hidden="true">
                    <img v-if="avatarSrc" :src="avatarSrc" alt="" />
                    <template v-else>{{ avatarText }}</template>
                </span>
                <div class="mp-acts">
                    <template v-if="readonly">
                        <button type="button" class="mp-pill" @click="closeAuthor"><NvIcon name="back" />回到我的主页</button>
                    </template>
                    <template v-else>
                        <div class="mp-share">
                            <button type="button" class="mp-pill" @click="shareOpen = !shareOpen"><NvIcon name="share" />分享主页</button>
                            <Transition name="mp-pop">
                                <div v-if="shareOpen" class="mp-menu mp-sharemenu">
                                    <button type="button" @click="copyFriendCode"><NvIcon name="copy" />复制好友码<small class="mono">{{ friendCode }}</small></button>
                                    <button type="button" @click="copyHomeAddress"><NvIcon name="link" />复制主页地址</button>
                                </div>
                            </Transition>
                        </div>
                        <button type="button" class="mp-pill pri" @click="editOpen = true"><NvIcon name="user" />编辑资料</button>
                    </template>
                </div>
            </div>

            <h1 class="mp-name">
                {{ displayName }}
                <span v-if="readonly" class="mp-viewer">{{ isOnline ? '在线' : '离线' }}</span>
            </h1>
            <p class="mp-sub">
                <template v-if="readonly">局域网里的创作者</template>
                <template v-else>好友码 <span class="mono">{{ friendCode || '—' }}</span> · 局域网身份</template>
            </p>

            <div class="mp-stats">
                <div class="mp-stat"><span>作品</span><b class="mono">{{ stats.items }}</b></div>
                <div class="mp-stat"><span>获赞</span><b class="mono">{{ stats.likes }}</b></div>
                <div class="mp-stat"><span>被克隆</span><b class="mono">{{ stats.clones }}</b></div>
                <div class="mp-stat"><span>浏览</span><b class="mono">{{ stats.views }}</b></div>
                <div v-if="!readonly" class="mp-frwrap">
                    <button type="button" class="mp-stat mp-frbtn" :class="{ open: friendsOpen }" :aria-expanded="friendsOpen" @click="toggleFriends">
                        <span>好友</span><b class="mono">{{ friends.length }}</b><NvIcon name="chev" class="mp-frchev" />
                    </button>
                    <Transition name="mp-pop">
                        <div v-if="friendsOpen" class="mp-friends" role="dialog" aria-label="好友">
                            <div class="mp-fh">
                                <b>好友 <span class="mono">{{ friends.length }}</span></b>
                                <button type="button" class="nv-btn sm" @click="addOpen = !addOpen"><NvIcon name="plus" />添加好友</button>
                            </div>
                            <div v-if="addOpen" class="mp-add">
                                <input v-model="addCode" class="nv-field mp-inp" placeholder="粘贴好友码，例如 NOVAI-483920" @keydown.enter="addFriend" />
                                <button type="button" class="nv-btn sm primary" :disabled="addBusy || !addCode.trim()" @click="addFriend">{{ addBusy ? '添加中…' : '添加' }}</button>
                            </div>
                            <div v-if="!friends.length" class="mp-fempty">还没有好友，用好友码加一个</div>
                            <div v-for="friend in friends" :key="friend.id" class="mp-frow">
                                <span class="av" :class="{ off: !friend.online }">
                                    <img v-if="friendAvatarImg(friend)" :src="friendAvatarImg(friend)" alt="" />
                                    <template v-else>{{ friendAvatarText(friend) }}</template>
                                    <i v-if="friend.online" class="dot" aria-hidden="true"></i>
                                </span>
                                <span class="fx"><b>{{ friend.nickname || '好友' }}</b><small>{{ friendStateText(friend) }}</small></span>
                                <button type="button" class="nv-btn sm" @click="openFriendProfile(friend)">主页</button>
                                <button type="button" class="nv-btn sm" @click="openFriendChat(friend)">消息<span v-if="Number(friend.unread) > 0" class="mp-unread mono">{{ friend.unread }}</span></button>
                            </div>
                            <div class="mp-ff">
                                <span>我的好友码 <span class="mono">{{ friendCode || '—' }}</span></span>
                                <button type="button" class="mp-copy" @click="copyText(friendCode, '好友码'); inviteCopied = true">{{ inviteCopied ? '已复制' : '复制' }}</button>
                            </div>
                        </div>
                    </Transition>
                </div>
            </div>

            <div class="mp-sep"></div>

            <div class="mp-bar">
                <nav class="mp-tabs" aria-label="我的作品">
                    <button v-for="entry in TABS" v-show="!readonly || entry.id === 'published'" :key="entry.id" type="button" :class="{ on: tab === entry.id }" :aria-pressed="tab === entry.id" @click="switchTab(entry.id)">
                        {{ entry.label }}<em class="mono">{{ entry.count }}</em>
                    </button>
                </nav>
                <span class="sp"></span>
                <div class="mp-ddwrap">
                    <select v-model="sort" class="mp-dd" aria-label="排序">
                        <option v-for="entry in SORTS" :key="entry.id" :value="entry.id">{{ entry.id === 'latest' ? '最新' : '最早' }}</option>
                    </select>
                </div>
                <div class="mp-ddwrap">
                    <select v-model="kindFilter" class="mp-dd" aria-label="类型">
                        <option v-for="entry in KINDS" :key="entry.id" :value="entry.id">{{ entry.label }}</option>
                    </select>
                </div>
                <div v-if="!readonly && tab === 'published'" class="mp-ddwrap">
                    <select v-model="statusFilter" class="mp-dd" aria-label="状态">
                        <option v-for="entry in STATUSES" :key="entry.id" :value="entry.id">{{ entry.label }}</option>
                    </select>
                </div>
                <label class="mp-search"><input v-model="q" type="search" placeholder="输入作品名称" autocomplete="off" aria-label="搜索作品名称" /><NvIcon name="search" /></label>
                <button v-if="!readonly" type="button" class="mp-pub" :class="{ alone: tab !== 'published' }" @click="openPublish"><NvIcon name="plus" />发布作品</button>
            </div>

            <div v-if="loading" class="mp-skel"><div class="nv-skel" v-for="n in 4" :key="n"></div></div>
            <div v-else-if="failed" class="mp-empty"><b>主页加载失败</b><span>{{ failed }}</span><button type="button" class="nv-btn sm" @click="loadAll">重试</button></div>
            <div v-else-if="!visibleList.length" class="mp-empty">
                <b>{{ emptyText }}</b>
                <span>{{ emptyHint }}</span>
                <button v-if="!readonly" type="button" class="nv-btn primary sm" @click="openPublish">发布作品</button>
            </div>
            <div v-else class="mp-grid">
                <div v-for="item in visibleList" :key="item.id" class="mp-card">
                    <button type="button" class="mp-cv" :class="{ off: item.status === 'unlisted' }" @click="openDetail(item)">
                        <img v-if="itemCover(item)" :src="itemCover(item)" alt="" loading="lazy" decoding="async" />
                        <span v-else class="ph"><NvIcon :name="kindMeta(item.kind).icon" /></span>
                        <span class="kind"><NvIcon :name="kindMeta(item.kind).icon" />{{ kindMeta(item.kind).label }}</span>
                        <span v-if="!readonly && tab === 'published'" class="bd">
                            <span v-if="Number((item.stats || {}).reports) > 0" class="rep"><NvIcon name="alert" />举报 {{ (item.stats || {}).reports }}</span>
                            <span v-else-if="item.status === 'unlisted'" class="offs">已下架</span>
                            <span v-else class="ok">已发布</span>
                        </span>
                        <span v-else-if="readonly && !item.online" class="bd"><span class="offs">作者离线</span></span>
                    </button>
                    <div v-if="!readonly && tab === 'published'" class="mp-more">
                        <button type="button" class="mp-morebtn" :aria-label="'更多操作 ' + item.title" @click="openMenu = openMenu === item.id ? '' : item.id"><NvIcon name="more" /></button>
                        <Transition name="mp-pop">
                            <div v-if="openMenu === item.id" class="mp-menu mp-moremenu">
                                <button type="button" @click="editWork(item)"><NvIcon name="pencil" />编辑信息</button>
                                <button type="button" @click="toggleUnlist(item)"><NvIcon :name="item.status === 'unlisted' ? 'up' : 'eyeoff'" />{{ item.status === 'unlisted' ? '重新上架' : '从社区下架' }}</button>
                                <button type="button" class="danger" @click="removeWork(item)"><NvIcon name="trash" />删除发布</button>
                            </div>
                        </Transition>
                    </div>
                    <button type="button" class="mp-title" @click="openDetail(item)">{{ item.title }}</button>
                    <span class="mp-meta">
                        <span class="mono">{{ 'v' + (item.version || 1) + ' · ' + (ago(item.updated_at || item.created_at) || '刚刚') }}</span>
                        <span class="st mono"><NvIcon name="heart" />{{ fmtCount((item.stats || {}).likes) }}<i></i><NvIcon name="copy" />{{ fmtCount((item.stats || {}).clones) }}</span>
                    </span>
                </div>
            </div>
        </div>

        <!-- 调整位置 -->
        <Teleport to="#nv-layer">
            <div v-if="focusOpen" class="mp-scrim" @click="focusOpen = false"></div>
            <div v-if="focusOpen" class="mp-sheet" role="dialog" aria-label="调整背景位置">
                <div class="mp-sh"><b>调整背景位置</b><button type="button" class="mp-x" aria-label="关闭" @click="focusOpen = false"><NvIcon name="x" /></button></div>
                <div class="mp-preview" :style="{ backgroundImage: coverSource ? 'url(\'' + coverSource + '\')' : 'none', backgroundPosition: focusDraft.x + '% ' + focusDraft.y + '%' }"></div>
                <label class="mp-range"><span>左右</span><input v-model.number="focusDraft.x" type="range" min="0" max="100" step="1" /><b class="mono">{{ Math.round(focusDraft.x) }}%</b></label>
                <label class="mp-range"><span>上下</span><input v-model.number="focusDraft.y" type="range" min="0" max="100" step="1" /><b class="mono">{{ Math.round(focusDraft.y) }}%</b></label>
                <div class="mp-shf"><button type="button" class="nv-btn" @click="focusOpen = false">取消</button><button type="button" class="nv-btn primary" @click="saveFocus">保存</button></div>
            </div>

            <!-- 从素材库选择 -->
            <div v-if="assetOpen" class="mp-scrim" @click="assetOpen = false"></div>
            <div v-if="assetOpen" class="mp-sheet mp-assets" role="dialog" aria-label="从素材库选择背景">
                <div class="mp-sh"><b>从素材库选择</b><button type="button" class="mp-x" aria-label="关闭" @click="assetOpen = false"><NvIcon name="x" /></button></div>
                <div v-if="assetLoading" class="mp-fempty">正在读取素材库…</div>
                <div v-else-if="!assets.length" class="mp-fempty">素材库还是空的，先上传几张图</div>
                <div v-else class="mp-assetgrid">
                    <button v-for="asset in assets" :key="asset.id || asset.url" type="button" @click="pickAsset(asset)">
                        <img :src="'/api/media-preview?url=' + encodeURIComponent(asset.url) + '&w=320'" alt="" loading="lazy" />
                    </button>
                </div>
            </div>
        </Teleport>

        <MeProfileDialog v-if="editOpen" :me="lanMe || {}" @close="editOpen = false" @saved="next => { if (next) lanMe = next; loadProfile(); broadcast({ type: 'novai:profile' }); }" />
    </div>
</template>

<style scoped>
.mp { position: absolute; inset: 0; overflow-y: auto; overflow-x: hidden; color: var(--ink); }
/* 顶部通栏背景：250 高，铺满窗口宽；默认是一张中性灰渐变 */
.mp-cover { position: relative; height: 250px; width: 100%; background-color: #d9d9dd; background-size: cover; background-repeat: no-repeat; background-position: 50% 50%; }
.mp-cover.is-default { background-image: linear-gradient(135deg, #e7e7ea 0%, #d5d5da 45%, #c6c6cc 100%); }
.mp-coverbtn { position: absolute; right: 20px; bottom: 16px; z-index: 3; height: 32px; padding: 0 14px; border: 0; border-radius: 16px; background: rgba(20,20,22,.55); backdrop-filter: blur(24px) saturate(160%); -webkit-backdrop-filter: blur(24px) saturate(160%); color: #fff; font: 500 12.5px/1 var(--font-sans); display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
.mp-coverbtn:hover { background: rgba(20,20,22,.72); }
.mp-coverbtn .nv-i { width: 13px; height: 13px; }
.mp-covermenu { position: absolute; right: 20px; bottom: 54px; }
.mp-menu { min-width: 190px; padding: 4px; border-radius: 12px; background: var(--solid); box-shadow: var(--shadow-pop); animation: mpPop .14s ease both; z-index: 6; }
.mp-menu button { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 30px; padding: 4px 10px; border: 0; border-radius: 8px; background: transparent; color: var(--ink); font: 400 12.5px/18px var(--font-sans); text-align: left; cursor: pointer; }
.mp-menu button:hover:not(:disabled) { background: var(--fill-1); }
.mp-menu button:disabled { opacity: .42; cursor: not-allowed; }
.mp-menu button.danger { color: var(--danger); }
.mp-menu button.danger .nv-i { color: var(--danger); }
.mp-menu button .nv-i { width: 14px; height: 14px; color: var(--ink-3); flex: none; }
.mp-menu small { margin-left: auto; color: var(--ink-4); font: 400 10.5px/1 var(--font-mono); }
@keyframes mpPop { from { opacity: 0; transform: translateY(4px); } }
.mp-pop-enter-active, .mp-pop-leave-active { transition: opacity .14s ease, transform .14s ease; }
.mp-pop-enter-from, .mp-pop-leave-to { opacity: 0; transform: translateY(4px); }

/* 内容区 1240 */
.mp-in { position: relative; width: min(1240px, calc(100% - 96px)); margin: 0 auto; padding-bottom: 96px; }
/* 头像压在背景下沿：封面是定位元素，会在普通流内容之上绘制，这里把头像行提到同一层。
   这行整宽横跨封面下沿，指针事件只给头像和按钮，别挡住「更换背景」。 */
.mp-head { position: relative; z-index: 2; display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-top: -56px; pointer-events: none; }
.mp-head .mp-av, .mp-head .mp-acts { pointer-events: auto; }
.mp-av { width: 112px; height: 112px; flex: none; border-radius: 50%; overflow: hidden; background: var(--fill-2); display: inline-flex; align-items: center; justify-content: center; font: 500 44px/1 var(--font-sans); color: var(--ink); box-shadow: 0 0 0 4px #fff; }
.mp-av img { width: 100%; height: 100%; object-fit: cover; display: block; }
.mp-acts { display: flex; align-items: center; gap: 8px; padding-bottom: 8px; }
.mp-pill { height: 34px; padding: 0 15px; border: 0; border-radius: 17px; background: var(--fill-1); color: var(--ink); font: 500 12.5px/1 var(--font-sans); display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
.mp-pill:hover { background: var(--fill-2); }
.mp-pill.pri { background: var(--accent); color: var(--on-accent); }
.mp-pill.pri:hover { opacity: .9; }
.mp-pill .nv-i { width: 13px; height: 13px; }
.mp-share { position: relative; }
.mp-sharemenu { position: absolute; right: 0; top: calc(100% + 6px); }

.mp-name { margin: 14px 0 0; font: 600 22px/28px var(--font-sans); letter-spacing: -.015em; display: flex; align-items: center; gap: 8px; }
.mp-viewer { height: 20px; padding: 0 8px; border-radius: 10px; background: var(--fill-1); color: var(--ink-3); font: 400 11px/20px var(--font-sans); }
.mp-sub { margin: 5px 0 0; font: 400 12px/17px var(--font-sans); color: var(--ink-3); }
.mp-sub .mono { color: var(--ink-2); }

.mp-stats { display: flex; align-items: center; gap: 8px; margin-top: 18px; flex-wrap: wrap; }
.mp-stat { display: flex; flex-direction: column; gap: 2px; min-width: 96px; padding: 10px 14px; border-radius: 14px; background: var(--fill-1); border: 0; color: var(--ink); text-align: left; }
.mp-stat span { font: 400 11px/15px var(--font-sans); color: var(--ink-3); }
.mp-stat b { font: 600 18px/22px var(--font-mono); font-variant-numeric: tabular-nums; }
.mp-frwrap { position: relative; }
.mp-frbtn { flex-direction: row; align-items: baseline; gap: 6px; cursor: pointer; }
.mp-frbtn.open { background: var(--fill-2); }
.mp-frbtn .mp-frchev { width: 12px; height: 12px; color: var(--ink-3); align-self: center; }
.mp-friends { position: absolute; left: 0; top: calc(100% + 8px); z-index: 7; width: 340px; padding: 12px; border-radius: 16px; background: color-mix(in srgb, var(--solid) 88%, transparent); backdrop-filter: blur(44px) saturate(190%); -webkit-backdrop-filter: blur(44px) saturate(190%); box-shadow: var(--shadow-pop); }
.mp-fh { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 2px 8px; font: 600 13px/18px var(--font-sans); }
.mp-add { display: flex; gap: 6px; padding-bottom: 8px; }
.mp-inp { flex: 1; min-width: 0; border: 0; }
.mp-fempty { padding: 14px 2px; text-align: center; color: var(--ink-4); font: 400 12px/18px var(--font-sans); }
.mp-frow { display: flex; align-items: center; gap: 8px; padding: 6px 2px; }
.mp-frow .av { position: relative; width: 30px; height: 30px; flex: none; border-radius: 50%; background: var(--fill-2); color: var(--ink-2); display: inline-flex; align-items: center; justify-content: center; font: 500 12px/1 var(--font-sans); }
.mp-frow .av.off { opacity: .6; }
.mp-frow .av img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; display: block; }
.mp-frow .av .dot { position: absolute; right: -1px; bottom: -1px; width: 8px; height: 8px; border-radius: 50%; background: var(--success); box-shadow: 0 0 0 2px var(--solid); }
.mp-frow .fx { flex: 1; min-width: 0; }
.mp-frow b { display: block; font: 500 12.5px/17px var(--font-sans); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mp-frow small { display: block; font: 400 11px/15px var(--font-sans); color: var(--ink-3); }
.mp-unread { margin-left: 4px; padding: 0 4px; border-radius: 7px; background: var(--danger); color: #fff; font: 500 10px/14px var(--font-mono); }
.mp-ff { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 10px 2px 0; padding: 10px 8px 2px; border-radius: 10px; background: var(--fill-1); font: 400 11.5px/16px var(--font-sans); color: var(--ink-3); }
.mp-copy { border: 0; background: var(--fill-1); color: var(--ink); height: 24px; padding: 0 10px; border-radius: 12px; font: 500 11.5px/1 var(--font-sans); cursor: pointer; }
.mp-copy:hover { background: var(--fill-2); }

/* 分隔只靠留白（不加发丝线） */
.mp-sep { height: 0; margin: 22px 0 6px; }

/* 工具行 */
.mp-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mp-tabs { display: flex; gap: 4px; flex-wrap: wrap; }
.mp-tabs button { height: 32px; padding: 0 12px; border: 0; border-radius: 16px; background: transparent; color: var(--ink-3); font: 600 14px/1 var(--font-sans); display: inline-flex; align-items: baseline; gap: 5px; cursor: pointer; }
.mp-tabs button:hover { color: var(--ink); }
.mp-tabs button.on { background: var(--fill-1); color: var(--ink); }
.mp-tabs em { font-style: normal; font: 400 11px/1 var(--font-mono); color: var(--ink-4); }
.mp-tabs button.on em { color: var(--ink-3); }
.sp { flex: 1; }
.mp-ddwrap { position: relative; }
.mp-dd { height: 30px; padding: 0 24px 0 10px; border: 0; border-radius: 15px; background-color: var(--fill-1); color: var(--ink-2); font: 500 12px/1 var(--font-sans); cursor: pointer; appearance: none; -webkit-appearance: none; background-image: var(--select-caret); background-repeat: no-repeat; background-position: calc(100% - 8px) 50%; background-size: 10px; }
.mp-dd:hover { background-color: var(--fill-2); color: var(--ink); }
.mp-search { display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 10px; border-radius: 15px; background: var(--fill-1); color: var(--ink-3); }
.mp-search input { width: 128px; border: 0; outline: 0; background: transparent; color: var(--ink); font: 400 12px/1 var(--font-sans); }
.mp-search input::-webkit-search-cancel-button { display: none; }
.mp-search .nv-i { width: 13px; height: 13px; }
.mp-pub { height: 32px; padding: 0 15px; border: 0; border-radius: 16px; background: var(--accent); color: var(--on-accent); font: 500 12.5px/1 var(--font-sans); display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
.mp-pub:hover { opacity: .9; }
.mp-pub.alone { margin-left: auto; }
.mp-pub .nv-i { width: 13px; height: 13px; }

/* 作品网格：4 列 4:5 */
.mp-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 26px 18px; margin-top: 18px; }
.mp-card { position: relative; min-width: 0; }
.mp-cv { position: relative; display: block; width: 100%; aspect-ratio: 4 / 5; border: 0; padding: 0; border-radius: 14px; overflow: hidden; background: var(--fill-1); cursor: pointer; transition: transform var(--duration-base) var(--ease-out), box-shadow var(--duration-base) var(--ease-out); }
.mp-cv img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform 600ms var(--ease-out); }
.mp-cv .ph { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--ink-4); }
.mp-cv .ph .nv-i { width: 28px; height: 28px; }
.mp-card:hover .mp-cv { transform: translateY(-2px); box-shadow: var(--shadow-lift); }
.mp-card:hover .mp-cv img { transform: scale(1.03); }
.mp-cv.off img, .mp-cv.off .ph { filter: grayscale(1); opacity: .5; }
.mp-cv .kind { position: absolute; left: 10px; top: 10px; z-index: 2; height: 22px; padding: 0 9px; border-radius: 11px; background: rgba(0,0,0,.36); backdrop-filter: blur(12px); color: #fff; font: 400 11px/22px var(--font-sans); display: inline-flex; align-items: center; gap: 4px; }
.mp-cv .kind .nv-i { width: 11px; height: 11px; }
.mp-cv .bd { position: absolute; left: 10px; bottom: 10px; z-index: 2; display: flex; gap: 5px; }
.mp-cv .bd .ok, .mp-cv .bd .offs, .mp-cv .bd .rep { height: 20px; padding: 0 8px; border-radius: 10px; font: 400 10.5px/20px var(--font-sans); display: inline-flex; align-items: center; gap: 3px; background: rgba(0,0,0,.36); backdrop-filter: blur(10px); color: #fff; }
.mp-cv .bd .offs { background: rgba(0,0,0,.5); color: rgba(255,255,255,.82); }
.mp-cv .bd .rep { background: rgba(180,35,24,.86); }
.mp-cv .bd .rep .nv-i { width: 10px; height: 10px; }
.mp-more { position: absolute; right: 8px; top: 8px; z-index: 3; }
.mp-morebtn { width: 26px; height: 26px; border: 0; border-radius: 13px; background: rgba(0,0,0,.32); backdrop-filter: blur(12px); color: #fff; display: flex; align-items: center; justify-content: center; cursor: pointer; opacity: 0; transition: opacity .16s; }
.mp-card:hover .mp-morebtn, .mp-morebtn:focus-visible { opacity: 1; }
.mp-morebtn .nv-i { width: 14px; height: 14px; }
.mp-moremenu { position: absolute; right: 0; top: calc(100% + 6px); }
.mp-title { display: block; width: 100%; margin-top: 9px; padding: 0; border: 0; background: none; text-align: left; color: var(--ink); font: 500 13px/18px var(--font-sans); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
.mp-meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 4px; font: 400 11px/15px var(--font-sans); color: var(--ink-3); }
.mp-meta .mono { font: 400 10.5px/15px var(--font-mono); color: var(--ink-4); }
.mp-meta .st { display: inline-flex; align-items: center; gap: 3px; flex: none; }
.mp-meta .st .nv-i { width: 12px; height: 12px; }
.mp-meta .st i { width: 7px; height: 1px; background: var(--ink-4); display: inline-block; }

.mp-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 64px 0 40px; text-align: center; color: var(--ink-3); font: 400 12.5px/19px var(--font-sans); }
.mp-empty b { font: 500 15px/21px var(--font-sans); color: var(--ink); }
.mp-empty .nv-btn { margin-top: 10px; }
.mp-skel { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 26px 18px; margin-top: 18px; }
.mp-skel .nv-skel { aspect-ratio: 4 / 5; border-radius: 14px; }

/* 弹层 */
.mp-scrim { position: fixed; inset: 0; z-index: 86; background: var(--scrim); backdrop-filter: var(--material-thin); -webkit-backdrop-filter: var(--material-thin); }
.mp-sheet { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 87; width: min(420px, calc(100vw - 32px)); padding: 16px; border-radius: 18px; background: color-mix(in srgb, var(--solid) 90%, transparent); backdrop-filter: blur(44px) saturate(190%); -webkit-backdrop-filter: blur(44px) saturate(190%); box-shadow: var(--shadow-dialog); font-family: var(--font-sans); }
.mp-assets { width: min(640px, calc(100vw - 32px)); }
.mp-sh { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-bottom: 10px; font: 600 14px/20px var(--font-sans); }
.mp-x { width: 26px; height: 26px; border: 0; border-radius: 13px; background: transparent; color: var(--ink-3); display: flex; align-items: center; justify-content: center; cursor: pointer; }
.mp-x:hover { background: var(--fill-1); color: var(--ink); }
.mp-x .nv-i { width: 14px; height: 14px; }
.mp-preview { height: 120px; border-radius: 12px; background-color: var(--fill-2); background-size: cover; background-repeat: no-repeat; margin-bottom: 10px; }
.mp-range { display: flex; align-items: center; gap: 10px; height: 34px; font: 400 12px/18px var(--font-sans); color: var(--ink-3); }
.mp-range span { width: 32px; flex: none; }
.mp-range input { flex: 1; accent-color: var(--ink); }
.mp-range b { width: 44px; text-align: right; font: 500 11.5px/1 var(--font-mono); color: var(--ink); }
.mp-shf { display: flex; justify-content: flex-end; gap: 8px; padding-top: 12px; }
.mp-assetgrid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; max-height: 46vh; overflow-y: auto; }
.mp-assetgrid button { border: 0; padding: 0; border-radius: 10px; overflow: hidden; background: var(--fill-1); aspect-ratio: 16 / 10; cursor: pointer; }
.mp-assetgrid img { width: 100%; height: 100%; object-fit: cover; display: block; }
.mp-assetgrid button:hover { box-shadow: var(--shadow-lift); }

/* 焦点：输入框不出现光圈（设计硬规则）；按钮只在键盘操作时给墨色描边，点完不留蓝框 */
.mp input:focus, .mp select:focus, .mp button:focus { outline: none; box-shadow: none; }
.mp button:focus-visible, .mp select:focus-visible {
    outline: 1.5px solid var(--accent); outline-offset: 2px;
}

@media (max-width: 1100px) {
    .mp-grid, .mp-skel { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 860px) {
    .mp-in { width: calc(100% - 32px); }
    .mp-grid, .mp-skel { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .mp-cover { height: 190px; }
    .mp-av { width: 88px; height: 88px; margin-top: -44px; }
    .mp-head { margin-top: -44px; }
    .mp-search input { width: 96px; }
}
</style>
