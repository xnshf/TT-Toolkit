import { ToolkitError } from '../../kernel/errors.js';
import { readEntryImageBinding, readEntryImageBindingSafe, writeEntryImageBinding } from './schema.js';

// imageBindingMethods: 由 runtime.js 挂到 WorldInfoImagesRuntime 原型。
// 图片绑定属于条目草稿的一部分：写入草稿后由既有自动保存链路落盘，
// 不在这里直接写世界书，避免绕过整本快照比对。
export const imageBindingMethods = {
    async refreshCurrentImagePreview(preloadedDataUrl = null) {
        const token = ++this.previewToken;
        const draft = this.state.currentDraft;
        if (!draft) {
            this.state.currentImagePreviewUrl = null;
            this.state.currentImageError = '';
            return;
        }
        const { binding, invalid } = readEntryImageBindingSafe(draft);
        if (invalid) {
            this.state.currentImagePreviewUrl = null;
            this.state.currentImageError = '条目图片绑定结构异常，请重新上传或清除图片。';
            this.notify();
            return;
        }
        if (!binding) {
            this.state.currentImagePreviewUrl = null;
            this.state.currentImageError = '';
            this.notify();
            return;
        }
        if (preloadedDataUrl) {
            this.state.currentImagePreviewUrl = preloadedDataUrl;
            this.state.currentImageError = '';
            this.notify();
            return;
        }
        try {
            const dataUrl = await this.images.loadImageDataUrl(binding);
            if (token !== this.previewToken)
                return;
            this.state.currentImagePreviewUrl = dataUrl;
            this.state.currentImageError = '';
        }
        catch {
            if (token !== this.previewToken)
                return;
            this.state.currentImagePreviewUrl = null;
            this.state.currentImageError = '本地图片资源缺失或不可读，请重新上传或移除图片绑定。';
        }
        this.notify();
    },
    // 上传失败只影响图片：草稿正文与已有绑定保持原样。
    async bindEntryImage(load) {
        if (!this.state.currentDraft)
            throw new ToolkitError('WORLD_INFO_ENTRY_MISSING', '请先选择条目。');
        if (this.state.imageBusy)
            throw new ToolkitError('WORLD_INFO_IMAGE_BUSY', '已有图片正在处理，请稍候。');
        const world = this.state.selectedWorld;
        const uid = this.state.selectedUid;
        this.state.imageBusy = true;
        this.notify();
        try {
            const prepared = await load();
            if (world !== this.state.selectedWorld || uid !== this.state.selectedUid)
                throw new ToolkitError('WORLD_INFO_IMAGE_TARGET_CHANGED', '图片处理期间条目已切换，未绑定图片，请重新选择。');
            const previous = readEntryImageBindingSafe(this.state.currentDraft).binding;
            if (previous?.description !== undefined)
                prepared.binding.description = previous.description;
            const nextDraft = writeEntryImageBinding(this.state.currentDraft, prepared.binding);
            this.updateDraftField('extensions', nextDraft.extensions);
            await this.refreshCurrentImagePreview(prepared.dataUrl);
            return prepared.binding;
        }
        finally {
            this.state.imageBusy = false;
            this.notify();
        }
    },
    bindEntryImageFromFile(blob) {
        return this.bindEntryImage(() => this.images.saveImageBlob(blob));
    },
    bindEntryImageFromUrl(rawUrl, fetchImpl) {
        return this.bindEntryImage(() => this.images.importImageFromUrl(rawUrl, fetchImpl));
    },
    setImageDescription(description) {
        const binding = readEntryImageBinding(this.state.currentDraft);
        if (!binding)
            throw new ToolkitError('WORLD_INFO_IMAGE_MISSING', '请先绑定图片。');
        const next = writeEntryImageBinding(this.state.currentDraft, { ...binding, description });
        this.updateDraftField('extensions', next.extensions);
    },
    removeEntryImage() {
        if (!this.state.currentDraft)
            return;
        const nextDraft = writeEntryImageBinding(this.state.currentDraft, null);
        this.updateDraftField('extensions', nextDraft.extensions);
        void this.refreshCurrentImagePreview();
    }
};
