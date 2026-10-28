import { Injectable } from '@nestjs/common';

@Injectable()
export class GpsTrackingWorkerService {
  getHello(): string {
    return 'Hello World!';
  }
}
