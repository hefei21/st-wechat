/**
 * index.js - ST WeChat Bot 服务端插件入口
 *
 * 启动流程：
 * 1. 加载 ST 配置
 * 2. 将 ui-extension/ 部署到 public/scripts/extensions/third-party/st-wechat/
 * 3. 注册 /status /qrcode 接口
 * 4. 启动 iLink Bot
 *
 * 部署：将 st-wechat/ 放入 plugins/，重启酒馆。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from './config.js';
import { ILinkBot } from './ilink.js';
import { SessionManager } from './session.js';
import { OwnerStore } from './owner-store.js';
import { getCharList, testLLMConnection } from './adapter.js';
import { createLogger } from './logger.js';
import { publicOperationError } from './errors.js';
import { RuntimeMetrics } from './metrics.js';
import { buildDiagnostics, buildHealth } from './diagnostics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(__dirname, '..');
const UI_SOURCE_DIR = path.join(PLUGIN_DIR, 'ui-extension');

let bot = null;
let sessionManager = null;
let ownerStore = null;
let metrics = null;
const logger = createLogger('HTTP');

async function init(router) {
    console.log('╔══════════════════════════════════════╗');
    console.log('║    🍷  ST WeChat Bot                 ║');
    console.log('║    酒馆角色卡 → 微信对话             ║');
    console.log('╚══════════════════════════════════════╝\n');

    // 部署 UI 扩展到酒馆 public 目录
    deployUIExtension();

    router.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Referrer-Policy', 'no-referrer');
        res.set('X-Frame-Options', 'SAMEORIGIN');
        next();
    });

    const cfg = load();
    metrics = new RuntimeMetrics();
    console.log(`[Bot] LLM 配置: ${cfg.llm.model || 'unknown'} @ ${cfg.llm.endpoint || 'unknown'}`);
    console.log(`[Bot] API 来源: ${cfg.settings?.chat_completion_sources?.find(s => s.active)?.name || cfg.settings?.chat_completion_sources?.[0]?.name || 'unknown'}`);
    if (cfg.llm.apiKey) {
        console.log('[Bot] API 密钥: 已加载');
    } else {
        console.warn('[Bot] ⚠️  未检测到 API 密钥，请在酒馆中配置 LLM API');
    }

    const chars = getCharList();
    console.log(`[Bot] 📚 ${chars.length} 个角色: ${chars.slice(0, 10).join(', ')}${chars.length > 10 ? '...' : ''}`);

    // 本地二维码生成库（供独立页面使用，避免外部 CDN 失败）
    router.get('/qrcode.min.js', (req, res) => {
        const libPath = path.join(UI_SOURCE_DIR, 'qrcode.min.js');
        if (!fs.existsSync(libPath)) {
            return res.status(503).send('qrcode.min.js 未找到，请确认 ui-extension 目录完整');
        }
        res.set('Content-Type', 'application/javascript');
        res.set('Cache-Control', 'public, max-age=86400');
        res.sendFile(libPath);
    });

    // 状态 + 浏览器页面
    router.get('/status', (req, res) => {
        const currentCfg = load();
        const rawState = bot ? bot.getLoginState() : { state: 'stopped', running: false, loggedIn: false };
        const qrCodeData = bot?.qrCodeData || '';
        const state = { ...rawState, qrCodeData };
        const chars = getCharList();
        const accept = req.headers.accept || '';

        if (accept.includes('text/html')) {
            res.set('Content-Type', 'text/html; charset=utf-8');
            res.send(qrCodePage(state, chars));
            return;
        }

        res.json({
            ...rawState,
            qrcodeData: qrCodeData,
            characters: chars,
            llm: currentCfg.llm.model || 'unknown',
            provider: currentCfg.llm.provider || 'unknown',
            ownerClaimed: ownerStore?.isClaimed() || false,
            claimCode: ownerStore?.isClaimed() ? null : ownerStore?.getClaimCode(),
            metrics: metrics?.snapshot(sessionManager?.getRuntimeSnapshot()),
        });
    });

    router.get('/health', (req, res) => {
        const state = bot?.getLoginState() || {};
        const health = buildHealth(state, metrics?.snapshot().uptimeSeconds);
        res.status(health.status).json(health.body);
    });

    router.get('/diagnostics', (req, res) => {
        const currentCfg = load();
        const state = bot?.getLoginState() || {};
        res.json(buildDiagnostics({
            state,
            llm: currentCfg.llm,
            ownerClaimed: ownerStore?.isClaimed(),
            metrics: metrics?.snapshot(sessionManager?.getRuntimeSnapshot()),
            version: readPluginVersion(),
        }));
    });

    // 只返回脱敏结果，不返回 endpoint 或 API key。
    router.post('/test-llm', async (req, res) => {
        const result = await testLLMConnection();
        res.status(result.ok ? 200 : 503).json(result);
    });

    router.post('/ilink/retry', (req, res) => {
        const state = bot?.getLoginState() || {};
        const woken = bot?.retryNow() || false;
        res.json({
            ok: true,
            woken,
            connectionState: state.connectionState || 'offline',
        });
    });

    ownerStore = new OwnerStore(path.join(cfg.dataRoot, 'st-wechat', 'owner.json'));
    sessionManager = new SessionManager({ config: cfg, ownerStore, metrics });

    router.post('/browser-state', async (req, res) => {
        try {
            res.json({ ok: true, ...await sessionManager.reportBrowserState(req.body || {}) });
        } catch (error) {
            sendRouteError(res, error);
        }
    });

    router.get('/browser-sync', async (req, res) => {
        try {
            res.json({ ok: true, ...await sessionManager.getBrowserSyncState(req.query || {}) });
        } catch (error) {
            sendRouteError(res, error);
        }
    });

    router.post('/browser-sync/ack', (req, res) => {
        try {
            res.json({ ok: true, ...sessionManager.acknowledgeWechatBrowserUpdates(req.body || {}) });
        } catch (error) {
            sendRouteError(res, error);
        }
    });

    router.post('/owner/reset', (req, res) => {
        if (req.body?.confirm !== 'RESET') {
            return res.status(400).json({ ok: false, error: 'confirmation_required' });
        }
        const claimCode = ownerStore.reset();
        sessionManager.resetOwnerRuntime();
        res.json({ ok: true, claimCode });
    });

    bot = new ILinkBot({
        credentialsFile: path.join(cfg.dataRoot, 'st-wechat', '.wechat_creds.json'),
        runtimeStateFile: path.join(cfg.dataRoot, 'st-wechat', 'ilink-events.json'),
        metrics,
    });
    sessionManager.setNotifier((userId, text) => bot.sendProactive(userId, text));
    sessionManager.setRuntimeStatusProvider(
        (userId, excludeOperationId) => bot.getOperationStatus(userId, excludeOperationId)
    );
    bot.start(async (userId, text, _contextToken, metadata) =>
        sessionManager.handle(userId, text, metadata)
    );

    console.log('[Bot] ✅ 插件已就绪');
    console.log('[Bot] 🌐 扩展面板: 点击左侧「扩展」→「ST WeChat Bot"');
    console.log('[Bot] 🌐 独立页面: /api/plugins/st-wechat/status\n');
}

/**
 * 将 UI 扩展文件复制到酒馆公共目录
 */
