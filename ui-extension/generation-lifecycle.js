/**
 * 保持浏览器生成租约直到 SillyTavern 完成最终保存，并在服务端确认后再清理。
 * 独立为纯函数，便于在没有浏览器环境时回归验证关键时序。
 */
export function createGenerationOperationId(
    cryptoApi = globalThis.crypto,
    now = () => Date.now(),
    random = () => Math.random()
) {
    if (typeof cryptoApi?.randomUUID === 'function') {
        return cryptoApi.randomUUID();
    }

    const bytes = new Uint8Array(16);
    if (typeof cryptoApi?.getRandomValues === 'function') {
        cryptoApi.getRandomValues(bytes);
    } else {
        for (let index = 0; index < bytes.length; index++) {
            bytes[index] = Math.floor(random() * 256);
        }
    }
    const entropy = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
    return `browser-${now()}-${entropy}`;
}

/**
 * 只为会写入当前聊天的真实生成申请跨端租约。
 *
 * SillyTavern 的提示词预计算会以 dry-run 形式触发生成事件；quiet 生成也不会写入
 * 当前聊天。二者若占用租约，会让下一次真实发送被自己的残留租约错误阻塞。
 */
export function shouldAcquireBrowserLease(type, dryRun) {
    return !dryRun && type !== 'quiet';
}

export function isEmptyAssistantMessage(message) {
    return Boolean(message && !message.is_user && !String(message.mes || '').trim());
}

export async function finalizeGenerationLifecycle({
    waitUntilSettled,
    waitForLease,
    saveChat,
    reportFinished,
    cleanup,
    applyPendingReload,
}) {
    try {
        await waitUntilSettled?.();
        await waitForLease?.();
        await saveChat();
        await reportFinished();
    } finally {
        cleanup();
        await applyPendingReload?.();
    }
}

/**
 * 在 SillyTavern 写入 user 消息和构造提示词之前等待聊天事务所有权。
 *
 * SillyTavern 的 EventEmitter 会记录监听器异常后继续执行，因此不能通过 throw
 * 阻止并发生成。这里必须保持 GENERATION_STARTED 的 Promise 未完成，直到服务端
 * 确认租约，才能真正形成双端串行。
 */
export async function waitForBrowserLease({
    acquire,
    onStale,
    onWaiting,
    pollMs = 250,
    delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
}) {
    let waiting = false;
    while (true) {
        try {
            const state = await acquire();
            if (state?.lease) return { state, waited: waiting };
            if (state?.stale) {
                await onStale?.(state);
                continue;
            }
        } catch {
            // 网络瞬断与“Bot 正在生成”采用同一安全策略：保持生成暂停并继续登记。
        }
        if (!waiting) {
            waiting = true;
            onWaiting?.();
        }
        await delay(pollMs);
    }
}

/**
 * 等待 SillyTavern 的流式输出和 UI 收尾都进入静默期。
 *
 * GENERATION_ENDED 在最终聊天保存之前发出，且事件监听器不会被上游 await。
 * 因此不能收到该事件后立刻保存、释放租约或重载聊天。
 */
export async function waitForGenerationSettled({
    isGenerating,
    getLastActivityAt,
    quietMs = 1000,
    maxWaitMs = 15000,
    pollMs = 50,
    now = () => Date.now(),
    delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
}) {
    const startedAt = now();
    while (now() - startedAt < maxWaitMs) {
        const generating = Boolean(isGenerating?.());
        const lastActivityAt = Number(getLastActivityAt?.() || startedAt);
        if (!generating && now() - lastActivityAt >= quietMs) return true;
        await delay(pollMs);
    }
    return false;
}
