// API 设置：常量（与旧 static/js/api-settings.js 一一对应，值不要改）
export const VOLCENGINE_DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
export const VOLCENGINE_DEFAULT_PROJECT_NAME = 'default';
export const VOLCENGINE_DEFAULT_REGION = 'cn-beijing';
export const MS_BUILTIN_IMAGE_MODELS = [
    'Tongyi-MAI/Z-Image-Turbo',
    'Qwen/Qwen-Image-2512',
    'Qwen/Qwen-Image-Edit-2511',
    'black-forest-labs/FLUX.2-klein-9B',
];
export const MS_DEFAULT_BASE_URL = 'https://api-inference.modelscope.cn/v1';
export const RH_DEFAULT_BASE_URL = 'https://www.runninghub.cn';
export const LOVART_DEFAULT_BASE_URL = 'https://lgw.lovart.ai';
export const VIP_GPT_DEFAULT_BASE_URL = 'https://www.vip-gpt.net';
export const VIP_GPT_REGISTER_URL = 'https://www.vip-gpt.net/vip-gpt/register?aff=YGMS7BDKNY5Y';
export const EXAMPLE_BASE_URL = 'https://api.example.com/v1';
export const JIMENG_DEFAULT_IMAGE_MODELS = ['5.0', '4.6', '4.5', '4.1', '4.0', '3.1', '3.0'];
export const JIMENG_DEFAULT_VIDEO_MODELS = ['seedance2.0fast_vip', 'seedance2.0_vip'];
export const JIMENG_LEGACY_IMAGE_MODELS = new Set(['jimeng-image-2k', 'jimeng-image-4k']);
export const JIMENG_LEGACY_VIDEO_MODELS = new Set(['jimeng-video-720p', 'jimeng-video-1080p']);
export const CODEX_DEFAULT_IMAGE_MODELS = ['gpt-image-2'];
export const CODEX_DEFAULT_CHAT_MODELS = ['gpt-5.5'];
export const GEMINI_CLI_DEFAULT_IMAGE_MODELS = ['auto'];
export const GEMINI_CLI_DEFAULT_CHAT_MODELS = ['auto'];
export const LOVART_DEFAULT_CHAT_MODELS = ['lovart-agent'];
export const LOVART_DEFAULT_IMAGE_MODELS = [
    'generate_image_gpt_image_2_5_flare', 'generate_image_gpt_image_2_5_flare_low', 'generate_image_gpt_image_2_5_flare_medium',
    'generate_image_gpt_image_2_5_flare_high', 'generate_image_gpt_image_2_5_flare_xhigh', 'generate_image_gpt_image_2_5_flare_max',
    'generate_image_gpt_image_2_5_sunburst', 'generate_image_gpt_image_2_5_sunburst_low', 'generate_image_gpt_image_2_5_sunburst_medium',
    'generate_image_gpt_image_2_5_sunburst_high', 'generate_image_gpt_image_2_5_sunburst_xhigh', 'generate_image_gpt_image_2_5_sunburst_max',
    'generate_image_gpt_image_2', 'generate_image_gpt_image_2_low', 'generate_image_gpt_image_2_medium',
    'generate_image_gpt_image_2_high', 'generate_image_nano_banana_pro', 'generate_image_nano_banana_2',
    'generate_image_seedream_v5_pro', 'generate_image_gpt_image_1_5', 'generate_image_seedream_v5',
    'generate_image_luma_uni_1', 'generate_image_luma_uni_1_max', 'generate_image_flux_2_max',
    'generate_image_flux_2_pro', 'generate_image_seedream_v4_5', 'generate_image_nano_banana',
    'generate_image_seedream_v4', 'generate_image_midjourney', 'generate_image_ideogram_v4',
    'generate_image_qwen_image3', 'generate_image_qwen_image3_pro', 'generate_image_nano_banana_2_lite',
    'generate_image_p_image_ideogram',
];
export const LOVART_DEFAULT_VIDEO_MODELS = [
    'generate_video_seedance_v2_5', 'generate_video_seedance_v2_0', 'generate_video_seedance_v2_0_fast',
    'generate_video_seedance_v2_0_mini', 'generate_video_kling_v3', 'generate_video_kling_v3_omni',
    'generate_video_minimax_h3', 'generate_video_seedance_pro_v1_5', 'generate_video_kling_v2_6',
    'generate_video_wan_v2_6', 'generate_video_veo3_1', 'generate_video_veo3_1_fast',
    'generate_video_kling_omni_v1', 'generate_video_hailuo_v2_3', 'generate_video_veo3',
    'generate_video_vidu_q2', 'generate_video_gemini_omni_flash', 'generate_video_minimax_h3_max',
    'generate_video_wan_v3', 'generate_video_wan_v3_prime',
];
export const CLI_PROTOCOLS = new Set(['jimeng', 'codex', 'gemini-cli']);
export const API_PROTOCOLS = ['openai', 'apimart', 'gemini', 'volcengine', 'runninghub', 'jimeng', 'codex', 'gemini-cli', 'lovart'];
export const CLI_PROVIDER_PRESETS = {
    jimeng: { id: 'jimeng', name: '即梦 CLI', protocol: 'jimeng' },
    codex: { id: 'codex', name: 'GPT CLI', protocol: 'codex' },
    'gemini-cli': { id: 'gemini-cli', name: 'Antigravity CLI', protocol: 'gemini-cli' },
};
// 与后端 FIXED_PROTOCOL_PROVIDER_IDS 对齐：这些平台协议固定，不显示/不接受单模型协议覆盖
export const FIXED_PROTOCOL_PROVIDER_IDS = new Set(['modelscope', 'volcengine', 'jimeng', 'runninghub', 'lovart']);
export const BUILTIN_IDS = new Set(['comfly', 'modelscope', 'runninghub', 'volcengine', 'jimeng', 'lovart']);

