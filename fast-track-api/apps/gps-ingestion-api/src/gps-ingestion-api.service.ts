import { Injectable } from '@nestjs/common';

@Injectable()
export class GpsIngestionApiService {
  getHello(): string {
    return 'Hello World!';
  }
}
