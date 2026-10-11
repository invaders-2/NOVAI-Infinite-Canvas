// 首页模板 / 技能 / 模式定义：从旧 home.html 原样迁来（节点结构与智能画布的 seed 协议一致，改动要同步 smart-canvas.js 的 seed 读取）
/* 每个模板就是一张小画布：nodes 里的节点会在新建的智能画布上照原样铺好。
     image  素材节点（ref:true 表示首页上传的参考图放这里；为空时等你把图拖进去）
     text   纯文本说明（brief:true 表示首页输入框里的文字放这里）；连到生成节点时会并进提示词
     gen    空的生成节点，带提示词草稿与比例；选中后点「运行」即可出图/出视频
     label  标题胶囊；table / batch 多维表格 + 生成输入（批量）
   col 是列号（0 列放素材与说明，1 列起放生成节点），inputs 是上游节点 key。 */
var KEEP = '保持参考图中产品的外形、颜色、材质、Logo 与文字完全一致，不要改变产品本身。';
function g(key, title, ratio, prompt, inputs, extra) {
    var n = { key: key, type: 'gen', title: title, ratio: ratio, prompt: prompt, inputs: inputs || ['ref', 'brief'], col: 1 };
    if (extra) for (var k in extra) n[k] = extra[k];
    return n;
}
function refNode(title) { return { key: 'ref', type: 'image', title: title || '参考图', ref: true, col: 0 }; }
function briefNode() { return { key: 'brief', type: 'text', brief: true, col: 0 }; }
function labelNode(text, color) { return { key: 'label', type: 'label', text: text, color: color, col: 0 }; }

