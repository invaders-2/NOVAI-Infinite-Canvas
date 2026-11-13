// 老用户首次启动的一次性提示：旧数据还在用户目录，要不要迁到安装目录。
// 「要不要问」和「已经回答过」都由后端判定（稳定配置 config.json），前端只负责问一次、
// 把回答写回后端；关闭弹窗等同于点「保持原位」（不再提示）。
import { reactive } from 'vue';

export const storageOffer = reactive({
    open: false,
    detail: null,      // 后端 install_migration_offer：当前路径 / 目标路径 / 占用
    phase: 'ask',      // ask | migrating | done | error
    busy: '',          // '' | 'keep' | 'migrate'
    error: '',         // 给用户看的一句人话
    message: '',       // 迁移完成后的结果说明（含重启提示）
});

let requested = false;

function humanBytes(size) {
    let value = Number(size) || 0;
    if (value < 1024) return value + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    for (let i = 0; i < units.length; i += 1) {
        value /= 1024;
        if (value < 1024 || i === units.length - 1) return value.toFixed(1) + ' ' + units[i];
    }
    return '0 B';
}

export async function checkStorageOffer() {
    if (requested) return;
    requested = true;
    try {
        const r = await fetch('/api/config/storage', { headers: { Accept: 'application/json' } });
        if (!r.ok) return;
        const info = await r.json();
        const detail = info && info.install_migration_offer;
        if (detail && detail.offer) {
            storageOffer.detail = detail;
            storageOffer.phase = 'ask';
            storageOffer.open = true;
        }
    } catch (e) {
        // 后端没起来 / 离线：不打扰用户，下次启动再问
    }
}

export async function answerStorageOffer(choice) {
    if (storageOffer.busy) return;
    storageOffer.busy = choice;
    storageOffer.error = '';
    if (choice === 'migrate') storageOffer.phase = 'migrating';
    try {
        const r = await fetch('/api/config/storage/install-offer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ choice }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || data.ok === false) {
            // 后端的失败说明已经是人话（迁移失败会说明旧数据完好）
            throw new Error(data.detail || '操作失败，请稍后重试');
        }
        if (choice === 'migrate') {
            // 后端 message 是设置页那份偏技术的文案（WAL/quick_check 等），这里只留用户要的：
            // 搬了多少、旧数据在哪、要不要重启
            const moved = (data.migrated && data.migrated.files) || 0;
            const bytes = (data.migrated && data.migrated.bytes) || 0;
            storageOffer.message = '已复制 ' + moved + ' 个文件（' + humanBytes(bytes) + '）到安装目录。'
                + '旧数据仍保留在 ' + (data.old_root || '原位置') + '，确认没问题后可以自己删。重启 NOVAI 后生效。';
            storageOffer.phase = 'done';
        } else {
            storageOffer.message = data.message || '';
            storageOffer.phase = 'ask';
            storageOffer.open = false;
        }
    } catch (e) {
        storageOffer.phase = 'error';
        storageOffer.error = (e && e.message) || '操作失败，请稍后重试';
    } finally {
        storageOffer.busy = '';
    }
}

export function closeStorageOffer() {
    if (storageOffer.phase === 'migrating') return;
    if (storageOffer.phase === 'done') { storageOffer.open = false; return; }
    storageOffer.open = false;
    // 关闭 = 保持原位：同样记一次回答，避免下次启动再弹
    answerStorageOffer('keep');
}
