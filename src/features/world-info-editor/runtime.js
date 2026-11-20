import { errorMessage, ToolkitError } from '../../kernel/errors.js';
import { sameJsonValue } from '../../kernel/snapshot.js';
import {
    convertEntryUserPlaceholders,
    createDefaultWorldInfoEditorSettings,
    createNewEntry,
    getFreeWorldEntryUid,
    isEditorEntry,
    parseWorldInfoEditorSettings,
} from './schema.js';
import { filterEntries, statsForEntries, summarizeEntries } from './entry-list.js';
import { readEntryImageBindingSafe } from '../world-info-images/schema.js';

const AUTOSAVE_DEBOUNCE_MS = 1000;
const SETTINGS_KEY = 'world-info-editor-settings-v1';

export class WorldInfoEditorRuntime {
    constructor(host, log) {
        this.host = host;
        this.log = log;
        this.listeners = new Set();
        this.autoSaveTimer = null;
        this.pending = null;
        this.revision = 0;
        this.baseline = null;
        this.settingsLoaded = false;
        this.state = {
            worldNames: [], activeBindings: [], selectedWorld: '', worldData: null,
            selectedUid: null, currentDraft: null, dirty: false, saveStatus: 'idle',
            lastSavedTime: null, lastConversionCount: 0, error: null, busy: false, searchQuery: '', filter: 'all', sort: 'order',
            settings: createDefaultWorldInfoEditorSettings(), settingsError: '',
        };
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    notify() {
        for (const listener of this.listeners)
            listener(this.state);
    }

    cancelTimer() {
        if (this.autoSaveTimer)
            clearTimeout(this.autoSaveTimer);
        this.autoSaveTimer = null;
    }

    async init() {
        if (!this.settingsLoaded)
            await this.loadSettings();
        // 返回页面时不丢弃未保存草稿，但世界书集合与聊天绑定仍要刷新。
        if (this.state.dirty || this.state.saveStatus === 'error') {
            this.state.worldNames = this.host.listWorldInfoNames();
            this.state.activeBindings = this.host.activeWorldInfoBindings();
            this.notify();
            return;
        }
        await this.refreshWorlds();
    }

    async loadSettings() {
        this.settingsLoaded = true;
        try {
            this.state.settings = parseWorldInfoEditorSettings(await this.host.globalGet(SETTINGS_KEY));
            this.state.settingsError = '';
        }
        catch (error) {
            this.state.settings = createDefaultWorldInfoEditorSettings();
            this.state.settingsError = `世界书管理设置读取失败，已回退默认值。${errorMessage(error)}`;
            this.log?.warn('settings.load_failed', {
                data: { operation: 'settings.load', kind: error instanceof ToolkitError ? error.code : 'unknown' },
            });
        }
    }

    async setConvertUserMacro(enabled) {
        const next = parseWorldInfoEditorSettings({ ...this.state.settings, convertUserMacro: Boolean(enabled) });
        try {
            await this.host.globalSet(SETTINGS_KEY, next);
            this.state.settings = next;
            this.state.settingsError = '';
            this.log?.info('settings.saved', { data: { operation: 'settings.save', convertUserMacro: next.convertUserMacro } });
        }
        catch (error) {
            this.log?.warn('settings.save_failed', {
                data: { operation: 'settings.save', kind: error instanceof ToolkitError ? error.code : 'unknown' },
            });
            throw error;
        }
        finally {
            this.notify();
        }
    }

    async resetSettings() {
        try {
            await this.host.globalDelete(SETTINGS_KEY);
        }
        catch (error) {
            this.log?.warn('settings.reset_failed', {
                data: { operation: 'settings.reset', kind: error instanceof ToolkitError ? error.code : 'unknown' },
            });
            throw error;
        }
        this.state.settings = createDefaultWorldInfoEditorSettings();
        this.state.settingsError = '';
        this.log?.warn('settings.reset');
        this.notify();
    }

    // keepDraft：只对齐磁盘事实源，不写入也未保存的草稿（“重读世界书”入口）。
    async refreshWorlds({ keepDraft = false } = {}) {
        if (keepDraft)
            await this.awaitPending();
        else
            await this.flush();
        this.state.worldNames = this.host.listWorldInfoNames();
        this.state.activeBindings = this.host.activeWorldInfoBindings();
        const bindings = this.state.activeBindings;
        const preferred = ['chat', 'character', 'persona', 'global']
            .map(source => bindings.find(binding => binding.source === source)?.name)
            .find(name => this.state.worldNames.includes(name));
        const selected = this.state.worldNames.includes(this.state.selectedWorld)
            ? this.state.selectedWorld : preferred ?? this.state.worldNames[0] ?? '';
        if (selected)
            return this.selectWorld(selected, { keepDraft });
        this.state.selectedWorld = '';
        this.state.worldData = null;
        this.state.selectedUid = null;
        this.state.currentDraft = null;
        this.baseline = null;
        this.notify();
        return { draftKept: false };
    }

    async selectWorld(name, { keepDraft = false } = {}) {
        if (keepDraft)
            await this.awaitPending();
        else
            await this.flush();
        if (!this.state.worldNames.includes(name))
            throw new ToolkitError('WORLD_INFO_NOT_FOUND', '世界书不在当前列表中，请刷新。');
        const data = await this.host.loadWorldInfoFresh(name);
        this.assertWorld(data);
        const sameWorld = this.state.selectedWorld === name;
        const draft = keepDraft && sameWorld ? this.state.currentDraft : null;
        const previousUid = sameWorld ? this.state.selectedUid : null;
        this.state.selectedWorld = name;
        this.state.worldData = structuredClone(data);
        this.baseline = structuredClone(data);
        const uids = Object.keys(data.entries);
        const targetUid = previousUid !== null && Object.hasOwn(data.entries, previousUid) ? previousUid : uids[0] ?? null;
        this.setEntry(targetUid);
        if (draft && targetUid === previousUid && isEditorEntry(draft)) {
            // 草稿仍在，但 baseline 已换成磁盘事实源；等用户确认后再保存。
            this.state.currentDraft = structuredClone(draft);
            this.state.dirty = true;
            this.state.saveStatus = 'unsaved';
            this.notify();
            return { draftKept: true };
        }
        return { draftKept: false };
    }

    // 放弃草稿：只把本地状态退回磁盘事实源，不写世界书。
    async discardDraft() {
        await this.awaitPending();
        this.state.dirty = false;
        this.state.saveStatus = 'idle';
        this.state.lastConversionCount = 0;
        this.state.error = null;
        const name = this.state.selectedWorld;
        if (!name) {
            this.notify();
            return;
        }
        const data = await this.host.loadWorldInfoFresh(name);
        this.assertWorld(data);
        this.state.worldData = structuredClone(data);
        this.baseline = structuredClone(data);
        const uid = this.state.selectedUid;
        this.setEntry(uid !== null && Object.hasOwn(data.entries, uid) ? uid : Object.keys(data.entries)[0] ?? null);
    }

    assertWorld(data) {
        if (!data || typeof data !== 'object' || Array.isArray(data)
            || !data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries))
            throw new ToolkitError('WORLD_INFO_INVALID', '世界书结构异常，已停止写入。');
    }

