function documentContext(target) {
    const ownerDocument = target.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    try {
        if (ownerWindow?.top?.document)
            return { document: ownerWindow.top.document, window: ownerWindow.top };
    }
    catch {
        // TauriTavern currently uses same-origin iframes; fall back safely if that changes.
    }
    return { document: ownerDocument, window: ownerWindow ?? globalThis };
}

function pickerOptions(filename, format) {
    const markdown = format === 'markdown';
    return {
        suggestedName: filename,
        types: [{
            description: markdown ? 'Markdown 文档' : '纯文本文档',
            accept: { [markdown ? 'text/markdown' : 'text/plain']: [markdown ? '.md' : '.txt'] },
        }],
    };
}

export async function saveChatDocument(target, suggestion, preparePayload) {
    const context = documentContext(target);
    if (typeof context.window.showSaveFilePicker === 'function') {
        try {
            const handle = await context.window.showSaveFilePicker(pickerOptions(suggestion.filename, suggestion.format));
            const payload = await preparePayload();
            const writable = await handle.createWritable();
            try {
                await writable.write(payload.content);
                await writable.close();
            }
            catch (error) {
                try {
                    await writable.abort?.();
                }
                catch {
                    // Preserve the original write error.
                }
                throw error;
            }
            return { saved: true, filename: payload.filename, payload };
        }
        catch (error) {
            if (error?.name === 'AbortError')
                return { saved: false, filename: suggestion.filename, payload: null };
            throw error;
        }
    }
    const payload = await preparePayload();
    const BlobConstructor = context.window.Blob ?? Blob;
    const urlApi = context.window.URL ?? URL;
    const mime = payload.format === 'markdown' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8';
    const url = urlApi.createObjectURL(new BlobConstructor([payload.content], { type: mime }));
    const link = context.document.createElement('a');
    link.href = url;
    link.download = payload.filename;
    link.style.display = 'none';
    context.document.body.append(link);
    link.click();
    context.window.setTimeout(() => {
        link.remove();
        urlApi.revokeObjectURL(url);
    }, 1000);
    return { saved: true, filename: payload.filename, payload };
}
