import { Injectable } from '@nestjs/common';

@Injectable()
export class ProfilesServiceService {
  getHello(): string {
    return 'Hello World!';
  }
}