    setEntry(uid) {
        const raw = uid === null ? null : this.state.worldData?.entries?.[uid];
        const editable = isEditorEntry(raw);
        this.state.selectedUid = editable ? (Number.isFinite(Number(uid)) ? Number(uid) : uid) : null;
        this.state.currentDraft = editable ? structuredClone(raw) : null;
        this.state.dirty = false;
        this.state.saveStatus = 'idle';
        this.state.lastConversionCount = 0;
        this.state.error = null;
        this.notify();
    }

    async selectEntry(uid) {
        await this.flush();
        if (!Object.hasOwn(this.state.worldData?.entries ?? {}, uid))
            throw new ToolkitError('WORLD_INFO_ENTRY_MISSING', '条目不存在，请刷新列表。');
        if (!isEditorEntry(this.state.worldData.entries[uid]))
            throw new ToolkitError('WORLD_INFO_ENTRY_INVALID', '该条目结构异常，编辑器不会改写它；可删除后用外部工具修复世界书。');
        this.setEntry(uid);
    }

    updateDraftField(field, value) {
        if (!this.state.currentDraft)
            return;
        this.state.currentDraft[field] = value;
        this.revision++;
        this.state.dirty = true;
        this.state.saveStatus = 'unsaved';
        this.cancelTimer();
        this.autoSaveTimer = setTimeout(() => {
            this.autoSaveTimer = null;
            void this.saveCurrentDraft({ isAuto: true }).catch(() => {}); // Error retained in state.
        }, AUTOSAVE_DEBOUNCE_MS);
        this.notify();
    }

    async awaitPending() {
        this.cancelTimer();
        if (this.pending)
            await this.pending;
    }

