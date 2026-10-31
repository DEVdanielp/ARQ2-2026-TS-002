/**
 * REST + SSE API of the Tracking Query Service (spec 4.4), behind Kong at
 * `/v1/tracking/...` (the `v1` prefix is set in main.ts; Kong does not buffer
 * this route, so SSE events reach the client at once, ADR-004).
 *
 * A controller is an INBOUND ADAPTER (ADR-014): it translates HTTP into
 * use-case calls and use-case errors into status codes. The @Api* decorators
 * produce the Swagger documentation.
 */
import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuthGuard, CurrentUser, RequireRoles, Roles, type AuthenticatedUser } from '@libs/auth';
import { ApiProblemResponses, problem } from '@libs/http';
import type { TrackingView } from '../../../domain/tracking-view.js';
import {
  InvalidRouteRangeError,
  OrderAccessDeniedError,
  OrderNotFoundError,
  TrackingCacheUnavailableError,
} from '../../../application/errors.js';
import { GetOrderRoute } from '../../../application/get-route.js';
import { GetTrackingView, type TrackingViewResult } from '../../../application/get-tracking-view.js';
import { TrackingQuerySettings, type OrderRoute } from '../../../application/ports.js';
import { WatchTrackingView } from '../../../application/watch-tracking-view.js';
import { OrderRouteDto, TrackingViewDto } from './dtos.js';

@ApiTags('Tracking')
@ApiBearerAuth()
@ApiProblemResponses(401, 403, 500)
@Controller('tracking')
@UseGuards(AuthGuard)
export class TrackingController {
  constructor(
    private readonly getView: GetTrackingView,
    private readonly watchView: WatchTrackingView,
    private readonly getRoute: GetOrderRoute,
    private readonly settings: TrackingQuerySettings,
  ) {}

  @Get(':orderId')
  @RequireRoles(Roles.CUSTOMER, Roles.OPERATIONS)
  @ApiOperation({
    summary: 'Current tracking view of an order (initial load)',
    description:
      'Role `CUSTOMER` (owner of the order) or `OPERATIONS`. Read from Redis, without touching PostgreSQL (F3-S1); ' +
      'terminal orders older than 24 h are read from the archive (F3-S5). `locationAgeSeconds` and ' +
      '`trackingAvailable` are computed at read time: with a location 300 s old or more, `trackingAvailable` is ' +
      'false and the status is unchanged (F3-S3). After this call the app follows the SSE stream instead of polling.',
  })
  @ApiParam({ name: 'orderId', format: 'uuid' })
  @ApiOkResponse({ type: TrackingViewDto })
  @ApiProblemResponses(400, 404, 503)
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
  ): Promise<TrackingView> {
    try {
      return (await this.getView.execute(orderId, user)).view;
    } catch (error) {
      throw toHttpError(error);
    }
  }

  @Get(':orderId/stream')
  @RequireRoles(Roles.CUSTOMER, Roles.OPERATIONS)
  @ApiOperation({
    summary: 'Live tracking view (Server-Sent Events)',
    description:
      'Role `CUSTOMER` (owner) or `OPERATIONS`. Keeps a `text/event-stream` open and sends the FULL view as an ' +
      '`event: tracking` whenever it changes (status, location, assignment, NEARBY), with `id` = view revision. ' +
      'A `: heartbeat` comment is sent every 15 s. On reconnection send `Last-Event-ID`: the current view is ' +
      'sent only if its revision is higher. The browser `EventSource` cannot set headers, so the token may also ' +
      'go in `?jwt=<token>` (accepted by Kong and by the service).\n\n' +
      '```\nid: 4\nevent: tracking\ndata: {"orderId":"6f1c…","status":"ON_THE_WAY","version":3,"nearbyReached":true,…}\n\n: heartbeat\n```',
  })
  @ApiParam({ name: 'orderId', format: 'uuid' })
  @ApiHeader({ name: 'Last-Event-ID', required: false, description: 'Last view revision received (on reconnection)' })
  @ApiQuery({ name: 'jwt', required: false, description: 'Access token, for clients that cannot send headers (EventSource)' })
  @ApiProduces('text/event-stream')
  @ApiOkResponse({ description: 'Event stream; each `data` is a TrackingView', type: TrackingViewDto })
  @ApiProblemResponses(400, 404, 503)
  async stream(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Headers('last-event-id') lastEventIdHeader: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const parsed = Number(lastEventIdHeader);
    const lastEventId = lastEventIdHeader && Number.isInteger(parsed) ? parsed : null;

    let opened = false;
    const open = () => {
      if (opened) return;
      opened = true;
      response.status(200).set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      response.flushHeaders();
    };
    const send = ({ view, revision }: TrackingViewResult) => {
      open();
      response.write(`id: ${revision}\nevent: tracking\ndata: ${JSON.stringify(view)}\n\n`);
    };

    let stop: () => void;
    try {
      // Throws before anything is written, so the error filter can still answer 403/404/503.
      stop = await this.watchView.start({ orderId, viewer: user, lastEventId, send });
    } catch (error) {
      throw toHttpError(error);
    }
    open();

    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), this.settings.heartbeatSeconds * 1000);
    request.on('close', () => {
      clearInterval(heartbeat);
      stop();
    });
  }

  @Get(':orderId/route')
  @RequireRoles(Roles.OPERATIONS)
  @ApiOperation({
    summary: 'Route audit of an order',
    description:
      'Role `OPERATIONS`. Points received for the order (from `LocationUpdated`), ordered by `sequence`, read ' +
      'from the archive (`query-archive-db`). `from` / `to` filter by device time and are optional.',
  })
  @ApiParam({ name: 'orderId', format: 'uuid' })
  @ApiQuery({ name: 'from', required: false, description: 'ISO-8601 with time zone', example: '2026-10-18T15:00:00Z' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO-8601 with time zone', example: '2026-10-18T16:00:00Z' })
  @ApiOkResponse({ type: OrderRouteDto })
  @ApiProblemResponses(400, 404)
  async route(
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<OrderRoute> {
    try {
      return await this.getRoute.execute(orderId, from, to);
    } catch (error) {
      throw toHttpError(error);
    }
  }
}

/** Use-case errors -> HTTP (spec 2, Common status codes). Anything else stays a 500. */
function toHttpError(error: unknown): unknown {
  if (error instanceof OrderNotFoundError) return new NotFoundException(error.message);
  if (error instanceof OrderAccessDeniedError) return new ForbiddenException(error.message);
  if (error instanceof InvalidRouteRangeError) {
    return problem(400, { type: 'invalid-range', title: 'Invalid range', detail: error.message });
  }
  if (error instanceof TrackingCacheUnavailableError) {
    return problem(503, {
      type: 'unavailable',
      title: 'Tracking temporarily unavailable',
      detail: 'The tracking cache cannot be reached; retry in a few seconds.',
    });
  }
  return error;
}