function deployUIExtension() {
    try {
        const targetDir = path.resolve(PLUGIN_DIR, '..', '..', 'public', 'scripts', 'extensions', 'third-party', 'st-wechat');
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }
        if (!fs.existsSync(UI_SOURCE_DIR)) {
            console.warn('[Bot] ⚠️ 未找到 ui-extension 目录');
            return;
        }
        copyDir(UI_SOURCE_DIR, targetDir);
        console.log(`[Bot] 🎨 UI 扩展已部署: ${targetDir}`);
    } catch (err) {
        console.warn('[Bot] ⚠️ UI 扩展部署失败:', err.message);
    }
}

function copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) { copyDir(srcPath, destPath); }
        else { fs.copyFileSync(srcPath, destPath); }
    }
}

async function exit() {
    console.log('[Bot] 正在关闭...');
    if (bot) await bot.stop();
    sessionManager?.close();
    sessionManager = null;
    metrics = null;
    console.log('[Bot] 👋 已退出');
}

const info = {
    id: 'st-wechat',
    name: 'ST WeChat Bot',
    description: '微信 iLink / ClawBot 接入酒馆角色卡',
};

export { init, exit, info };
export default { init, exit, info };

function readPluginVersion() {
    try {
        return JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8')).version || 'unknown';
    } catch {
        return 'unknown';
    }
}

function sendRouteError(res, error) {
    const safe = publicOperationError(error);
    logger.warn(`请求失败: diagnostic=${safe.diagnosticId}, type=${safe.type}`);
    res.status(400).json({
        ok: false,
        error: safe.message,
        errorType: safe.type,
        diagnosticId: safe.diagnosticId,
    });
}