    async flush() {
        await this.awaitPending();
        if (this.state.dirty)
            await this.saveCurrentDraft({ isAuto: true });
    }

    // Serialize all writes. Validate fresh whole-book state before replacing it: the host
    // API saves a whole world, not a single entry. Never silently overwrite external edits.
    async commit(transform, { isAuto = false } = {}) {
        if (this.pending)
            await this.pending;
        const name = this.state.selectedWorld;
        const baseline = this.baseline;
        if (!name || !baseline)
            throw new ToolkitError('NO_WORLD_SELECTED', '请先选择世界书。');
        const operation = (async () => {
            this.state.saveStatus = 'saving';
            this.notify();
            const fresh = await this.host.loadWorldInfoFresh(name);
            this.assertWorld(fresh);
            // 键序无关的快照比对：宿主写入会把对象键重排成字典序。
            if (!sameJsonValue(fresh, baseline))
                throw new ToolkitError('WORLD_INFO_CHANGED', '世界书已被其它操作修改；请保留当前草稿，核对后刷新。');
            const next = structuredClone(fresh);
            transform(next, name);
            await this.host.saveWorldInfo(name, next);
            // 写入成功后磁盘回读才是 baseline：本地对象只是请求体，不代表落盘结果。
            const stored = await this.readBackWorld(name, next);
            this.baseline = stored;
            this.state.worldData = structuredClone(stored);
            this.state.error = null;
            this.state.saveStatus = isAuto ? 'saved_auto' : 'saved_manual';
            this.state.lastSavedTime = new Date().toLocaleTimeString('zh-CN', { hour12: false });
            this.notify();
            return next;
        })();
        this.pending = operation;
        try {
            return await operation;
        }
        catch (error) {
            this.state.saveStatus = 'error';
            this.state.error = `保存失败：${errorMessage(error)}`;
            this.notify();
            throw error;
        }
        finally {
            if (this.pending === operation)
                this.pending = null;
        }
    }

    async readBackWorld(name, written) {
        try {
            const stored = await this.host.loadWorldInfoFresh(name);
            this.assertWorld(stored);
            if (!sameJsonValue(stored, written))
                this.log?.warn('world_info.saved_content_differs', {
                    data: { operation: 'save', stage: 'read-back', reason: 'host-normalized-or-concurrent-change' },
                });
            return structuredClone(stored);
        }
        catch (error) {
            this.log?.warn('world_info.read_back_failed', {
                data: {
                    operation: 'save',
                    stage: 'read-back',
                    kind: error instanceof ToolkitError ? error.code : 'unknown',
                    outcome: 'local-request-as-baseline',
                    nextAction: 'none',
                },
            });
            return structuredClone(written);
        }
    }

    // 手动保存时把整个条目内的独立 user 单词归一为 {{user}} 宏；自动保存不改写正文。
    convertManualUserPlaceholders() {
        if (!this.state.settings.convertUserMacro)
            return 0;
        const { entry, count } = convertEntryUserPlaceholders(this.state.currentDraft);
        this.state.lastConversionCount = count;
        if (count === 0)
            return 0;
        this.state.currentDraft = entry;
        this.revision++;
        this.state.dirty = true;
        this.state.saveStatus = 'unsaved';
        this.log?.info('manual_save.user_macro_applied', {
            data: { operation: 'manual_save.user_macro', convertedCount: count },
        });
        return count;
    }

    async saveCurrentDraft({ isAuto = false } = {}) {
        this.cancelTimer();
        if (this.pending)
            await this.pending;
        if (!this.state.currentDraft)
            return;
        if (!isAuto)
            this.convertManualUserPlaceholders();
        if (!this.state.dirty)
            return false;
        const uid = this.state.selectedUid;
        const revision = this.revision;
        const original = this.baseline?.entries?.[uid];
        const draft = structuredClone(this.state.currentDraft);
        const allKeys = new Set([...Object.keys(draft), ...Object.keys(original ?? {})]);
        const changes = [...allKeys].filter(key => !sameJsonValue(draft[key], original?.[key]));
        await this.commit(next => {
            // 整本快照已比对过；这里只防止状态错配导致的 TypeError，不再重复判定冲突。
            if (!Object.hasOwn(next.entries, uid))
                throw new ToolkitError('WORLD_INFO_ENTRY_MISSING', '条目已不存在，已保留草稿。');
            for (const key of changes) {
                if (draft[key] === undefined)
                    delete next.entries[uid][key];
                else
                    next.entries[uid][key] = structuredClone(draft[key]);
            }
        }, { isAuto });
        if (this.revision === revision) {
            this.state.dirty = false;
        }
        else {
            this.state.saveStatus = 'unsaved';
            this.cancelTimer();
            this.autoSaveTimer = setTimeout(() => {
                this.autoSaveTimer = null;
                void this.saveCurrentDraft({ isAuto: true }).catch(() => {});
            }, AUTOSAVE_DEBOUNCE_MS);
        }
        this.notify();
        return true;
    }

