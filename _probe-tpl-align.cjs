
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT=9347, ud='/tmp/novai-tpl-'+Date.now();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const proc=spawn(CHROME,['--headless=new','--no-sandbox','--remote-debugging-port='+PORT,'--user-data-dir='+ud,'--no-first-run','--disable-gpu','--hide-scrollbars','--window-size=1680,963','about:blank'],{stdio:'ignore'});
async function wsUrl(){for(let i=0;i<60;i++){try{const r=await fetch('http://127.0.0.1:'+PORT+'/json/version');const j=await r.json();if(j.webSocketDebuggerUrl)return j.webSocketDebuggerUrl;}catch(e){}await sleep(250);}throw new Error('no ws');}
(async()=>{
 const url=await wsUrl(); const ws=new WebSocket(url); let id=0; const pend=new Map();
 const send=(m,p,s)=>new Promise((res,rej)=>{const i=++id;pend.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p||{},sessionId:s}));});
 await new Promise(r=>ws.addEventListener('open',r));
 ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data); if(m.id&&pend.has(m.id)){const p=pend.get(m.id);pend.delete(m.id);m.error?p.rej(new Error(JSON.stringify(m.error))):p.res(m.result);}});
 const {targetId}=await send('Target.createTarget',{url:'http://127.0.0.1:3000/static/canvas.html'});
 const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
 await send('Page.enable',{},sessionId); await send('Runtime.enable',{},sessionId);
 await sleep(7000);
 const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true},sessionId); if(r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0,300)); return r.result.value;};
 console.log('url', await ev('location.href'));
 console.log('button', await ev("(()=>{const b=document.querySelector('[data-drawer=templates]'); if(!b) return 'NOBTN'; const r=b.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height};})()"));
 const clicked = await ev("(()=>{const b=document.querySelector('[data-drawer=templates]'); if(!b) return 'NOBTN'; b.click(); return 'OK';})()");
 console.log('clicked', clicked); await sleep(1500);
 console.log('wrap', await ev("(()=>{const w=document.querySelector('.tpl-wrap'); if(!w) return 'NOWRAP'; const r=w.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height, style:w.getAttribute('style')};})()"));
 console.log('tip', await ev("(()=>{const t=document.querySelector('.tpl-tip'); if(!t) return 'NOTIP'; const r=t.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height};})()"));
 console.log('panel', await ev("(()=>{const p=document.querySelector('.tpl'); if(!p) return 'NOPANEL'; const r=p.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height};})()"));
 console.log('modalbg', await ev("(()=>{const m=document.querySelector('.modal-bg'); if(!m) return 'NOMB'; const cs=getComputedStyle(m); return {pos:cs.position,len:cs.left+' '+cs.top,rect:(()=>{const r=m.getBoundingClientRect();return [r.x,r.y,r.width,r.height];})()};})()"));
 const shot=await send('Page.captureScreenshot',{format:'png'},sessionId);
 fs.mkdirSync('_verification-tpl-align',{recursive:true});
 fs.writeFileSync('_verification-tpl-align/tpl-open.png',Buffer.from(shot.data,'base64'));
 ws.close(); proc.kill(); await sleep(300); fs.rmSync(ud,{recursive:true,force:true}); process.exit(0);
})().catch(e=>{console.error('ERR',e.message);proc.kill();process.exit(1);});
