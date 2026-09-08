export interface AutoDocErrorShape {
  code: string;
  message: string;
  detail?: unknown;
}

export class AutoDocException extends Error {
  public readonly code: string;
  public readonly detail?: unknown;

  constructor(code: string, message: string, detail?: unknown) {
    super(`[${code}] ${message}`);
    this.name = "AutoDocException";
    this.code = code;
    this.detail = detail;
  }

  toJSON(): AutoDocErrorShape {
    return {
      code: this.code,
      message: this.message,
      detail: this.detail,
    };
  }
}
