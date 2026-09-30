/**
 * Contrato compartido por API y formulario: campos, fechas y scopes. La aceptación final y sus errores provienen de Audax.
 */
import { z } from 'zod';
import { fail } from './security.mjs';
const id = z.string().trim().min(1).max(128);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const d = new Date(v + 'T00:00:00Z');
  return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === v;
}, 'Fecha inválida');
const currency = z.union([id, z.number().int().positive().safe()]);
const premium = { price: z.number().positive().finite().optional(), currency_id: currency.optional() };
const upgrade = z.strictObject({ valid_from: date, valid_to: date, ...premium });
const upgradeEntry = z.record(id, upgrade).refine(v => Object.keys(v).length === 1, 'Cada objeto debe tener un solo upgrade ID');
const membership = z.strictObject({
  plan_id: id, membership_number: id, national_id: id, business_id: id,
  last_name: z.string().trim().min(1).max(200), first_name: z.string().trim().min(1).max(200),
  issued_country: id, date_of_birth: date, issued_date: date, valid_from: date, valid_to: date,
  max_consecutive_days_per_trip: z.number().int().positive().max(2147483647),
  ...premium, upgrades: z.array(upgradeEntry).max(100).optional(), override: z.boolean().optional(),
}).superRefine((v, ctx) => {
  if (v.valid_from >= v.valid_to) ctx.addIssue({ code: 'custom', path: ['valid_to'], message: 'Debe ser posterior a valid_from' });
  const seen = new Set();
  for (const [i, entry] of (v.upgrades || []).entries()) {
    const [key, u] = Object.entries(entry)[0];
    if (seen.has(key)) ctx.addIssue({ code: 'custom', path: ['upgrades', i], message: 'Upgrade duplicado' });
    seen.add(key);
    if (u.valid_from >= u.valid_to || u.valid_from < v.valid_from || u.valid_to > v.valid_to) {
      ctx.addIssue({ code: 'custom', path: ['upgrades', i], message: 'Vigencia del upgrade inválida o fuera de la membership' });
    }
  }
});
const cancellation = z.strictObject({ business_id: id, plan_id: id, issued_country: id, membership_number: id, override: z.boolean().optional() });
export const ALL_SCOPES = ['memberships:read', 'memberships:insert', 'memberships:update', 'memberships:upgrade', 'memberships:cancel', 'memberships:override'];
export const clientSchema = z.strictObject({
  name: z.string().trim().min(1).max(120), company_name: z.string().trim().min(1).max(180),
  email: z.union([z.email(), z.literal('')]).default(''),
  business_ids: z.array(id).min(1).max(100), plan_ids: z.array(id).min(1).max(500),
  business_plan_pairs: z.array(z.strictObject({business_id:id,plan_id:id})).max(5000).default([]),
  scopes: z.array(z.enum(ALL_SCOPES)).min(1), active: z.boolean().default(true),
});
export const membershipKey = v => JSON.stringify([v.business_id, v.plan_id, v.issued_country, v.membership_number]);
export function validatePayload(kind, payload, client, maxBatch = 500, allowOverride = false) {
  const parsed = (kind === 'cancel' ? cancellation : z.array(membership).min(1).max(maxBatch)).safeParse(payload);
  if (!parsed.success) throw fail(400, 'validation_error', 'El lote completo fue rechazado por errores de validación', parsed.error.issues);
  const items = kind === 'cancel' ? [parsed.data] : parsed.data;
  const seen = new Set();
  for (const [index, item] of items.entries()) {
    if (kind === 'upgrade' && !client.scopes.includes('memberships:update')) throw fail(403, 'insufficient_scope', 'El alias de upgrade envía una modificación completa y requiere memberships:update', { index });
    if (kind === 'insert' && item.override !== undefined) throw fail(400, 'invalid_override', 'Override solo está documentado para modificaciones y bajas', { index });
    if (item.override === true && (!allowOverride || !client.scopes.includes('memberships:override'))) {
      throw fail(403, 'override_forbidden', 'Override requiere habilitación del servidor y permiso especial del usuario', { index });
    }
    if (!client.business_ids.includes(item.business_id) || !client.plan_ids.includes(item.plan_id)) {
      throw fail(403, 'forbidden_membership', 'Empresa o plan no habilitado para este usuario', { index });
    }
    if (kind === 'upgrade' && !item.upgrades?.length) throw fail(400, 'missing_upgrades', 'UpgradeMembershipBatch requiere upgrades y todos los campos de la membership', { index });
    if (item.upgrades?.length && !client.scopes.includes('memberships:upgrade')) throw fail(403, 'insufficient_scope', 'Los upgrades también requieren permiso memberships:upgrade dentro de insert o update', { index });
    const key = membershipKey(item);
    if (seen.has(key)) throw fail(400, 'duplicate_membership', 'La misma membership aparece dos veces en el lote', { index });
    seen.add(key);
  }
  return { payload: parsed.data, items, keys: [...seen] };
}
