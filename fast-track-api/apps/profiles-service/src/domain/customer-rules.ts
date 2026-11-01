/**
 * Customer rules of F1 (spec 4.1 `PUT /customers/me`, F1-S1).
 */
import type { Customer } from './profiles.js';

/** The fields a customer can set about themselves (the id always comes from the JWT). */
export interface CustomerProfileInput {
  name: string;
  email: string;
  /** `PUT` replaces the profile: an omitted phone is stored as null. */
  phone: string | null;
}

/**
 * Whether saving `input` must publish `CustomerContactUpdated` (spec 4.1):
 * always when the profile is created (F1-S1), and on update only when the
 * email or the phone changes. A name-only change is not a contact change.
 */
export function publishesContactUpdate(
  current: Pick<Customer, 'email' | 'phone'> | null,
  input: CustomerProfileInput,
): boolean {
  if (current === null) return true;
  return current.email !== input.email || current.phone !== input.phone;
}
