#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const esbuild = require('../novai-canvas-ui/node_modules/esbuild');
const root = path.join(__dirname, '..');
const KEY = 'canvas-next:elements';

function load(entry) {
    const result = esbuild.buildSync({
        entryPoints: [path.join(root, entry)], bundle: true, platform: 'node',
        format: 'cjs', write: false, logLevel: 'silent', loader: { '.css': 'text' },
    });
    const module = { exports: {} };
    new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
    return module.exports;
}

const storage = new Map();
globalThis.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => { storage.set(k, String(v)); },
};
const events = [];
globalThis.CustomEvent = class CustomEvent {
    constructor(type) { this.type = type; }
};
globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent(ev) { events.push(ev.type); return true; },
};

const els = load('novai-canvas-ui/src/canvas/canvas-next/elements.ts');
const seed = (list) => { localStorage.setItem(KEY, JSON.stringify(list)); els.resetElementCache(); };
const stored = () => JSON.parse(localStorage.getItem(KEY));

const baseEl = { id: 'el_a', name: '小白', kind: 'character', desc: '', refs: [], at: 1 };

(async () => {
    els.setElementCommand(async () => ({ ok: false }));

    seed([baseEl]);
    events.length = 0;
    els.setElementFav('el_a', true);
    let list = els.listElements();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].fav, true);
    assert.strictEqual(list[0].at, 1);
    assert.strictEqual(stored()[0].fav, true);
    assert(events.includes('cn:elements'));

    els.setElementFav('el_a', false);
    list = els.listElements();
    assert.notStrictEqual(list[0].fav, true);
    assert(!stored()[0].fav);

    events.length = 0;
    els.setElementFav('el_missing', true);
    assert.strictEqual(events.length, 0);

    seed([{ ...baseEl, fav: true }]);
    const saved = els.saveElement({ id: 'el_a', name: '小白', kind: 'character', desc: '改过描述', refs: [] });
    assert.strictEqual(saved.fav, true);
    list = els.listElements();
    assert.strictEqual(list[0].fav, true);
    assert.strictEqual(list[0].desc, '改过描述');

    const remote = [
        { id: 'r1', name: '小红', description: '', prompt: 'element-kind:character', referenceUrls: [], updatedAt: 20 },
        { id: 'r2', name: '小蓝', description: '', prompt: 'element-kind:character', referenceUrls: [], updatedAt: 10 },
    ];
    seed([
        { id: 'el_r1', remoteId: 'r1', name: '小红', kind: 'character', desc: '', refs: [], at: 1, fav: true },
        { id: 'el_r2', remoteId: 'r2', name: '小蓝', kind: 'character', desc: '', refs: [], at: 2 },
    ]);
    els.setElementCommand(async (req) => {
        if (req.type === 'canvas/assetLibrary/ensure') return { ok: true, library: { id: 'lib1' } };
        if (req.type === 'canvas/assetLibrary/characterList') return { ok: true, characters: remote };
        return { ok: false };
    });
    assert.strictEqual(await els.syncElements(), true);
    list = els.listElements();
    const r1 = list.find((x) => x.remoteId === 'r1');
    const r2 = list.find((x) => x.remoteId === 'r2');
    assert(r1 && r2 && list.length === 2);
    assert.strictEqual(r1.fav, true);
    assert.notStrictEqual(r2.fav, true);
    assert.strictEqual(stored().find((x) => x.remoteId === 'r1').fav, true);

    const library = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/CharacterLibrary.tsx'), 'utf8');
    const css = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/character.css'), 'utf8');
    assert(library.includes('data-ch-fav') && library.includes('data-ch-del') && library.includes('data-ch-del-confirm'));
    assert(library.includes('data-ch-del-dialog') && library.includes('data-ch-del-cancel'));
    assert(library.includes('className="chdt-confirm"') && css.includes('.chdt-confirm'));
    assert(!library.includes('chdel-pop') && !css.includes('chdel-pop'));
    assert(library.includes('setElementFav'));
    assert(library.includes('data-ch-era={row.key}') && library.includes('"fav"'));
    assert(css.includes('.chfav'));
    assert(/\.chfav\{[^}]*opacity:0/.test(css) && /\.chcard:hover \.chfav/.test(css) && /\.chfav\.on/.test(css));
    assert(css.includes('.chdt-ib.danger'));

    console.log('[PASS] 角色库收藏字段、收藏保留与同步、卡片星标与详情删除');
})().catch((err) => { console.error(err); process.exit(1); });
