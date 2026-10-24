/*
 * 会话状态机（ES5 / 零依赖）：把 /api/agent/run 的 SSE 事件累积成一份可渲染的会话状态。
 * 只做「事件 → 状态」，不碰 DOM；smart-canvas.js 现阶段是旁路双写，原有卡片渲染照旧。
 * 字段名对齐助手会话的初始状态，后续 part 渲染器可以直接消费。
 */
(function(){
    'use strict';

    var TERMINAL_STATUSES = ['completed', 'failed', 'stopped', 'ended_unknown'];
    var WAITING_STATUSES = ['waiting_user_input', 'waiting_external'];
    var DONE_STATUS_MAP = {
        ok: 'completed',
        completed: 'completed',
        success: 'completed',
        failed: 'failed',
        fail: 'failed',
        error: 'failed',
        aborted: 'stopped',
        stopped: 'stopped',
        canceled: 'stopped',
        cancelled: 'stopped',
        ended_unknown: 'ended_unknown'
    };

    var seq = 0;
    function nowMs(){
        var value = Date.now();
        return typeof value === 'number' ? value : 0;
    }
    function uid(prefix){
        seq += 1;
        return (prefix || 'id') + '_' + nowMs().toString(36) + '_' + seq;
    }
    function isObject(value){
        return !!value && typeof value === 'object' && !(value instanceof Array);
    }
    function copyObject(source){
        var out = {};
        if(!isObject(source)) return out;
        for(var key in source){
            if(Object.prototype.hasOwnProperty.call(source, key)) out[key] = source[key];
        }
        return out;
    }
    function isWaiting(status){
        return WAITING_STATUSES.indexOf(String(status || '')) !== -1;
    }
    function isTerminal(status){
        return TERMINAL_STATUSES.indexOf(String(status || '')) !== -1;
    }

    function create(){
        return {
            conversationId: '',
            runId: '',
            lastEventId: null,
            streamState: 'idle',
            messages: [],
            streamingMessageId: null,
            thinkingActivity: null,
            runActivity: null,
            contextUsage: null,
            contextNodeIds: [],
            pendingConfirmation: null,
            pendingQuestion: null,
            inputValue: '',
            attachments: []
        };
    }

    function pushAssistantMessage(state, extra){
        var at = nowMs();
        var message = {
            id: uid('msg'),
            role: 'assistant',
            parts: [],
            status: '',
            activeWorkMs: 0,
            createdAt: at,
            updatedAt: at
        };
        if(isObject(extra)){
            for(var key in extra){
                if(Object.prototype.hasOwnProperty.call(extra, key)) message[key] = extra[key];
            }
        }
        state.messages.push(message);
        state.streamingMessageId = message.id;
        return message;
    }

    function pushUserMessage(state, text){
        var at = nowMs();
        var message = {
            id: uid('msg'),
            role: 'user',
            parts: [],
            status: '',
            activeWorkMs: 0,
            createdAt: at,
            updatedAt: at
        };
        var clean = String(text === undefined || text === null ? '' : text);
        if(clean) message.parts.push({ id: uid('part'), type: 'text', text: clean, createdAt: at, updatedAt: at });
        state.messages.push(message);
        return message;
    }

    function findMessage(state, id){
        if(!id) return null;
        for(var i = state.messages.length - 1; i >= 0; i--){
            if(state.messages[i] && state.messages[i].id === id) return state.messages[i];
        }
        return null;
    }
    function currentAssistant(state){
        return findMessage(state, state.streamingMessageId);
    }
    function ensureAssistant(state){
        return currentAssistant(state) || pushAssistantMessage(state);
    }

    function touchThinking(state, part, at){
        if(part.type === 'thinking'){
            if(!state.thinkingActivity){
                state.thinkingActivity = { startedAt: at, active: true };
            } else {
                state.thinkingActivity.active = true;
            }
            return;
        }
        if(state.thinkingActivity && state.thinkingActivity.active){
            state.thinkingActivity.active = false;
            state.thinkingActivity.endedAt = at;
        }
    }

    function appendPart(state, message, part){
        var at = nowMs();
        if(!part.id) part.id = uid('part');
        if(!part.createdAt) part.createdAt = at;
        part.updatedAt = at;
        message.parts.push(part);
        message.updatedAt = at;
        touchThinking(state, part, at);
        return part;
    }

    function stepIndexKey(event){
        var index = event.index;
        if(index === undefined || index === null || index === '') return '';
        return String(index);
    }
    function findStepPart(message, key){
        var i;
        if(key){
            for(i = 0; i < message.parts.length; i++){
                var part = message.parts[i];
                if(part.type !== 'tool_event' || part.kind !== 'step') continue;
                var index = (part.index === undefined || part.index === null) ? '' : String(part.index);
                if(index === key) return part;
            }
            return null;
        }
        for(i = message.parts.length - 1; i >= 0; i--){
            if(message.parts[i].type === 'tool_event' && message.parts[i].kind === 'step') return message.parts[i];
        }
        return null;
    }
    function upsertStepPart(state, message, event, phase){
        var at = nowMs();
        var part = findStepPart(message, stepIndexKey(event));
        if(!part){
            part = appendPart(state, message, {
                type: 'tool_event',
                kind: 'step',
                index: stepIndexKey(event),
                tool: '',
                title: '',
                status: '',
                message: '',
                startedAt: at,
                endedAt: 0
            });
        }
        if(event.tool) part.tool = String(event.tool);
        if(event.description && !part.title) part.title = String(event.description);
        if(phase === 'start'){
            part.status = 'running';
            if(!part.startedAt) part.startedAt = at;
        } else {
            part.status = event.ok ? 'done' : 'failed';
            part.ok = !!event.ok;
            part.endedAt = at;
            if(event.message) part.message = String(event.message);
            else if(event.error) part.message = String(event.error);
            if(event.code) part.code = String(event.code);
        }
        message.updatedAt = at;
        return part;
    }

    function toolEventPart(event){
        var payload = null;
        if(isObject(event.payload)) payload = event.payload;
        else if(isObject(event.data)) payload = event.data;
        return {
            type: 'tool_event',
            kind: event.kind ? String(event.kind) : 'tool',
            tool: String(event.tool || event.name || ''),
            status: String(event.status || ''),
            message: String(event.message || ''),
            payload: payload
        };
    }

    function activityElapsed(activity, at){
        if(!activity) return 0;
        var frozenMs = Number(activity.frozenMs) || 0;
        if(activity.frozen) return frozenMs;
        var started = Number(activity.startedAt) || 0;
        return frozenMs + Math.max(0, (Number(at) || nowMs()) - started);
    }
    function freezeActivity(state, at){
        var activity = state.runActivity;
        if(!activity || activity.frozen) return Number(activity && activity.frozenMs) || 0;
        var when = Number(at) || nowMs();
        activity.frozenMs = activityElapsed(activity, when);
        activity.startedAt = when;
        activity.frozen = true;
        return activity.frozenMs;
    }
    function settleActivity(state, at){
        var frozenMs = freezeActivity(state, at);
        var message = currentAssistant(state);
        if(message) message.activeWorkMs = frozenMs;
        return frozenMs;
    }

    function workMs(state, now){
        if(!state || !state.runActivity) return 0;
        var at = Number(now) || nowMs();
        if(isWaiting(state.streamState) || isTerminal(state.streamState) || state.runActivity.frozen){
            return Number(state.runActivity.frozenMs) || 0;
        }
        return activityElapsed(state.runActivity, at);
    }

    /* 跨轮基线：把上一段（如规划卡）已结算的毫秒写进 frozenMs，run_start 会原样带上，
       workMs 就从基线开始累加；0 / 负数 / 非数字直接忽略，不改 workMs 语义。 */
    function setBaseline(state, ms){
        if(!state) return state;
        var value = Number(ms);
        if(!isFinite(value) || value <= 0) return state;
        if(!state.runActivity){
            state.runActivity = { startedAt: 0, frozenMs: value, frozen: true };
        } else if(state.runActivity.frozen){
            state.runActivity.frozenMs = value;
        }
        return state;
    }

    function mergeThinking(parts){
        var list = parts instanceof Array ? parts : [];
        var out = [];
        for(var i = 0; i < list.length; i++){
            var part = list[i];
            if(!isObject(part)){
                out.push(part);
                continue;
            }
            var previous = out.length ? out[out.length - 1] : null;
            if(part.type === 'thinking' && previous && previous.type === 'thinking'){
                var merged = copyObject(previous);
                merged.id = previous.id || part.id;
                merged.text = String(previous.text || '') + String(part.text || '');
                merged.totalDurationMs = (Number(previous.totalDurationMs) || 0) + (Number(part.totalDurationMs) || 0);
                merged.updatedAt = Number(part.updatedAt) || nowMs();
                out[out.length - 1] = merged;
                continue;
            }
            out.push(part);
        }
        return out;
    }

    function normalizeDoneStatus(data){
        var raw = String((data && (data.status || data.state)) || 'completed').toLowerCase();
        if(DONE_STATUS_MAP[raw]) return DONE_STATUS_MAP[raw];
        return isTerminal(raw) ? raw : 'ended_unknown';
    }

    function usageOf(data){
        if(isObject(data.usage)) return copyObject(data.usage);
        var keys = ['input_tokens', 'output_tokens', 'total_tokens', 'cached_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens'];
        var usage = {};
        var found = false;
        for(var i = 0; i < keys.length; i++){
            if(typeof data[keys[i]] === 'number'){
                usage[keys[i]] = data[keys[i]];
                found = true;
            }
        }
        return found ? usage : null;
    }

    function applyEvent(state, event){
        if(!state || !isObject(event)) return state;
        var type = String(event.type || event.event || event.name || '');
        var data = isObject(event.data) ? event.data : event;
        var eventId = event.id;
        if((eventId === undefined || eventId === null || eventId === '') && data !== event) eventId = data.event_id;
        if(eventId !== undefined && eventId !== null && eventId !== '') state.lastEventId = String(eventId);

        if(type === 'run_start'){
            var assistant = pushAssistantMessage(state);
            assistant.status = 'streaming';
            state.streamState = 'streaming';
            state.runId = String(data.run_id || data.runId || '');
            if(data.conversation_id) state.conversationId = String(data.conversation_id);
            var baselineMs = (state.runActivity && state.runActivity.frozen) ? (Number(state.runActivity.frozenMs) || 0) : 0;
            state.runActivity = { startedAt: nowMs(), frozenMs: baselineMs, frozen: false };
            state.pendingConfirmation = null;
            state.pendingQuestion = null;
            return state;
        }

        if(type === 'plan'){
            var steps = data.steps instanceof Array ? data.steps : [];
            state.plan = {
                intent: String(data.intent || ''),
                summary: String(data.summary || ''),
                steps: steps,
                requiresConfirmation: !!data.requires_confirmation,
                round: Number(data.round) || 0
            };
            if(data.requires_confirmation){
                state.pendingConfirmation = {
                    id: String(data.plan_id || data.confirmation_id || ''),
                    kind: 'plan',
                    tool: 'plan',
                    description: String(data.summary || ''),
                    steps: steps
                };
                state.streamState = 'waiting_user_input';
                ensureAssistant(state).status = 'waiting_user_input';
                freezeActivity(state);
            }
            return state;
        }

        if(type === 'step_start'){
            upsertStepPart(state, ensureAssistant(state), data, 'start');
            return state;
        }
        if(type === 'step_result'){
            upsertStepPart(state, ensureAssistant(state), data, 'result');
            return state;
        }

        if(type === 'tool_event'){
            appendPart(state, ensureAssistant(state), toolEventPart(data));
            return state;
        }

        if(type === 'thinking'){
            var thinkingText = String(data.text === undefined || data.text === null ? '' : data.text);
            if(thinkingText.trim()){
                appendPart(state, ensureAssistant(state), {
                    type: 'thinking',
                    text: thinkingText,
                    totalDurationMs: Number(data.duration_ms || data.totalDurationMs) || 0
                });
            }
            return state;
        }

        if(type === 'message'){
            var text = String(data.text === undefined || data.text === null ? '' : data.text);
            if(text.trim()){
                var message = ensureAssistant(state);
                if(String(data.kind || '') === 'thinking'){
                    appendPart(state, message, { type: 'thinking', text: text, totalDurationMs: Number(data.duration_ms) || 0 });
                } else {
                    appendPart(state, message, { type: 'text', text: text });
                }
            }
            return state;
        }

        if(type === 'usage'){
            var usage = usageOf(data);
            if(usage){
                var usageMessage = ensureAssistant(state);
                usageMessage.usage = usage;
                appendPart(state, usageMessage, { type: 'usage', usage: usage });
            }
            return state;
        }

        if(type === 'context_usage'){
            var source = isObject(data.context_usage) ? data.context_usage : data;
            var contextUsage = {};
            if(typeof source.used_tokens === 'number') contextUsage.used_tokens = source.used_tokens;
            if(typeof source.max_tokens === 'number') contextUsage.max_tokens = source.max_tokens;
            if(typeof source.percentage === 'number') contextUsage.percentage = source.percentage;
            if(isObject(source.breakdown)) contextUsage.breakdown = copyObject(source.breakdown);
            if(Object.keys(contextUsage).length) state.contextUsage = contextUsage;
            return state;
        }

        if(type === 'context_nodes'){
            var nodeIds = data.node_ids instanceof Array ? data.node_ids : (data.ids instanceof Array ? data.ids : null);
            if(nodeIds){
                state.contextNodeIds = nodeIds.map(function(id){ return String(id); });
                appendPart(state, ensureAssistant(state), {
                    type: 'context_nodes',
                    nodeIds: state.contextNodeIds,
                    nodeCount: state.contextNodeIds.length
                });
            }
            return state;
        }

        if(type === 'confirmation_required' || type === 'confirm_required'){
            var confirmation = copyObject(data);
            if(!confirmation.id) confirmation.id = String(data.confirmation_id || data.tool || '');
            state.pendingConfirmation = confirmation;
            state.streamState = 'waiting_user_input';
            ensureAssistant(state).status = 'waiting_user_input';
            freezeActivity(state);
            return state;
        }

        if(type === 'user_steer'){
            var steerText = String(data.text || data.message || '');
            if(steerText.trim()){
                appendPart(state, ensureAssistant(state), { type: 'user_steer', text: steerText, status: String(data.status || '') });
            }
            return state;
        }

        if(type === 'done'){
            var finalMessage = ensureAssistant(state);
            var doneStatus = normalizeDoneStatus(data);
            state.streamState = doneStatus;
            finalMessage.status = doneStatus;
            if(data.message){
                var doneText = String(data.message);
                if(doneText.trim()) appendPart(state, finalMessage, { type: 'text', text: doneText });
            }
            finalMessage.activeWorkMs = settleActivity(state);
            appendPart(state, finalMessage, { type: 'run_outcome', status: doneStatus, activeWorkMs: finalMessage.activeWorkMs, steps: Number(data.steps_executed) || 0 });
            state.streamingMessageId = null;
            state.pendingConfirmation = null;
            state.pendingQuestion = null;
            return state;
        }

        if(type === 'error'){
            var errorMessage = ensureAssistant(state);
            state.streamState = 'failed';
            errorMessage.status = 'failed';
            appendPart(state, errorMessage, {
                type: 'agent_error',
                message: String(data.message || data.error || '未知错误'),
                code: data.code ? String(data.code) : ''
            });
            errorMessage.activeWorkMs = settleActivity(state);
            appendPart(state, errorMessage, { type: 'run_outcome', status: 'failed', activeWorkMs: errorMessage.activeWorkMs, steps: 0 });
            state.streamingMessageId = null;
            state.pendingConfirmation = null;
            state.pendingQuestion = null;
            return state;
        }

        /* 未知事件（后端新增类型 / 心跳之类的杂项）一律忽略，不能因为它打断正常渲染 */
        return state;
    }

    window.NovaiAgentSession = {
        VERSION: 1,
        TERMINAL_STATUSES: TERMINAL_STATUSES,
        WAITING_STATUSES: WAITING_STATUSES,
        create: create,
        isWaiting: isWaiting,
        isTerminal: isTerminal,
        applyEvent: applyEvent,
        mergeThinking: mergeThinking,
        workMs: workMs,
        setBaseline: setBaseline,
        pushUserMessage: pushUserMessage,
        pushAssistantMessage: pushAssistantMessage
    };
})();
