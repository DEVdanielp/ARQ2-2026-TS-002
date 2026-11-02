import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '../domain/order.js';

export const ROLES_KEY = 'orders:roles';

export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
