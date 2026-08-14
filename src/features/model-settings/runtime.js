import { errorMessage } from '../../kernel/errors.js';
import { fetchOpenAiCompatibleModels } from '../../kernel/llm-models.js';
import { createDefaultLlmPresetSettings, LlmPresetStore, parseLlmPresetSettings } from '../../kernel/llm-presets.js';

export class ModelSettingsRuntime {
    constructor(host, options = {}) {
        this.host = host;
        this.store = new LlmPresetStore(host);
        this.fetchModelsRequest = options.fetchModels ?? fetchOpenAiCompatibleModels;
        this.mutable = {
            settings: createDefaultLlmPresetSettings(),
            busy: false,
            status: '',
            error: '',
        };
        this.state = this.mutable;
        this.listeners = new Set();
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    notify() {
        for (const listener of this.listeners)
            listener(this.state);
    }

    async load() {
        this.mutable.busy = true;
        this.notify();
        try {
            this.mutable.settings = await this.store.load();
            this.mutable.error = '';
        }
        catch (error) {
            this.mutable.error = errorMessage(error);
        }
        finally {
            this.mutable.busy = false;
            this.notify();
        }
    }

    async save(settings) {
        this.mutable.busy = true;
        this.notify();
        try {
            this.mutable.settings = await this.store.save(parseLlmPresetSettings(settings));
            this.mutable.status = '模型预设已保存。';
            this.mutable.error = '';
        }
        catch (error) {
            this.mutable.error = errorMessage(error);
            throw error;
        }
        finally {
            this.mutable.busy = false;
            this.notify();
        }
    }

    async fetchModels(preset) {
        return this.fetchModelsRequest(this.host, structuredClone(preset));
    }

    async testConnection(preset) {
        const models = await this.fetchModels(preset);
        return { modelCount: models.length };
    }
}
