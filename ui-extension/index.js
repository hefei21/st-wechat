/**
 * index.js - ST WeChat Bot UI 扩展
 *
 * 在酒馆扩展面板展示二维码和登录状态。
 * 兼容 ST 1.16.0+，不依赖 hooks.activate。
 */

import { getContext } from '../../../extensions.js';
import {
    eventSource,
    event_types,
    getRequestHeaders,
    isGenerating,
} from '../../../../script.js';
import {
    createGenerationOperationId,
    finalizeGenerationLifecycle,
    isEmptyAssistantMessage,
    shouldAcquireBrowserLease,
    waitForBrowserLease,
    waitForGenerationSettled,
} from './generation-lifecycle.js';
import { mergeWechatUpdates } from './chat-merge.js';

const EXTENSION_DIR = 'third-party/st-wechat';
const API_BASE = '/api/plugins/st-wechat';

let initialized = false;
let qrcodeLibLoaded = false;
let browserStateKey = '';
let browserRevision = '';
let generationOperationId = null;
let generationLeaseTimer = null;
let generationFinishPromise = null;
let generationStartPromise = null;
let lastGenerationActivityAt = 0;
let pendingAutomaticMerge = false;
let browserSyncPromise = null;

async function init() {
    if (initialized) return;
    initialized = true;

    console.log('[ST WeChat] UI 扩展初始化开始');

    // 等待 DOM 就绪
    if (document.readyState === 'loading') {
        await new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true }));
    }

    // 加载浏览器端 QRCode 库
    try { await loadQRCodeLib(); } catch (err) { console.error('[ST WeChat] QRCode 库加载失败:', err); }

    try {
        const context = getContext();
        const html = await context.renderExtensionTemplateAsync(EXTENSION_DIR, 'settings', {});
        $('#extensions_settings2').append(html);
        console.log('[ST WeChat] 设置面板已插入 #extensions_settings2');
    } catch (err) {
        console.error('[ST WeChat] 渲染设置面板失败:', err);
        return;
    }

    document.getElementById('st_wechat_refresh')?.addEventListener('click', () => refresh());
    document.getElementById('st_wechat_test_llm')?.addEventListener('click', testLlmConnection);
    document.getElementById('st_wechat_retry_ilink')?.addEventListener('click', retryIlinkConnection);
    document.getElementById('st_wechat_copy_diagnostics')?.addEventListener('click', copyDiagnostics);
    document.getElementById('st_wechat_reset_owner')?.addEventListener('click', resetOwner);

    refresh();
    setInterval(refresh, 10000);
    setupChatSync();
}

async function postAction(path, body = {}) {
    const response = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
}

async function testLlmConnection() {
    try {
        const result = await postAction('/test-llm');
        window.toastr?.success(
            `模型连接正常：${result.provider || 'unknown'} / ${result.model || 'unknown'}`,
            'ST WeChat'
        );
    } catch (error) {
        window.toastr?.error(`模型连接失败：${error.message}`, 'ST WeChat');
    }
}

async function retryIlinkConnection() {
    try {
        const result = await postAction('/ilink/retry');
        window.toastr?.info(
            result.woken ? '已唤醒现有 iLink 轮询，将立即重试。' : '当前没有等待中的重试，轮询仍保持单实例运行。',
            'ST WeChat'
        );
        setTimeout(refresh, 500);
    } catch (error) {
        window.toastr?.error(`连接重试失败：${error.message}`, 'ST WeChat');
    }
}

async function copyDiagnostics() {
    try {
        const response = await fetch(`${API_BASE}/diagnostics`, {
            headers: { Accept: 'application/json' },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const report = JSON.stringify(await response.json(), null, 2);
        await copyText(report);
        window.toastr?.success('脱敏诊断报告已复制。', 'ST WeChat');
    } catch (error) {
        window.toastr?.error(`复制诊断报告失败：${error.message}`, 'ST WeChat');
    }
}

async function copyText(text) {
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) throw new Error('当前浏览器不允许写入剪贴板');
}

async function resetOwner() {
    if (!window.confirm('确定重置微信所有者？重置后必须使用新验证码重新认领。')) return;
    const response = await fetch(`${API_BASE}/owner/reset`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ confirm: 'RESET' }),
    });
    if (!response.ok) {
        window.toastr?.error('所有者重置失败', 'ST WeChat');
        return;
    }
    const data = await response.json();
    window.toastr?.success(`已重置，请在微信发送 /claim ${data.claimCode}`, 'ST WeChat');
    refresh();
}

