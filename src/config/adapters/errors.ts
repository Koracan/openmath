/**
 * Retryable error type used by model adapters.
 */
export class ModelRequestError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ModelRequestError";
  }
}
