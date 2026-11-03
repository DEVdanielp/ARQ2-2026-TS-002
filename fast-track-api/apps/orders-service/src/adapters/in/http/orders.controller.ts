/**
 * REST API of the Orders Service (spec 4.2), behind Kong at `/v1/orders`. An
 * INBOUND ADAPTER (ADR-014): no business rules here. Identity always comes from
 * the JWT (spec 2).
 */
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import {
  AuthGuard,
  CurrentUser,
  RequireRoles,
  Roles,
  type AuthenticatedUser,
} from '@libs/auth';
import { ApiProblemResponses } from '@libs/http';
import {
  CreateOrder,
  GetOrder,
  ListOrders,
  SubmitIntent,
} from '../../../application/orders.use-cases.js';
import {
  CreateOrderDto,
  IntentAcceptedDto,
  ListOrdersQueryDto,
  OrderDto,
  OrderPageDto,
  SubmitIntentDto,
} from './dtos.js';
import {
  asHttp,
  correlationIdFrom,
  idempotencyKeyFrom,
} from './http-errors.js';
import { problemExample, problemExamples } from './openapi-examples.js';

const ORDER_ID = '6f1c2b7e-8d4a-4f3b-9e21-0c5a7d8e9f10';
const ORDERS_PATH = '/v1/orders';
const INTENTS_PATH = `${ORDERS_PATH}/${ORDER_ID}/intents`;

const IDEMPOTENCY_HEADER = ApiHeader({
  name: 'Idempotency-Key',
  required: false,
  schema: { type: 'string', format: 'uuid' },
  description:
    'Optional. A repeated key within 24 h returns the original response without repeating the action.',
});

const ORDER_ID_PARAM = ApiParam({
  name: 'orderId',
  format: 'uuid',
  example: ORDER_ID,
});

@ApiTags('Orders')
@ApiBearerAuth()
@ApiProblemResponses(401, 429, 500)
@Controller('orders')
@UseGuards(AuthGuard)
export class OrdersController {
  constructor(
    private readonly createOrder: CreateOrder,
    private readonly getOrder: GetOrder,
    private readonly listOrders: ListOrders,
    private readonly submitIntent: SubmitIntent,
  ) {}

