import { errorKind, errorMessage } from '../../kernel/errors.js';
import { LlmCapabilityStore, probeResponseFormatCapability } from '../../kernel/llm-capabilities.js';
import { fetchOpenAiCompatibleModels } from '../../kernel/llm-models.js';
import { createDefaultLlmPresetSettings, LlmPresetStore, parseLlmPresetSettings } from '../../kernel/llm-presets.js';

export class ModelSettingsRuntime {
    constructor(host, logger, options = {}) {
        this.host = host;
        this.logger = logger;
        this.log = logger.scoped({ featureId: 'model-settings', source: 'model-settings' });
        this.store = new LlmPresetStore(host);
        this.capabilities = options.capabilities ?? new LlmCapabilityStore(host);
        this.probeCapabilityRequest = options.probeCapability ?? probeResponseFormatCapability;
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

    protectDraft(draft) {
        this.logger.protectValues(draft);
    }

    async load() {
        this.mutable.busy = true;
        this.notify();
        try {
            const settings = await this.store.load();
            this.logger.protectValues(settings);
            this.mutable.settings = settings;
            this.mutable.error = '';
        }
        catch (error) {
            this.mutable.error = errorMessage(error);
            this.log.fail('presets.load_failed', 'presets.load', error, { includeError: false });
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
            const parsed = parseLlmPresetSettings(settings);
            this.mutable.settings = await this.store.save(parsed);
            this.logger.protectValues(parsed);
            this.mutable.status = '模型预设已保存。';
            this.mutable.error = '';
            void this.probeMissingCapabilities(parsed).catch(() => undefined);
        }
        catch (error) {
            this.mutable.error = errorMessage(error);
            this.log.fail('presets.save_failed', 'presets.save', error, { includeError: false });
            throw error;
        }
        finally {
            this.mutable.busy = false;
            this.notify();
        }
    }

    async probeMissingCapabilities(settings) {
        for (const preset of settings.presets) {
            try {
                const known = await this.capabilities.formatFor(preset.id);
                if (known)
                    continue;
                const result = await this.probeCapabilityRequest(this.host, structuredClone(preset));
                if (result) {
                    await this.capabilities.record(preset.id, result.format);
                    this.log.info('capability.probed', { data: { presetId: preset.id, format: result.format } });
                }
            }
            catch (error) {
                this.log.warn('capability.probe_failed', {
                    data: { presetId: preset.id, ...errorKind(error) },
                });
            }
        }
    }

    async fetchModels(preset) {
        try {
            return await this.fetchModelsRequest(this.host, structuredClone(preset));
        }
        catch (error) {
            this.log.fail('models.fetch_failed', 'models.fetch', error, { includeError: false });
            throw error;
        }
    }

    async testConnection(preset) {
        try {
            const models = await this.fetchModelsRequest(this.host, structuredClone(preset));
            return { modelCount: models.length };
        }
        catch (error) {
            this.log.fail('connection.test_failed', 'connection.test', error, { includeError: false });
            throw error;
        }
    }
}
