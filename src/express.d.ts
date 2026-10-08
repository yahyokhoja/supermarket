import type { JwtPayload } from './types';

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
      file?: any;
      rawBody?: string;
      requestId?: string;
    }
  }
}

export {};