// ========== 独立页面 HTML ==========
function qrCodePage(state, chars = []) {
    const stateText = {
        idle: '⏳ 等待中', qr_ready: '📱 等待扫码', scaned: '📲 已扫描，请确认',
        logged_in: '✅ 已登录', expired: '⏰ 二维码已过期', error: '❌ 错误', stopped: '⏹ 已停止',
    };
    let text = stateText[state.state] || '⏳ 未知';
    if (state.state === 'logged_in' && state.connectionState === 'checking') {
        text = '🔍 已载入凭证，正在检查连接';
    } else if (state.state === 'logged_in' && state.connectionState === 'degraded') {
        text = '⚠️ 已登录，但连接异常，正在重试';
    } else if (state.state === 'logged_in' && state.connectionState === 'online') {
        text = '✅ 已登录，Bot 在线';
    }
    const showQR = (state.state === 'qr_ready' || state.state === 'scaned');
    const qrCode = escapeHtmlAttribute(state.qrCodeData || '');
    const qrScript = showQR ? `
        <script src="qrcode.min.js"></script>
        <script>
            (function() {
                const el = document.getElementById('qrcode-img');
                if (!el || !el.dataset.code) { el.innerHTML = '<div class="placeholder">等待二维码数据</div>'; return; }
                if (typeof QRCode === 'undefined') { el.innerHTML = '<div class="placeholder">QRCode 库未加载</div>'; return; }
                try {
                    el.innerHTML = '';
                    new QRCode(el, { text: el.dataset.code, width: 260, height: 260, colorDark: '#000000', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.H });
                } catch (err) {
                    el.textContent = '二维码生成失败，请刷新后重试';
                    el.className = 'qrcode-area placeholder';
                }
            })();
        </script>
    ` : '';

    return `<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>ST WeChat Bot</title><style>
body{font-family:-apple-system,"Microsoft YaHei",sans-serif;background:#1a1a2e;color:#eee;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:20px;margin:0}
.card{background:#16213e;border-radius:16px;padding:40px;max-width:420px;width:100%;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,0.4)}
h1{font-size:24px;margin-bottom:8px}.subtitle{color:#888;font-size:14px;margin-bottom:30px}
.qrcode-area{background:#fff;border-radius:12px;padding:20px;margin-bottom:20px;min-height:280px;display:flex;align-items:center;justify-content:center}
.qrcode-area img{max-width:260px;border-radius:8px}.placeholder{color:#666;font-size:14px}
.state{font-size:18px;font-weight:bold;margin-bottom:15px}.info{background:#0f3460;border-radius:8px;padding:12px 16px;margin-bottom:10px;font-size:13px;text-align:left}
.info span{color:#00d2ff}.button{display:inline-block;margin-top:16px;padding:10px 24px;background:#e94560;color:#fff;border:none;border-radius:8px;cursor:pointer;text-decoration:none;font-size:14px}
.logged-in{color:#00d2ff}.error{color:#e94560}.scanning{animation:pulse 1.5s infinite}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
</style></head><body><div class="card"><h1>🍷 ST WeChat Bot</h1><div class="subtitle">酒馆角色卡 → 微信对话</div><div class="state ${showQR && state.state === 'qr_ready' ? 'scanning' : ''}">${text}</div>
${showQR ? `<div class="qrcode-area" id="qrcode-img" data-code="${qrCode}"><div class="placeholder">二维码加载中...</div></div><p style="font-size:13px;color:#888">用微信扫一扫</p>` : state.state === 'logged_in' ? `<div style="margin:30px 0;color:#00d2ff;font-size:48px">${state.connected ? '✅' : '⚠️'}</div><p>${state.connected ? 'Bot 已在线' : 'Bot 尚未连通'}</p>` : '<div style="margin:30px 0;color:#888">等待二维码</div>'}
<div class="info">Bot状态:<span>${state.running ? '运行中' : '已停止'}</span><br>凭证:<span>${state.loggedIn ? '已载入' : '未登录'}</span><br>连接:<span>${state.connected ? '已连通' : state.connectionState === 'degraded' ? '异常重试中' : state.connectionState === 'checking' ? '检查中' : '未连接'}</span><br>角色:<span>${chars.length}</span><br>LLM:<span>${'auto'}</span></div>
<a href="javascript:location.reload()" class="button">刷新</a></div>${qrScript}</body></html>`;
}

function escapeHtmlAttribute(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
