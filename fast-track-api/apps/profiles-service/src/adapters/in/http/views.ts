/**
 * Domain objects -> response bodies. Only the fields of the spec schemas
 * leave the service (internal fields such as `contactVersion` or
 * `lastAssignedAt` do not).
 */
import type { Assignment, Customer, Driver } from '../../../domain/profiles.js';
import type { AssignmentDto, CustomerDto, DriverDto } from './dtos.js';

export const customerView = (c: Customer): CustomerDto => ({
  customerId: c.customerId,
  name: c.name,
  email: c.email,
  phone: c.phone,
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});

export const driverView = (d: Driver): DriverDto => ({
  driverId: d.driverId,
  name: d.name,
  phone: d.phone,
  vehiclePlate: d.vehiclePlate,
  availability: d.availability,
  capacity: d.capacity,
  activeOrderIds: d.activeOrderIds,
});

export const assignmentView = (a: Assignment): AssignmentDto => ({
  orderId: a.orderId,
  driverId: a.driverId,
  assignedAt: a.assignedAt.toISOString(),
  releasedAt: a.releasedAt?.toISOString() ?? null,
});
