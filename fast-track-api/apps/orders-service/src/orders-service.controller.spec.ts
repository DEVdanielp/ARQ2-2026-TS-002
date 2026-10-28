import { Test, TestingModule } from '@nestjs/testing';
import { OrdersServiceController } from './orders-service.controller.js';
import { OrdersServiceService } from './orders-service.service.js';

describe('OrdersServiceController', () => {
  let ordersServiceController: OrdersServiceController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [OrdersServiceController],
      providers: [OrdersServiceService],
    }).compile();

    ordersServiceController = app.get<OrdersServiceController>(OrdersServiceController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(ordersServiceController.getHello()).toBe('Hello World!');
    });
  });
});
