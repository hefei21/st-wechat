import { createDiagnosticId } from './logger.js';

export function classifyOperationError(error) {
    const code = String(error?.code || error?.type || '').toLowerCase();
    const status = Number(error?.status) || 0;
    const message = String(error?.message || '');

    if (code === 'queue_overloaded') return 'queue_overloaded';
    if (code === 'cancelled' || code === 'canceled') return 'cancelled';
    if (code === 'billing' || status === 402) return 'billing';
    if (code === 'context_limit') return 'context_limit';
    if (code === 'configuration' || /API 密钥|api key/i.test(message)) return 'configuration';
    if (code === 'rate_limit' || status === 429) return 'rate_limit';
    if (code === 'auth' || status === 401 || status === 403) return 'auth';
    if (code === 'timeout' || error?.name === 'AbortError' || /超时|timeout/i.test(message)) {
        return 'timeout';
    }
    if (code === 'network' || /network|fetch failed|连接失败/i.test(message)) return 'network';
    if (code === 'protocol') return 'protocol';
    if (code === 'send_failed') return 'send_failed';
    if (status >= 500) return 'service_unavailable';
    return 'processing_failed';
}

export function publicOperationError(error, diagnosticId = '') {
    const type = classifyOperationError(error);
    const id = normalizeDiagnosticId(diagnosticId || error?.diagnosticId || createDiagnosticId());
    const advice = {
        queue_overloaded: error?.message
            || '当前消息队列已满，本条未处理，请稍后重新发送。',
        cancelled: '生成已停止，本轮没有写入聊天记录。',
        billing: '模型服务余额或额度不足，请在对应提供商后台检查账户状态。',
        context_limit: '当前对话超过模型上下文上限，请新建聊天或缩短历史后重试。',
        configuration: '模型配置不可用，请在酒馆中检查对应提供商的模型与 API 密钥。',
        rate_limit: '模型服务请求过于频繁，请稍后重试。',
        auth: '模型服务鉴权失败，请在酒馆中重新保存对应提供商的 API 密钥。',
        timeout: '模型请求超时，请稍后重试。',
        network: '模型服务暂时无法连接，请稍后重试。',
        protocol: '上游服务返回了无法识别的数据，请稍后重试。',
        send_failed: '回复发送失败，系统会保留处理状态，请发送 /status 查看。',
        service_unavailable: '模型服务暂时不可用，请稍后重试。',
        processing_failed: '消息处理失败，请稍后重试。',
    }[type];
    return {
        type,
        diagnosticId: id,
        message: `${advice}\n\n类型：${type}；诊断编号：${id}`,
    };
}

function normalizeDiagnosticId(value) {
    return String(value || '')
        .replace(/[^a-zA-Z0-9-]/g, '')
        .slice(0, 24)
        || createDiagnosticId();
}
