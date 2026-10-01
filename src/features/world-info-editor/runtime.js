import { errorMessage, ToolkitError } from '../../kernel/errors.js';
import { createNewEntry, estimateTokens, getFreeWorldEntryUid, normalizeEntry } from './schema.js';

const AUTOSAVE_DEBOUNCE_MS = 1000;

export class WorldInfoEditorRuntime {
    constructor(host, log) {
        this.host = host;
        this.log = log;
        this.listeners = new Set();
        this.autoSaveTimer = null;
        this.pending = null;
        this.revision = 0;
        this.baseline = null;
        this.state = {
            worldNames: [], activeBindings: [], selectedWorld: '', worldData: null,
            selectedUid: null, currentDraft: null, dirty: false, saveStatus: 'idle',
            lastSavedTime: null, error: null, busy: false, searchQuery: '', filter: 'all', sort: 'order',
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
        // Returning to the page after an unsuccessful save must not discard its draft.
        if (this.state.dirty || this.state.saveStatus === 'error') {
            this.notify();
            return;
        }
        await this.refreshWorlds();
    }

    async refreshWorlds() {
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
            await this.selectWorld(selected);
        else {
            this.state.selectedWorld = '';
            this.state.worldData = null;
            this.state.selectedUid = null;
            this.state.currentDraft = null;
            this.baseline = null;
            this.notify();
        }
    }

    async selectWorld(name) {
        await this.flush();
        if (!this.state.worldNames.includes(name))
            throw new ToolkitError('WORLD_INFO_NOT_FOUND', '世界书不在当前列表中，请刷新。');
        const data = await this.host.loadWorldInfoFresh(name);
        this.assertWorld(data);
        const previousUid = this.state.selectedWorld === name ? this.state.selectedUid : null;
        this.state.selectedWorld = name;
        this.state.worldData = structuredClone(data);
        this.baseline = structuredClone(data);
        const uids = Object.keys(data.entries);
        this.setEntry(previousUid !== null && Object.hasOwn(data.entries, previousUid) ? previousUid : uids[0] ?? null);
    }

    assertWorld(data) {
        if (!data || typeof data !== 'object' || Array.isArray(data)
            || !data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries))
            throw new ToolkitError('WORLD_INFO_INVALID', '世界书结构异常，已停止写入。');
    }

    setEntry(uid) {
        const raw = uid === null ? null : this.state.worldData?.entries?.[uid];
        this.state.selectedUid = raw ? Number(uid) : null;
        this.state.currentDraft = raw ? structuredClone(raw) : null;
        this.state.dirty = false;
        this.state.saveStatus = 'idle';
        this.state.error = null;
        this.notify();
    }

    async selectEntry(uid) {
        await this.flush();
        if (!Object.hasOwn(this.state.worldData?.entries ?? {}, uid))
            throw new ToolkitError('WORLD_INFO_ENTRY_MISSING', '条目不存在，请刷新列表。');
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

    async flush() {
        this.cancelTimer();
        if (this.pending)
            await this.pending;
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
            if (JSON.stringify(fresh) !== JSON.stringify(baseline))
                throw new ToolkitError('WORLD_INFO_CHANGED', '世界书已被其它操作修改；请保留当前草稿，核对后刷新。');
            const next = structuredClone(fresh);
            transform(next);
            await this.host.saveWorldInfo(name, next);
            // Do not publish a failed save to the local working copy.
            this.baseline = structuredClone(next);
            this.state.worldData = structuredClone(next);
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

    async saveCurrentDraft({ isAuto = false } = {}) {
        this.cancelTimer();
        if (this.pending)
            await this.pending;
        if (!this.state.dirty || !this.state.currentDraft)
            return;
        const name = this.state.selectedWorld;
        const uid = this.state.selectedUid;
        const revision = this.revision;
        const original = this.baseline?.entries?.[uid];
        const draft = structuredClone(this.state.currentDraft);
        const changes = Object.keys(draft).filter(key => JSON.stringify(draft[key]) !== JSON.stringify(original?.[key]));
        await this.commit(next => {
            if (this.state.selectedWorld !== name || !Object.hasOwn(next.entries, uid)
                || JSON.stringify(next.entries[uid]) !== JSON.stringify(original))
                throw new ToolkitError('WORLD_INFO_ENTRY_CHANGED', '原条目已变化，已保留草稿。');
            for (const key of changes)
                next.entries[uid][key] = structuredClone(draft[key]);
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

    async deleteEntry(uid) {
        // Deleting the currently selected dirty entry is intentional, not an implicit flush.
        if (Number(uid) !== this.state.selectedUid)
            await this.flush();
        else
            this.cancelTimer();
        const original = this.state.worldData?.entries?.[uid];
        if (!original)
            throw new ToolkitError('WORLD_INFO_ENTRY_MISSING', '条目不存在。');
        await this.commit(data => { delete data.entries[uid]; });
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
        const entries = Object.values(this.state.worldData?.entries ?? {}).map(entry => normalizeEntry(entry));
        const needle = this.state.searchQuery.trim().toLowerCase();
        return entries.filter(item => {
            if (needle && ![item.comment, String(item.uid), item.content, ...item.key, ...item.keysecondary]
                .some(value => String(value).toLowerCase().includes(needle))) return false;
            switch (this.state.filter) {
                case 'constant': return item.constant;
                case 'active': return !item.disable;
                case 'disabled': return item.disable;
                case 'depth': return item.position === 4;
                default: return true;
            }
        }).sort((a, b) => {
            switch (this.state.sort) {
                case 'uid': return a.uid - b.uid;
                case 'title': return a.comment.localeCompare(b.comment, 'zh-CN');
                case 'tokens': return estimateTokens(b.content) - estimateTokens(a.content);
                default: return a.order - b.order;
            }
        });
    }

    getStats() {
        const entries = Object.values(this.state.worldData?.entries ?? {});
        return {
            total: entries.length,
            constant: entries.filter(entry => entry.constant).length,
            active: entries.filter(entry => !entry.disable).length,
            disabled: entries.filter(entry => entry.disable).length,
            totalTokens: entries.reduce((total, entry) => total + estimateTokens(entry.content), 0),
        };
    }
}
