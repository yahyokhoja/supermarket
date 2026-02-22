import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import type { DbUser, JwtPayload, UserRole } from './types';

export function buildToken(user: DbUser, secret: string) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, secret, { expiresIn: '7d' });
}

export function authRequired(secret: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Требуется авторизация' });
    }

    const token = authHeader.replace('Bearer ', '').trim();
    try {
      req.user = jwt.verify(token, secret) as JwtPayload;
      return next();
    } catch {
      return res.status(401).json({ message: 'Недействительный токен' });
    }
  };
}

export function roleRequired(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Недостаточно прав' });
    }
    return next();
  };
}
