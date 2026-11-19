import { AppError, type AppErrorOptions } from '@/core/errors/app.error.js';
import { ErrorCode } from '@/core/errors/error-code.js';

/** Base class for failures raised by the data/persistence layer. */
export class RepositoryException extends AppError {
  readonly code = ErrorCode.REPOSITORY_ERROR;

  constructor(message: string, options?: AppErrorOptions) {
    super(message, options);
  }
}

export class UniqueConstraintException extends RepositoryException {
  readonly constraint: string;

  constructor(constraint: string, options?: AppErrorOptions) {
    super(`Unique constraint violated: ${constraint}`, options);
    this.constraint = constraint;
  }
}

export class PersistenceException extends RepositoryException {
  constructor(message = 'A database operation failed', options?: AppErrorOptions) {
    super(message, options);
  }
}

/** Failure talking to S3-compatible object storage. */
export class ObjectStoreException extends RepositoryException {
  constructor(message = 'Object storage operation failed', options?: AppErrorOptions) {
    super(message, options);
  }
}

/** Failure talking to the ClamAV daemon or parsing its protocol. */
export class VirusScannerException extends RepositoryException {
  constructor(message = 'Virus scan failed', options?: AppErrorOptions) {
    super(message, options);
  }
}
