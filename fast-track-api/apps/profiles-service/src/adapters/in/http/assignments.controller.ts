/**
 * REST API of assignments for operations (spec 4.1), behind Kong at
 * `/v1/assignments`. An INBOUND ADAPTER (ADR-014): no business rules here.
 */
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthGuard, RequireRoles, Roles } from '@libs/auth';
import { ApiProblemResponses } from '@libs/http';
import { GetAssignment } from '../../../application/driver-profile.use-cases.js';
import { AssignmentDto, AssignmentQueryDto } from './dtos.js';
import { asHttp } from './http-errors.js';
import { problemExample } from './openapi-examples.js';
import { assignmentView } from './views.js';

@ApiTags('Assignments')
@ApiBearerAuth()
@ApiProblemResponses(401, 403, 500)
@Controller('assignments')
@UseGuards(AuthGuard)
export class AssignmentsController {
  constructor(private readonly getAssignment: GetAssignment) {}

  @Get()
  @RequireRoles(Roles.OPERATIONS)
  @ApiOperation({
    summary: 'Driver assignment of an order',
    description:
      "Role `OPERATIONS`. The order's current assignment, or its most recent one if it was released " +
      '(delivered, cancelled, or the driver went OFFLINE before pickup). `404` while no driver has been assigned yet ' +
      '(the order may still be waiting: retries every 30 s for up to 10 minutes).',
  })
  @ApiOkResponse({ type: AssignmentDto })
  @ApiResponse(
    problemExample(400, 'Missing or invalid orderId', {
      type: 'validation',
      title: 'Invalid request',
      detail: 'One or more fields are invalid.',
      instance: '/v1/assignments?orderId=abc',
      errors: [{ field: 'orderId', message: 'orderId must be a UUID' }],
    }),
  )
  @ApiResponse(
    problemExample(404, 'No assignment yet', {
      type: 'not-found',
      title: 'Not Found',
      detail:
        'Order 6f1c2b7e-8d4a-4f3b-9e21-0c5a7d8e9f10 has no assignment yet',
      instance: '/v1/assignments?orderId=6f1c2b7e-8d4a-4f3b-9e21-0c5a7d8e9f10',
    }),
  )
  async get(@Query() query: AssignmentQueryDto): Promise<AssignmentDto> {
    return assignmentView(
      await asHttp(() => this.getAssignment.execute(query.orderId)),
    );
  }
}
