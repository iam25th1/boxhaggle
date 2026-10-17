import * as z from "zod";

// Request and response contracts shared by merchant, agent, plugin and web.
// Every request object is strict: unknown fields are rejected.

export const SessionId = z.string().regex(/^[a-f0-9]{32}$/, "sessionId must be 32 lowercase hex characters");
export const AtomicAmount = z
  .string()
  .regex(/^[1-9][0-9]{0,11}$/, "amount must be a positive integer string of atomic USDC");
export const Channel = z.enum(["sdk", "plugin"]);
export const MoodSchema = z.enum(["calm", "amused", "irritated", "insulted", "sold"]);
export const StatusSchema = z.enum(["open", "sold", "walked"]);

export const CreateSessionBody = z.strictObject({
  itemId: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  channel: Channel.default("sdk"),
});
export type CreateSessionBody = z.infer<typeof CreateSessionBody>;

export const OfferBody = z.strictObject({
  sessionId: SessionId,
  amount: AtomicAmount,
});
export type OfferBody = z.infer<typeof OfferBody>;

export const CheckoutBody = z.strictObject({
  sessionId: SessionId,
});
export type CheckoutBody = z.infer<typeof CheckoutBody>;

export const ItemView = z.strictObject({
  id: z.string(),
  name: z.string(),
  blurb: z.string(),
  art: z.string(),
});

export const PublicSession = z.strictObject({
  sessionId: SessionId,
  channel: Channel,
  item: ItemView,
  currency: z.literal("USDC"),
  listPrice: z.number().int(),
  ask: z.number().int(),
  patience: z.number().int().min(0).max(100),
  mood: MoodSchema,
  round: z.number().int().min(0),
  status: StatusSchema,
  finalPrice: z.number().int().nullable(),
  offerFee: z.number().int(),
  commitment: z.string().regex(/^[a-f0-9]{64}$/),
  networks: z.array(z.string()),
  checkoutPaid: z.boolean(),
  expiresAt: z.string(),
});
export type PublicSession = z.infer<typeof PublicSession>;

export const SessionCreated = PublicSession.extend({ line: z.string() });
export type SessionCreated = z.infer<typeof SessionCreated>;

export const PaymentRef = z.strictObject({
  network: z.string(),
  txRef: z.string(),
  payer: z.string().nullable(),
});
export type PaymentRef = z.infer<typeof PaymentRef>;

export const OfferReply = z.strictObject({
  sessionId: SessionId,
  round: z.number().int(),
  offer: z.number().int(),
  previousAsk: z.number().int(),
  ask: z.number().int(),
  patience: z.number().int(),
  mood: MoodSchema,
  status: StatusSchema,
  finalPrice: z.number().int().nullable(),
  line: z.string(),
  fee: z.number().int(),
  payment: PaymentRef,
});
export type OfferReply = z.infer<typeof OfferReply>;

export const CheckoutReply = z.strictObject({
  sessionId: SessionId,
  finalPrice: z.number().int(),
  receiptId: z.string(),
  payment: PaymentRef,
});
export type CheckoutReply = z.infer<typeof CheckoutReply>;

export const RevealReply = z.strictObject({
  sessionId: SessionId,
  floor: z.number().int(),
  salt: z.string().regex(/^[a-f0-9]{64}$/),
  commitment: z.string().regex(/^[a-f0-9]{64}$/),
  verified: z.boolean(),
});
export type RevealReply = z.infer<typeof RevealReply>;

export const ErrorReply = z.object({
  error: z.string(),
  message: z.string().optional(),
});
