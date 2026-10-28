import { Test, TestingModule } from '@nestjs/testing';
import { TrackingQueryServiceController } from './tracking-query-service.controller.js';
import { TrackingQueryServiceService } from './tracking-query-service.service.js';

describe('TrackingQueryServiceController', () => {
  let trackingQueryServiceController: TrackingQueryServiceController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [TrackingQueryServiceController],
      providers: [TrackingQueryServiceService],
    }).compile();

    trackingQueryServiceController = app.get<TrackingQueryServiceController>(TrackingQueryServiceController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(trackingQueryServiceController.getHello()).toBe('Hello World!');
    });
  });
});
