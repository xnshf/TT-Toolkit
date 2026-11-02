import { ToolkitError } from './errors.js';
import { valueType } from './chat-diagnostics.js';
import { fileExportErrorKind, fileExportResult } from './file-export.js';
import { EXTENSIONS_URL, FILE_EXPORT_URL, dynamicImport } from './host-abi.js';

// entryMethods: 由 host.js 按宿主能力拆分，方法体与拆分前一致。
export const entryMethods = {
    async mountToolkitWandEntry(onOpen) {
        this.extensionsModule ??= await dynamicImport(EXTENSIONS_URL);
        const extensions = this.extensionsModule;
        if (typeof extensions.ensureExtensionsUiReady !== 'function'
            || typeof extensions.showHideExtensionsMenu !== 'function') {
            // 这两个导出由宿主构建决定：缺少导出说明宿主本身没有该能力，重载宿主不会恢复。
            throw new ToolkitError('HOST_WAND_EXPORT_MISSING', '当前 TauriTavern 构建未提供扩展菜单初始化接口，重载宿主无法恢复。请升级或更换宿主构建后重试，并保留悬浮球入口。');
        }
        await extensions.ensureExtensionsUiReady();
        const menu = document.getElementById('extensionsMenu');
        const focusTarget = document.getElementById('extensionsMenuButton');
        if (!menu || !focusTarget) {
            throw new ToolkitError('HOST_WAND_DOM_MISSING', '宿主扩展菜单挂载点缺失。请保留悬浮球入口，重载宿主后重试。');
        }
        if (document.getElementById('tt-toolkit-wand-entry')) {
            throw new ToolkitError('HOST_WAND_ENTRY_DUPLICATE', 'TT-Toolkit 魔棒入口已存在，请重载宿主后重试。');
        }
        const element = document.createElement('div');
        element.id = 'tt-toolkit-wand-entry';
        element.className = 'list-group-item flex-container flexGap5';
        element.setAttribute('role', 'button');
        element.tabIndex = 0;
        element.title = '打开 TT-Toolkit';
        const icon = document.createElement('span');
        icon.className = 'fa-solid fa-toolbox extensionsMenuExtensionButton';
        icon.setAttribute('aria-hidden', 'true');
        element.append(icon, document.createTextNode('TT-Toolkit'));
        const click = () => onOpen(focusTarget);
        const keydown = event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                element.click();
            }
        };
        element.addEventListener('click', click);
        element.addEventListener('keydown', keydown);
        menu.append(element);
        const dispose = () => {
            element.removeEventListener('click', click);
            element.removeEventListener('keydown', keydown);
            element.remove();
            extensions.showHideExtensionsMenu();
        };
        try {
            extensions.showHideExtensionsMenu();
        } catch (error) {
            dispose();
            throw error;
        }
        return { element, focusTarget, dispose };
    },
    async exportFile(content, filename, mimeType) {
        for (const [field, value] of Object.entries({ content, filename, mimeType })) {
            if (typeof value !== 'string' || (field !== 'content' && !value.trim()))
                throw new ToolkitError('FILE_EXPORT_INPUT_INVALID', '文件导出参数无效，请重新生成导出内容。', {
                    field, expected: field === 'content' ? 'string' : 'nonempty-string', actualType: valueType(value),
                });
        }
        let result;
        try {
            this.fileExportModule ??= await (this.dynamicImport ?? dynamicImport)(FILE_EXPORT_URL);
        }
        catch {
            throw new ToolkitError('FILE_EXPORT_UNAVAILABLE', '宿主文件导出模块不可用，请检查宿主版本并重试。');
        }
        if (typeof this.fileExportModule?.download !== 'function')
            throw new ToolkitError('FILE_EXPORT_UNAVAILABLE', '宿主未提供前端 download() 接口，当前导出已停止。请检查宿主构建后重试。');
        try {
            // Let the retained frontend interface own platform delivery and notifications.
            result = await this.fileExportModule.download(content, filename, mimeType, { throwOnFailure: true });
        }
        catch (error) {
            const aborted = error?.name === 'AbortError';
            throw new ToolkitError(aborted ? 'FILE_EXPORT_ABORTED' : 'FILE_EXPORT_FAILED', aborted
                ? '宿主导出已中止，无法确认是否为主动取消。请检查目标位置后重试。'
                : '宿主文件导出失败，未确认文件保存。请检查目标位置后重试。', { kind: fileExportErrorKind(error) });
        }
        return fileExportResult(result);
    }
};