var CATS = ['全部', '电商', '海报', '人像', '分镜视频', '角色设定'];
var TEMPLATES = [
    { id: 'ecom-set', title: '电商主图套装', cat: '电商', icon: 'bag', color: '#e0782f',
      desc: '主图、卖点、场景、细节一套出',
      agent: '帮我做一套电商套图：白底主图、卖点图、使用场景图、细节特写图各一张，风格统一。先根据画布上的产品图和卖点说明规划，再逐张生成。',
      toast: '已搭好电商套图：把产品图拖进「产品图」节点、在文本里写卖点，再选中生成节点运行',
      nodes: [labelNode('电商套图', '#e0782f'), refNode('产品图'), briefNode(),
        g('main', '主图 · 白底', 'square', '电商主图：纯白背景，产品居中完整展示，柔和棚拍光，干净投影，高级质感。' + KEEP),
        g('sell', '卖点图', 'portrait43', '电商卖点图：产品为主体，旁边留出排版区域，用简洁的图标和短标题展示 3 个核心卖点，版式清爽。' + KEEP),
        g('scene', '场景图', 'portrait43', '电商场景图：把产品放进真实的使用场景，自然光，生活化构图，突出产品。' + KEEP),
        g('detail', '细节图', 'square', '电商细节图：产品局部微距特写，展示材质、做工与纹理，浅景深。' + KEEP)] },
    { id: 'white-bg', title: '白底产品图', cat: '电商', icon: 'wand', color: '#16a34a',
      desc: '去背景、补光，得到平台标准白底图',
      agent: '把画布上的产品图处理成电商平台标准白底图：纯白背景、主体居中、光线均匀、保留自然投影。',
      toast: '已搭好白底图流程：把产品图拖进「产品图」节点后运行',
      nodes: [refNode('产品图'),
        g('white', '白底图', 'square', '纯白背景（#FFFFFF）的电商标准产品图，主体居中占画面 80%，均匀柔光，底部保留自然柔和投影。' + KEEP, ['ref'])] },
    { id: 'multi-angle', title: '多角度商品图', cat: '电商', icon: 'camera', color: '#ca8a04',
      desc: '同一商品正面、45°、背面、俯视',
      agent: '根据画布上的产品图，生成同一商品的正面、45° 侧面、背面、俯视四个机位的展示图，背景与光线统一。',
      toast: '已搭好多角度流程：拖入产品图后，选中任一机位节点运行',
      nodes: [refNode('产品图'), briefNode(),
        g('front', '正面', 'square', '产品正面视角展示，浅灰渐变背景，棚拍柔光。' + KEEP),
        g('side', '45° 侧面', 'square', '产品 45 度侧面视角展示，浅灰渐变背景，棚拍柔光。' + KEEP),
        g('back', '背面', 'square', '产品背面视角展示，浅灰渐变背景，棚拍柔光。' + KEEP),
        g('top', '俯视', 'square', '产品正上方俯视视角展示，浅灰渐变背景，棚拍柔光。' + KEEP)] },
    { id: 'retouch', title: '产品精修', cat: '电商', icon: 'wand', color: '#0d9488',
      desc: '去瑕疵、提质感、重新打光',
      agent: '帮我精修画布上的产品图：去除瑕疵和灰尘、增强材质质感、重新布光，输出高清成品。',
      toast: '已搭好精修流程：拖入产品图后运行',
      nodes: [refNode('产品图'), briefNode(),
        g('retouch', '精修', 'square', '商业级产品精修：去除灰尘、划痕与瑕疵，增强材质质感与边缘高光，重新布置柔和的棚拍光，色彩准确，超清细节。' + KEEP)] },
    { id: 'poster', title: '活动海报', cat: '海报', icon: 'poster', color: '#2563eb',
      desc: '竖版主海报 + 横版 Banner',
      agent: '根据画布上的主体图和文案说明，设计一张竖版活动海报和一张横版 Banner，版式和配色保持统一。',
      toast: '已搭好海报流程：在文本里写标题和卖点，可拖入主体图，再运行',
      nodes: [labelNode('活动海报', '#2563eb'), refNode('主体图'), briefNode(),
        g('v', '竖版海报', 'portrait43', '设计一张竖版商业活动海报：醒目的大标题，清晰的信息层级，主体突出，留白合理，配色高级统一，画面中的文字清晰准确。'),
        g('h', '横版 Banner', 'wide', '设计一张横版网页 Banner：左侧标题与卖点文案，右侧主体视觉，配色与竖版海报统一，文字清晰准确。')] },
    { id: 'social-cover', title: '社交媒体封面', cat: '海报', icon: 'grid', color: '#db2777',
      desc: '小红书 3:4、视频 9:16、横版 16:9',
      agent: '根据画布上的说明，做一组社交媒体封面：小红书 3:4、竖屏视频 9:16、横版 16:9，风格一致。',
      toast: '已搭好封面流程：在文本里写主题和标题后运行',
      nodes: [refNode('主体图'), briefNode(),
        g('xhs', '小红书 3:4', 'portrait43', '小红书风格封面：大号标题文字，氛围感强，色彩明快，主体清晰，文字清晰准确。'),
        g('story', '竖屏 9:16', 'story', '竖屏短视频封面：标题醒目位于上三分之一，主体居中，对比强烈，文字清晰准确。'),
        g('wide', '横版 16:9', 'wide', '横版视频封面：左文右图构图，标题醒目，文字清晰准确。')] },
    { id: 'portrait', title: '人物写真', cat: '人像', icon: 'user', color: '#be185d',
      desc: '同一人物三种风格写真',
      agent: '以画布上的人物照片为参考，生成三张风格不同的写真：棚拍肖像、户外自然光、电影感夜景，人物长相保持一致。',
      toast: '已搭好写真流程：拖入人物照片后运行',
      nodes: [refNode('人物照片'), briefNode(),
        g('studio', '棚拍肖像', 'portrait43', '专业棚拍肖像写真，柔和伦勃朗光，简洁背景，皮肤质感自然。保持参考图人物的长相、发型与气质一致。'),
        g('outdoor', '户外自然光', 'portrait43', '户外自然光人像写真，逆光发丝光，浅景深，清新通透。保持参考图人物的长相、发型与气质一致。'),
        g('night', '电影感夜景', 'portrait43', '电影感夜景人像，霓虹与街灯氛围，胶片色调。保持参考图人物的长相、发型与气质一致。')] },
    { id: 'try-on', title: '模特试穿', cat: '人像', icon: 'user', color: '#9333ea',
      desc: '把服装穿到模特身上',
      agent: '把画布上的服装图穿到模特身上，生成正面全身和侧面半身两张试穿图，服装细节保持一致。',
      toast: '已搭好试穿流程：把服装图拖进「服装」、模特图拖进「模特」后运行',
      nodes: [{ key: 'ref', type: 'image', title: '服装', ref: true, col: 0 }, { key: 'model', type: 'image', title: '模特', col: 0 }, briefNode(),
        g('front', '正面全身', 'portrait43', '让模特穿上参考图中的服装，正面全身站姿，电商模特图风格，服装的款式、颜色、图案与细节完全一致。', ['ref', 'model', 'brief']),
        g('side', '侧面半身', 'portrait43', '让模特穿上参考图中的服装，侧身半身构图，展示服装版型，服装的款式、颜色、图案与细节完全一致。', ['ref', 'model', 'brief'])] },
    { id: 'storyboard', title: '竖版故事分镜', cat: '分镜视频', icon: 'film', color: '#7c3aed',
      desc: '一句剧情 → 分镜设定板 + 九宫格',
      agent: '根据画布上的剧情说明（和角色参考图）先写 6 个镜头的分镜脚本，再生成分镜设定板和九宫格分镜图，角色保持一致。',
      toast: '已搭好分镜流程：在文本里写剧情，可拖入角色参考图后运行',
      nodes: [labelNode('分镜故事板', '#7c3aed'), refNode('角色参考'), briefNode(),
        g('board', '分镜设定板', 'portrait43', '请根据下面的剧情生成一张"专业影视分镜设定板"。要求：竖版、黑灰底细线分栏、顶部标题 + 中部 4-6 个 CUT（CUT 编号 / 画面 / 描述 / 镜头 / 台词 / 音效）+ 底部补充区。分镜画面叙事连贯、角色场景一致。'),
        g('grid9', '九宫格分镜', 'square', '生成一张无缝的九宫格（3x3）连贯剧情分镜图。角色一致性极强；每格推进一个小动作或情绪变化。')] },
    { id: 'video-relay', title: '视频接力', cat: '分镜视频', icon: 'relay', color: '#0284c7',
      desc: '首帧图 → 视频，再截尾帧接下一段',
      agent: '以画布上的首帧图为起点，帮我生成一段 5 秒视频，然后截取尾帧作为下一段的首帧继续生成，串成连贯的两段镜头。',
      toast: '已搭好视频接力：拖入首帧图后运行；生成后在视频上截取尾帧，连到下一段继续',
      nodes: [refNode('首帧图'), briefNode(),
        g('clip1', '片段 1', 'wide', '镜头缓慢推进，主体自然运动，画面稳定，电影感光影。', ['ref', 'brief'], { video: true }),
        g('clip2', '片段 2（接尾帧）', 'wide', '承接上一段的动作继续运动，镜头平稳跟随，光影与色调保持一致。', ['brief'], { video: true })] },
    { id: 'product-video', title: '产品短视频', cat: '分镜视频', icon: 'video', color: '#0891b2',
      desc: '产品图 → 主视觉 → 展示视频',
      agent: '根据画布上的产品图，先生成一张适合做视频首帧的产品主视觉，再用它生成一段产品展示短视频。',
      toast: '已搭好产品视频流程：拖入产品图，先运行「主视觉」，再运行「展示视频」',
      nodes: [refNode('产品图'), briefNode(),
        g('kv', '主视觉（首帧）', 'wide', '产品主视觉：产品置于精致的展台上，高级感布光，背景简洁有层次，适合作为视频首帧。' + KEEP),
        { key: 'clip', type: 'gen', title: '展示视频', ratio: '16:9', video: true, col: 2, inputs: ['kv'],
          prompt: '镜头环绕产品缓慢旋转，光线在产品表面流动，展现质感与细节，稳定流畅。' }] },
    { id: 'char-three', title: '人物三视图', cat: '角色设定', icon: 'user', color: '#e11d48',
      desc: '正面 / 侧面 / 背面 + 脸部特写',
      agent: '根据画布上的角色参考图和设定说明，生成角色三视图（正面、侧面、背面）加脸部特写，以及一张人设解析图。',
      toast: '已搭好三视图流程：拖入角色参考图、在文本里写设定后运行',
      nodes: [labelNode('人设三视图', '#e11d48'), refNode('角色参考'), briefNode(),
        g('three', '三视图 + 脸部', 'wide', '生成全身三视图以及一张脸部特写，右边三分之二放正视图、侧视图、后视图，最左边三分之一是上半身特写。纯色背景，角色特征完全一致。'),
        g('sheet', '人设解析图', 'wide', '生成人设解析图，包含正视图、侧视图、背视图，以及服装细节拆解、面部特征特写，排版紧凑。')] },
    { id: 'scene-four', title: '场景四视图', cat: '角色设定', icon: 'scene', color: '#65a30d',
      desc: '顶视、轴测与立面，场景设定用',
      agent: '根据画布上的场景描述，生成一张没有人物的四宫格场景设定图（顶视图、轴测图、两个立面图），再生成一张 360° 全景图。',
      toast: '已搭好场景设定：在文本里描述场景后运行',
      nodes: [refNode('场景参考'), briefNode(),
        g('four', '场景四视图', 'square', '生成一张四宫格场景图（没有人物），包含顶视图（Plan View）、轴测图 / 45° 俯视图（Axonometric View）、两个正交立面图（Elevations）。'),
        g('pano', '360° 全景', 'ultrawide', '360-degree equirectangular panorama, spherical panorama for VR viewing, seamless 360° wrap-around environment.')] },
    { id: 'batch', title: '表格批量出图', cat: '电商', icon: 'table', color: '#475569',
      desc: '表格一行一个需求，批量生成',
      agent: '帮我规划一个批量出图任务：先把需求整理成多维表格（每行一个画面），再批量生成。',
      toast: '已搭好批量流程：在表格里每行写一个画面需求，再在「生成输入」里批量运行',
      nodes: [{ key: 'table', type: 'table', title: '需求表', col: 0 },
        { key: 'batch', type: 'batch', title: '批量生成', col: 1, inputs: ['table'] }] }
];

