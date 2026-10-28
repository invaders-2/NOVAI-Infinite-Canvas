#!/usr/bin/env node
/*
 * desktop/main.js 保存文件的纯函数单测（不启动 Electron、不弹系统对话框）。
 *
 *   node desktop/__tests__/test_save_file.js
 *
 * 覆盖：按真实媒体类型生成 filters（视频/音频/图片优先，其它只给全部文件）、
 *       保存面板追加后缀后的路径纠正、mp3/png 这类正常文件名不被误伤。
 */
'use strict';

const assert = require('assert');

// 让 main.js 只导出纯函数，不走 Electron 生命周期（见 main.js 里的同名开关）。
process.env.NOVAI_MAIN_LIB_ONLY = '1';
const { saveDialogFilters, correctSavedFilePath } = require('../main.js');

const ALL_FILES = { name: '全部文件', extensions: ['*'] };

let passed = 0;
function check(name, fn) {
    fn();
    passed += 1;
    console.log('  ok - ' + name);
}

console.log('[save-file] saveDialogFilters');

check('视频文件名：第一项是「视频」，mp4 排首位', () => {
    const filters = saveDialogFilters('video_52480844dd.mp4', 'data:video/mp4;base64,AAA');
    assert.strictEqual(filters[0].name, '视频');
    assert.deepStrictEqual(filters[0].extensions, ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi']);
});

check('只有 mime 是 video/* 也走视频', () => {
    const filters = saveDialogFilters('', 'data:video/webm;base64,AAA');
    assert.strictEqual(filters[0].name, '视频');
});

check('文件名视频扩展名优先于其它 mime（保存面板按文件名判断补不补后缀）', () => {
    const filters = saveDialogFilters('clip.mkv', 'data:video/mp4;base64,AAA');
    assert.strictEqual(filters[0].name, '视频');
});

check('音频：第一项是「音频」', () => {
    const filters = saveDialogFilters('a.mp3', 'data:audio/mpeg;base64,AAA');
    assert.strictEqual(filters[0].name, '音频');
    assert.deepStrictEqual(filters[0].extensions, ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac']);
    assert.strictEqual(saveDialogFilters('x', 'data:audio/wav;base64,AAA')[0].name, '音频');
});

check('图片：第一项是「图片」，png 排首位', () => {
    const filters = saveDialogFilters('b.png', 'data:image/png;base64,AAA');
    assert.strictEqual(filters[0].name, '图片');
    assert.deepStrictEqual(filters[0].extensions, ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']);
});

check('其它类型只给「全部文件」', () => {
    assert.deepStrictEqual(saveDialogFilters('doc.pdf', 'data:application/pdf;base64,AAA'), [ALL_FILES]);
    assert.deepStrictEqual(saveDialogFilters('', ''), [ALL_FILES]);
});

check('每种情况最后一项都是「全部文件」', () => {
    ['x.mp4', 'x.mp3', 'x.png', 'x.pdf'].forEach((name) => {
        const filters = saveDialogFilters(name, '');
        assert.deepStrictEqual(filters[filters.length - 1], ALL_FILES);
    });
});

console.log('[save-file] correctSavedFilePath');

check('面板追加的后缀被剥掉：video_52480844dd.mp4.png → .mp4', () => {
    assert.strictEqual(
        correctSavedFilePath('/Users/x/Downloads/video_52480844dd.mp4.png', 'video_52480844dd.mp4'),
        '/Users/x/Downloads/video_52480844dd.mp4'
    );
    assert.strictEqual(correctSavedFilePath('video_52480844dd.mp4.png', 'video_52480844dd.mp4'), 'video_52480844dd.mp4');
});

check('a.mp3 / b.png 不误伤', () => {
    assert.strictEqual(correctSavedFilePath('/tmp/a.mp3', 'a.mp3'), '/tmp/a.mp3');
    assert.strictEqual(correctSavedFilePath('/tmp/b.png', 'b.png'), '/tmp/b.png');
});

check('大小写不同但扩展名一致时不改路径', () => {
    assert.strictEqual(correctSavedFilePath('/tmp/a.MP4', 'a.mp4'), '/tmp/a.MP4');
});

check('用户把扩展名改成别的类型，按原始扩展名纠正', () => {
    assert.strictEqual(correctSavedFilePath('/tmp/holiday.jpg', 'x.mp4'), '/tmp/holiday.mp4');
});

check('保存面板完全没带扩展名时补回原始扩展名', () => {
    assert.strictEqual(correctSavedFilePath('/tmp/clip', 'x.mp4'), '/tmp/clip.mp4');
});

check('多层后缀只保留到原始扩展名：a.mp4.jpg.png → a.mp4', () => {
    assert.strictEqual(correctSavedFilePath('/tmp/a.mp4.jpg.png', 'x.mp4'), '/tmp/a.mp4');
});

check('原始文件名没有扩展名时原样返回', () => {
    assert.strictEqual(correctSavedFilePath('/tmp/download.png', 'download'), '/tmp/download.png');
    assert.strictEqual(correctSavedFilePath('', 'x.mp4'), '');
});

check('目录里的点号不会被当成扩展名', () => {
    assert.strictEqual(correctSavedFilePath('/Users/me/my.folder/clip.mp4', 'x.mp4'), '/Users/me/my.folder/clip.mp4');
    assert.strictEqual(correctSavedFilePath('/Users/me/my.folder/clip', 'x.mp4'), '/Users/me/my.folder/clip.mp4');
});

console.log('');
console.log('[save-file] ' + passed + ' 项断言全部通过');
