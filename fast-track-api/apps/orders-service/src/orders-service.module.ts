import { Module } from '@nestjs/common';
import { OrdersServiceController } from './orders-service.controller.js';
import { OrdersServiceService } from './orders-service.service.js';

@Module({
  imports: [],
  controllers: [OrdersServiceController],
  providers: [OrdersServiceService],
})
export class OrdersServiceModule {}
