/**
 * Customer profile use cases (spec 4.1 `GET/PUT /customers/me`, F1-S1).
 * The customer id is always the JWT `sub` (spec 2, Identity).
 */
import { Injectable } from '@nestjs/common';
import {
  publishesContactUpdate,
  type CustomerProfileInput,
} from '../domain/customer-rules.js';
import type { Customer } from '../domain/profiles.js';
import { NotFoundError } from './errors.js';
import { customerContactUpdated } from './events.js';
import { Clock, ProfilesStore } from './ports.js';

@Injectable()
export class GetCustomerProfile {
  constructor(private readonly store: ProfilesStore) {}

  /** @throws {NotFoundError} if the profile was never created (404). */
  async execute(customerId: string): Promise<Customer> {
    const customer = await this.store.findCustomer(customerId);
    if (!customer)
      throw new NotFoundError('customer', 'Customer profile not created yet');
    return customer;
  }
}

@Injectable()
export class SaveCustomerProfile {
  constructor(
    private readonly store: ProfilesStore,
    private readonly clock: Clock,
  ) {}

  /**
   * Creates or replaces the caller's profile. On create, or when the email or
   * phone changes, publishes `CustomerContactUpdated` with a higher
   * `aggregateVersion`, in the same transaction (ADR-005, ADR-015).
   */
  async execute(
    customerId: string,
    input: CustomerProfileInput,
    correlationId: string,
  ): Promise<{ customer: Customer; created: boolean }> {
    return this.store.inCustomerSession(customerId, async (session) => {
      const { current } = session;
      const now = this.clock.now();
      const publish = publishesContactUpdate(current, input);

      const customer: Customer = {
        customerId,
        name: input.name,
        email: input.email,
        phone: input.phone,
        contactVersion: current
          ? current.contactVersion + (publish ? 1 : 0)
          : 1,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      };
      await session.save(customer);
      if (publish)
        await session.publish(customerContactUpdated(customer, correlationId));
      return { customer, created: current === null };
    });
  }
}
