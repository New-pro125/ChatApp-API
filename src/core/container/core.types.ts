export const CORE_TYPES = {
  Config: Symbol.for('Core.Config'),
  Logger: Symbol.for('Core.Logger'),

  PgPool: Symbol.for('Core.PgPool'),
  Db: Symbol.for('Core.Db'),
  RedisClient: Symbol.for('Core.RedisClient'),

  SessionStore: Symbol.for('Core.SessionStore'),
  Passport: Symbol.for('Core.Passport'),

  ApiResponse: Symbol.for('Core.ApiResponse'),
  ErrorMapper: Symbol.for('Core.ErrorMapper'),

  OpenApiRegistry: Symbol.for('Core.OpenApiRegistry'),
  ApiDocumentBuilder: Symbol.for('Core.ApiDocumentBuilder'),

  HttpRequest: Symbol.for('Core.HttpRequest'),
} as const;
