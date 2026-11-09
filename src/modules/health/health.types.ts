export const HEALTH_TYPES = {
  HealthCheck: Symbol.for('Health.HealthCheck'),
  HealthService: Symbol.for('Health.HealthService'),
  HealthController: Symbol.for('Health.HealthController'),
  HealthRouter: Symbol.for('Health.HealthRouter'),
  RequestScope: Symbol.for('Health.RequestScope'),
} as const;
