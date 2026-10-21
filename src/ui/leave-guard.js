import { confirmDanger } from './confirm.js';

// 离开前确认的统一入口。功能页只回答“有没有未保存草稿”与文案，
// 询问时机（关闭工作台、切换功能）和重入控制由外壳的 App.requestLeave 负责。
// 返回的守卫向外壳回答“是否可以离开”：true = 走，false = 留在当前页面。
// 文案只说“继续离开不会写入”：关闭工作台时功能仍挂载，草稿不会被清空，
// 切换功能才随卸载丢弃，两种路径用同一句话都不会误导读者的预期。
// 守卫不得抛错（询问失败时由外壳兜底），因此这里只做一件事。
export function unsavedChangesGuard(doc, { isDirty, title, message, confirmLabel = '不保存，继续离开' }) {
    return async () => {
        if (!isDirty())
            return true;
        return confirmDanger(doc, { title, message, confirmLabel });
    };
}
