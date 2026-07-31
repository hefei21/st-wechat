/**
 * 将微信端产生的精确增量合并进 SillyTavern 当前内存聊天。
 *
 * 不从磁盘整份重载：整份重载可能用较旧的 JSONL 快照覆盖浏览器刚生成的回答。
 */
export async function mergeWechatUpdates(context, updates = []) {
    const chat = Array.isArray(context?.chat) ? context.chat : null;
    if (!chat) return { added: 0, updateIds: [] };

    let added = 0;
    const updateIds = [];
    for (const update of updates) {
        if (!update?.id || !Array.isArray(update.messages)) continue;
        updateIds.push(update.id);
        for (const [index, source] of update.messages.entries()) {
            const syncId = `${update.id}:${index}`;
            if (chat.some(message => isSameMessage(message, source, syncId))) continue;

            const raw = source?._raw && typeof source._raw === 'object' ? source._raw : {};
            const message = {
                ...raw,
                name: raw.name || source.name || (source.role === 'user' ? context.name1 || 'You' : context.name2 || ''),
                is_user: source.role === 'user',
                is_system: false,
                send_date: raw.send_date ?? Date.now(),
                mes: String(source.content ?? ''),
                extra: {
                    ...(raw.extra && typeof raw.extra === 'object' ? raw.extra : {}),
                    st_wechat_sync_id: syncId,
                },
            };
            chat.push(message);
            await context.addOneMessage?.(message);
            added += 1;
        }
    }
    return { added, updateIds };
}

function isSameMessage(message, source, syncId) {
    if (message?.extra?.st_wechat_sync_id === syncId) return true;
    const raw = source?._raw && typeof source._raw === 'object' ? source._raw : {};
    return Boolean(
        message
        && message.is_user === (source.role === 'user')
        && String(message.mes ?? '') === String(source.content ?? '')
        && String(message.name ?? '') === String(raw.name || source.name || message.name || '')
        && raw.send_date != null
        && String(message.send_date ?? '') === String(raw.send_date)
    );
}
