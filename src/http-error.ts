export class HttpError extends Error {
  statusCode: number;
  exposeMessage: boolean;

  constructor(statusCode: number, message: string, opts?: { exposeMessage?: boolean }) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = Math.max(400, Math.min(599, Math.floor(Number(statusCode) || 500)));
    this.exposeMessage = opts?.exposeMessage ?? this.statusCode < 500;
  }
}
