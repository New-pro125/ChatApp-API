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
  UserBlockReader: Symbol.for('Core.UserBlockReader'),
  ReadReceiptPreferenceReader: Symbol.for('Core.ReadReceiptPreferenceReader'),
  UserSummaryReader: Symbol.for('Core.UserSummaryReader'),
  UsernameReader: Symbol.for('Core.UsernameReader'),
  E2eeDeviceReader: Symbol.for('Core.E2eeDeviceReader'),
  E2eeCiphertextValidator: Symbol.for('Core.E2eeCiphertextValidator'),
  MediaAccess: Symbol.for('Core.MediaAccess'),
  /** Resolves MediaAccess on demand so consumers started at boot do not pin adapters too early. */
  MediaAccessProvider: Symbol.for('Core.MediaAccessProvider'),
  MediaReferenceReader: Symbol.for('Core.MediaReferenceReader'),
  RequireAuth: Symbol.for('Core.RequireAuth'),
  RequireVerifiedEmail: Symbol.for('Core.RequireVerifiedEmail'),

  ApiResponse: Symbol.for('Core.ApiResponse'),
  ErrorMapper: Symbol.for('Core.ErrorMapper'),

  OpenApiRegistry: Symbol.for('Core.OpenApiRegistry'),
  ApiDocumentBuilder: Symbol.for('Core.ApiDocumentBuilder'),
  Metrics: Symbol.for('Core.Metrics'),

  HttpRequest: Symbol.for('Core.HttpRequest'),
} as const;
