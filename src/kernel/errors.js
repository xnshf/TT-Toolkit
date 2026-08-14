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