function setupChatSync() {
    const subscribe = (eventName, handler) => {
        if (eventName && eventSource?.on) eventSource.on(eventName, handler);
    };
    subscribe(event_types?.CHAT_CHANGED, () => reportBrowserState('chat-changed'));
    subscribe(event_types?.CHARACTER_MESSAGE_RENDERED, () => {
        markGenerationActivity();
        reportBrowserState('file-updated');
    });
    subscribe(event_types?.USER_MESSAGE_RENDERED, () => reportBrowserState('file-updated'));
    subscribe(event_types?.STREAM_TOKEN_RECEIVED, markGenerationActivity);
    const generationReadyEvent = event_types?.GENERATION_AFTER_COMMANDS
        || event_types?.GENERATION_STARTED;
    subscribe(generationReadyEvent, (type, _options, dryRun) => {
        if (!shouldAcquireBrowserLease(type, dryRun)) return;
        // 自动续写等嵌套调用可能在同一次生命周期内再次触发生成事件，应复用已有租约，
        // 不能生成新的 operationId 后与自己持有的租约互相等待。
        if (generationOperationId) return generationStartPromise;
        if (generationLeaseTimer) clearInterval(generationLeaseTimer);
        generationOperationId = createGenerationOperationId();
        markGenerationActivity();
        const operationId = generationOperationId;
        let waitingToast = null;
        generationStartPromise = waitForBrowserLease({
            acquire: () => reportBrowserState('generation-started', operationId),
            onWaiting: () => {
                waitingToast = window.toastr?.info(
                    '微信端正在处理当前聊天，本次浏览器消息已排队等待。',
                    'ST WeChat',
                    { timeOut: 0, extendedTimeOut: 0, preventDuplicates: true }
                );
            },
        }).then(({ state, waited }) => {
            if (waitingToast) window.toastr?.clear(waitingToast);
            if (waited) {
                window.toastr?.success('微信端处理完成，正在继续发送浏览器消息。', 'ST WeChat');
            }
            generationLeaseTimer = setInterval(() => {
                if (generationOperationId === operationId) {
                    reportBrowserState('generation-renew', operationId);
                }
            }, 10000);
            return state;
        });
        // GENERATION_AFTER_COMMANDS 仍早于 user 消息写入和提示词构造。保持该 Promise
        // 未完成，直到服务端确认租约，才能真正阻止双端同时基于不同快照生成。
        return generationStartPromise;
    });
    const finish = () => {
        if (generationFinishPromise) return generationFinishPromise;
        const operationId = generationOperationId;
        if (!operationId) return;
        generationFinishPromise = finalizeGenerationLifecycle({
            // GENERATION_ENDED 早于 SillyTavern 的最终保存，且上游不会等待异步监听器。
            // 先等流式输出静默，再保存和释放租约，避免微信更新覆盖浏览器正在收尾的回答。
            waitUntilSettled: () => waitForGenerationSettled({
                isGenerating,
                getLastActivityAt: () => lastGenerationActivityAt,
            }),
            waitForLease: () => generationStartPromise,
            saveChat: () => getContext().saveChat?.(),
            reportFinished: () => {
                const latestMessage = getContext().chat?.at(-1);
                if (isEmptyAssistantMessage(latestMessage)) {
                    window.toastr?.warning(
                        '本轮只产生了思考过程，没有生成有效正文。请提高最大回复长度后重试；本轮不会与下一条微信消息合并。',
                        'ST WeChat',
                        { timeOut: 10000, extendedTimeOut: 5000 }
                    );
                }
                return reportBrowserState('generation-finished', operationId);
            },
            cleanup: () => {
                if (generationLeaseTimer) clearInterval(generationLeaseTimer);
                generationLeaseTimer = null;
                generationOperationId = null;
                generationFinishPromise = null;
                generationStartPromise = null;
            },
            applyPendingReload: () => pendingAutomaticMerge
                ? checkBrowserSync()
                : undefined,
        }).catch(error => {
            console.warn('[ST WeChat] 浏览器聊天最终保存未完成，将等待服务端租约自动失效:', error);
        });
        return generationFinishPromise;
    };
    subscribe(event_types?.GENERATION_ENDED, finish);
    subscribe(event_types?.GENERATION_STOPPED, finish);

    setInterval(() => reportBrowserState('state'), 5000);
    setInterval(checkBrowserSync, 15000);
    reportBrowserState('state');
}

function currentBrowserChat() {
    const context = getContext();
    const character = context.characters?.[context.characterId];
    const characterRef = character?.avatar || character?.name || '';
    const chatId = context.chatId || '';
    if (!characterRef || !chatId) return null;
    return { characterRef, chatId };
}

