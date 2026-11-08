#!/usr/bin/env node
'use strict';
/*
 * 画布助手语音输入：voiceInput.ts 的纯函数 + 上传契约，以及 AgentPanel / GenPanel / CSS 的源码字面量。
 * 真实录音（getUserMedia）和后端转写依赖设备与运行环境，这里只测能离线验证的部分。
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const esbuild = require('../novai-canvas-ui/node_modules/esbuild');
const root = path.join(__dirname, '..');

function load(entry) {
    const result = esbuild.buildSync({
        entryPoints: [path.join(root, entry)], bundle: true, platform: 'node',
        format: 'cjs', write: false, logLevel: 'silent',
    });
    const module = { exports: {} };
    new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
    return module.exports;
}

const voice = load('novai-canvas-ui/src/canvas/canvas-next/voiceInput.ts');
const { downsample, encodeWav, transcribeVoice, voiceErrorText, startVoiceCapture } = voice;

const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const panelSrc = read('novai-canvas-ui/src/canvas/tapnow/AgentPanel.tsx');
const genSrc = read('novai-canvas-ui/src/canvas/canvas-next/ui/GenPanel.tsx');
const panelCss = read('novai-canvas-ui/src/canvas/tapnow/agent-panel-v2.css');
const canvasCss = read('novai-canvas-ui/src/canvas/canvas-next/ui/canvas-next.css');
const shortcutsSrc = read('novai-canvas-ui/src/canvas/canvas-next/ui/shortcuts.tsx');

async function main() {
    // 1) downsample：48k → 16k 长度 / 取值
    const constant = new Float32Array(4800).fill(0.5);
    const down = downsample(constant, 48000, 16000);
    assert.strictEqual(down.length, 1600, '48k→16k 长度应是 1/3');
    assert.strictEqual(down[0], 0.5, '常量信号降采样后首值不变');

    const ramp = new Float32Array(4800);
    for (let i = 0; i < ramp.length; i += 1) ramp[i] = i / 48000;
    const rampDown = downsample(ramp, 48000, 16000);
    assert.strictEqual(rampDown.length, 1600);
    assert.ok(Math.abs(rampDown[0] - (1 / 48000)) < 1e-7, '首值为前 3 个采样的平均');
    assert.ok(Math.abs(rampDown[1599] - ((1599 * 3 + 1) / 48000)) < 1e-7, '末值取对应区间平均');

    const unchanged = downsample(new Float32Array([0.1, 0.2, 0.3, 0.4]), 16000, 48000);
    assert.strictEqual(unchanged.length, 4, '目标采样率不低于源时原样返回');
    assert.strictEqual(downsample(new Float32Array(0), 48000, 16000).length, 0, '空输入不崩');

    // 2) encodeWav：RIFF / WAVE / fmt / data
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const blob = encodeWav(samples, 16000);
    assert.strictEqual(blob.type, 'audio/wav', 'Blob MIME 是 audio/wav');
    assert.strictEqual(blob.size, 44 + samples.length * 2, 'WAV 总长 = 44 头 + 2 字节/采样');
    const buffer = await blob.arrayBuffer();
    const view = new DataView(buffer);
    const tag = (offset) => String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
    assert.strictEqual(tag(0), 'RIFF');
    assert.strictEqual(view.getUint32(4, true), blob.size - 8, 'RIFF 块长度 = 总长 - 8');
    assert.strictEqual(tag(8), 'WAVE');
    assert.strictEqual(tag(12), 'fmt ');
    assert.strictEqual(view.getUint32(16, true), 16, 'fmt 块长度 16');
    assert.strictEqual(view.getUint16(20, true), 1, 'PCM 编码');
    assert.strictEqual(view.getUint16(22, true), 1, '单声道');
    assert.strictEqual(view.getUint32(24, true), 16000, '采样率 16k');
    assert.strictEqual(view.getUint32(28, true), 32000, '字节率 = 16k × 2');
    assert.strictEqual(view.getUint16(32, true), 2, 'blockAlign 2');
    assert.strictEqual(view.getUint16(34, true), 16, '16bit');
    assert.strictEqual(tag(36), 'data');
    assert.strictEqual(view.getUint32(40, true), samples.length * 2, 'data 块长度 = 采样数 × 2');
    assert.strictEqual(view.getInt16(44, true), 0);
    assert.ok(Math.abs(view.getInt16(46, true) - 16383) <= 1, '0.5 → 约 16384');
    assert.strictEqual(view.getInt16(48, true), -16384, '-0.5 → -16384');
    assert.strictEqual(view.getInt16(50, true), 32767, '超过 1 的采样被削顶');
    assert.strictEqual(view.getInt16(52, true), -32768, '低于 -1 的采样被削底');

    // 3) voiceErrorText：每个错误码都要有中文，配置错误要指到设置路径
    const codes = ['ASR_NOT_CONFIGURED', 'ASR_AUDIO_INVALID', 'ASR_PROVIDER_ERROR', 'ASR_EMPTY', 'ASR_UNSUPPORTED'];
    for (const code of codes) {
        const text = voiceErrorText(code);
        assert.ok(text && /[\u4e00-\u9fa5]/.test(text), code + ' 必须有中文提示');
    }
    assert.ok(voiceErrorText('ASR_NOT_CONFIGURED').includes('设置 → 通用 → 语音转写'), '未配置要指向 设置 → 通用 → 语音转写');
    assert.ok(voiceErrorText('NotAllowedError').includes('麦克风权限'), '权限拒绝要单独提示');
    assert.ok(voiceErrorText('NotAllowedError').includes('隐私与安全性'), '权限提示要给系统设置路径');
    assert.ok(voiceErrorText('NotFoundError').includes('没找到麦克风'), '没设备要单独提示');
    assert.ok(voiceErrorText('NotSupportedError').includes('不支持'), '不支持录音要单独提示');
    assert.ok(voiceErrorText('ASR_PROVIDER_ERROR', '超时').includes('超时'), '服务错误要带上后端原文');

    // 4) transcribeVoice：multipart 契约 + 失败归一
    assert.strictEqual(typeof startVoiceCapture, 'function', 'startVoiceCapture 必须导出');
    let captured = null;
    global.fetch = async (url, init) => {
        captured = { url, init };
        return { ok: true, status: 200, json: async () => ({ ok: true, text: ' 画一只猫 ', provider: 'test', model: 'm', source: 'builtin' }) };
    };
    const ok = await transcribeVoice(new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' }));
    assert.deepStrictEqual(ok, { ok: true, text: '画一只猫' }, '成功时返回 trim 过的文本');
    assert.strictEqual(captured.url, '/api/asr/transcribe');
    assert.strictEqual(captured.init.method, 'POST');
    const form = captured.init.body;
    assert.ok(form instanceof FormData, '请求体是 FormData');
    assert.strictEqual(form.get('lang'), 'zh', 'lang 固定 zh');
    const audio = form.get('audio');
    assert.ok(audio instanceof File, 'audio 字段是 File');
    assert.ok(/^voice-\d+\.wav$/.test(audio.name), '文件名 voice-<ts>.wav');
    assert.strictEqual(audio.type, 'audio/wav', 'File MIME 是 audio/wav');

    global.fetch = async () => { throw new Error('offline'); };
    assert.deepStrictEqual(
        await transcribeVoice(new Blob([new Uint8Array([1])], { type: 'audio/wav' })),
        { ok: false, code: 'ASR_PROVIDER_ERROR', error: 'offline' },
        '网络错误归一成 ASR_PROVIDER_ERROR',
    );

    global.fetch = async () => ({ ok: false, status: 500, json: async () => ({ ok: false, code: 'ASR_NOT_CONFIGURED', error: '没有音频模型' }) });
    const failed = await transcribeVoice(new Blob([new Uint8Array([1])], { type: 'audio/wav' }));
    assert.strictEqual(failed.code, 'ASR_NOT_CONFIGURED', '后端错误码原样带回');
    assert.strictEqual(failed.error, '没有音频模型');

    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, text: '' }) });
    const empty = await transcribeVoice(new Blob([new Uint8Array([1])], { type: 'audio/wav' }));
    assert.strictEqual(empty.code, 'ASR_EMPTY', '空文本归一成 ASR_EMPTY');

    global.fetch = async () => ({ ok: false, status: 502, json: async () => { throw new Error('html'); } });
    const broken = await transcribeVoice(new Blob([new Uint8Array([1])], { type: 'audio/wav' }));
    assert.strictEqual(broken.code, 'ASR_PROVIDER_ERROR', '非 JSON 的非 2xx 也归一');

    /* ── 源码字面量：两个入口都改走新模块，不再碰 Web Speech API ───────── */
    for (const [name, src] of [['AgentPanel.tsx', panelSrc], ['GenPanel.tsx', genSrc]]) {
        assert.ok(!src.includes('SpeechRecognition'), name + ' 不能再用 SpeechRecognition');
        assert.ok(src.includes('startVoiceCapture'), name + ' 必须用 startVoiceCapture');
        assert.ok(src.includes('transcribeVoice'), name + ' 必须用 transcribeVoice');
        assert.ok(src.includes('voiceErrorText'), name + ' 必须走中文错误映射');
        assert.ok(src.includes('data-voice-phase'), name + ' 按钮要带 data-voice-phase');
        assert.ok(src.includes('maxSeconds: 90'), name + ' 录音上限 90 秒');
    }

    // AgentPanel：删掉旧 micInput 与横条，改成底栏 #aMic 原位变身（方案 3）
    assert.ok(!panelSrc.includes('micInput'), 'AgentPanel 旧的 micInput 必须删掉');
    assert.ok(!panelSrc.includes('className="ap2-voice"'), '横条状态条必须删掉');
    assert.ok(!panelSrc.includes('ap2-voice-time') && !panelSrc.includes('ap2-voice-hint'), '横条计时/提示不再渲染');
    assert.ok(panelSrc.includes('data-voice={voicePhase}'), '.ap2-foot 要带 data-voice');
    assert.ok(panelSrc.includes('(voicePhase === "idle" ? "" : " voice-live")'), '#aMic 录音/转写追加 voice-live');
    assert.ok(panelSrc.includes('" rec"'), '录音时追加 rec 类');
    assert.ok(panelSrc.includes('className="ap2-vdot"'), '录音态 9px 红点');
    assert.ok(!panelSrc.includes('ap2-vbars'), '录音态不再用波形');
    assert.ok(panelSrc.includes('className="ap2-vstop"'), '录音态圆形停止块（纯 span）');
    assert.ok(panelSrc.includes('typeIntoDraft'), '成功后走逐字上屏');
    assert.ok(panelSrc.includes('text.slice(0, i)'), '逐字上屏按 slice(0, i) 取前缀');
    assert.ok(panelSrc.includes('Math.ceil(text.length / 40)'), '步长 = ceil(长度 / 40)');
    assert.ok(panelSrc.includes('}, 28)'), '每 28ms 推进一步（约 1.1s 封顶）');
    assert.ok(panelSrc.includes('a.draft = prefix + text.slice(0, i)'), '动画直接写 a.draft 并 emit');
    assert.ok(panelSrc.includes('stopVoiceTyping'), '取消 / 卸载 / 重录会停掉逐字动画');
    assert.ok(panelSrc.includes('const setDraft = (t: string) => { stopVoiceTyping();'), 'setDraft 会停掉逐字动画');
    assert.ok(panelSrc.includes('const onDraftInput = (v: string) => { stopVoiceTyping();'), '用户打字会停掉逐字动画');
    const sendBody = panelSrc.slice(panelSrc.indexOf('async function send('), panelSrc.indexOf('const refs = outgoing'));
    assert.ok(sendBody.includes('stopVoiceTyping()'), 'send 开头会停掉逐字动画');
    const enqueueBody = panelSrc.slice(panelSrc.indexOf('const enqueueDraft = () => {'), panelSrc.indexOf('const raw = a.draft;', panelSrc.indexOf('const enqueueDraft = () => {')));
    assert.ok(enqueueBody.includes('stopVoiceTyping()'), 'enqueueDraft 开头会停掉逐字动画');
    assert.ok(panelSrc.includes('正在聆听…'), '录音态 placeholder「正在聆听…」');
    assert.ok(panelSrc.includes('className="ap2-vspin"'), '转写态 13px spinner');
    assert.ok(panelSrc.includes('className="ap2-voice-x"'), '取消按钮用 ap2-voice-x');
    assert.ok(panelSrc.includes('aria-label="取消语音输入"'), '取消按钮 aria-label');
    assert.ok(panelSrc.includes('aria-pressed={voicePhase === "recording"}'), '只有录音时 aria-pressed');
    assert.ok(panelSrc.includes('data-voice-phase={voicePhase}'), '按钮始终带 data-voice-phase');
    assert.ok(panelSrc.includes('disabled={voicePhase === "transcribing"}'), '转写中禁用按钮');
    assert.ok(panelSrc.includes('正在转写…'), '转写中文案');
    assert.ok(panelSrc.includes('正在转写"'), '转写 aria-label');
    assert.ok(panelSrc.includes('结束语音输入'), '录音 aria-label');
    assert.ok(panelSrc.includes('voiceClock(voiceSecs)'), '录音显示 mm:ss');
    assert.ok(panelSrc.includes('const prefix = base ? base + " " : ""'), '逐字上屏前保留现有草稿并加一个空格');

    const composerAt = panelSrc.indexOf('className="ai ap2-composer"');
    const inputAt = panelSrc.indexOf('id="aiInput"');
    const footAt = panelSrc.indexOf('className="foot ap2-foot"');
    const micAt = panelSrc.indexOf('id="aMic"');
    assert.ok(composerAt >= 0 && composerAt < inputAt && inputAt < footAt && footAt < micAt, '#aMic 仍在 composer 底栏内、输入框之后');

    // 快捷键 V 仍是点 #aMic，不改 shortcut 逻辑
    assert.ok(shortcutsSrc.includes('getElementById("aMic")'), 'V 快捷键仍点 #aMic');

    // GenPanel：沿用 cur ? cur + '，' : '' 的拼接并 commitPrompt
    assert.ok(genSrc.includes('(cur ? cur + "，" : "") + text'), 'GenPanel 沿用逗号拼接');
    assert.ok(genSrc.includes('commitPrompt(next)'), 'GenPanel 回填后 commitPrompt');
    assert.ok(genSrc.includes('voicePhase === "recording" ? " rec"'), 'GenPanel 录音态加 rec 类');

    /* ── 样式：胶囊变身 / 让位 / 无描边 / 动画尊重 reduce motion ───────── */
    const cssStart = panelCss.indexOf('/* ── 语音输入（方案 7）');
    const cssEnd = panelCss.indexOf('.cn-root #agent.ap2-agent .ap2-pill {', cssStart);
    assert.ok(cssStart >= 0 && cssEnd > cssStart, 'agent-panel-v2.css 缺少语音胶囊样式段');
    const voiceCss = panelCss.slice(cssStart, cssEnd);
    assert.ok(voiceCss.includes('.ap2-btn.voice-live'), '胶囊基础规则 .ap2-btn.voice-live');
    assert.ok(/\.ap2-btn\.voice-live\.rec\s*\{[^}]*color-mix\(in srgb, var\(--bad\) 14%, transparent\)/.test(voiceCss), '录音胶囊红色软底 14%');
    assert.ok(/\.ap2-vdot\s*\{[^}]*width:\s*9px[^}]*background:\s*var\(--bad\)/.test(voiceCss), '红点 9px 用 --bad');
    assert.ok(/\.ap2-vdot\s*\{[^}]*animation:\s*ap2-vpulse 1\.2s/.test(voiceCss), '红点 1.2s 脉冲');
    assert.ok(!voiceCss.includes('.ap2-vbars') && !voiceCss.includes('ap2-vwave'), '波形样式已删除');
    assert.ok(/\.ap2-vstop\s*\{[^}]*width:\s*20px/.test(voiceCss), '停止块 20px');
    assert.ok(/\.ap2-vstop i\s*\{[^}]*width:\s*7px/.test(voiceCss), '停止块内白方块 7px');
    assert.ok(/\.ap2-voice-x\s*\{[^}]*width:\s*24px/.test(voiceCss), '取消按钮 24px');
    assert.ok(voiceCss.includes('[data-voice="recording"]') && voiceCss.includes('[data-voice="transcribing"]'), '让位选择器覆盖录音/转写');
    assert.ok(/\[data-voice="recording"\] #aModel[\s\S]*?opacity:\s*0/.test(voiceCss), '让位规则收起右侧参数');
    assert.ok(/\.ap2-btn\.voice-live\s*\{[^}]*max-width:\s*220px/.test(voiceCss), '胶囊宽度上限 220px');
    assert.ok(!/border:\s*1px/.test(voiceCss), '胶囊样式不允许 1px 描边');
    assert.ok(!/inset 0 0 0 1px/.test(voiceCss), '胶囊样式不允许 inset 发丝线');
    assert.ok(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.ap2-vdot/.test(panelCss), 'reduce motion 下停红点脉冲');
    assert.ok(canvasCss.includes('.cn-root .gp-act .mic.rec'), 'GenPanel 沿用 canvas-next.css 的 .mic.rec');
}

main().then(() => {
    console.log('test_novai_canvas_voice_input: 全部断言通过（downsample / encodeWav / voiceErrorText / 转写契约 / 两个入口 / 样式）');
}).catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
});
