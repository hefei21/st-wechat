export function buildHealth(state = {}, uptimeSeconds = 0) {
    const ok = Boolean(state.running && state.connected);
    return {
        status: ok ? 200 : 503,
        body: {
            ok,
            state: state.connectionState || 'offline',
            uptimeSeconds: Math.max(0, Number(uptimeSeconds) || 0),
        },
    };
}

export function buildDiagnostics({
    state = {},
    llm = {},
    ownerClaimed = false,
    metrics = {},
    version = 'unknown',
} = {}) {
    return {
        plugin: { id: 'st-wechat', version: String(version || 'unknown') },
        bot: {
            running: Boolean(state.running),
            credentialLoaded: Boolean(state.loggedIn),
            connectionState: state.connectionState || 'offline',
            lastPollSuccessAt: state.lastPollSuccessAt || null,
            lastPollErrorType: state.lastPollErrorType || '',
            retryCount: Number(state.retryCount) || 0,
        },
        llm: {
            provider: llm.provider || 'unknown',
            model: llm.model || 'unknown',
            apiKeyConfigured: Boolean(llm.apiKey),
        },
        ownerClaimed: Boolean(ownerClaimed),
        metrics,
    };
}
