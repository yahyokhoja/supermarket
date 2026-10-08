import { z } from 'zod';

const phoneRegex = /^\+?[0-9\s\-()]{7,20}$/;
const emptyToUndefined = (value: unknown) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
};

const optionalPhoneSchema = z.preprocess(
  emptyToUndefined,
  z.string().trim().regex(phoneRegex, 'некорректный номер телефона').min(7).max(20).optional()
);

const optionalAddressSchema = z.preprocess(
  emptyToUndefined,
  z.string().trim().min(3, 'адрес слишком короткий').max(255).optional()
);

export const registerBodySchema = z.object({
  fullName: z.string().trim().min(2, 'минимум 2 символа').max(120, 'максимум 120 символов'),
  email: z.string().trim().email('некорректный email').max(254, 'слишком длинный email').transform((value) => value.toLowerCase()),
  password: z
    .string()
    .min(8, 'пароль должен быть минимум 8 символов')
    .max(72, 'пароль слишком длинный')
    .regex(/[a-z]/, 'пароль должен содержать строчную букву')
    .regex(/[A-Z]/, 'пароль должен содержать заглавную букву')
    .regex(/[0-9]/, 'пароль должен содержать цифру')
    .regex(/[^A-Za-z0-9]/, 'пароль должен содержать спецсимвол'),
  phone: optionalPhoneSchema,
  address: optionalAddressSchema
});

export const loginBodySchema = z.object({
  email: z.string().trim().email('некорректный email').max(254, 'слишком длинный email').transform((value) => value.toLowerCase()),
  password: z.string().min(1, 'пароль обязателен').max(72, 'пароль слишком длинный')
});

export const verificationRequestBodySchema = z.object({
  channel: z.enum(['email', 'phone'], {
    error: () => ({ message: 'channel должен быть email или phone' })
  })
});

export const verificationConfirmBodySchema = z.object({
  channel: z.enum(['email', 'phone'], {
    error: () => ({ message: 'channel должен быть email или phone' })
  }),
  code: z.string().trim().regex(/^\d{6}$/, 'Код должен состоять из 6 цифр')
});
