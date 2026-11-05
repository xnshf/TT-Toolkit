import { WorldInfoEditorRuntime } from '../world-info-editor/runtime.js';
import { WorldInfoImageRuntime } from './images.js';
import { imageBindingMethods } from './image-binding.js';

// 复用世界书的 fresh 快照/最小字段写回，不启用世界书编辑器或改写正文。
export class WorldInfoImagesRuntime extends WorldInfoEditorRuntime {
    constructor(host, log) {
        super(host, log);
        this.images = new WorldInfoImageRuntime(host, log);
        this.previewToken = 0;
        Object.assign(this.state, {
            currentImagePreviewUrl: null, currentImageError: '', imageBusy: false,
        });
    }

    async loadSettings() {
        this.settingsLoaded = true;
        this.state.settings.convertUserMacro = false;
    }

    activate() {
        return this.images.activate();
    }

    async deactivate() {
        this.images.deactivate();
        await this.flush();
    }

    setEntry(uid) {
        this.state.currentImagePreviewUrl = null;
        this.state.currentImageError = '';
        super.setEntry(uid);
        void this.refreshCurrentImagePreview();
    }

    revertDraft() {
        super.revertDraft();
        void this.refreshCurrentImagePreview();
    }
}

Object.assign(WorldInfoImagesRuntime.prototype, imageBindingMethods);
