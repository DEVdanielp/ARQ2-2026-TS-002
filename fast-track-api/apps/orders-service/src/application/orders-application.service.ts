import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  isUuid,
  ORDER_STATUSES,
  type AuthenticatedUser,
  type Destination,
  type IntentInput,
  type Order,
  type OrderStatus,
  type StoredResponse,
} from '../domain/order.js';
import { ProblemError, validationError } from './problem-error.js';
import {
  ORDERS_REPOSITORY,
  type ListOrdersInput,
  type OrdersRepository,
} from './orders-repository.port.js';

const INTENT_TYPES = [
  'PICKUP_CONFIRMED',
  'DELIVERY_CONFIRMED',
  'CANCELLATION_REQUESTED',
] as const;

@Injectable()
export class OrdersApplicationService {
  constructor(
    @Inject(ORDERS_REPOSITORY) private readonly repository: OrdersRepository,
  ) {}

  async create(
    user: AuthenticatedUser,
    body: unknown,
    idempotencyKey: string | undefined,
    correlationId: string,
  ): Promise<StoredResponse<Order>> {
    if (!isRecord(body)) {
      throw validationError('Body must be a JSON object.', 'body');
    }

    const destination = parseDestination(body.destination);
    if (body.notes !== undefined && typeof body.notes !== 'string') {
      throw validationError('Notes must be a string.', 'notes');
    }

    return this.repository.createOrder(
      {
        customerId: user.id,
        destination,
        ...(body.notes === undefined ? {} : { notes: body.notes }),
      },
      parseIdempotencyKey(idempotencyKey),
      correlationId,
    );
  }

  async get(user: AuthenticatedUser, orderId: string): Promise<Order> {
    if (!isUuid(orderId)) {
      throw validationError('Order id must be a UUID v4.', 'orderId');
    }
    const order = await this.repository.getOrder(orderId);
    if (!order || !canReadOrder(user, order)) {
      throw new ProblemError(
        404,
        'not-found',
        'Order not found',
        `Order ${orderId} was not found.`,
      );
    }
    return order;
  }

  async list(
    user: AuthenticatedUser,
    query: { status?: string; page?: string; size?: string },
  ) {
    const status = parseStatus(query.status);
    const page = parseInteger(query.page, 0, 0, 1_000_000, 'page');
    const size = parseInteger(query.size, 20, 1, 100, 'size');
    const input: ListOrdersInput = { status, page, size };
    return this.repository.listOrders(user, input);
  }

