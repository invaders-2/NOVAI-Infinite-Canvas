// 应用市场「最新上线」轮播：当前最新的 7 个模型，封面是各家官网 / 官方文档的示例图。
// 图片由 tools/market-art/build.cjs 统一裁成 1600×900，来源见 static/images/market/SOURCES.md。
// 有官方示例视频的（Seedance / Kling / Gemini Omni）当前张直接播视频（tools/market-art/videos.sh 生成），dur 是视频秒数，进度条按它走。
// to：点「立即体验」要去的地方。
export const SHOWCASE = [
    { id: 'gpt26', title: 'GPT Image 2.6', maker: 'OpenAI', desc: '细节、质感和画面里的文字都更稳，改图也更听话', tag: '图像', icon: 'image', cover: '/static/images/market/showcase-gpt26.jpg?v=20261119', to: 'canvas' },
    { id: 'seedream', title: 'Seedream 5.5', maker: '字节跳动 Seed', desc: '2K / 4K 超清直出，光影和材质一步到位', tag: '图像', icon: 'image', cover: '/static/images/market/showcase-seedream.jpg?v=20261119', to: 'canvas' },
    { id: 'minimax', title: 'MiniMax H3-Image', maker: 'MiniMax', desc: '电影感构图与色彩，海报、概念图都拿得出手', tag: '图像', icon: 'image', cover: '/static/images/market/showcase-minimax.jpg?v=20261119', to: 'canvas' },
    { id: 'nanobanana', title: 'Nano Banana 2.1', maker: 'Google', desc: '最多 14 张参考图，多角色、多商品保持一致', tag: '图像', icon: 'image', cover: '/static/images/market/showcase-nanobanana.jpg?v=20261119', to: 'canvas' },
    { id: 'seedance', title: 'Seedance 2.5', maker: '字节跳动 Seed', desc: '首尾帧直出，几秒钟把静图变成镜头', tag: '视频', icon: 'film', cover: '/static/images/market/showcase-seedance.jpg?v=20261119', video: '/static/images/market/showcase-seedance.mp4?v=20261119', dur: 10, to: 'canvas' },
    { id: 'kling', title: 'Kling 4.0', maker: '快手可灵', desc: '多镜头叙事与关键帧控制，长镜头更连贯', tag: '视频', icon: 'film', cover: '/static/images/market/showcase-kling.jpg?v=20261119', video: '/static/images/market/showcase-kling.mp4?v=20261119', dur: 12, to: 'canvas' },
    { id: 'gemini', title: 'Gemini Omni 1.2 Flash', maker: 'Google', desc: '15 秒视频直出，用对话就能改镜头和画面', tag: '视频', icon: 'film', cover: '/static/images/market/showcase-gemini.jpg?v=20261119', video: '/static/images/market/showcase-gemini.mp4?v=20261119', dur: 9.6, to: 'canvas' },
];
