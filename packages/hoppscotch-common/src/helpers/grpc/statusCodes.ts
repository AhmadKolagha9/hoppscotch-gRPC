/** Standard gRPC status codes (0-16) per the gRPC core spec, so the UI can render named constants instead of bare numbers (feature spec §5). */
export const GRPC_STATUS_CODES: Record<number, string> = {
  0: "OK",
  1: "CANCELLED",
  2: "UNKNOWN",
  3: "INVALID_ARGUMENT",
  4: "DEADLINE_EXCEEDED",
  5: "NOT_FOUND",
  6: "ALREADY_EXISTS",
  7: "PERMISSION_DENIED",
  8: "RESOURCE_EXHAUSTED",
  9: "FAILED_PRECONDITION",
  10: "ABORTED",
  11: "OUT_OF_RANGE",
  12: "UNIMPLEMENTED",
  13: "INTERNAL",
  14: "UNAVAILABLE",
  15: "DATA_LOSS",
  16: "UNAUTHENTICATED",
}

export const getGRPCStatusName = (code: number): string =>
  GRPC_STATUS_CODES[code] ?? "UNKNOWN"
