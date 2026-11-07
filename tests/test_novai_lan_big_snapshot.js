'use strict';
/**
 * T54 大快照不截断（后端）：spawn python 跑 tests/test_lan_big_snapshot.py。
 * 覆盖：lan 代取默认不限（15MB 完整）、旧 4MB 边界、env 上限 413、超时 504、钩子优先、
 * 分享快照接口 1000 节点 / ≥15MB 完整返回。
 * 没有能 import fastapi+httpx 的 python 时跳过（与 test_canvas_gen_pipe.js 同款降级）。
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

function pythonProbe() {
    const candidates = [path.join(root, 'venv/bin/python'), 'python3'];
    for (const bin of candidates) {
        const probe = spawnSync(bin, ['-c', 'import fastapi, httpx, fastapi.testclient'], { encoding: 'utf8' });
        if (probe.status === 0) return bin;
    }
    return '';
}

const python = pythonProbe();
if (!python) {
    console.log('[lan-big-snapshot] 跳过：没有能 import fastapi/httpx 的 python（venv/bin/python 或 python3）');
    process.exit(0);
}
const result = spawnSync(python, [path.join(__dirname, 'test_lan_big_snapshot.py')], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
});
console.log(((result.stdout || '') + (result.stderr || '')).trim());
assert.equal(result.status, 0, '大快照后端测试退出码 ' + result.status);
console.log('[lan-big-snapshot] T54 大快照测试通过');
