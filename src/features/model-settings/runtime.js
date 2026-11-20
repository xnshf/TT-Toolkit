import { ToolkitError, errorKind, errorMessage } from '../../kernel/errors.js';
import { LlmCapabilityStore, probeResponseFormatCapability } from '../../kernel/llm-capabilities.js';
import { fetchOpenAiCompatibleModels } from '../../kernel/llm-models.js';
import { listDecisionModels } from '../../kernel/decision-model.js';
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
        this.fetchDecisionModelsRequest = options.fetchDecisionModels ?? (preset => listDecisionModels(preset, { fetch: options.fetch }));
        this.mutable = {
            settings: createDefaultLlmPresetSettings(),
            busy: false,
            loaded: false,
            status: '',
            error: '',
            damaged: false,
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
        if (this.state.busy)
            return;
        this.mutable.busy = true;
        this.mutable.loaded = false;
        this.mutable.status = '';
        this.mutable.error = '';
        this.notify();
        try {
            const settings = await this.store.load();
            this.logger.protectValues(settings);
            this.mutable.settings = settings;
            this.mutable.loaded = true;
            this.mutable.damaged = false;
        }
        catch (error) {
            this.mutable.damaged = error instanceof ToolkitError && ['INVALID_SCHEMA', 'UNSUPPORTED_SCHEMA'].includes(error.code);
            this.mutable.error = this.state.damaged
                ? '模型预设格式无法读取。可重新加载，或确认重置损坏的预设。'
                : '未能加载模型预设，未修改已保存的预设。请重新加载后再编辑。';
            this.log.fail('presets.load_failed', 'presets.load', error, { includeError: false });
        }
        finally {
            this.mutable.busy = false;
            this.notify();
        }
    }

    async save(settings) {
        if (!this.state.loaded || this.state.busy)
            throw new ToolkitError('PRESET_WRITE_BLOCKED', '请在模型预设加载成功且当前操作结束后再保存。');
        await this.#write(settings, { reset: false });
    }

    async reset() {
        if ((!this.state.loaded && !this.state.damaged) || this.state.busy)
            throw new ToolkitError('PRESET_WRITE_BLOCKED', '请先重新加载模型预设，再确认是否重置。');
        await this.#write(createDefaultLlmPresetSettings(), { reset: true });
    }

    async #write(settings, { reset }) {
        this.mutable.busy = true;
        this.notify();
        try {
            const parsed = parseLlmPresetSettings(settings);
            this.logger.protectValues(parsed);
            this.mutable.settings = await this.store.save(parsed);
            this.mutable.loaded = true;
            this.mutable.status = reset ? '模型预设已重置；原预设及访问密钥已清除。' : '模型预设已保存。';
            this.mutable.error = '';
            this.mutable.damaged = false;
            if (!reset)
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
            if (preset.protocol === 'systemone')
                continue;
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

    requestModels(preset) {
        const draft = structuredClone(preset);
        this.logger.protectValues(draft);
        return draft.protocol === 'systemone'
            ? this.fetchDecisionModelsRequest(draft)
            : this.fetchModelsRequest(this.host, draft);
    }

    async fetchModels(preset) {
        try {
            return await this.requestModels(preset);
        }
        catch (error) {
            this.log.fail('models.fetch_failed', 'models.fetch', error, { includeError: false });
            throw error;
        }
    }

    async testConnection(preset) {
        try {
            const models = await this.requestModels(preset);
            return { modelCount: models.length };
        }
        catch (error) {
            this.log.fail('connection.test_failed', 'connection.test', error, { includeError: false });
            throw error;
        }
    }
}