    revertDraft() {
        this.cancelTimer();
        const original = this.state.worldData?.entries?.[this.state.selectedUid];
        if (!original)
            return;
        this.state.currentDraft = structuredClone(original);
        this.state.dirty = false;
        this.state.saveStatus = 'idle';
        this.state.error = null;
        this.notify();
    }

    async createEntry() {
        await this.flush();
        const uid = getFreeWorldEntryUid(this.state.worldData);
        await this.commit(data => { data.entries[uid] = createNewEntry(uid, `新条目 #${uid}`); });
        this.setEntry(uid);
    }

    async duplicateEntry(uid) {
        await this.flush();
        const original = this.state.worldData?.entries?.[uid];
        if (!original)
            throw new ToolkitError('WORLD_INFO_ENTRY_MISSING', '条目不存在。');
        const newUid = getFreeWorldEntryUid(this.state.worldData);
        await this.commit(data => {
            data.entries[newUid] = { ...structuredClone(original), uid: newUid, comment: `${original.comment || '未命名'} (副本)` };
        });
        this.setEntry(newUid);
    }

    async deleteEntry(uid, { confirmedTarget } = {}) {
        // Deleting the currently selected dirty entry is intentional, not an implicit flush.
        if (this.state.selectedUid === null || String(uid) !== String(this.state.selectedUid))
            await this.flush();
        else
            this.cancelTimer();
        let stage = 'validate-target';
        const checkTarget = (entries, world) => {
            if (!Object.hasOwn(entries, uid))
                throw new ToolkitError('WORLD_INFO_ENTRY_MISSING', '条目不存在，请刷新列表。');
            if (confirmedTarget && (confirmedTarget.world !== world || !sameJsonValue(confirmedTarget.value, entries[uid])))
                throw new ToolkitError('WORLD_INFO_DELETE_STALE', '确认后目标条目已变化，没有删除；请刷新并重新确认。');
        };
        try {
            checkTarget(this.state.worldData?.entries ?? {}, this.state.selectedWorld);
            stage = 'commit';
            await this.commit((data, name) => {
                checkTarget(data.entries, name);
                delete data.entries[uid];
            });
        }
        catch (error) {
            this.log?.warn('world_info.entry_delete_failed', {
                data: {
                    operation: 'delete_entry', stage,
                    kind: error instanceof ToolkitError ? error.code : 'unknown',
                    outcome: 'deletion-not-confirmed', nextAction: 'reload-and-review',
                },
            });
            throw error;
        }
        this.setEntry(Object.keys(this.state.worldData.entries)[0] ?? null);
    }

    async toggleEntryActive(uid, active) {
        await this.flush();
        if (!Object.hasOwn(this.state.worldData?.entries ?? {}, uid))
            throw new ToolkitError('WORLD_INFO_ENTRY_MISSING', '条目不存在。');
        await this.commit(data => { data.entries[uid].disable = !active; });
        if (Number(uid) === this.state.selectedUid)
            this.state.currentDraft = structuredClone(this.state.worldData.entries[uid]);
        this.notify();
    }

    setSearchQuery(query) { this.state.searchQuery = String(query ?? ''); }
    setFilter(filter) { this.state.filter = filter; this.notify(); }
    setSort(sort) { this.state.sort = sort; this.notify(); }

    getFilteredEntries() {
        return filterEntries(this.entrySummaries(), {
            query: this.state.searchQuery,
            filter: this.state.filter,
            sort: this.state.sort,
        });
    }

    entrySummaries() {
        const items = summarizeEntries(this.state.worldData?.entries);
        // 当前选中条目以草稿为准：刚绑定的图片在保存前也应显示徽章。
        const draft = this.state.currentDraft;
        if (!draft)
            return items;
        const { binding, invalid } = readEntryImageBindingSafe(draft);
        return items.map(item => (String(item.uid) === String(draft.uid)
            ? { ...item, hasImage: Boolean(binding), imageInvalid: invalid, imageBinding: binding }
            : item));
    }

    getStats() {
        return statsForEntries(this.state.worldData?.entries);
    }
}

