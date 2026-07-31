const SENSITIVE_KEY = /(?:api[_-]?key|authorization|token|secret|qrcode|context_token)/i;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const LONG_SECRET = /\b(?:sk-|sess-|ilink_)[A-Za-z0-9._-]{6,}\b/gi;
const SECRET_QUERY = /([?&](?:api[_-]?key|key|token|secret)=)[^&\s]+/gi;

export function redact(value, key = '') {
    if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
    if (typeof value === 'string') {
        return value
            .replace(BEARER, 'Bearer [REDACTED]')
            .replace(LONG_SECRET, '[REDACTED]')
            .replace(SECRET_QUERY, '$1[REDACTED]');
    }
    if (Array.isArray(value)) return value.map(item => redact(item));
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([itemKey, itemValue]) => [itemKey, redact(itemValue, itemKey)])
        );
    }
    return value;
}

export function createLogger(scope) {
    const prefix = `[${scope}]`;
    return {
        debug: (...args) => {
            if (process.env.ST_WECHAT_DEBUG) console.debug(prefix, ...args.map(arg => redact(arg)));
        },
        info: (...args) => console.log(prefix, ...args.map(arg => redact(arg))),
        warn: (...args) => console.warn(prefix, ...args.map(arg => redact(arg))),
        error: (...args) => console.error(prefix, ...args.map(arg => redact(arg))),
    };
}

export function createDiagnosticId() {
    const time = Date.now().toString(36);
    const random = Math.random().toString(36).slice(2, 8);
    return `${time}-${random}`;
}

export function pseudonymizeId(value, label = 'user') {
    const digest = crypto.createHash('sha256')
        .update(`st-wechat:${String(value || '')}`)
        .digest('hex')
        .slice(0, 12);
    return `${label}#${digest}`;
}
import crypto from 'node:crypto';
