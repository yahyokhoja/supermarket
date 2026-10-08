import { z } from 'zod';

const phoneRegex = /^\+?[0-9\s\-()]{7,20}$/;

export const updateMeBodySchema = z
  .object({
    fullName: z.string().trim().min(2, 'минимум 2 символа').max(120, 'максимум 120 символов').optional(),
    phone: z.union([z.string().trim().regex(phoneRegex, 'некорректный номер телефона').min(7).max(20), z.null()]).optional(),
    address: z.union([z.string().trim().min(3, 'адрес слишком короткий').max(255), z.null()]).optional()
  })
  .refine((value) => Object.prototype.hasOwnProperty.call(value, 'fullName') || Object.prototype.hasOwnProperty.call(value, 'phone') || Object.prototype.hasOwnProperty.call(value, 'address'), {
    message: 'Нужно передать хотя бы одно поле: fullName, phone или address'
  });
