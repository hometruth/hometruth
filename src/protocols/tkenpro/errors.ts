export class MeariError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class MeariAuthError extends MeariError {
  readonly resultCode: string | undefined;

  constructor(message: string, resultCode?: string, options?: ErrorOptions) {
    super(message, options);
    this.resultCode = resultCode;
  }
}

export class MeariSessionError extends MeariAuthError {}

export class MeariApiError extends MeariError {
  readonly resultCode: string | undefined;

  constructor(message: string, resultCode?: string, options?: ErrorOptions) {
    super(message, options);
    this.resultCode = resultCode;
  }
}

export class DeviceOfflineError extends MeariApiError {}

export class DestructiveControlError extends MeariError {
  readonly code: string;

  constructor(code: string, message = `IoT code ${code} requires explicit confirmation`) {
    super(message);
    this.code = code;
  }
}
