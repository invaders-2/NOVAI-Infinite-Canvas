// 读 text/event-stream：按空行切事件，取 data: 行 JSON.parse 后交给 onEvent（与旧 readChatStream 的切分方式一致）。
export async function readSSE(res, onEvent) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const handle = async chunk => {
        const line = chunk.split('\n').find(l => l.startsWith('data:'));
        if (!line) return;
        let ev;
        try { ev = JSON.parse(line.slice(5).trim()); } catch (e) { return; }
        await onEvent(ev);
    };
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';
        for (const e of events) await handle(e);
    }
    if (buffer.trim()) await handle(buffer);
}
