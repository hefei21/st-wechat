import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ILinkBot, ILinkHttpError } from '../src/ilink.js';

async function withTempDir(run) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-creds-'));
    try {
        return await run(directory);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

test('credentials persist outside the plugin directory and restore after restart', async () => {
    await withTempDir(async directory => {
        const credentialsFile = path.join(directory, 'data', 'st-wechat', '.wechat_creds.json');
        const first = new ILinkBot({
            credentialsFile,
            legacyCredentialsFile: path.join(directory, 'plugin', '.wechat_creds.json'),
        });
        first.token = 'test-token';
        first.baseUrl = 'https://example.test';
        first.ilinkBotId = 'test-bot';
        first.saveCredentials();

        const restarted = new ILinkBot({
            credentialsFile,
            legacyCredentialsFile: path.join(directory, 'plugin', '.wechat_creds.json'),
        });
        restarted.apiPost = async () => ({ ret: 0 });

        assert.equal(await restarted.tryRestoreSession(), true);
        assert.equal(restarted.token, 'test-token');
        assert.equal(restarted.baseUrl, 'https://example.test');
        assert.equal(restarted.ilinkBotId, 'test-bot');
        assert.equal(restarted.loginState, 'logged_in');
    });
});

test('restore does not issue a short getupdates request that would abort normal long polling', async () => {
    await withTempDir(async directory => {
        const credentialsFile = path.join(directory, '.wechat_creds.json');
        fs.writeFileSync(credentialsFile, JSON.stringify({
            token: 'test-token',
            baseUrl: 'https://example.test',
            ilinkBotId: 'test-bot',
        }));

        const bot = new ILinkBot({ credentialsFile });
        let requests = 0;
        bot.apiPost = async () => { requests++; return { ret: 0 }; };

        assert.equal(await bot.tryRestoreSession(), true);
        assert.equal(requests, 0);
        assert.equal(bot.token, 'test-token');
        assert.equal(bot.loginState, 'logged_in');
        assert.equal(fs.existsSync(credentialsFile), true);
    });
});

test('expired credentials are removed and require a fresh login', async () => {
    await withTempDir(async directory => {
        const credentialsFile = path.join(directory, '.wechat_creds.json');
        fs.writeFileSync(credentialsFile, JSON.stringify({ token: 'expired-token' }));

        const bot = new ILinkBot({ credentialsFile });
        bot.apiPost = async () => ({ ret: -14 });

        assert.equal(await bot.tryRestoreSession(), true);
        assert.equal(await bot.poll(), false);
        assert.equal(bot.token, null);
        assert.equal(bot.loginState, 'expired');
        assert.equal(fs.existsSync(credentialsFile), false);
    });
});

test('failed credential restore clears stale in-memory authentication state', async () => {
    await withTempDir(async directory => {
        const credentialsFile = path.join(directory, '.wechat_creds.json');
        fs.writeFileSync(credentialsFile, '{broken json');
        const bot = new ILinkBot({ credentialsFile });
        bot.token = 'stale-token';
        bot.ilinkBotId = 'stale-bot';
        bot.baseUrl = 'https://stale.example';

        assert.equal(await bot.tryRestoreSession(), false);
        assert.equal(bot.token, null);
        assert.equal(bot.ilinkBotId, '');
        assert.equal(bot.baseUrl, 'https://ilinkai.weixin.qq.com');
    });
});

test('HTTP authentication failure expires the restored session', async () => {
    await withTempDir(async directory => {
        const credentialsFile = path.join(directory, '.wechat_creds.json');
        fs.writeFileSync(credentialsFile, JSON.stringify({ token: 'expired-token' }));
        const bot = new ILinkBot({ credentialsFile });
        await bot.tryRestoreSession();
        bot.apiPost = async () => {
            throw new ILinkHttpError('auth', 'iLink HTTP 401', { status: 401 });
        };

        assert.equal(await bot.poll(), false);
        assert.equal(bot.token, null);
        assert.equal(bot.loginState, 'expired');
        assert.equal(fs.existsSync(credentialsFile), false);
    });
});

test('expired QR restarts the explicit login loop without recursion', async () => {
    await withTempDir(async directory => {
        const bot = new ILinkBot({ credentialsFile: path.join(directory, '.wechat_creds.json') });
        const responses = [
            { qrcode: 'qr-1', qrcode_img_content: 'https://qr.example/1' },
            { status: 'expired' },
            { qrcode: 'qr-2', qrcode_img_content: 'https://qr.example/2' },
            {
                status: 'confirmed',
                bot_token: 'token-2',
                baseurl: 'https://example.test',
                ilink_bot_id: 'bot-2',
            },
        ];
        bot.apiGet = async () => responses.shift();
        bot.sleep = async () => {};

        await bot.login(() => {});

        assert.equal(responses.length, 0);
        assert.equal(bot.token, 'token-2');
        assert.equal(bot.loginState, 'logged_in');
    });
});

test('login logs never expose QR material or bot identifiers', async () => {
    await withTempDir(async directory => {
        const bot = new ILinkBot({ credentialsFile: path.join(directory, '.wechat_creds.json') });
        const secretQr = 'qr-secret-material';
        const secretBotId = 'bot-secret-id';
        let request = 0;
        bot.apiGet = async () => {
            request++;
            return request === 1
                ? { qrcode: secretQr, qrcode_img_content: 'https://qr.example/secret' }
                : {
                    status: 'confirmed',
                    bot_token: 'token-secret',
                    baseurl: 'https://example.test',
                    ilink_bot_id: secretBotId,
                };
        };
        bot.sleep = async () => {};
        const output = [];
        const originalLog = console.log;
        const originalDebug = console.debug;
        const previousDebug = process.env.ST_WECHAT_DEBUG;
        try {
            console.log = (...args) => output.push(args.join(' '));
            console.debug = (...args) => output.push(args.join(' '));
            process.env.ST_WECHAT_DEBUG = '1';
            await bot.login(() => {});
        } finally {
            console.log = originalLog;
            console.debug = originalDebug;
            if (previousDebug === undefined) delete process.env.ST_WECHAT_DEBUG;
            else process.env.ST_WECHAT_DEBUG = previousDebug;
        }
        const joined = output.join('\n');
        assert.doesNotMatch(joined, new RegExp(secretQr));
        assert.doesNotMatch(joined, new RegExp(secretBotId));
        assert.doesNotMatch(joined, /token-secret/);
    });
});
