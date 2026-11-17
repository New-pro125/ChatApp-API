export const CORE_TYPES = {
  Config: Symbol.for('Core.Config'),
  Logger: Symbol.for('Core.Logger'),

  PgPool: Symbol.for('Core.PgPool'),
  Db: Symbol.for('Core.Db'),
  RedisClient: Symbol.for('Core.RedisClient'),

  Passport: Symbol.for('Core.Passport'),

  AccessTokenService: Symbol.for('Core.AccessTokenService'),
  AuthDenylist: Symbol.for('Core.AuthDenylist'),
  PrincipalStore: Symbol.for('Core.PrincipalStore'),
  UserPrivacyReader: Symbol.for('Core.UserPrivacyReader'),
  RequireAuth: Symbol.for('Core.RequireAuth'),
  RequireVerifiedEmail: Symbol.for('Core.RequireVerifiedEmail'),

  ApiResponse: Symbol.for('Core.ApiResponse'),
  ErrorMapper: Symbol.for('Core.ErrorMapper'),

  OpenApiRegistry: Symbol.for('Core.OpenApiRegistry'),
  ApiDocumentBuilder: Symbol.for('Core.ApiDocumentBuilder'),
  Metrics: Symbol.for('Core.Metrics'),

  HttpRequest: Symbol.for('Core.HttpRequest'),
} as const;
