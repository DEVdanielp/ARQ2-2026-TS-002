import { AssignmentWindow, strictlyAfter } from './assignment-window.js';
import { publishesContactUpdate } from './customer-rules.js';
import {
  availabilityFor,
  checkCapacity,
  chooseDriver,
  freeSlots,
  isEligible,
} from './driver-rules.js';
import type { Driver } from './profiles.js';

function driver(overrides: Partial<Driver> = {}): Driver {
  return {
    driverId: 'd-1',
    name: 'Carlos Ruiz',
    phone: '+573109876543',
    vehiclePlate: 'ABC123',
    availability: 'AVAILABLE',
    capacity: 3,
    activeOrderIds: [],
    lastAssignedAt: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  };
}

describe('driver rules', () => {
  it('counts free slots and never goes negative', () => {
    expect(freeSlots(driver({ capacity: 3, activeOrderIds: ['o1'] }))).toBe(2);
    expect(
      freeSlots(driver({ capacity: 1, activeOrderIds: ['o1', 'o2'] })),
    ).toBe(0);
  });

  it('an OFFLINE driver is never eligible', () => {
    expect(isEligible(driver({ availability: 'OFFLINE' }))).toBe(false);
  });

  it('F1-S4: a driver whose active orders equal the capacity is not eligible', () => {
    expect(
      isEligible(driver({ capacity: 2, activeOrderIds: ['o1', 'o2'] })),
    ).toBe(false);
  });

  it('an EN_ROUTE driver with a free slot is eligible (ADR-019)', () => {
    expect(
      isEligible(
        driver({
          availability: 'EN_ROUTE',
          capacity: 2,
          activeOrderIds: ['o1'],
        }),
      ),
    ).toBe(true);
  });

  it('chooses the driver with fewest active orders', () => {
    const busy = driver({
      driverId: 'a',
      availability: 'EN_ROUTE',
      activeOrderIds: ['o1'],
    });
    const free = driver({ driverId: 'b' });

    expect(chooseDriver([busy, free])?.driverId).toBe('b');
  });

  it('on a tie, chooses the driver who has waited longest (never assigned first)', () => {
    const recent = driver({
      driverId: 'a',
      lastAssignedAt: new Date('2026-10-18T15:00:00Z'),
    });
    const older = driver({
      driverId: 'b',
      lastAssignedAt: new Date('2026-10-18T14:00:00Z'),
    });
    const never = driver({ driverId: 'c', lastAssignedAt: null });

    expect(chooseDriver([recent, older])?.driverId).toBe('b');
    expect(chooseDriver([recent, older, never])?.driverId).toBe('c');
  });

  it('is deterministic on a full tie', () => {
    expect(
      chooseDriver([driver({ driverId: 'b' }), driver({ driverId: 'a' })])
        ?.driverId,
    ).toBe('a');
  });

  it('F1-S3: returns null when nobody is eligible', () => {
    expect(
      chooseDriver([
        driver({ availability: 'OFFLINE' }),
        driver({ capacity: 1, activeOrderIds: ['x'] }),
      ]),
    ).toBeNull();
    expect(chooseDriver([])).toBeNull();
  });

  it('F1-S5: availability follows the active orders, except OFFLINE', () => {
    expect(availabilityFor('AVAILABLE', 1)).toBe('EN_ROUTE');
    expect(availabilityFor('EN_ROUTE', 0)).toBe('AVAILABLE');
    expect(availabilityFor('OFFLINE', 0)).toBe('OFFLINE');
    expect(availabilityFor('OFFLINE', 2)).toBe('OFFLINE');
  });

  it('checks capacity: 1–10 and not below the active orders', () => {
    expect(checkCapacity(4, 1)).toBeNull();
    expect(checkCapacity(0, 0)).toBe('OUT_OF_RANGE');
    expect(checkCapacity(11, 0)).toBe('OUT_OF_RANGE');
    expect(checkCapacity(2.5, 0)).toBe('OUT_OF_RANGE');
    expect(checkCapacity(1, 2)).toBe('BELOW_ACTIVE_ORDERS');
  });
});

describe('customer rules', () => {
  const input = {
    name: 'Laura',
    email: 'laura@example.com',
    phone: '+573001234567',
  };

  it('F1-S1: creating a profile publishes CustomerContactUpdated', () => {
    expect(publishesContactUpdate(null, input)).toBe(true);
  });

  it('publishes on an email or phone change only', () => {
    expect(
      publishesContactUpdate(
        { email: input.email, phone: input.phone },
        { ...input, name: 'Laura G.' },
      ),
    ).toBe(false);
    expect(
      publishesContactUpdate(
        { email: 'old@example.com', phone: input.phone },
        input,
      ),
    ).toBe(true);
    expect(
      publishesContactUpdate({ email: input.email, phone: null }, input),
    ).toBe(true);
  });
});

describe('AssignmentWindow', () => {
  const window = new AssignmentWindow(30, 600);
  const start = new Date('2026-10-18T15:01:00Z');

  it('expires 10 minutes after the window started', () => {
    expect(
      window.isExpired(
        { windowStartedAt: start },
        new Date('2026-10-18T15:10:59Z'),
      ),
    ).toBe(false);
    expect(
      window.isExpired(
        { windowStartedAt: start },
        new Date('2026-10-18T15:11:00Z'),
      ),
    ).toBe(true);
  });

  it('schedules the next attempt 30 seconds later', () => {
    expect(window.nextAttemptAfter(start).toISOString()).toBe(
      '2026-10-18T15:01:30.000Z',
    );
  });
});

describe('strictlyAfter', () => {
  const now = new Date('2026-10-18T15:06:00.000Z');

  it('keeps now when the previous event is older', () => {
    expect(strictlyAfter(new Date('2026-10-18T15:01:00Z'), now)).toEqual(now);
    expect(strictlyAfter(null, now)).toEqual(now);
  });

  it('moves 1 ms after a previous event at the same time (or later)', () => {
    expect(strictlyAfter(now, now).toISOString()).toBe(
      '2026-10-18T15:06:00.001Z',
    );
  });
});
