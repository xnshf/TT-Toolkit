export class ToolkitError extends Error {
    code;
    context;
    constructor(code, message, context = {}) {
        super(message);
        this.name = 'ToolkitError';
        this.code = code;
        this.context = context;
    }
}
export function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
export function errorKind(error) {
    if (error instanceof ToolkitError)
        return { kind: 'ToolkitError', code: error.code };
    if (error instanceof Error)
        return { kind: error.name };
    return { kind: typeof error };
}
