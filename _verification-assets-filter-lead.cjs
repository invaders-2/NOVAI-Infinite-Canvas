
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9346;
const ud = '/tmp/novai-verify-filter-' + Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const proxy = spawn('node', ['_verification-assets-canvas/verify-server.js', '3956'], { cwd: process.cwd(), stdio: 'ignore' });
const proc = spawn(CHROME, ['--headless=new','--no-sandbox','--remote-debugging-port='+PORT,'--user-data-dir='+ud,'--no-first-run','--disable-gpu','--hide-scrollbars','--window-size=1680,963','about:blank'], { stdio: 'ignore' });
async function wsUrl(){ for(let i=0;i<60;i++){ try{ const r=await fetch('http://127.0.0.1:'+PORT+'/json/version'); const j=await r.json(); if(j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl; }catch(e){} await sleep(250);} throw new Error('no ws'); }
(async () => {
  const url = await wsUrl();
  const ws = new WebSocket(url); let id = 0; const pend = new Map();
  const send = (method, params, sessionId) => new Promise((res, rej) => { const i = ++id; pend.set(i, {res, rej}); ws.send(JSON.stringify({id:i, method, params: params||{}, sessionId})); });
  await new Promise(r => ws.addEventListener('open', r));
  ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
  const { targetId } = await send('Target.createTarget', { url: 'http://127.0.0.1:3956/' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId); await send('Runtime.enable', {}, sessionId);
  await sleep(4500);
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 600)); return r.result.value; };
  const clickExact = async (sel, text) => {
    const src = "(() => { const els=[...document.querySelectorAll(" + JSON.stringify(sel) + ")]; const el=els.find(e=>((e.querySelector('b')||e).innerText||'').trim()===" + JSON.stringify(text) + "); if(!el) return 'NOTFOUND:'+els.map(e=>((e.querySelector('b')||e).innerText||'').trim()).slice(0,8).join('|'); el.click(); return 'OK'; })()";
    return ev(src);
  };
  console.log('nav 素材库:', await clickExact('button, a', '素材库'));
  await sleep(2500);
  console.log('tab 画布里的:', await clickExact('.am-tr, button', '画布里的'));
  await sleep(800);
  console.log('cat 智能画布:', await clickExact('.am-tr.par', '智能画布'));
  await sleep(800);
  console.log('date 今天:', await clickExact('.am-fbar .nv-seg.static button', '今天'));
  await sleep(1000);
  const before = await ev("({title: document.querySelector('.am-ct .ch b')?.innerText, sub: document.querySelector('.am-ct .ch span')?.innerText, cards: document.querySelectorAll('.am-card').length, dateOn: [...document.querySelectorAll('.am-fbar .nv-seg.static button.is-on')].map(b=>b.innerText), empty: (document.querySelector('.am-empty')||{}).innerText||''})");
  console.log('before-click-canvas:', JSON.stringify(before));
  console.log('canvas 画布 09:02:', await clickExact('.am-tr.sub', '画布 09:02'));
  await sleep(1200);
  const after = await ev("({title: document.querySelector('.am-ct .ch b')?.innerText, sub: document.querySelector('.am-ct .ch span')?.innerText, cards: document.querySelectorAll('.am-card').length, dateOn: [...document.querySelectorAll('.am-fbar .nv-seg.static button.is-on')].map(b=>b.innerText), empty: (document.querySelector('.am-empty')||{}).innerText||''})");
  console.log('after-click-canvas:', JSON.stringify(after));
  const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  fs.mkdirSync('_verification-assets-filter', { recursive: true });
  fs.writeFileSync('_verification-assets-filter/lead-after-clean.png', Buffer.from(shot.data, 'base64'));
  ws.close(); proc.kill(); proxy.kill(); await sleep(300);
  fs.rmSync(ud, { recursive: true, force: true });
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); proc.kill(); proxy.kill(); process.exit(1); });
