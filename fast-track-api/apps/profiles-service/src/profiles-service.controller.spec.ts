import { Test, TestingModule } from '@nestjs/testing';
import { ProfilesServiceController } from './profiles-service.controller.js';
import { ProfilesServiceService } from './profiles-service.service.js';

describe('ProfilesServiceController', () => {
  let profilesServiceController: ProfilesServiceController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [ProfilesServiceController],
      providers: [ProfilesServiceService],
    }).compile();

    profilesServiceController = app.get<ProfilesServiceController>(ProfilesServiceController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(profilesServiceController.getHello()).toBe('Hello World!');
    });
  });
});
