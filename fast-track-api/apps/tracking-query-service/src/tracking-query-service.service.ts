import { Injectable } from '@nestjs/common';

@Injectable()
export class TrackingQueryServiceService {
  getHello(): string {
    return 'Hello World!';
  }
}
