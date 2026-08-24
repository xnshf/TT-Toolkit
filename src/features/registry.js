export const temporarilyHiddenFeatureIds = Object.freeze([
    'model-settings',
    'world-info-ai',
    'prompt-conflict',
]);

export const featureDefinitions = [{
        id: 'model-settings',
        category: { id: 'settings', label: '设置', order: 90 },
        label: '模型服务',
        description: '管理 TT-Toolkit 内置 LLM 任务使用的 OpenAI-compatible 模型预设。',
        icon: '⚙️',
        order: 5,
        defaultEnabled: true,
        load: async (context) => (await import('./model-settings/index.js')).createModelSettingsFeature(context),
    }, {
        id: 'developer-logs',
        category: { id: 'settings', label: '设置', order: 90 },
        label: '日志',
        description: '记录、筛选并导出 TT-Toolkit 结构化诊断日志。',
        icon: '📋',
        order: 10,
        activationPhase: 'bootstrap',
        load: async (context) => (await import('./developer-logs/index.js')).createDeveloperLogsFeature(context),
    }, {
        id: 'chat-viewer',
        category: { id: 'chat-data', label: '聊天数据', order: 10 },
        label: '聊天查看',
        description: '按对话楼层范围查看、搜索并跳转当前聊天。',
        icon: '🔎',
        order: 20,
        load: async (context) => (await import('./chat-viewer/index.js')).createChatViewerFeature(context),
    }, {
        id: 'chat-cleaner',
        category: { id: 'chat-data', label: '聊天数据', order: 10 },
        label: '聊天清洗',
        description: '永久移除指定正文区段与原生 reasoning。',
        icon: '🧹',
        order: 10,
        load: async (context) => (await import('./chat-cleaner/index.js')).createChatCleanerFeature(context),
    }, {
        id: 'world-info-ai',
        category: { id: 'world-info', label: '世界书', order: 20 },
        label: 'AI 激活',
        description: '由独立语义描述决定世界书条目是否在本轮激活。',
        icon: '🧭',
        order: 10,
        load: async (context) => (await import('./world-info-ai/index.js')).createWorldInfoAiFeature(context),
    }, {
        id: 'prompt-conflict',
        category: { id: 'world-info', label: '世界书', order: 20 },
        label: '冲突检测',
        description: '对照当前预设与挂载世界书中的常驻指令，并管理当前聊天的世界书屏蔽。',
        icon: '⚖️',
        order: 20,
        defaultEnabled: false,
        load: async (context) => (await import('./prompt-conflict/index.js')).createPromptConflictFeature(context),
    }];

export const featureRegistrations = featureDefinitions.filter(
    feature => !temporarilyHiddenFeatureIds.includes(feature.id),
);
