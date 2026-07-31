export class RuntimeMetrics {
    constructor(options = {}) {
        this.startedAt = Date.now();
        this.maxRecentErrors = options.maxRecentErrors || 10;
        this.counters = {
            messagesReceived: 0,
            messagesCompleted: 0,
            messagesFailed: 0,
            generationsStarted: 0,
            generationsSucceeded: 0,
            generationsFailed: 0,
            sendsSucceeded: 0,
            sendsFailed: 0,
        };
        this.timings = {
            generationTotalMs: 0,
            sendTotalMs: 0,
        };
        this.tokens = { input: 0, output: 0, estimated: 0 };
        this.recentErrors = [];
    }

    increment(name, amount = 1) {
        if (Object.hasOwn(this.counters, name)) this.counters[name] += amount;
    }

    timing(name, durationMs) {
        const value = Math.max(0, Number(durationMs) || 0);
        if (name === 'generation') this.timings.generationTotalMs += value;
        if (name === 'send') this.timings.sendTotalMs += value;
    }

    usage({ input = 0, output = 0, estimated = false } = {}) {
        this.tokens.input += Math.max(0, Number(input) || 0);
        this.tokens.output += Math.max(0, Number(output) || 0);
        if (estimated) this.tokens.estimated += 1;
    }

    error(type, diagnosticId = '') {
        this.recentErrors.unshift({
            at: new Date().toISOString(),
            type: String(type || 'unknown').slice(0, 40),
            diagnosticId: String(diagnosticId || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 24),
        });
        this.recentErrors.length = Math.min(this.recentErrors.length, this.maxRecentErrors);
    }

    snapshot(runtime = {}) {
        const generationCount = this.counters.generationsSucceeded + this.counters.generationsFailed;
        const sendCount = this.counters.sendsSucceeded + this.counters.sendsFailed;
        const messageCount = this.counters.messagesCompleted + this.counters.messagesFailed;
        return {
            uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
            ...this.counters,
            messageSuccessRate: ratio(this.counters.messagesCompleted, messageCount),
            generationSuccessRate: ratio(this.counters.generationsSucceeded, generationCount),
            sendSuccessRate: ratio(this.counters.sendsSucceeded, sendCount),
            averageGenerationMs: average(this.timings.generationTotalMs, generationCount),
            averageSendMs: average(this.timings.sendTotalMs, sendCount),
            tokenUsage: { ...this.tokens },
            recentErrors: this.recentErrors.map(item => ({ ...item })),
            queueDepth: Math.max(0, Number(runtime.queueDepth) || 0),
            activeGenerations: Math.max(0, Number(runtime.activeGenerations) || 0),
            pendingSync: Math.max(0, Number(runtime.pendingSync) || 0),
        };
    }
}

function average(total, count) {
    return count > 0 ? Math.round(total / count) : 0;
}

function ratio(success, total) {
    return total > 0 ? Number((success / total).toFixed(4)) : null;
}
