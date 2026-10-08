import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ParamsDictionary } from 'express-serve-static-core';
import { z, type ZodTypeAny } from 'zod';
import { HttpError } from '../http-error';

function formatZodError(error: z.ZodError) {
  const firstIssue = error.issues[0];
  if (!firstIssue) return 'Некорректные данные запроса';

  const path = firstIssue.path.length ? firstIssue.path.join('.') : 'body';
  return `Некорректное поле ${path}: ${firstIssue.message}`;
}

export function validateBody<TSchema extends ZodTypeAny>(schema: TSchema): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return next(new HttpError(400, formatZodError(result.error), { exposeMessage: true }));
    }

    req.body = result.data;
    return next();
  };
}

export function validateParams<TSchema extends ZodTypeAny>(schema: TSchema): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      return next(new HttpError(400, formatZodError(result.error), { exposeMessage: true }));
    }

    req.params = result.data as unknown as ParamsDictionary;
    return next();
  };
}