  async submitIntent(
    user: AuthenticatedUser,
    orderId: string,
    body: unknown,
    idempotencyKey: string | undefined,
    correlationId: string,
  ): Promise<StoredResponse<Record<string, unknown>>> {
    if (!isUuid(orderId)) {
      throw validationError('Order id must be a UUID v4.', 'orderId');
    }
    if (!isRecord(body) || !INTENT_TYPES.includes(body.type as (typeof INTENT_TYPES)[number])) {
      throw validationError('Intent type is invalid.', 'type');
    }
    if (body.reason !== undefined && typeof body.reason !== 'string') {
      throw validationError('Reason must be a string.', 'reason');
    }

    const intent: IntentInput = {
      type: body.type as IntentInput['type'],
      ...(body.reason === undefined ? {} : { reason: body.reason }),
    };
    validateIntentActor(user, intent);
    const key = parseIdempotencyKey(idempotencyKey);
    const scope = `POST:/v1/orders/${orderId}/intents`;
    const input = {
      orderId,
      type: intent.type,
      actor: intentActor(user, intent),
      actorId: user.id,
      reason: intent.reason,
    };
    const replay = await this.repository.findIdempotentResponse(
      user.id,
      scope,
      key,
      input,
    );
    if (replay) {
      return replay;
    }

    const order = await this.repository.getOrder(orderId);
    if (!order) {
      throw new ProblemError(
        404,
        'not-found',
        'Order not found',
        `Order ${orderId} was not found.`,
      );
    }
    validateIntentAccess(user, order, intent);

    if (order.status === 'DELIVERED' || order.status === 'CANCELLED') {
      throw new ProblemError(
        409,
        'order-terminal',
        'Order is in a terminal state',
        `Order ${orderId} is ${order.status}.`,
      );
    }

    return this.repository.queueIntent(
      order,
      user,
      intent,
      key,
      correlationId,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDestination(value: unknown): Destination {
  if (!isRecord(value) || typeof value.address !== 'string') {
    throw validationError('Destination address is required.', 'destination.address');
  }
  const address = value.address.trim();
  if (address.length < 1 || address.length > 300) {
    throw validationError(
      'Destination address must contain 1 to 300 characters.',
      'destination.address',
    );
  }
  if (!isRecord(value.location)) {
    throw validationError('Destination location is required.', 'destination.location');
  }
  const { lat, lng } = value.location;
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw validationError('Latitude must be between -90 and 90.', 'destination.location.lat');
  }
  if (typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw validationError(
      'Longitude must be between -180 and 180.',
      'destination.location.lng',
    );
  }
  return { address, location: { lat, lng } };
}

function parseIdempotencyKey(key: string | undefined): string | undefined {
  if (key === undefined) {
    return undefined;
  }
  if (!isUuid(key)) {
    throw validationError('Idempotency-Key must be a UUID v4.', 'Idempotency-Key');
  }
  return key;
}

function parseStatus(status: string | undefined): OrderStatus | undefined {
  if (status === undefined) {
    return undefined;
  }
  if (!ORDER_STATUSES.includes(status as OrderStatus)) {
    throw validationError('Status filter is invalid.', 'status');
  }
  return status as OrderStatus;
}

function parseInteger(
  value: string | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw validationError(`${field} must be a whole number.`, field);
  }
  const parsed = Number(value);
  if (parsed < minimum || parsed > maximum) {
    throw validationError(`${field} must be between ${minimum} and ${maximum}.`, field);
  }
  return parsed;
}

function validateIntentActor(user: AuthenticatedUser, intent: IntentInput): void {
  const allowed =
    ((intent.type === 'PICKUP_CONFIRMED' || intent.type === 'DELIVERY_CONFIRMED') &&
      user.roles.includes('DRIVER')) ||
    (intent.type === 'CANCELLATION_REQUESTED' &&
      (user.roles.includes('CUSTOMER') || user.roles.includes('OPERATIONS')));
  if (!allowed) {
    throw new ProblemError(
      403,
      'forbidden',
      'Forbidden',
      'Your role cannot submit this intent.',
    );
  }
  if (
    intent.type === 'CANCELLATION_REQUESTED' &&
    user.roles.includes('OPERATIONS') &&
    (!intent.reason || intent.reason.trim().length === 0)
  ) {
    throw validationError('Reason is required for operations cancellation.', 'reason');
  }
  if (intent.reason && intent.reason.length > 300) {
    throw validationError('Reason cannot exceed 300 characters.', 'reason');
  }
}

function intentActor(
  user: AuthenticatedUser,
  intent: IntentInput,
): AuthenticatedUser['roles'][number] {
  if (intent.type !== 'CANCELLATION_REQUESTED') {
    return 'DRIVER';
  }
  return user.roles.includes('OPERATIONS') ? 'OPERATIONS' : 'CUSTOMER';
}

function validateIntentAccess(
  user: AuthenticatedUser,
  order: Order,
  intent: IntentInput,
): void {
  if (
    (intent.type === 'PICKUP_CONFIRMED' || intent.type === 'DELIVERY_CONFIRMED') &&
    (!user.roles.includes('DRIVER') || order.driverId !== user.id)
  ) {
    throw new ProblemError(
      403,
      'forbidden',
      'Forbidden',
      'Only the assigned driver may submit this intent.',
    );
  }
  if (
    intent.type === 'CANCELLATION_REQUESTED' &&
    user.roles.includes('CUSTOMER') &&
    order.customerId !== user.id
  ) {
    throw new ProblemError(403, 'forbidden', 'Forbidden', 'You do not own this order.');
  }
  if (
    intent.type === 'CANCELLATION_REQUESTED' &&
    user.roles.includes('CUSTOMER') &&
    order.status === 'ON_THE_WAY'
  ) {
    throw new ProblemError(
      403,
      'forbidden',
      'Forbidden',
      'Customers cannot cancel an order after pickup.',
    );
  }
}

function canReadOrder(user: AuthenticatedUser, order: Order): boolean {
  if (user.roles.includes('OPERATIONS')) {
    return true;
  }
  if (user.roles.includes('CUSTOMER')) {
    return order.customerId === user.id;
  }
  return order.driverId === user.id;
}

export function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
