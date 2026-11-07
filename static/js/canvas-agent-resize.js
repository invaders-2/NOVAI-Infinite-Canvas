/* 画布助手左缘拖拽调宽：body 级把手，不进入 React 树；宽度写 --agent-w 并持久化 */
(function(){
  'use strict';
  var KEY='novai.agent.width', DEFAULT=380, MIN=380;
  var agent=null, handle=null, width=DEFAULT, drag=null, raf=0, ro=null;
  function maxW(){ return Math.max(MIN, Math.min(720, innerWidth-160)); }
  function clamp(v){ return Math.max(MIN, Math.min(maxW(), Math.round(Number(v)||DEFAULT))); }
  function root(){ return document.querySelector('.cn-root'); }
  function apply(w){ width=clamp(w); var r=root(); if(r) r.style.setProperty('--agent-w', width+'px'); }
  function saved(){ try{ return clamp(parseInt(localStorage.getItem(KEY)||'',10)||DEFAULT); }catch(e){ return DEFAULT; } }
  function visible(){
    if(!agent) return false;
    if(agent.classList.contains('full')||agent.classList.contains('closed')) return false;
    if(root() && root().dataset.w==='narrow') return false;
    var r=agent.getBoundingClientRect();
    /* 展开动画中途面板还在窗口外：等完全进来再显示把手，避免贴在右缘闪一下 */
    return r.width>0 && r.height>0 && r.left>0 && r.right<=innerWidth+1;
  }
  function place(){
    if(!agent||!handle) return;
    var r=agent.getBoundingClientRect();
    handle.style.left=(r.left-5)+'px';
    handle.style.top=r.top+'px';
    handle.style.height=r.height+'px';
    handle.classList.toggle('is-on', visible());
  }
  function schedulePlace(){ if(raf) return; raf=requestAnimationFrame(function(){ raf=0; place(); }); }
  /* 展开/收起是 margin 过渡，宽高不变，ResizeObserver 不会触发：跟着动画追几帧 */
  function chase(){
    var left=40;
    (function step(){
      place();
      if(left-->0) requestAnimationFrame(step);
    })();
  }
  function bind(){
    handle.addEventListener('pointerdown', function(e){
      if(!visible() || e.button!==0) return;
      e.preventDefault(); e.stopPropagation();
      drag={ x:e.clientX, w:agent.getBoundingClientRect().width };
      try{ handle.setPointerCapture(e.pointerId); }catch(_){}
      handle.classList.add('is-dragging'); document.body.classList.add('agent-resizing');
    });
    handle.addEventListener('pointermove', function(e){
      if(!drag) return;
      e.preventDefault();
      apply(drag.w + (drag.x - e.clientX));
      schedulePlace();
    });
    function stop(){
      if(!drag) return;
      drag=null; handle.classList.remove('is-dragging'); document.body.classList.remove('agent-resizing');
      try{ localStorage.setItem(KEY, String(width)); }catch(_){}
      dispatchEvent(new Event('resize'));
    }
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
    handle.addEventListener('dblclick', function(e){
      e.preventDefault(); e.stopPropagation();
      width=DEFAULT; var r=root(); if(r) r.style.removeProperty('--agent-w');
      try{ localStorage.removeItem(KEY); }catch(_){}
      schedulePlace(); dispatchEvent(new Event('resize'));
    });
  }
  function ensureHandle(){
    if(!handle){ handle=document.createElement('div'); handle.className='agent-resize-handle'; handle.title='拖动调整助手宽度，双击复位'; document.body.appendChild(handle); bind(); }
  }
  /* 面板开合只改 class、窗口变窄只改 .cn-root[data-w]，都不会改尺寸：这些都要盯 */
  function observe(){
    if(ro){ try{ ro.disconnect(); }catch(_){} ro=null; }
    if(!agent) return;
    if(typeof ResizeObserver==='function'){
      ro=new ResizeObserver(schedulePlace);
      ro.observe(agent);
    }
    agent.addEventListener('transitionend', schedulePlace);
    new MutationObserver(function(){
      var next=document.getElementById('agent');
      if(next!==agent){ agent=next; observe(); }
      chase();
    }).observe(agent, { attributes:true, attributeFilter:['class','style'] });
    var r=root();
    if(r){
      new MutationObserver(function(){ chase(); }).observe(r, { attributes:true, attributeFilter:['data-w','class','style'] });
      new MutationObserver(function(){
        var next=document.getElementById('agent');
        if(next!==agent){ agent=next; observe(); chase(); return; }
        schedulePlace();
      }).observe(r, { childList:true, subtree:true });
    }
  }
  function tick(){
    agent=document.getElementById('agent');
    if(!agent){ setTimeout(tick,300); return; }
    ensureHandle();
    var w=saved(); apply(w); width=w;
    place();
    observe();
    addEventListener('resize', function(){ apply(width); chase(); });
    addEventListener('scroll', schedulePlace, true);
    document.addEventListener('pointerdown', function(e){
      if(e.target && e.target.closest && e.target.closest('#orb')) setTimeout(chase, 0);
    }, true);
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', tick); else tick();
})();