/* 八个技能 = 八个常用模板的快捷入口：点一下搭节点；右侧星芒 = 交给 Agent 做 */
var SKILLS = [
    { id: 'ecom-set', label: '电商套图' },
    { id: 'poster', label: '海报设计' },
    { id: 'storyboard', label: '分镜故事板' },
    { id: 'char-three', label: '人设三视图' },
    { id: 'retouch', label: '产品精修' },
    { id: 'multi-angle', label: '多角度商品图' },
    { id: 'video-relay', label: '视频接力' },
    { id: 'batch', label: '批量出图' }
];

var MODES = [
    { id: 'agent', label: 'Agent', icon: 'spark', tip: 'Agent 会读你的需求，在画布上规划并搭建节点', ph: '描述你想做的东西，例如「给这双鞋做一套电商主图，白底 + 户外场景」' },
    { id: 'image', label: '图片', icon: 'image', tip: '直接生成一张图片（使用画布默认模型）', ph: '描述你想要的画面，例如「清晨海边的咖啡馆，胶片质感」' },
    { id: 'video', label: '视频', icon: 'video', tip: '直接生成一段视频（使用画布默认视频模型）', ph: '描述视频内容，例如「镜头缓慢推近一杯冒着热气的咖啡」' }
];
var MODE_KEY = 'novai_home_mode';
var SEED_PREFIX = 'novai_canvas_seed:';


export const TEMPLATE_MAP = {};
TEMPLATES.forEach(t => { TEMPLATE_MAP[t.id] = t; });
export { CATS, TEMPLATES, SKILLS, MODES, MODE_KEY, SEED_PREFIX };
