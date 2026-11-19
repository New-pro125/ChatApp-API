import { Container } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { MediaRateLimiter } from '@/core/http/middleware/rate-limit.js';
import { RequestScopeMiddleware } from '@/core/http/middleware/request-scope.js';
import type { MediaAccess } from '@/core/media/media-access.port.js';
import { ClamAvVirusScanner } from '@/modules/media/data/clamav-virus.scanner.js';
import { PostgresMediaObjectRepository } from '@/modules/media/data/postgres-media-object.repository.js';
import { S3ObjectStore } from '@/modules/media/data/s3-object.store.js';
import { ClamAvProtocol } from '@/modules/media/logic/clamav-protocol.js';
import { MediaService } from '@/modules/media/logic/media.service.js';
import { MediaAccessService } from '@/modules/media/logic/media-access.service.js';
import { MediaObjectKeyFactory } from '@/modules/media/logic/media-object-key.factory.js';
import { MediaPresignOptions } from '@/modules/media/logic/media-presign.options.js';
import type { MediaObjectRepository } from '@/modules/media/logic/ports/media-object.repository.js';
import type { ObjectStore } from '@/modules/media/logic/ports/object-store.js';
import type { VirusScanner } from '@/modules/media/logic/ports/virus-scanner.js';
import { MEDIA_TYPES } from '@/modules/media/media.types.js';
import { MediaController } from '@/modules/media/web/media.controller.js';
import { MediaRouter } from '@/modules/media/web/routes/media.router.js';

export class MediaContainer extends Container {
  constructor(private readonly root: Container) {
    super({ parent: root });

    this.bind<RequestScopeMiddleware>(MEDIA_TYPES.RequestScope).toConstantValue(
      new RequestScopeMiddleware(this),
    );
    this.bind<MediaRateLimiter>(MEDIA_TYPES.MediaRateLimiter)
      .to(MediaRateLimiter)
      .inSingletonScope();
    this.bind(MediaObjectKeyFactory).toSelf().inSingletonScope();
    this.bind(MEDIA_TYPES.MediaObjectKeyFactory).toConstantValue(this.get(MediaObjectKeyFactory));
    this.bind(MediaPresignOptions).toSelf().inSingletonScope();
    this.bind(MEDIA_TYPES.MediaPresignOptions).toConstantValue(this.get(MediaPresignOptions));
    this.bind(ClamAvProtocol).toSelf().inSingletonScope();
    this.bind(MEDIA_TYPES.ClamAvProtocol).toConstantValue(this.get(ClamAvProtocol));

    this.bind<MediaObjectRepository>(MEDIA_TYPES.MediaObjectRepository)
      .to(PostgresMediaObjectRepository)
      .inSingletonScope();
    this.bind<ObjectStore>(MEDIA_TYPES.ObjectStore).to(S3ObjectStore).inSingletonScope();
    this.bind<VirusScanner>(MEDIA_TYPES.VirusScanner).to(ClamAvVirusScanner).inSingletonScope();
    this.bind<MediaService>(MEDIA_TYPES.MediaService).to(MediaService).inSingletonScope();
    this.bind<MediaAccessService>(MEDIA_TYPES.MediaAccessService)
      .to(MediaAccessService)
      .inSingletonScope();
    // Resolve lazily: eager resolution would construct MediaService here and pin
    // the real scanner before tests rebind the module's VirusScanner dependency.
    this.root
      .bind<MediaAccess>(CORE_TYPES.MediaAccess)
      .toDynamicValue(() => this.get<MediaAccessService>(MEDIA_TYPES.MediaAccessService))
      .inSingletonScope();

    this.bind<MediaController>(MEDIA_TYPES.MediaController).to(MediaController);
    this.bind<MediaRouter>(MEDIA_TYPES.MediaRouter).to(MediaRouter).inSingletonScope();
  }
}
