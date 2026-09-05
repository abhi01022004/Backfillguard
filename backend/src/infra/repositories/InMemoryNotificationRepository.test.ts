import { InMemoryNotificationRepository } from './InMemoryNotificationRepository';
import { runNotificationRepositoryContract } from './notificationContract';

runNotificationRepositoryContract({
  name: 'InMemoryNotificationRepository',
  create: async () => new InMemoryNotificationRepository(),
});