export const ONBOARDING_GUIDES = {
    modelscope: {
        titleKey: 'api.msOnboardingTitle', title: 'ModelScope 新手引导',
        descKey: 'api.msOnboardingDesc', desc: '先获取 Token，填入 API Key 并保存后，右侧完整设置会自动显示。',
        primaryLabelKey: 'api.msGetTokenCn', primaryLabel: '获取 Token · 国内',
        secondaryLabelKey: 'api.msGetTokenGlobal', secondaryLabel: '获取 Token · 国外',
        primaryUrl: 'https://www.modelscope.cn/my/access/token',
        secondaryUrl: 'https://www.modelscope.ai/my/access/token',
    },
    runninghub: {
        titleKey: 'api.rhOnboardingTitle', title: 'RunningHub 新手引导',
        descKey: 'api.rhOnboardingDesc', desc: 'RH 有 RH币和账户余额两种 Key，RH币必填，账户余额可选。',
        primaryLabelKey: 'api.rhGetKeyCn', primaryLabel: '获取 Key · 国内',
        secondaryLabelKey: 'api.rhGetKeyGlobal', secondaryLabel: '获取 Key · 国外',
        primaryUrl: 'https://www.runninghub.cn/enterprise-api/consumerApi?inviteCode=rh-v1331',
        secondaryUrl: 'https://www.runninghub.ai/enterprise-api/consumerApi?inviteCode=rh-v1331',
        walletPrimaryLabelKey: 'api.rhGetWalletKeyCn', walletPrimaryLabel: '获取余额 Key · 国内',
        walletSecondaryLabelKey: 'api.rhGetWalletKeyGlobal', walletSecondaryLabel: '获取余额 Key · 国外',
        walletPrimaryUrl: 'https://www.runninghub.cn/enterprise-api/sharedApi?inviteCode=rh-v1331',
        walletSecondaryUrl: 'https://www.runninghub.ai/enterprise-api/sharedApi?inviteCode=rh-v1331',
    },
};

// RunningHub「RH币 / 账户余额」Key 的获取链接（API Key 卡片里的 国内 / 国外 Key）
export const RH_KEY_LINKS = {
    free: { cn: ONBOARDING_GUIDES.runninghub.primaryUrl, global: ONBOARDING_GUIDES.runninghub.secondaryUrl },
    wallet: { cn: ONBOARDING_GUIDES.runninghub.walletPrimaryUrl, global: ONBOARDING_GUIDES.runninghub.walletSecondaryUrl },
};

