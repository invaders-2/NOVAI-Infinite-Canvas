#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const smart = fs.readFileSync(path.join(root, 'static/js/smart-canvas.js'), 'utf8');
const classic = fs.readFileSync(path.join(root, 'static/js/canvas.js'), 'utf8');
let passed = 0;
const failures = [];
function ok(condition, message) {
    if (condition) passed++;
    else failures.push(message);
}

for (const [name, source] of [['smart', smart], ['classic', classic]]) {
    ok(source.includes('midjourney_version'), name + ' submits Midjourney version');
    ok(source.includes('midjourney_hd'), name + ' submits Midjourney HD');
    ok(source.includes("['8.2','8.1','7','6.1','5.2','5.1']"), name + ' exposes documented versions');
    ok(source.includes("['8.2','8.1'].includes"), name + ' gates HD to v8.1/v8.2');
}
ok(smart.includes('function renderMidjourneyOptions()'), 'smart canvas renders Midjourney options');
ok(smart.includes('data-toggle-param="mjHd"'), 'smart canvas has HD toggle');
ok(classic.includes('function renderGeneratorBody') && classic.includes('syncMidjourneyControls'), 'classic canvas synchronizes Midjourney controls');
ok(classic.includes('mj-generic-options'), 'classic canvas has dedicated Midjourney option row');

if (failures.length) {
    console.error(failures.join('\n'));
    process.exit(1);
}
console.log(`[midjourney-hd-options] ${passed} 项通过`);