  @Post()
  @RequireRoles(Roles.CUSTOMER)
  @ApiOperation({
    summary: 'Create an order',
    description:
      'Role `CUSTOMER`. Creates the order in `CREATED` and publishes `OrderCreated` through the outbox, ' +
      'which starts the fulfillment saga: Profiles & Assignment looks for a driver.',
  })
  @IDEMPOTENCY_HEADER
  @ApiCreatedResponse({
    type: OrderDto,
    description: 'Order created',
    headers: {
      Location: {
        description: 'Path of the new order',
        schema: { type: 'string', example: `${ORDERS_PATH}/${ORDER_ID}` },
      },
    },
  })
  @ApiResponse(
    problemExample(400, 'Invalid destination', {
      type: 'validation',
      title: 'Invalid request',
      detail: 'One or more fields are invalid.',
      instance: ORDERS_PATH,
      errors: [
        {
          field: 'destination.location.lat',
          message: 'lat must not be greater than 90',
        },
      ],
    }),
  )
  @ApiResponse(
    problemExample(403, 'The caller is not a customer', {
      type: 'forbidden',
      title: 'Forbidden',
      detail: 'Requires one of the roles: CUSTOMER',
      instance: ORDERS_PATH,
    }),
  )
  @ApiResponse(
    problemExample(409, 'Same `Idempotency-Key` with a different body', {
      type: 'idempotency-key-reused',
      title: 'Idempotency key reused',
      detail:
        'Idempotency-Key 1f6e0c2a-77b1-4d0e-9a8f-2b3c4d5e6f70 was already used with a different body.',
      instance: ORDERS_PATH,
    }),
  )
  @ApiProblemResponses(503)
  async create(
    @Body() body: CreateOrderDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OrderDto> {
    const order = await asHttp(() =>
      this.createOrder.execute({
        customerId: user.userId,
        destination: body.destination,
        notes: body.notes,
        idempotencyKey: idempotencyKeyFrom(idempotencyKey),
        correlationId: correlationIdFrom(correlationId),
      }),
    );
    response.setHeader('Location', `${ORDERS_PATH}/${order.orderId}`);
    return order;
  }

  @Get()
  @RequireRoles(Roles.CUSTOMER, Roles.DRIVER, Roles.OPERATIONS)
  @ApiOperation({
    summary: "List the caller's orders",
    description:
      'A customer sees their own orders, a driver the ones assigned to them, and operations sees all. Newest first.',
  })
  @ApiOkResponse({ type: OrderPageDto })
  @ApiResponse(
    problemExample(400, 'Invalid filter', {
      type: 'validation',
      title: 'Invalid request',
      detail: 'One or more fields are invalid.',
      instance: `${ORDERS_PATH}?status=LOST`,
      errors: [
        {
          field: 'status',
          message:
            'status must be one of the following values: CREATED, ON_THE_WAY, DELIVERED, CANCELLED',
        },
      ],
    }),
  )
  @ApiProblemResponses(403)
  async list(
    @Query() query: ListOrdersQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrderPageDto> {
    return asHttp(() => this.listOrders.execute(user, query));
  }

  @Get(':orderId')
  @RequireRoles(Roles.CUSTOMER, Roles.DRIVER, Roles.OPERATIONS)
  @ApiOperation({
    summary: 'Get an order',
    description:
      'The `CUSTOMER` who owns it, the `DRIVER` assigned to it, or `OPERATIONS`.',
  })
  @ORDER_ID_PARAM
  @ApiOkResponse({ type: OrderDto })
  @ApiResponse(
    problemExample(403, 'Not the owner, not the assigned driver', {
      type: 'forbidden',
      title: 'Forbidden',
      detail: `Order ${ORDER_ID} is not visible to this user.`,
      instance: `${ORDERS_PATH}/${ORDER_ID}`,
    }),
  )
  @ApiResponse(
    problemExample(404, 'The order does not exist', {
      type: 'not-found',
      title: 'Not Found',
      detail: `Order ${ORDER_ID} not found`,
      instance: `${ORDERS_PATH}/${ORDER_ID}`,
    }),
  )
  @ApiProblemResponses(400)
  async get(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrderDto> {
    return asHttp(() => this.getOrder.execute(orderId, user));
  }

  @Post(':orderId/intents')
  @HttpCode(202)
  @RequireRoles(Roles.CUSTOMER, Roles.DRIVER, Roles.OPERATIONS)
  @ApiOperation({
    summary: 'Submit an intent',
    description:
      'Queues the intent on `orders.intents` (key = `orderId`) and returns `202`: the state engine applies it ' +
      'asynchronously and in order. The result is visible in the tracking view (status change or `lastRejectedIntent`).\n\n' +
      '| Intent | Who | Status |\n| --- | --- | --- |\n' +
      '| `PICKUP_CONFIRMED` | assigned `DRIVER` | `CREATED` → `ON_THE_WAY` |\n' +
      '| `DELIVERY_CONFIRMED` | assigned `DRIVER` | `ON_THE_WAY` → `DELIVERED` |\n' +
      '| `CANCELLATION_REQUESTED` | owner `CUSTOMER` | `CREATED` → `CANCELLED` |\n' +
      '| `CANCELLATION_REQUESTED` + `reason` | `OPERATIONS` | `CREATED` or `ON_THE_WAY` → `CANCELLED` |\n\n' +
      'The `403`/`409` here are fast pre-checks. The authoritative validation is done by the state engine.',
  })
  @ORDER_ID_PARAM
  @IDEMPOTENCY_HEADER
  @ApiAcceptedResponse({
    type: IntentAcceptedDto,
    description: 'Accepted for processing',
  })
  @ApiResponse(
    problemExample(400, 'Invalid type or missing reason', {
      type: 'validation',
      title: 'Invalid request',
      detail: 'One or more fields are invalid.',
      instance: INTENTS_PATH,
      errors: [{ field: 'reason', message: 'required for OPERATIONS' }],
    }),
  )
  @ApiResponse(
    problemExamples(403, 'Role or ownership does not allow this intent', {
      'Customer cancelling after pickup': {
        type: 'forbidden',
        title: 'Forbidden',
        detail: 'Customers cannot cancel an order that is ON_THE_WAY.',
        instance: INTENTS_PATH,
      },
      'Driver no longer assigned': {
        type: 'forbidden',
        title: 'Forbidden',
        detail: `Order ${ORDER_ID} is not assigned to this driver.`,
        instance: INTENTS_PATH,
      },
    }),
  )
  @ApiResponse(
    problemExample(404, 'The order does not exist', {
      type: 'not-found',
      title: 'Not Found',
      detail: `Order ${ORDER_ID} not found`,
      instance: INTENTS_PATH,
    }),
  )
  @ApiResponse(
    problemExamples(409, 'Conflict with the current state', {
      'Order already terminal': {
        type: 'order-terminal',
        title: 'Order is in a terminal state',
        detail: `Order ${ORDER_ID} is DELIVERED.`,
        instance: INTENTS_PATH,
      },
      'Key used with a different body': {
        type: 'idempotency-key-reused',
        title: 'Idempotency key reused',
        detail:
          'Idempotency-Key 1f6e0c2a-77b1-4d0e-9a8f-2b3c4d5e6f70 was already used with a different body.',
        instance: INTENTS_PATH,
      },
    }),
  )
  @ApiResponse(
    problemExample(503, 'Kafka unavailable: the intent was not queued', {
      type: 'unavailable',
      title: 'Service temporarily unavailable',
      detail: 'Kafka is temporarily unavailable; try again.',
      instance: INTENTS_PATH,
    }),
  )
  async submit(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() body: SubmitIntentDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ): Promise<IntentAcceptedDto> {
    return asHttp(() =>
      this.submitIntent.execute({
        orderId,
        type: body.type,
        reason: body.reason,
        caller: user,
        idempotencyKey: idempotencyKeyFrom(idempotencyKey),
        correlationId: correlationIdFrom(correlationId),
      }),
    );
  }
}
