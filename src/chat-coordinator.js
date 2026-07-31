import fs from 'node:fs';
import path from 'node:path';

export class RevisionConflictError extends Error {
    constructor() {
        super('聊天在生成期间发生变化');
        this.name = 'RevisionConflictError';
    }
}

export class ChatCoordinator {
    constructor(options = {}) {
        this.queues = new Map();
        this.leases = new Map();
        this.activeTasks = new Set();
        this.leaseTtlMs = options.leaseTtlMs || 45000;
        this.pollMs = options.pollMs || 200;
    }

    revision(filePath) {
        const stat = fs.statSync(path.resolve(filePath));
        return `${stat.size}:${stat.mtimeMs}`;
    }

    acquireLease(filePath, operationId) {
        if (typeof operationId !== 'string' || !operationId.trim()) return false;
        const key = path.resolve(filePath);
        if (this.activeTasks.has(key)) return false;
        const current = this.leases.get(key);
        if (current && current.expiresAt > Date.now() && current.operationId !== operationId) {
            return false;
        }
        this.leases.set(key, {
            operationId,
            expiresAt: Date.now() + this.leaseTtlMs,
        });
        return true;
    }

    renewLease(filePath, operationId) {
        if (typeof operationId !== 'string' || !operationId.trim()) return false;
        const key = path.resolve(filePath);
        const current = this.leases.get(key);
        if (!current || current.operationId !== operationId) return false;
        current.expiresAt = Date.now() + this.leaseTtlMs;
        return true;
    }

    releaseLease(filePath, operationId) {
        if (typeof operationId !== 'string' || !operationId.trim()) return false;
        const key = path.resolve(filePath);
        const current = this.leases.get(key);
        if (!current || current.operationId !== operationId) return false;
        this.leases.delete(key);
        return true;
    }

    isActive(filePath) {
        return this.activeTasks.has(path.resolve(filePath));
    }

    async run(filePath, task, options = {}) {
        const key = path.resolve(filePath);
        const previous = this.queues.get(key) || Promise.resolve();
        const current = previous
            .catch(() => undefined)
            .then(async () => {
                await this.waitForLease(key);
                this.activeTasks.add(key);
                try {
                    const retries = Math.max(0, options.conflictRetries ?? 1);
                    for (let attempt = 0; attempt <= retries; attempt++) {
                        const baseRevision = this.revision(key);
                        const assertUnchanged = () => {
                            if (this.revision(key) !== baseRevision) throw new RevisionConflictError();
                        };
                        const prepareWrite = async () => {
                            assertUnchanged();
                        };
                        try {
                            return await task({ baseRevision, assertUnchanged, prepareWrite, attempt });
                        } catch (error) {
                            if (!(error instanceof RevisionConflictError) || attempt === retries) throw error;
                        }
                    }
                } finally {
                    this.activeTasks.delete(key);
                }
            });
        this.queues.set(key, current);
        try {
            return await current;
        } finally {
            if (this.queues.get(key) === current) this.queues.delete(key);
        }
    }

    async waitForLease(filePath) {
        while (true) {
            const lease = this.leases.get(filePath);
            if (!lease) return;
            if (lease.expiresAt <= Date.now()) {
                this.leases.delete(filePath);
                return;
            }
            await new Promise(resolve => setTimeout(resolve, this.pollMs));
        }
    }

    pruneExpired(now = Date.now()) {
        for (const [filePath, lease] of this.leases) {
            if (lease.expiresAt <= now) this.leases.delete(filePath);
        }
    }
}
