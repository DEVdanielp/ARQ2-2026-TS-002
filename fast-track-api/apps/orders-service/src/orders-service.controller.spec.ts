import { OrdersApplicationService } from './application/orders-application.service.js';
import type { OrdersRepository } from './application/orders-repository.port.js';
import type { AuthenticatedUser, Order } from './domain/order.js';

const order: Order = {
  orderId: '11111111-1111-4111-8111-111111111111',
  customerId: '22222222-2222-4222-8222-222222222222',
  driverId: null,
  destination: {
    address: 'Cra 43A #1-50, Medellín',
    location: { lat: 6.2088, lng: -75.5679 },
  },
  status: 'CREATED',
  version: 1,
  cancellation: null,
  createdAt: '2026-10-18T15:01:00.000Z',
  updatedAt: '2026-10-18T15:01:00.000Z',
};

describe('OrdersApplicationService', () => {
  const createOrder = vi.fn();
  const getOrder = vi.fn();
  const findIdempotentResponse = vi.fn();
  const listOrders = vi.fn();
  const queueIntent = vi.fn();
  const repository: OrdersRepository = {
    createOrder,
    getOrder,
    findIdempotentResponse,
    listOrders,
    queueIntent,
  };
  const service = new OrdersApplicationService(repository);
  const customer: AuthenticatedUser = {
    id: order.customerId,
    roles: ['CUSTOMER'],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates an order from the authenticated customer and validated destination', async () => {
    createOrder.mockResolvedValue({ status: 201, body: order });

    await expect(
      service.create(
        customer,
        { destination: order.destination },
        undefined,
        '33333333-3333-4333-8333-333333333333',
      ),
    ).resolves.toEqual({ status: 201, body: order });
    expect(createOrder).toHaveBeenCalledWith(
      {
        customerId: customer.id,
        destination: order.destination,
      },
      undefined,
      '33333333-3333-4333-8333-333333333333',
    );
  });

  it('returns a validation error for coordinates outside WGS-84 bounds', async () => {
    await expect(
      service.create(
        customer,
        {
          destination: {
            address: 'Somewhere',
            location: { lat: 91, lng: 0 },
          },
        },
        undefined,
        '33333333-3333-4333-8333-333333333333',
      ),
    ).rejects.toMatchObject({ status: 400, type: 'validation' });
    expect(createOrder).not.toHaveBeenCalled();
  });

  it('rejects customer cancellation after pickup before queueing', async () => {
    getOrder.mockResolvedValue({ ...order, status: 'ON_THE_WAY' });

    await expect(
      service.submitIntent(
        customer,
        order.orderId,
        { type: 'CANCELLATION_REQUESTED' },
        undefined,
        '33333333-3333-4333-8333-333333333333',
      ),
    ).rejects.toMatchObject({ status: 403, type: 'forbidden' });
    expect(queueIntent).not.toHaveBeenCalled();
  });

  it('rejects intents for terminal orders', async () => {
    getOrder.mockResolvedValue({ ...order, status: 'DELIVERED' });

    await expect(
      service.submitIntent(
        customer,
        order.orderId,
        { type: 'CANCELLATION_REQUESTED' },
        undefined,
        '33333333-3333-4333-8333-333333333333',
      ),
    ).rejects.toMatchObject({ status: 409, type: 'order-terminal' });
  });

  it('returns an accepted intent replay before checking the changed order state', async () => {
    const savedResponse = {
      status: 202,
      body: {
        intentId: '44444444-4444-4444-8444-444444444444',
        orderId: order.orderId,
        type: 'CANCELLATION_REQUESTED',
        status: 'QUEUED',
      },
    };
    findIdempotentResponse.mockResolvedValue(savedResponse);

    await expect(
      service.submitIntent(
        customer,
        order.orderId,
        { type: 'CANCELLATION_REQUESTED' },
        '55555555-5555-4555-8555-555555555555',
        '33333333-3333-4333-8333-333333333333',
      ),
    ).resolves.toEqual(savedResponse);
    expect(getOrder).not.toHaveBeenCalled();
  });
});
