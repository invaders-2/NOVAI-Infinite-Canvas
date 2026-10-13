// 读 text/event-stream：按空行切事件，取 data: 行 JSON.parse 后交给 onEvent（与旧 readChatStream 的切分方式一致）。
// onEvent 的第二个参数回传同一事件的 event: 名字（缺省为空串）；老调用方只取第一个参数，行为不变。
export async function readSSE(res, onEvent) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const handle = async chunk => {
        const lines = chunk.split('\n');
        const line = lines.find(l => l.startsWith('data:'));
        if (!line) return;
        let ev;
        try { ev = JSON.parse(line.slice(5).trim()); } catch (e) { return; }
        const nameLine = lines.find(l => l.startsWith('event:'));
        await onEvent(ev, nameLine ? nameLine.slice(6).trim() : '');
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
