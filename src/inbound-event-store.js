import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = 1;

export class InboundEventStore {
    constructor(filePath = null, options = {}) {
        this.filePath = filePath ? path.resolve(filePath) : null;
        this.maxEvents = options.maxEvents || 500;
        this.state = this.read();
    }

    get cursor() {
        return this.state.cursor;
    }

    get contexts() {
        return { ...this.state.contexts };
    }

    setCursor(cursor) {
        this.state.cursor = String(cursor || '');
        this.flush();
    }

    setContext(userId, contextToken) {
        if (!userId || !contextToken) return;
        this.state.contexts[String(userId)] = String(contextToken);
        this.flush();
    }

    enqueue(message) {
        const normalized = normalizeMessage(message);
        if (!normalized) return { event: null, inserted: false };
        const id = messageId(message, normalized);
        const existing = this.state.events.find(event => event.id === id);
        if (existing) return { event: { ...existing }, inserted: false };
        this.compact();
        if (this.state.events.length >= this.maxEvents) {
            throw new Error(`iLink 入站事件积压已达到上限 ${this.maxEvents}`);
        }

        const event = {
            id,
            diagnosticId: crypto.randomBytes(4).toString('hex'),
            status: 'pending',
            stage: 'received',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            ...normalized,
        };
        this.state.events.push(event);
        this.flush();
        return { event: { ...event }, inserted: true };
    }

    pending() {
        return this.state.events
            .filter(event => event.status === 'pending' || event.status === 'processing')
            .map(event => ({ ...event }));
    }

    get(id) {
        const event = this.state.events.find(candidate => candidate.id === id);
        return event ? { ...event } : null;
    }

    setOutbound(id, outbound, outcome = {}) {
        const event = this.state.events.find(candidate => candidate.id === id);
        if (!event) return false;
        event.outbound = (Array.isArray(outbound) ? outbound : []).map(item => ({
            text: String(item.text || ''),
            clientIds: Array.isArray(item.clientIds) ? item.clientIds.map(String) : [],
        }));
        event.outcome = {
            failed: Boolean(outcome.failed),
            errorType: String(outcome.errorType || ''),
        };
        event.stage = 'ready_to_send';
        event.updatedAt = Date.now();
        this.flush();
        return true;
    }

    mark(id, status, details = {}) {
        const event = this.state.events.find(candidate => candidate.id === id);
        if (!event) return false;
        event.status = status;
        event.updatedAt = Date.now();
        if (details.stage) event.stage = String(details.stage);
        if (Number.isFinite(details.startedAt)) event.startedAt = details.startedAt;
        if (Number.isFinite(details.durationMs)) event.durationMs = details.durationMs;
        if (details.errorType) event.errorType = String(details.errorType);
        this.compact();
        this.flush();
        return true;
    }

    latestForUser(userId, excludeId = '') {
        const event = [...this.state.events].reverse().find(candidate =>
            candidate.userId === String(userId)
            && candidate.id !== String(excludeId || '')
        );
        if (!event) return null;
        return {
            diagnosticId: event.diagnosticId || '',
            status: event.status,
            stage: event.stage || event.status,
            createdAt: event.createdAt,
            updatedAt: event.updatedAt,
            durationMs: event.durationMs,
            errorType: event.errorType || '',
        };
    }

    clearSession() {
        this.state = emptyState();
        this.flush();
    }

    close() {
        this.flush();
    }

    compact() {
        if (this.state.events.length <= this.maxEvents) return;
        const completed = this.state.events.filter(event => event.status === 'completed');
        const removable = this.state.events.length - this.maxEvents;
        const removeIds = new Set(completed.slice(0, removable).map(event => event.id));
        this.state.events = this.state.events.filter(event => !removeIds.has(event.id));
    }

    read() {
        if (!this.filePath || !fs.existsSync(this.filePath)) return emptyState();
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            if (parsed?.version !== VERSION || !Array.isArray(parsed.events)) {
                throw new Error('不支持的入站事件版本');
            }
            return {
                version: VERSION,
                cursor: String(parsed.cursor || ''),
                contexts: isRecord(parsed.contexts) ? parsed.contexts : {},
                events: parsed.events.filter(isEvent).map(event => ({
                    ...event,
                    status: event.status === 'processing' ? 'pending' : event.status,
                })).slice(-this.maxEvents),
            };
        } catch (error) {
            const backup = `${this.filePath}.invalid-${Date.now()}`;
            try { fs.renameSync(this.filePath, backup); } catch {}
            console.warn(`[InboundEventStore] 入站事件箱损坏，已隔离并重建: ${error.message}`);
            return emptyState();
        }
    }

    flush() {
        if (!this.filePath) return;
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
        const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, {
            encoding: 'utf8',
            mode: 0o600,
        });
        fs.renameSync(temporary, this.filePath);
    }
}

function normalizeMessage(message) {
    const textItem = message?.item_list?.find(item => item.type === 1);
    const text = textItem?.text_item?.text;
    const userId = message?.from_user_id;
    if (!userId) return null;
    const inputKind = text ? 'text' : classifyUnsupportedInput(message?.item_list);
    if (!inputKind) return null;
    return {
        userId: String(userId),
        text: text ? String(text) : '',
        inputKind,
        contextToken: String(message.context_token || ''),
    };
}

function classifyUnsupportedInput(items) {
    if (!Array.isArray(items) || items.length === 0) return '';
    const keys = items.flatMap(item => Object.keys(item || {}));
    if (keys.some(key => /image|photo|picture/i.test(key))) return 'image';
    if (keys.some(key => /voice|audio|speech/i.test(key))) return 'voice';
    if (keys.some(key => /video/i.test(key))) return 'video';
    if (keys.some(key => /file|attachment/i.test(key))) return 'file';
    return 'non_text';
}

function messageId(message, normalized) {
    const protocolId = message.message_id || message.msg_id || message.client_id || message.seq;
    if (protocolId !== undefined && protocolId !== null && protocolId !== '') {
        return `ilink-${String(protocolId)}`;
    }
    return `ilink-${crypto.createHash('sha256')
        .update(JSON.stringify([
            normalized.userId,
            normalized.contextToken,
            normalized.text,
            normalized.inputKind,
            (message.item_list || []).map(item => item?.type ?? ''),
            message.create_time ?? message.timestamp ?? '',
        ]))
        .digest('hex')}`;
}

function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isEvent(event) {
    return typeof event?.id === 'string'
        && typeof event?.userId === 'string'
        && typeof event?.text === 'string'
        && ['pending', 'processing', 'completed'].includes(event.status);
}

function emptyState() {
    return { version: VERSION, cursor: '', contexts: {}, events: [] };
}
