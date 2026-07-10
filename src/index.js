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
import { getCharList } from './adapter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(__dirname, '..');
const UI_SOURCE_DIR = path.join(PLUGIN_DIR, 'ui-extension');

let bot = null;

async function init(router) {
    console.log('╔══════════════════════════════════════╗');
    console.log('║    🍷  ST WeChat Bot                 ║');
    console.log('║    酒馆角色卡 → 微信对话             ║');
    console.log('╚══════════════════════════════════════╝\n');

    // 部署 UI 扩展到酒馆 public 目录
    deployUIExtension();

    const cfg = load();
    console.log(`[Bot] LLM 配置: ${cfg.llm.model || 'unknown'} @ ${cfg.llm.endpoint || 'unknown'}`);
    console.log(`[Bot] API 来源: ${cfg.settings?.chat_completion_sources?.find(s => s.active)?.name || cfg.settings?.chat_completion_sources?.[0]?.name || 'unknown'}`);
    if (cfg.llm.apiKey) {
        console.log(`[Bot] API 密钥: 已加载 (${cfg.llm.apiKey.slice(0, 6)}...)`);
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
        const rawState = bot ? bot.getLoginState() : { state: 'stopped', running: false, loggedIn: false };
        const state = { ...rawState, qrCodeData: bot?.qrCodeData || '' };
        const chars = getCharList();
        const accept = req.headers.accept || '';

        if (accept.includes('text/html')) {
            res.set('Content-Type', 'text/html; charset=utf-8');
            res.send(qrCodePage(state, chars));
            return;
        }

        res.json({ ...state, qrcodeData: bot?.qrCodeData || '', characters: chars, llm: cfg.llm.model || 'unknown' });
    });

    const sessions = new SessionManager();
    bot = new ILinkBot();
    bot.start(async (userId, text) => sessions.handle(userId, text));

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
    console.log('[Bot] 👋 已退出');
}

const info = {
    id: 'st-wechat',
    name: 'ST WeChat Bot',
    description: '微信 iLink / ClawBot 接入酒馆角色卡',
};

export { init, exit, info };
export default { init, exit, info };

// ========== 独立页面 HTML ==========
function qrCodePage(state, chars = []) {
    const stateText = {
        idle: '⏳ 等待中', qr_ready: '📱 等待扫码', scaned: '📲 已扫描，请确认',
        logged_in: '✅ 已登录', expired: '⏰ 二维码已过期', error: '❌ 错误', stopped: '⏹ 已停止',
    };
    const text = stateText[state.state] || '⏳ 未知';
    const showQR = (state.state === 'qr_ready' || state.state === 'scaned');
    const qrCode = (state.qrCodeData || '').replace(/"/g, '&quot;').replace(/'/g, '\\&#39;');
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
                    el.innerHTML = '<div class="placeholder">二维码生成失败：' + (err.message || '未知错误') + '</div>';
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
${showQR ? `<div class="qrcode-area" id="qrcode-img" data-code="${qrCode}"><div class="placeholder">二维码加载中...</div></div><p style="font-size:13px;color:#888">用微信扫一扫</p>` : state.state === 'logged_in' ? '<div style="margin:30px 0;color:#00d2ff;font-size:48px">✅</div><p>Bot 已在线</p>' : '<div style="margin:30px 0;color:#888">等待二维码</div>'}
<div class="info">Bot状态:<span>${state.running ? '运行中' : '已停止'}</span><br>登录:<span>${state.loggedIn ? '已登录' : '未登录'}</span><br>角色:<span>${chars.length}</span><br>LLM:<span>${'auto'}</span></div>
<a href="javascript:location.reload()" class="button">刷新</a></div>${qrScript}</body></html>`;
}
