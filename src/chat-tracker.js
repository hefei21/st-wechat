import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class ChatTracker {
    constructor(options = {}) {
        this.states = new Map();
        this.maxIncrementBytes = options.maxIncrementBytes || 1024 * 1024;
    }

    observe(filePath, checkpoint = null) {
        const resolved = path.resolve(filePath);
        const stat = fs.statSync(resolved);
        const previous = this.states.get(resolved) || stateFromCheckpoint(checkpoint);
        const revision = `${stat.size}:${stat.mtimeMs}`;

        if (!previous) {
            const fingerprint = lastMessageFingerprint(fs.readFileSync(resolved, 'utf8'));
            const state = trackerState(stat, revision, fingerprint);
            this.states.set(resolved, state);
            return trackerUpdate(state, { initialized: true });
        }
        if (previous.revision === revision) {
            previous.observedAt = Date.now();
            this.states.set(resolved, previous);
            return trackerUpdate(previous);
        }
        if (stat.size < previous.size || (stat.size === previous.size && stat.mtimeMs !== previous.mtimeMs)) {
            const fingerprint = lastMessageFingerprint(fs.readFileSync(resolved, 'utf8'));
            const state = trackerState(stat, revision, fingerprint);
            this.states.set(resolved, state);
            return trackerUpdate(state, { reset: true });
        }

        const addedLength = stat.size - previous.size;
        if (addedLength > this.maxIncrementBytes) {
            const tailStart = Math.max(0, stat.size - 65536);
            const fingerprint = lastMessageFingerprint(readRange(resolved, tailStart, stat.size - tailStart));
            const state = trackerState(stat, revision, fingerprint);
            this.states.set(resolved, state);
            return trackerUpdate(state, { reset: true, overflow: true });
        }
        const added = readRange(resolved, previous.size, addedLength);
        const addedMessages = parseAppendedMessages(added);
        const fingerprint = addedMessages.length > 0
            ? messageFingerprint(addedMessages.at(-1)._raw)
            : previous.lastMessageFingerprint;
        const state = trackerState(stat, revision, fingerprint);
        this.states.set(resolved, state);
        return trackerUpdate(state, { addedMessages });
    }

    async observeAsync(filePath, checkpoint = null) {
        const resolved = path.resolve(filePath);
        const stat = await fs.promises.stat(resolved);
        const previous = this.states.get(resolved) || stateFromCheckpoint(checkpoint);
        const revision = `${stat.size}:${stat.mtimeMs}`;

        if (!previous) {
            const content = await fs.promises.readFile(resolved, 'utf8');
            const state = trackerState(stat, revision, lastMessageFingerprint(content));
            const concurrent = this.concurrentState(resolved, previous);
            if (concurrent) return trackerUpdate(concurrent);
            this.states.set(resolved, state);
            return trackerUpdate(state, { initialized: true });
        }
        if (previous.revision === revision) {
            previous.observedAt = Date.now();
            this.states.set(resolved, previous);
            return trackerUpdate(previous);
        }
        if (stat.size < previous.size || (stat.size === previous.size && stat.mtimeMs !== previous.mtimeMs)) {
            const content = await fs.promises.readFile(resolved, 'utf8');
            const state = trackerState(stat, revision, lastMessageFingerprint(content));
            const concurrent = this.concurrentState(resolved, previous);
            if (concurrent) return trackerUpdate(concurrent);
            this.states.set(resolved, state);
            return trackerUpdate(state, { reset: true });
        }

        const addedLength = stat.size - previous.size;
        if (addedLength > this.maxIncrementBytes) {
            const tailStart = Math.max(0, stat.size - 65536);
            const content = await readRangeAsync(resolved, tailStart, stat.size - tailStart);
            const state = trackerState(stat, revision, lastMessageFingerprint(content));
            const concurrent = this.concurrentState(resolved, previous);
            if (concurrent) return trackerUpdate(concurrent);
            this.states.set(resolved, state);
            return trackerUpdate(state, { reset: true, overflow: true });
        }
        const added = await readRangeAsync(resolved, previous.size, addedLength);
        const addedMessages = parseAppendedMessages(added);
        const fingerprint = addedMessages.length > 0
            ? messageFingerprint(addedMessages.at(-1)._raw)
            : previous.lastMessageFingerprint;
        const state = trackerState(stat, revision, fingerprint);
        const concurrent = this.concurrentState(resolved, previous);
        if (concurrent) return trackerUpdate(concurrent);
        this.states.set(resolved, state);
        return trackerUpdate(state, { addedMessages });
    }

    concurrentState(resolved, previous) {
        const latest = this.states.get(resolved);
        return latest && latest !== previous ? latest : null;
    }

    forget(filePath) {
        this.states.delete(path.resolve(filePath));
    }

    pruneOlderThan(cutoff) {
        for (const [filePath, state] of this.states) {
            if ((state.observedAt || 0) < cutoff) this.states.delete(filePath);
        }
    }
}

function stateFromCheckpoint(checkpoint) {
    if (!checkpoint || typeof checkpoint.revision !== 'string') return null;
    const match = checkpoint.revision.match(/^(\d+):(\d+(?:\.\d+)?)$/);
    if (!match) return null;
    const size = Number(checkpoint.cursor ?? match[1]);
    const mtimeMs = Number(match[2]);
    if (!Number.isFinite(size) || size < 0 || !Number.isFinite(mtimeMs)) return null;
    return {
        size,
        cursor: size,
        mtimeMs,
        revision: checkpoint.revision,
        lastMessageFingerprint: String(checkpoint.lastMessageFingerprint || ''),
        observedAt: Date.now(),
    };
}

function trackerState(stat, revision, lastFingerprint = '') {
    return {
        size: stat.size,
        cursor: stat.size,
        mtimeMs: stat.mtimeMs,
        revision,
        lastMessageFingerprint: lastFingerprint,
        observedAt: Date.now(),
    };
}

function trackerUpdate(state, overrides = {}) {
    return {
        revision: state.revision,
        cursor: state.cursor,
        lastMessageFingerprint: state.lastMessageFingerprint,
        initialized: false,
        reset: false,
        addedMessages: [],
        overflow: false,
        ...overrides,
    };
}

function readRange(filePath, start, length) {
    if (length <= 0) return '';
    const fd = fs.openSync(filePath, 'r');
    try {
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, start);
        return buffer.toString('utf8');
    } finally {
        fs.closeSync(fd);
    }
}

async function readRangeAsync(filePath, start, length) {
    if (length <= 0) return '';
    const handle = await fs.promises.open(filePath, 'r');
    try {
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, start);
        return buffer.toString('utf8');
    } finally {
        await handle.close();
    }
}

function parseAppendedMessages(content) {
    const messages = [];
    for (const line of String(content || '').split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
            const object = JSON.parse(line);
            if (object.is_system || typeof object.mes !== 'string' || object.mes.length === 0) continue;
            messages.push({
                role: object.is_user ? 'user' : 'assistant',
                content: object.mes,
                _raw: object,
            });
        } catch {
            // 部分行或未知行等待完整重读兜底。
        }
    }
    return messages;
}

function lastMessageFingerprint(content) {
    const messages = parseAppendedMessages(content);
    return messages.length > 0 ? messageFingerprint(messages.at(-1)._raw) : '';
}

function messageFingerprint(message) {
    const identity = JSON.stringify({
        name: message?.name || '',
        is_user: !!message?.is_user,
        send_date: message?.send_date ?? null,
        mes: message?.mes || '',
        swipe_id: message?.swipe_id ?? null,
    });
    return crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24);
}
