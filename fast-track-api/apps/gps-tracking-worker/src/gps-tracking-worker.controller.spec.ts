import { Test, TestingModule } from '@nestjs/testing';
import { GpsTrackingWorkerController } from './gps-tracking-worker.controller.js';
import { GpsTrackingWorkerService } from './gps-tracking-worker.service.js';

describe('GpsTrackingWorkerController', () => {
  let gpsTrackingWorkerController: GpsTrackingWorkerController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [GpsTrackingWorkerController],
      providers: [GpsTrackingWorkerService],
    }).compile();

    gpsTrackingWorkerController = app.get<GpsTrackingWorkerController>(GpsTrackingWorkerController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(gpsTrackingWorkerController.getHello()).toBe('Hello World!');
    });
  });
});
