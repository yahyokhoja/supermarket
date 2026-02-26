import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import type { DbUser, JwtPayload, UserRole } from './types';

export function buildToken(user: DbUser, secret: string) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role, sessionVersion: user.session_version }, secret, { expiresIn: '7d' });
}

type AuthUserState = {
  id: number;
  email: string;
  role: UserRole;
  isActive: boolean;
  sessionVersion: number;
};

let authUserResolver: ((userId: number) => Promise<AuthUserState | null>) | null = null;

export function setAuthUserResolver(resolver: (userId: number) => Promise<AuthUserState | null>) {
  authUserResolver = resolver;
}

export function authRequired(secret: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.user) {
      return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Требуется авторизация' });
    }

    const token = authHeader.replace('Bearer ', '').trim();
    try {
      const payload = jwt.verify(token, secret) as JwtPayload;
      if (authUserResolver) {
        const currentUser = await authUserResolver(payload.id);
        if (!currentUser) return res.status(401).json({ message: 'Пользователь не найден' });
        if (!currentUser.isActive) return res.status(403).json({ message: 'Аккаунт заблокирован администратором' });
        if (Number(payload.sessionVersion ?? -1) !== currentUser.sessionVersion) {
          return res.status(401).json({ message: 'Сессия завершена. Войдите снова' });
        }
        req.user = {
          id: currentUser.id,
          email: currentUser.email,
          role: currentUser.role,
          sessionVersion: currentUser.sessionVersion
        };
      } else {
        req.user = payload;
      }
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
