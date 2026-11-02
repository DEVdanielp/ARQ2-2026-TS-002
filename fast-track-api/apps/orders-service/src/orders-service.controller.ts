import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { OrdersApplicationService } from './application/orders-application.service.js';
import type { AuthenticatedUser } from './domain/order.js';
import { JwtAuthGuard } from './http/jwt-auth.guard.js';
import { Roles } from './http/roles.decorator.js';
import { RolesGuard } from './http/roles.guard.js';

@Controller('v1/orders')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OrdersServiceController {
  constructor(private readonly orders: OrdersApplicationService) {}

  @Post()
  @Roles('CUSTOMER')
  create(
    @Req() request: Request & { user: AuthenticatedUser },
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.orders.create(
      request.user,
      body,
      idempotencyKey,
      this.correlationId(request),
    ).then((result) => {
      for (const [name, value] of Object.entries(result.headers ?? {})) {
        response.setHeader(name, value);
      }
      return result.body;
    });
  }

  @Get()
  @Roles('CUSTOMER', 'DRIVER', 'OPERATIONS')
  list(
    @Req() request: Request & { user: AuthenticatedUser },
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('size') size?: string,
  ) {
    return this.orders.list(request.user, { status, page, size });
  }

  @Get(':orderId')
  @Roles('CUSTOMER', 'DRIVER', 'OPERATIONS')
  get(
    @Req() request: Request & { user: AuthenticatedUser },
    @Param('orderId') orderId: string,
  ) {
    return this.orders.get(request.user, orderId);
  }

  @Post(':orderId/intents')
  @HttpCode(202)
  @Roles('CUSTOMER', 'DRIVER', 'OPERATIONS')
  submitIntent(
    @Req() request: Request & { user: AuthenticatedUser },
    @Param('orderId') orderId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.orders.submitIntent(
      request.user,
      orderId,
      body,
      idempotencyKey,
      this.correlationId(request),
    ).then((result) => result.body);
  }

  private correlationId(request: Request): string {
    const value = request.header('x-correlation-id');
    return value &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      )
      ? value
      : randomUUID();
  }
}
