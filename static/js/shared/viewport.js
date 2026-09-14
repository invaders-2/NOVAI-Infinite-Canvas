(function(){
    /* ── 视口数学工具（canvas.js / smart-canvas.js / canvas-list.js 共享）── */
    
    // 安全缩放值校验：钳制在可用区间，防止缩放过小导致整个画布只剩几个像素
    function safeScale(value){
        var n = Number(value);
        if(!Number.isFinite(n) || n <= 0) return 1;
        return Math.max(0.06, Math.min(8, n));
    }
    
    // 检测鼠标滚轮（非触控板）
    function isMouseWheel(e){
        return e.deltaMode === 1 || Math.abs(e.deltaY) >= 100;
    }
    
    // 屏幕坐标转世界坐标（通用版）
    function screenToWorld(clientX, clientY, rect, viewport){
        return {
            x: (clientX - rect.left - viewport.x) / viewport.scale,
            y: (clientY - rect.top - viewport.y) / viewport.scale
        };
    }
    
    // 核心视口 transform 字符串
    function viewportTransform(viewport){
        return 'translate(' + viewport.x + 'px, ' + viewport.y + 'px) scale(' + viewport.scale + ')';
    }
    
    /* ── expose ── */
    window.NovaViewport = {
        safeScale: safeScale,
        isMouseWheel: isMouseWheel,
        screenToWorld: screenToWorld,
        viewportTransform: viewportTransform
    };
})();
