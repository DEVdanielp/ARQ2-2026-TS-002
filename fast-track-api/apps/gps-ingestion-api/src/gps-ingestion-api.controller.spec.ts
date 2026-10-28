import { Test, TestingModule } from '@nestjs/testing';
import { GpsIngestionApiController } from './gps-ingestion-api.controller.js';
import { GpsIngestionApiService } from './gps-ingestion-api.service.js';

describe('GpsIngestionApiController', () => {
  let gpsIngestionApiController: GpsIngestionApiController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [GpsIngestionApiController],
      providers: [GpsIngestionApiService],
    }).compile();

    gpsIngestionApiController = app.get<GpsIngestionApiController>(GpsIngestionApiController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(gpsIngestionApiController.getHello()).toBe('Hello World!');
    });
  });
});
