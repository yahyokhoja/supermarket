import { z } from 'zod';

const orderStatuses = [
  'assembling',
  'courier_assigned',
  'courier_picked',
  'on_the_way',
  'arrived',
  'received',
  'paid',
  'cancelled'
] as const;

const substitutionPreferences = ['allow_similar', 'no_substitution', 'contact_me'] as const;
const paymentMethods = ['cash', 'wallet'] as const;

const deliveryLatSchema = z.coerce.number().gte(-90, 'deliveryLat должен быть >= -90').lte(90, 'deliveryLat должен быть <= 90');
const deliveryLngSchema = z.coerce.number().gte(-180, 'deliveryLng должен быть >= -180').lte(180, 'deliveryLng должен быть <= 180');

export const orderIdParamsSchema = z.object({
  orderId: z.coerce.number().int('orderId должен быть целым числом').positive('orderId должен быть больше 0')
});

export const createOrderBodySchema = z
  .object({
    deliveryAddress: z.string().trim().min(3, 'deliveryAddress слишком короткий').max(255, 'deliveryAddress слишком длинный').optional(),
    deliveryLat: z.union([deliveryLatSchema, z.null()]).optional(),
    deliveryLng: z.union([deliveryLngSchema, z.null()]).optional(),
    paymentMethod: z.enum(paymentMethods).optional(),
    substitutionPreference: z.enum(substitutionPreferences).optional(),
    substitutionNote: z.union([z.string().trim().max(500, 'substitutionNote слишком длинный'), z.null()]).optional()
  })
  .superRefine((value, ctx) => {
    const hasLat = value.deliveryLat !== undefined && value.deliveryLat !== null;
    const hasLng = value.deliveryLng !== undefined && value.deliveryLng !== null;
    if (hasLat !== hasLng) {
      ctx.addIssue({
        code: 'custom',
        message: 'Координаты доставки должны быть переданы парой',
        path: ['deliveryLat']
      });
      ctx.addIssue({
        code: 'custom',
        message: 'Координаты доставки должны быть переданы парой',
        path: ['deliveryLng']
      });
    }
  });

export const updateOrderStatusBodySchema = z.object({
  status: z.enum(orderStatuses),
  comment: z.union([z.string().trim().max(1000, 'comment слишком длинный'), z.null()]).optional()
});
