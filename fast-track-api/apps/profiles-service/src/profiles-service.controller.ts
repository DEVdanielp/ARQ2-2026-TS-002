import { Controller, Get } from '@nestjs/common';
import { ProfilesServiceService } from './profiles-service.service.js';

@Controller()
export class ProfilesServiceController {
  constructor(private readonly profilesServiceService: ProfilesServiceService) {}

  @Get()
  getHello(): string {
    return this.profilesServiceService.getHello();
  }
}
