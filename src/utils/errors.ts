export class HubError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HubError";
    this.code = code;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function errorCode(error: unknown): string {
  if (error instanceof HubError) {
    return error.code;
  }
  return "error";
}
