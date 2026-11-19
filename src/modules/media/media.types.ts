export const MEDIA_TYPES = {
  MediaObjectRepository: Symbol.for('Media.MediaObjectRepository'),
  ObjectStore: Symbol.for('Media.ObjectStore'),
  VirusScanner: Symbol.for('Media.VirusScanner'),
  MediaObjectKeyFactory: Symbol.for('Media.MediaObjectKeyFactory'),
  MediaPresignOptions: Symbol.for('Media.MediaPresignOptions'),
  ClamAvProtocol: Symbol.for('Media.ClamAvProtocol'),
  MediaRateLimiter: Symbol.for('Media.MediaRateLimiter'),
  MediaService: Symbol.for('Media.MediaService'),
  MediaAccessService: Symbol.for('Media.MediaAccessService'),
  MediaController: Symbol.for('Media.MediaController'),
  MediaRouter: Symbol.for('Media.MediaRouter'),
  RequestScope: Symbol.for('Media.RequestScope'),
} as const;