// category: 'allround'（全能）| 'value'（性价比）| 'free'（免费），推荐页按分组分节展示
export const RECOMMENDED_APIS = [
    {
        id: 'exellome', name: 'EXELLOME', category: 'value', base_url: 'https://new.exellome.online',
        // 异步协议 + 异步生图模式：提交 /v1/videos、轮询 /v1/videos/{id}，本地参考图走 multipart 直传
        protocol: 'apimart', image_request_mode: 'openai-video-proxy',
        register_url: 'https://new.exellome.online/register?aff=r2dZ',
        tagKeys: ['GPT-Image2', 'Nano-Banana'], icons: ['IMG'],
        summaryKey: 'api.recommendExellomeSummary', summary: '稳定输出 GPT-Image2 和 Nano Banana 的 2K/4K。',
        perks: [{ key: 'api.recommendExellome2k4k', label: '2K/4K' }],
        keyHint: '使用 VIP 分组',
        image_models: ['gpt-image2-2k', 'gpt-image2-4k', 'Nano-Banana-2-2k', 'Nano-Banana-2-4k', 'Nano-Banana-Pro-2k', 'Nano-Banana-Pro-4k'],
        chat_models: [], video_models: [],
    },
    {
        id: 'fhl', name: 'FHL', category: 'value', base_url: 'https://www.fhl.mom',
        // FHL 生图走 OpenAI Responses / image_generation，避免 edits 长任务返回半截 keepalive
        protocol: 'openai', image_request_mode: 'openai-responses',
        register_url: 'https://www.fhl.mom/register?aff=86L574B4T2N9',
        tagKeys: ['Codex', 'Claude', 'api.tagGptImage2'], icons: ['CODEX', 'GPT', 'IMG'],
        summaryKey: 'api.recommendFhlSummary', summary: '稳定便宜接入 codex/Claude/GPT Image 2出图。',
        image_models: ['gpt-image-2', 'gpt-image-2-2k', 'gpt-image-2-4k', 'nano-banana'],
        chat_models: ['gpt-5.5'], video_models: [],
    },
    {
        id: 'vip-gpt', name: 'VIP-GPT', category: 'value', base_url: VIP_GPT_DEFAULT_BASE_URL,
        protocol: 'openai', register_url: VIP_GPT_REGISTER_URL,
        tagKeys: ['Codex', 'Claude', 'GPT-image-2', 'Nano-banana'], icons: ['GPT', 'LLM'],
        summaryKey: 'api.recommendVipGptSummary', summary: '支持 AI 编程的模型和生图模型，还可以包月使用。',
        empty_models_on_save: true,
    },
    {
        id: 'runninghub', name: 'RunningHub', category: 'allround', base_url: RH_DEFAULT_BASE_URL,
        protocol: 'runninghub', image_request_mode: 'openai',
        register_url: ONBOARDING_GUIDES.runninghub.secondaryUrl, register_url_cn: ONBOARDING_GUIDES.runninghub.primaryUrl,
        tagKeys: ['api.tagImageModels', 'api.tagVideoModels', 'api.tagLlmModels', 'api.tagSeedance'], icons: ['IMG', 'VID', 'LLM'],
        summaryKey: 'api.recommendRunninghubSummary', summary: 'RunningHub 覆盖图像、LLM、视频和工作流能力，适合一套 Key 接入多类型生成任务。',
    },
    {
        name: 'APIMART', category: 'allround', base_url: 'https://api.apimart.ai', protocol: 'apimart',
        register_url: 'https://apimart.ai/zh/register?aff=1uyAbb', register_url_cn: 'https://apib.ai/register?aff=1uyAbb',
        tagKeys: ['api.tagImageModels', 'api.tagVideoModels', 'api.tagLlmModels', 'api.tagSeedance'], icons: ['IMG', 'VID', 'LLM'],
        summaryKey: 'api.recommendApimartSummary', summary: '聚合多类型生成模型，适合希望用一套配置快速接入图像、视频和 LLM 的用户。',
    },
    {
        id: 'modelscope', name: 'ModelScope', category: 'free', base_url: MS_DEFAULT_BASE_URL,
        protocol: 'openai', image_request_mode: 'openai',
        register_url: ONBOARDING_GUIDES.modelscope.secondaryUrl, register_url_cn: ONBOARDING_GUIDES.modelscope.primaryUrl,
        tagKeys: ['api.tagImageModels', 'api.tagLlmModels', 'api.tagAliyunBinding'], icons: ['IMG', 'LLM'],
        summaryKey: 'api.recommendModelScopeSummary', summary: 'ModelScope 提供免费额度和模型广场接入，适合基础图像与 LLM 测试。',
        perks: [{ key: 'api.recommendModelScopeFree', label: '免费额度', free: true }],
    },
    {
        id: 'agnes-ai', name: 'Agnes AI', category: 'free', base_url: 'https://apihub.agnes-ai.com',
        // Agnes 生图走 /v1/images/generations JSON（见 detect_image_request_mode）
        protocol: 'openai', image_request_mode: 'openai-json',
        register_url: 'https://platform.agnes-ai.com/settings/apiKeys',
        tagKeys: ['api.tagImageModels', 'api.tagVideoModels', 'api.tagLlmModels'], icons: ['IMG', 'VID', 'LLM'],
        summaryKey: 'api.recommendAgnesSummary', summary: '免费可用的 Agnes AI 接口，支持图像与视频生成，适合快速测试和低成本接入。',
        perks: [{ key: 'api.recommendAgnesFree', label: '免费', free: true }],
        image_models: ['agnes-image-2.5-flash', 'agnes-image-2.1-flash', 'agnes-image-2.0-flash'],
        chat_models: ['agnes-3.0-flash', 'agnes-2.5-pro', 'agnes-2.5-pro-beta', 'agnes-2.5-flash', 'agnes-2.0-flash'],
        video_models: ['agnes-video-2.5', 'agnes-video-2.5-flash'],
        model_protocols: {},
    },
];
export const RECOMMEND_GROUPS = [
    { key: 'allround', titleKey: 'api.recommendGroupAllround', title: '全能可靠', short: '全能', icon: 'box' },
    { key: 'value', titleKey: 'api.recommendGroupValue', title: '性价比', short: '性价比', icon: 'bolt' },
    { key: 'free', titleKey: 'api.recommendGroupFree', title: '免费', short: '免费', icon: 'sparkles' },
];
export const RECOMMEND_CAPS = { IMG: ['image', '图像'], VID: ['video', '视频'], LLM: ['chat', 'LLM'], CODEX: ['terminal', 'Codex'], GPT: ['sparkles', 'GPT'] };
export const LOCKED_RECOMMENDED_PROTOCOL_IDS = new Set(['exellome', 'fhl']);