async function reportBrowserState(event, operationId = null, options = {}) {
    const current = currentBrowserChat();
    if (!current) return;
    const key = `${current.characterRef}:${current.chatId}`;
    if (event === 'state' && key === browserStateKey) return;
    try {
        const response = await fetch(`${API_BASE}/browser-state`, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ ...current, event, operationId }),
        });
        if (!response.ok) {
            if (options.required) throw new Error('无法登记浏览器生成事务');
            return null;
        }
        const data = await response.json();
        browserStateKey = key;
        browserRevision = data.revision || browserRevision;
        return data;
    } catch (error) {
        console.debug('[ST WeChat] 浏览器状态上报失败:', error.message);
        if (options.required) throw error;
        return null;
    }
}

async function checkBrowserSync() {
    if (browserSyncPromise) return browserSyncPromise;
    browserSyncPromise = checkBrowserSyncOnce();
    try {
        return await browserSyncPromise;
    } finally {
        browserSyncPromise = null;
    }
}

async function checkBrowserSyncOnce() {
    const current = currentBrowserChat();
    if (!current) return;
    try {
        const query = new URLSearchParams({ ...current, revision: browserRevision });
        const response = await fetch(`${API_BASE}/browser-sync?${query}`);
        if (!response.ok) return;
        const data = await response.json();
        if (data.revision) browserRevision = data.revision;
        if (data.sameCurrent && Array.isArray(data.updates) && data.updates.length > 0) {
            await applyWechatUpdates(current, data.updates);
        }
    } catch (error) {
        console.debug('[ST WeChat] 同步状态检查失败:', error.message);
    }
}

async function applyWechatUpdates(expectedChat, updates) {
    if (isBrowserBusy()) {
        pendingAutomaticMerge = true;
        window.toastr?.info('微信端已更新当前聊天，将在当前操作完成后自动同步。', 'ST WeChat');
        return;
    }

    pendingAutomaticMerge = false;
    const current = currentBrowserChat();
    if (!current
        || current.characterRef !== expectedChat.characterRef
        || current.chatId !== expectedChat.chatId) return;
    try {
        const context = getContext();
        const result = await mergeWechatUpdates(context, updates);
        if (result.added > 0) {
            await context.saveChat?.();
        }
        await acknowledgeWechatUpdates(current, result.updateIds);
        browserStateKey = '';
        await reportBrowserState('state');
        if (result.added > 0) {
            window.toastr?.success(`已自动合并微信端更新（新增 ${result.added} 条）。`, 'ST WeChat');
        }
    } catch (error) {
        pendingAutomaticMerge = true;
        window.toastr?.warning('自动同步暂未完成，将稍后重试。', 'ST WeChat');
        console.debug('[ST WeChat] 自动合并微信端更新失败:', error.message);
    }
}

async function acknowledgeWechatUpdates(current, updateIds) {
    if (!Array.isArray(updateIds) || updateIds.length === 0) return;
    const response = await fetch(`${API_BASE}/browser-sync/ack`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ ...current, updateIds }),
    });
    if (!response.ok) throw new Error('微信增量确认失败');
}

function isEditingMessage() {
    return Boolean(document.querySelector('#curEditTextarea, .reasoning_edit_textarea'));
}

function markGenerationActivity() {
    lastGenerationActivityAt = Date.now();
}

function isBrowserBusy() {
    const recentlyStreaming = lastGenerationActivityAt > 0
        && Date.now() - lastGenerationActivityAt < 1000;
    return Boolean(
        generationOperationId
        || generationFinishPromise
        || isGenerating?.()
        || document.body?.dataset?.generating === 'true'
        || recentlyStreaming
        || isEditingMessage()
    );
}

// 兼容旧版 hooks 和新版自动加载
export async function onActivate() {
    await init();
}

// 立即启动（如果 hooks 不可用）
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init(), { once: true });
} else {
    init().catch(err => console.error('[ST WeChat] 初始化失败:', err));
}

function loadQRCodeLib() {
    return new Promise((resolve, reject) => {
        if (window.QRCode || qrcodeLibLoaded) { resolve(); return; }
        // 优先加载本地库，避免 CDN 失效或被墙
        const s = document.createElement('script');
        s.src = '/scripts/extensions/third-party/st-wechat/qrcode.min.js';
        s.onload = () => { qrcodeLibLoaded = true; resolve(); };
        s.onerror = () => reject(new Error('本地 qrcode.min.js 加载失败'));
        document.head.appendChild(s);
    });
}

