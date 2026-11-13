/**
 * 中文加粗容错：CommonMark 的 flanking 规则会被中文标点卡住，屏幕上看不出原因。
 *
 * 例：**这一步完成了「阶段二」的画面生成**
 * 闭合 ** 前面是「」这类标点、后面紧跟汉字 —— 既没有前置空白、又没被空白或标点收尾，
 * 不满足 right-flanking，整段退化成一串字面星号。
 * 反向的开场同理：他说**「好」**。 —— ** 后面紧跟标点、前面又是汉字，不满足 left-flanking。
 *
 * 修法：只给「本来就不合规」的定界符补一个 U+200B 零宽空格（开场补在 ** 之后、闭合补在 ** 之前）。
 * U+200B 既不是 Unicode 空白也不是标点，定界符因此重新满足 flanking；屏幕上看不见，
 * 文字内容也不变（把 U+200B 去掉就是原文），不用加空格、更不删星号。
 *
 * 不碰的地方：围栏代码块 / 行内 code / 公式（里面的星号是内容）、链接地址、
 * 以及所有没配上对的定界符。表格单元格里的文字照常处理（只是插了不可见字符，列结构不变）。
 */
const ZWSP = "\u200b";
/** CommonMark 的「标点」= Unicode P（标点）+ S（符号），和解析器的判定保持一致 */
const PUNCT = /[\p{P}\p{S}]/u;
const SPACE = /\s/;
const isPunct = (ch: string | undefined): boolean => !!ch && PUNCT.test(ch);
const isSpace = (ch: string | undefined): boolean => !ch || SPACE.test(ch);

type Range = [number, number];

/** 行内 code 的区间（同一行内按反引号长度配对；没配对的当正文） */
function codeSpans(line: string): Range[] {
    const runs: Array<{ at: number; len: number }> = [];
    for (let i = 0; i < line.length;) {
        if (line[i] !== "`") { i += 1; continue; }
        let end = i;
        while (end < line.length && line[end] === "`") end += 1;
        runs.push({ at: i, len: end - i });
        i = end;
    }
    const spans: Range[] = [];
    for (let k = 0; k < runs.length;) {
        let close = -1;
        for (let t = k + 1; t < runs.length; t += 1) if (runs[t].len === runs[k].len) { close = t; break; }
        if (close < 0) { k += 1; continue; }
        spans.push([runs[k].at, runs[close].at + runs[close].len]);
        k = close + 1;
    }
    return spans;
}

/** 公式区间：$$…$$ 与行内 $…$（单个 $ 要求两侧不贴空白，避免把货币金额当公式） */
function mathSpans(line: string, taken: Range[]): Range[] {
    const spans: Range[] = [];
    const free = (at: number) => !taken.some(([s, e]) => at >= s && at < e) && !spans.some(([s, e]) => at >= s && at < e);
    for (const m of line.matchAll(/\$\$([\s\S]+?)\$\$/g)) {
        const at = m.index ?? 0;
        if (free(at)) spans.push([at, at + m[0].length]);
    }
    for (const m of line.matchAll(/(?<![\\$])\$(?![\s$])([^$\n]+?)(?<=[^\s$])\$(?!\$)/g)) {
        const at = m.index ?? 0;
        if (free(at)) spans.push([at, at + m[0].length]);
    }
    return spans;
}

/** 行内链接地址 / 裸 URL 的区间：地址里的星号不是强调，不能动 */
function linkSpans(line: string): Range[] {
    const spans: Range[] = [];
    for (const m of line.matchAll(/\]\(([^)\s]*)\)/g)) {
        const at = (m.index ?? 0) + 1;
        spans.push([at, at + m[0].length - 1]);
    }
    for (const m of line.matchAll(/(?:https?:\/\/|www\.)[^\s<>()]+/g)) {
        const at = m.index ?? 0;
        spans.push([at, at + m[0].length]);
    }
    return spans;
}

/** 整段一眼扫过：围栏代码块按行成对，行内 code / 公式 / 链接地址按行内的配对区间收集 */
function verbatimRanges(text: string): Range[] {
    const ranges: Range[] = [];
    let offset = 0;
    let fenceMark = "";
    let fenceLen = 0;
    let fenceStart = 0;
    for (const line of text.split("\n")) {
        const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
        if (fenceMark) {
            if (fence && fence[1][0] === fenceMark && fence[1].length >= fenceLen) {
                ranges.push([fenceStart, offset + line.length]);
                fenceMark = "";
            }
        } else if (fence) {
            fenceMark = fence[1][0];
            fenceLen = fence[1].length;
            fenceStart = offset;
        } else {
            const local = [...codeSpans(line)];
            const spans = [...local, ...mathSpans(line, local), ...linkSpans(line)];
            for (const [start, end] of spans) ranges.push([offset + start, offset + end]);
        }
        offset += line.length + 1;
    }
    if (fenceMark) ranges.push([fenceStart, text.length]);
    return ranges;
}

/**
 * 成对判定按「行」做：段落里出现一个没配对的字面 ** 时，跨行配对会把后面每对定界符都错位
 * （实测：上一行的散星号抢走了下一行的开场符）。行内加粗本来就极少跨行，按行配对优先不误伤。
 */
function collectPads(text: string, from: number, to: number, pads: Set<number>): void {
    for (let lineStart = from; lineStart < to;) {
        const newline = text.indexOf("\n", lineStart);
        const lineEnd = newline < 0 || newline > to ? to : newline;
        collectLinePads(text, lineStart, lineEnd, pads);
        lineStart = lineEnd + 1;
    }
}

/** 单行里成对的 ** / __：只给 flanking 不成立的那一侧记一个插入点 */
function collectLinePads(text: string, from: number, to: number, pads: Set<number>): void {
    for (const mark of ["*", "_"]) {
        const runs: Range[] = [];
        for (let i = from; i < to;) {
            if (text[i] !== mark) { i += 1; continue; }
            let end = i;
            while (end < to && text[end] === mark) end += 1;
            if (end - i === 2) runs.push([i, end]);
            i = end;
        }
        for (let k = 0; k + 1 < runs.length; k += 2) {
            const [openAt, openEnd] = runs[k];
            const [closeAt, closeEnd] = runs[k + 1];
            if (closeAt <= openEnd) continue;
            // 开场：** 后面紧跟标点、前面是汉字 → 在 ** 后面补零宽空格
            if (isPunct(text[openEnd]) && !isSpace(text[openAt - 1]) && !isPunct(text[openAt - 1])) pads.add(openEnd);
            // 闭合：** 前面是标点、后面紧跟非空白非标点 → 在 ** 前面补零宽空格（截图那句就是这种）
            if (isPunct(text[closeAt - 1]) && !isSpace(text[closeEnd]) && !isPunct(text[closeEnd])) pads.add(closeAt);
        }
    }
}

/** 给中文标点旁的成对加粗定界符补零宽空格；没有需要修的就原样返回（幂等） */
export function padCjkEmphasis(src: string): string {
    const text = String(src ?? "");
    if (!text.includes("**") && !text.includes("__")) return src;
    const pads = new Set<number>();
    let at = 0;
    for (const [start, end] of verbatimRanges(text).sort((a, b) => a[0] - b[0])) {
        if (end <= at) continue;
        if (start > at) collectPads(text, at, start, pads);
        at = Math.max(at, end);
    }
    collectPads(text, at, text.length, pads);
    if (!pads.size) return src;
    let out = "";
    let last = 0;
    for (const position of [...pads].sort((a, b) => a - b)) {
        out += text.slice(last, position) + ZWSP;
        last = position;
    }
    return out + text.slice(last);
}
