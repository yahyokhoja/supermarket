import { z } from 'zod';

export const cartItemParamsSchema = z.object({
  itemId: z.coerce.number().int('itemId должен быть целым числом').positive('itemId должен быть больше 0')
});

export const cartAddItemBodySchema = z.object({
  productId: z.coerce.number().int('productId должен быть целым числом').positive('productId должен быть больше 0'),
  quantity: z.coerce.number().int('quantity должен быть целым числом').positive('quantity должен быть больше 0').max(100, 'quantity не должен превышать 100').optional()
});

export const cartUpdateItemBodySchema = z.object({
  quantity: z.coerce.number().int('quantity должен быть целым числом').positive('quantity должен быть больше 0').max(100, 'quantity не должен превышать 100')
});