async function refresh() {
    const stateEl = document.getElementById('st_wechat_state');
    const qrcodeEl = document.getElementById('st_wechat_qrcode');
    const infoEl = document.getElementById('st_wechat_info');

    if (!stateEl || !qrcodeEl || !infoEl) return;

    try {
        const res = await fetch(`${API_BASE}/status`, { headers: { Accept: 'application/json' } });
        const data = await res.json();

        const stateText = {
            idle: '⏳ 等待中', qr_ready: '📱 请用微信扫码', scaned: '📲 已扫描，请确认',
            logged_in: '✅ 已登录，Bot 运行中', expired: '⏰ 二维码已过期', error: '❌ 错误', stopped: '⏹ 已停止',
        };

        let text = stateText[data.state] || `⏳ ${data.state}`;
        if (data.state === 'logged_in' && data.connectionState === 'checking') {
            text = '🔍 已载入凭证，正在检查连接';
        } else if (data.state === 'logged_in' && data.connectionState === 'degraded') {
            text = '⚠️ 已登录，但连接异常，正在重试';
        } else if (data.state === 'logged_in' && data.connectionState === 'online') {
            text = '✅ 已登录，Bot 在线';
        }
        stateEl.textContent = text;
        stateEl.className = 'st-wechat-state';
        if (data.state === 'logged_in') stateEl.classList.add('logged-in');
        if (data.state === 'error' || data.connectionState === 'degraded') stateEl.classList.add('error');
        if (data.state === 'qr_ready') stateEl.classList.add('scanning');

        if ((data.state === 'qr_ready' || data.state === 'scaned') && data.qrcodeData) {
            try {
                qrcodeEl.innerHTML = '';
                new QRCode(qrcodeEl, {
                    text: data.qrcodeData,
                    width: 240,
                    height: 240,
                    colorDark: '#000000',
                    colorLight: '#ffffff',
                    correctLevel: QRCode.CorrectLevel.H,
                });
            } catch (err) {
                qrcodeEl.innerHTML = '<div class="placeholder">🖼 二维码生成失败<br>'
                    + '<span style="font-size:11px">请刷新页面重试，不显示原始登录数据。</span></div>';
            }
        } else if (data.state === 'logged_in') {
            qrcodeEl.innerHTML = '<div class="placeholder">✅ 已登录，无需扫码</div>';
        } else {
            qrcodeEl.innerHTML = '<div class="placeholder">等待二维码...</div>';
        }

        infoEl.innerHTML = `
            <p>Bot 状态: <code>${data.running ? '运行中' : '已停止'}</code></p>
            <p>凭证已载入: <code>${data.loggedIn ? '是' : '否'}</code></p>
            <p>iLink 连接: <code>${data.connected ? '已连通' : data.connectionState === 'degraded' ? '异常重试中' : data.connectionState === 'checking' ? '检查中' : '未连接'}</code></p>
            <p>角色数量: <code>${data.characters?.length || 0}</code></p>
            <p>LLM: <code>${escapeHtml(data.llm || 'unknown')}</code></p>
            <p>Provider: <code>${escapeHtml(data.provider || 'unknown')}</code></p>
            <p>队列 / 生成中 / 待同步: <code>${data.metrics?.queueDepth || 0} / ${data.metrics?.activeGenerations || 0} / ${data.metrics?.pendingSync || 0}</code></p>
            <p>消息完成 / 失败: <code>${data.metrics?.messagesCompleted || 0} / ${data.metrics?.messagesFailed || 0}</code></p>
            <p>消息成功率: <code>${formatRate(data.metrics?.messageSuccessRate)}</code></p>
            <p>平均生成耗时: <code>${formatDuration(data.metrics?.averageGenerationMs)}</code></p>
            <p>Token: <code>${formatTokenUsage(data.metrics?.tokenUsage)}</code></p>
            ${data.metrics?.recentErrors?.length
                ? `<p>最近错误: <code>${escapeHtml(data.metrics.recentErrors[0].type)}</code> (${escapeHtml(data.metrics.recentErrors[0].diagnosticId || '无诊断号')})</p>`
                : ''}
            ${!data.ownerClaimed && data.claimCode
                ? `<p>所有者认领码: <code>${escapeHtml(data.claimCode)}</code><br>`
                    + `<small>在微信发送 /claim ${escapeHtml(data.claimCode)}</small></p>`
                : '<p>所有者: <code>已认领</code></p>'}
            ${data.retryCount > 0 ? `<p>重试次数: <code>${data.retryCount}</code></p>` : ''}
        `;
    } catch (err) {
        stateEl.textContent = '❌ 无法连接到服务端插件';
        stateEl.className = 'st-wechat-state error';
        qrcodeEl.innerHTML = '<div class="placeholder">请确认 plugins/st-wechat 已启用并重启酒馆</div>';
        infoEl.textContent = '状态获取失败，请稍后重试。';
    }
}

function formatDuration(value) {
    const milliseconds = Math.max(0, Number(value) || 0);
    return milliseconds ? `${(milliseconds / 1000).toFixed(1)} 秒` : '暂无';
}

function formatRate(value) {
    return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '暂无';
}

function formatTokenUsage(usage) {
    if (!usage) return '暂无';
    const suffix = usage.estimated ? `（含 ${usage.estimated} 次估算）` : '';
    return `${usage.input || 0} 入 / ${usage.output || 0} 出${suffix}`;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
