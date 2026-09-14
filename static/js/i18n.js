(function(){
    const VERSION = '2026.07.18.api-settings-i18n.1';
    const scripts = [
        '/static/js/i18n-core.js',
        '/static/js/i18n/common.js',
        '/static/js/i18n/studio.js',
        '/static/js/i18n/api-settings.js',
        '/static/js/i18n/canvas.js',
        '/static/js/i18n/smart-canvas.js',
        '/static/js/i18n/comfyui-settings.js',
    ];
    // 并行下载、按序执行：async=false 允许浏览器同时下载所有脚本，
    // 但保证执行顺序与插入顺序一致（等价于 document.write 的顺序保证，
    // 但不阻塞 HTML 解析）
    const loaded = [];
    let applyScheduled = false;
    scripts.forEach(src => {
        const script = document.createElement('script');
        script.src = src + '?v=' + VERSION;
        script.async = false;
        script.onload = () => {
            loaded.push(src);
            if(loaded.length === scripts.length && !applyScheduled){
                applyScheduled = true;
                window.StudioI18n?.apply?.();
            }
        };
        script.onerror = () => console.error('Failed to load i18n module:', src);
        document.head.appendChild(script);
    });
})();
