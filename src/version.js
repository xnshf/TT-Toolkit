import { ToolkitError } from './kernel/errors.js';

const MANIFEST_URL = new URL('../manifest.json', import.meta.url);
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// manifest 是唯一版本来源；启动时读取一次，再由外壳传给界面。
export async function loadToolkitVersion(fetchManifest = globalThis.fetch) {
    let response;
    try {
        response = await fetchManifest(MANIFEST_URL, { cache: 'no-store' });
    } catch {
        throw new ToolkitError('VERSION_MANIFEST_UNAVAILABLE', '无法读取 TT-Toolkit 安装清单，请重载宿主或重新安装插件。');
    }
    if (!response?.ok) {
        throw new ToolkitError('VERSION_MANIFEST_UNAVAILABLE', '无法读取 TT-Toolkit 安装清单，请重载宿主或重新安装插件。');
    }
    let manifest;
    try {
        manifest = await response.json();
    } catch {
        throw new ToolkitError('VERSION_MANIFEST_INVALID', 'TT-Toolkit 安装清单不是有效 JSON，请重新安装插件。');
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
        || typeof manifest.version !== 'string' || !VERSION_PATTERN.test(manifest.version)) {
        throw new ToolkitError('VERSION_MANIFEST_INVALID', 'TT-Toolkit 安装清单缺少有效版本号，请重新安装插件。');
    }
    return manifest.version;
}
