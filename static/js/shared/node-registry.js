(function(root, factory){
    const api = factory();
    if(typeof module === 'object' && module.exports) module.exports = api;
    if(root) root.NovaNodeRegistry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){

    const MEDIA = {
        image:['image', 'generator', 'midjourney', 'msgen', 'comfy'],
        video:['video', 'ltxDirector', 'rh', 'minimax'],
        text:['prompt', 'promptGroup', 'llm']
    };

    const DEFAULTS = {
        runnable:false, capabilities:[], inputTypes:[], outputTypes:[],
        supportsImage:false, supportsVideo:false, supportsText:false, label:''
    };

    function spec(key, options={}){
        return {...DEFAULTS, key, aliases:[], ...options};
    }

    // 节点类型单一事实来源。之前这些判断散落在 canvas.js 的 5 份白名单 + 大量 if/else 里。
    const TYPES = [

        spec('image', {label:'图片', inputTypes:['image'], outputTypes:['image'], supportsImage:true}),
        spec('prompt', {label:'提示词', outputTypes:['text'], supportsText:true}),
        spec('promptGroup', {label:'提示词组', outputTypes:['text'], supportsText:true}),
        spec('llm', {label:'LLM', runnable:true, inputTypes:['text', 'image'], outputTypes:['text'], supportsText:true, capabilities:['llm', 'plan']}),
        spec('table', {label:'多维表格', inputTypes:['image', 'text'], outputTypes:['text'], capabilities:['data', 'table-ops']}),
        spec('loop', {label:'循环', runnable:true, inputTypes:['image', 'text'], outputTypes:['image', 'text']}),
        spec('group', {label:'分组', runnable:true, capabilities:['container', 'dag'], inputTypes:['image', 'text'], outputTypes:['image', 'text']}),
        spec('generator', {label:'生图', runnable:true, inputTypes:['text', 'image'], outputTypes:['image'], supportsImage:true, capabilities:['generate']}),
        spec('midjourney', {label:'Midjourney', runnable:true, inputTypes:['text', 'image'], outputTypes:['image'], supportsImage:true, capabilities:['generate']}),
        spec('msgen', {label:'ModelScope', runnable:true, inputTypes:['text', 'image'], outputTypes:['image'], supportsImage:true, capabilities:['generate']}),
        spec('comfy', {label:'ComfyUI', runnable:true, inputTypes:['text', 'image'], outputTypes:['image'], supportsImage:true, capabilities:['generate']}),
        spec('video', {label:'视频', runnable:true, inputTypes:['text', 'image', 'video'], outputTypes:['video'], supportsVideo:true, capabilities:['generate']}),
        spec('ltxDirector', {label:'LTX 导演', runnable:true, inputTypes:['text', 'image', 'video'], outputTypes:['video'], supportsVideo:true, capabilities:['generate']}),
        spec('rh', {label:'RunningHub', runnable:true, inputTypes:['text', 'image'], outputTypes:['image', 'video'], supportsImage:true, supportsVideo:true, capabilities:['generate']}),
        spec('minimax', {label:'MiniMax', runnable:true, inputTypes:['text', 'image'], outputTypes:['video'], supportsVideo:true, capabilities:['generate']}),
        spec('output', {label:'输出', inputTypes:['image', 'video', 'text'], outputTypes:['image', 'video', 'text'], supportsImage:true, supportsVideo:true, supportsText:true})
    ];

    const byKey = new Map();
    const byAlias = new Map();
    TYPES.forEach(item => {
        byKey.set(item.key, item);
        [item.key, ...item.aliases].forEach(alias => byAlias.set(alias, item.key));
    });

    function canonical(type){ return byAlias.get(String(type || '')) || String(type || ''); }
    function specFor(type){ return byKey.get(canonical(type)) || null; }
    function isType(type, key){ return canonical(type) === key; }


    function isTypeOf(node, key){ return Boolean(node) && isType(node.type, key); }
    function specOf(node){ return specFor(node?.type); }
    function isRunnable(node){ return Boolean(specOf(node)?.runnable); }
    function supports(node, media){ return media === 'image' ? Boolean(specOf(node)?.supportsImage) : media === 'video' ? Boolean(specOf(node)?.supportsVideo) : Boolean(specOf(node)?.supportsText); }
    function hasCapability(node, capability){ return (specOf(node)?.capabilities || []).includes(capability); }

    function acceptsInput(node, type){ return (specOf(node)?.inputTypes || []).includes(type); }
    function producesOutput(node, type){ return (specOf(node)?.outputTypes || []).includes(type); }

    // 统一的迁移入口：只迁移注册过的类型，其余原样返回
    function migrateNode(node){
        if(!node || typeof node !== 'object') return node;
        const item = specFor(node.type);
        if(!item || typeof item.migrate !== 'function') return node;
        try {
            return item.migrate(node);
        } catch(error){
            return node;
        }
    }
    function migrateNodes(nodes){
        return Array.isArray(nodes) ? nodes.map(migrateNode) : nodes;
    }

    function allTypes(){ return TYPES.map(item => ({...item})); }
    function typesWithMedia(media){ return (MEDIA[media] || []).slice(); }

    return {
        MEDIA,
        canonical, specFor, isType, isTypeOf, specOf,
        isRunnable, supports, hasCapability, acceptsInput, producesOutput,
        migrateNode, migrateNodes, allTypes, typesWithMedia
    };
});
