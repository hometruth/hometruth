export type WhiskerFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * `authentication`: the account was refused; `unreachable`: Whisker or the
 * network did not answer; `protocol`: an answer we cannot use;
 * `not_found`: the account has no robot with that serial;
 * `not_configured`: this site has no Whisker account.
 */
export type WhiskerErrorCode = "authentication" | "unreachable" | "protocol" | "not_found" | "not_configured";

export class WhiskerError extends Error {
  constructor(message: string, readonly code: WhiskerErrorCode) {
    super(message);
    this.name = "WhiskerError";
  }
}
