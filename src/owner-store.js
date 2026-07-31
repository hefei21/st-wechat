import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class OwnerStore {
    constructor(filePath, options = {}) {
        this.filePath = path.resolve(filePath);
        this.randomInt = options.randomInt || crypto.randomInt;
        this.claimCode = null;
        this.state = this.read();
    }

    read() {
        if (!fs.existsSync(this.filePath)) return { version: 1, salt: null, ownerHash: null };
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            if (parsed?.version !== 1) throw new Error('不支持的所有者状态版本');
            return {
                version: 1,
                salt: typeof parsed.salt === 'string' ? parsed.salt : null,
                ownerHash: typeof parsed.ownerHash === 'string' ? parsed.ownerHash : null,
            };
        } catch (error) {
            const backup = `${this.filePath}.invalid-${Date.now()}`;
            try { fs.renameSync(this.filePath, backup); } catch {}
            console.warn(`[Owner] 所有者状态损坏，已隔离: ${error.message}`);
            return { version: 1, salt: null, ownerHash: null };
        }
    }

    isClaimed() {
        return !!this.state.salt && !!this.state.ownerHash;
    }

    getClaimCode() {
        if (this.isClaimed()) return null;
        if (!this.claimCode) {
            this.claimCode = String(this.randomInt(0, 1000000)).padStart(6, '0');
        }
        return this.claimCode;
    }

    isOwner(userId) {
        if (!this.isClaimed()) return false;
        return safeEqual(this.state.ownerHash, hashUser(this.state.salt, userId));
    }

    claim(userId, code) {
        if (this.isClaimed()) return this.isOwner(userId);
        if (!code || code !== this.getClaimCode()) return false;
        const salt = crypto.randomBytes(32).toString('hex');
        this.state = {
            version: 1,
            salt,
            ownerHash: hashUser(salt, userId),
        };
        this.claimCode = null;
        this.flush();
        return true;
    }

    reset() {
        this.state = { version: 1, salt: null, ownerHash: null };
        this.claimCode = null;
        this.flush();
        return this.getClaimCode();
    }

    flush() {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
        const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, {
            encoding: 'utf8',
            mode: 0o600,
        });
        fs.renameSync(tempPath, this.filePath);
    }
}

function hashUser(salt, userId) {
    return crypto.createHash('sha256').update(`${salt}:${String(userId || '')}`).digest('hex');
}

function safeEqual(left, right) {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}
