import { InMemoryPatientRepository } from './InMemoryPatientRepository';
import { runPatientRepositoryContract } from './repositoryContract';

runPatientRepositoryContract({
  name: 'InMemoryPatientRepository',
  create: async () => new InMemoryPatientRepository(),
});