export const PROTOCOL_LABELS = { openai: 'OpenAI 直连', apimart: '异步协议', gemini: 'Gemini', volcengine: '方舟 / Ark', runninghub: 'RunningHub', jimeng: '即梦 CLI', codex: 'Codex CLI', 'gemini-cli': 'Antigravity CLI', lovart: 'Lovart 设计代理' };
export const IMAGE_MODE_LABELS = { openai: 'OpenAI 标准', 'openai-json': 'OpenAI JSON', 'openai-video-proxy': 'OpenAI 中转', 'openai-responses': 'OpenAI RS' };
export const PROXY_LABELS = { auto: '跟随全局', on: '走代理', off: '直连' };
export const CONCURRENCY_STEPS = [0, 1, 2, 3, 4, 6, 8];

export const RH_KNOWN_MODEL_LABELS = {
    'gpt-image-2.0/text-to-image-channel-low-price': '全能图片G2 · 文生图 · 低价渠道版',
    'gpt-image-2.0/edit-channel-low-price': '全能图片G2 · 图片编辑 · 低价渠道版',
    'gpt-image-2/text-to-image-official-stable': '全能图片G2 · 文生图 · 官方稳定版',
    'gpt-image-2/image-to-image-official-stable': '全能图片G2 · 图生图 · 官方稳定版',
    'nano-banana/text-to-image-official-stable': '全能图片 · 文生图 · 官方稳定版',
    'nano-banana/image-to-image-official-stable': '全能图片 · 图生图 · 官方稳定版',
    'nano-banana-pro/text-to-image-official-stable': '全能图片Pro · 文生图 · 官方稳定版',
    'nano-banana-pro/image-to-image-official-stable': '全能图片Pro · 图生图 · 官方稳定版',
};
// 视频没有协议概念：按模型名前缀自动分发到各厂商接口
export const VIDEO_VENDOR_RULES = [
    ['通义万象', /^(happyhorse-|wan2\.|wan-)/],
    ['豆包Seedance', /^(doubao-seedance|doubao-)/],
    ['海螺', /^(minimax-hailuo|minimax)/],
    ['可灵', /^kling/],
    ['Luma', /^(luma|ray-)/],
    ['Runway', /^(runway|gen3a_|gen4_|gen3a-turbo|gen4-turbo)/],
    ['Vidu', /^(vidu|tc-vidu)/],
    ['统一格式', /^(jimeng-video|jimeng-|sora-|sora2)/],
    ['OpenAI视频', /^veo/],
];
export const MODEL_KINDS = [
    { kind: 'image', key: 'image_models', titleKey: 'api.imageModels', title: '生图模型', hintKey: 'api.imageHint', hint: '在线生图和无限画布 API 生成使用' },
    { kind: 'chat', key: 'chat_models', titleKey: 'api.chatModels', title: '聊天模型', hintKey: 'api.chatHint', hint: 'GPT 对话和 LLM 节点使用' },
    { kind: 'video', key: 'video_models', titleKey: 'api.videoModels', title: '视频模型', hintKey: 'api.videoHint', hint: '无限画布视频生成节点使用' },
];
export function modelListKey(kind) { return kind === 'image' ? 'image_models' : kind === 'video' ? 'video_models' : 'chat_models'; }
