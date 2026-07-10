/**
 * index.js - ST WeChat Bot UI 扩展
 *
 * 在酒馆扩展面板展示二维码和登录状态。
 * 兼容 ST 1.16.0+，不依赖 hooks.activate。
 */

import { getContext } from '../../../extensions.js';

const EXTENSION_DIR = 'third-party/st-wechat';
const API_BASE = '/api/plugins/st-wechat';

let initialized = false;
let qrcodeLibLoaded = false;

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

    refresh();
    setInterval(refresh, 10000);
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

        const text = stateText[data.state] || `⏳ ${data.state}`;
        stateEl.textContent = text;
        stateEl.className = 'st-wechat-state';
        if (data.state === 'logged_in') stateEl.classList.add('logged-in');
        if (data.state === 'error') stateEl.classList.add('error');
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
                qrcodeEl.innerHTML = `<div class="placeholder">🖼 二维码生成失败<br><span style="font-size:11px">数据: ${data.qrcodeData.slice(0,40)}...</span><br><span style="font-size:11px">复制此数据到二维码生成器扫码</span></div>`;
            }
        } else if (data.state === 'logged_in') {
            qrcodeEl.innerHTML = '<div class="placeholder">✅ 已登录，无需扫码</div>';
        } else {
            qrcodeEl.innerHTML = '<div class="placeholder">等待二维码...</div>';
        }

        infoEl.innerHTML = `
            <p>Bot 状态: <code>${data.running ? '运行中' : '已停止'}</code></p>
            <p>已登录: <code>${data.loggedIn ? '是' : '否'}</code></p>
            <p>角色数量: <code>${data.characters?.length || 0}</code></p>
            <p>LLM: <code>${data.llm || 'unknown'}</code></p>
            ${data.retryCount > 0 ? `<p>重试次数: <code>${data.retryCount}</code></p>` : ''}
        `;
    } catch (err) {
        stateEl.textContent = '❌ 无法连接到服务端插件';
        stateEl.className = 'st-wechat-state error';
        qrcodeEl.innerHTML = '<div class="placeholder">请确认 plugins/st-wechat 已启用并重启酒馆</div>';
        infoEl.innerHTML = `<p style="color:#e94560">错误: ${err.message}</p>`;
    }
}
